/**
 * turnLoop — a reply that stops at the model's output limit. A thinking model
 * (Claude Fable 5.2 thinks on every request) can spend a whole small output
 * budget thinking and stop at `max_tokens` with no text. The loop asks the
 * model once to continue, and when the reply still ends cut off it hands the
 * final reply on with the limit, so the thread gets a notice instead of a
 * run that ends quietly with nothing posted. A cut-off tool call never runs.
 */

// — Assertable handles (referenced inside jest.mock factories via wrappers) —
const wsBroadcast = jest.fn();
const wsSend = jest.fn();
const runsCreate = jest.fn();
const runsMarkFailed = jest.fn();
const trackerFinish = jest.fn();
const streamModelCallMock = jest.fn();
const assembleCtxMock = jest.fn();
const prepareCtxMock = jest.fn();
const persistRunErrorMock = jest.fn();
const dispatchToolCallsMock = jest.fn();
const helperTurnHeldMock = jest.fn();

jest.mock('@server/services/WebSocketService', () => ({
  wsService: {
    broadcastToChannel: (...a: unknown[]) => wsBroadcast(...a),
    sendToClient: (...a: unknown[]) => wsSend(...a),
  },
}));

jest.mock('@snaglet/db/tables/runs', () => ({
  Runs: {
    create: (...a: unknown[]) => runsCreate(...a),
    markFailed: (...a: unknown[]) => runsMarkFailed(...a),
  },
}));

jest.mock('@snaglet/db/tables/messages', () => ({
  Messages: { getLastByThread: jest.fn(), listAfter: jest.fn() },
}));

jest.mock('@snaglet/db/tables/agent_activity_log', () => ({
  AgentActivityLog: { logActivity: jest.fn().mockResolvedValue(undefined) },
}));

jest.mock('@server/services/ActiveRunTracker', () => ({
  activeRunTracker: {
    start: jest.fn(),
    noteProgress: jest.fn(),
    noteToolCall: jest.fn(),
    // Run-ended narration reads the turn's stats here; null = nothing to narrate.
    takeTurnSummary: jest.fn().mockReturnValue(null),
    finish: (...a: unknown[]) => trackerFinish(...a),
  },
}));

jest.mock('@server/services/PendingAgentMessageService', () => ({
  pendingAgentMessages: { enqueue: jest.fn(), clearAgent: jest.fn() },
}));

jest.mock('@server/services/LogsService', () => ({
  LogsService: {
    socket: { event: jest.fn(), error: jest.fn() },
    warn: jest.fn(),
  },
}));

jest.mock('@server/config/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), debug: jest.fn() },
}));

jest.mock('@server/services/SocketService/handlers/chatHelpers', () => ({
  emitAgentStatus: jest.fn(),
  emitAgentTyping: jest.fn(),
  stripThinkingTags: (s: string) => ({ reply: s ?? '', thinking: '' }),
}));

jest.mock('@server/services/SocketService/persistRunErrorMessage', () => ({
  persistRunErrorMessage: (...a: unknown[]) => persistRunErrorMock(...a),
  classifyRunError: () => 'model_failure',
}));

jest.mock('@server/services/SocketService/handlers/chatPhases/contextAssembly', () => ({
  assembleAgentTurnContext: (...a: unknown[]) => assembleCtxMock(...a),
  prepareModelAttemptContext: (...a: unknown[]) => prepareCtxMock(...a),
}));

jest.mock('@server/services/SocketService/handlers/chatPhases/llmStream', () => ({
  streamModelCall: (...a: unknown[]) => streamModelCallMock(...a),
}));

const handleFinalReplyMock = jest.fn();
jest.mock('@server/services/SocketService/handlers/chatPhases/finalReply', () => ({
  handleFinalReply: (...a: unknown[]) => handleFinalReplyMock(...a),
}));

jest.mock('@server/services/SocketService/handlers/chatPhases/midRunMessages', () => ({
  drainToolLoopMidRunMessages: jest.fn().mockResolvedValue(undefined),
}));

// The block builders run for real; only the payload assembly is stubbed.
jest.mock('@server/services/SocketService/handlers/chatPhases/promptBuilder', () => ({
  ...jest.requireActual('@server/services/SocketService/handlers/chatPhases/promptBuilder'),
  buildPromptMessagesForIteration: jest.fn().mockResolvedValue([]),
}));

jest.mock('@server/services/SocketService/handlers/chatPhases/toolDispatch', () => ({
  dispatchToolCalls: (...a: unknown[]) => dispatchToolCallsMock(...a),
}));

jest.mock('@server/services/SocketService/handlers/chatPhases/repeatCallGuard', () => ({
  createRepeatCallGuard: jest.fn(() => ({})),
}));

jest.mock('@server/services/SocketService/handlers/chatPhases/cacheFootprintTracker', () => ({
  estimateAbandonedCacheTokens: jest.fn(() => 0),
  recordCacheFootprint: jest.fn(),
}));

jest.mock('@server/services/SocketService/handlers/chatPhases/utteranceMessages', () => ({
  persistUtterance: jest.fn().mockResolvedValue(undefined),
  routeSpokenMentions: jest.fn(),
}));

jest.mock('@server/services/SocketService/handlers/chatPhases/routeAllModeMidRunMessage', () => ({
  routeAllModeMidRunMessage: jest.fn(() => ({})),
  applyAllModeFanoutEffects: jest.fn(),
}));

jest.mock('@server/services/SocketService/handlers/chatPhases/voiceCatchUp', () => ({
  buildVoiceCatchUpBlocks: jest.fn(() => ({ blocks: [], cursor: null })),
}));

jest.mock('@server/services/SocketService/voiceSession/voiceSessionRegistry', () => ({
  isThreadVoiceActive: jest.fn(() => false),
}));

jest.mock('@server/services/SocketService/voiceSession/voiceStreamEvents', () => ({
  emitVoiceDelta: jest.fn(),
}));

jest.mock('@server/services/subagents/turnGate', () => ({
  helperTurnHeld: (...a: unknown[]) => helperTurnHeldMock(...a),
}));

jest.mock('@server/services/SocketService/voiceSession/floorArbiter', () => ({
  acquireGenerationFloor: jest.fn().mockResolvedValue('acquired'),
  releaseGenerationFloor: jest.fn(),
  releaseGenerationFloorAfterPlayback: jest.fn(),
}));

import { runAgentTurnLoop } from '@server/services/SocketService/handlers/chatPhases/turnLoop';
import { Messages } from '@snaglet/db/tables/messages';
import { isThreadVoiceActive } from '@server/services/SocketService/voiceSession/voiceSessionRegistry';
import {
  acquireGenerationFloor,
  releaseGenerationFloor,
} from '@server/services/SocketService/voiceSession/floorArbiter';
import { ProviderStreamStallError } from '@server/services/SocketService/handlers/chatPhases/streamIdleWatchdog';
import {
  resetHelperTurnFailuresForTests,
  takeHelperTurnFailure,
} from '@server/services/subagents/turnFailures';
import type {
  RunAgentTurnDeps,
  RunAgentTurnSharedState,
} from '@server/services/SocketService/handlers/chatPhases/types';

const THREAD_ID = 'thread-1';
const AGENT_ID = 'agent-1';

type WsCall = [string, { type: string; payload: Record<string, unknown> }];

function makeDeps(): RunAgentTurnDeps {
  return {
    session: { threadId: THREAD_ID },
    sessionId: 's1',
    threadId: THREAD_ID,
    threadName: 'Test Thread',
    clientId: 'client-1',
    meta: { clientId: 'client-1' },
    isGroup: false,
    participantAgentIds: [AGENT_ID],
    activeRunIds: new Set<string>(),
    previewMessage: (v: string) => v,
    toToolText: (v: unknown) => String(v),
    triggerMessageId: undefined,
    wokenByMention: new Set<string>(),
    startAgent: () => {},
    HARD_DISPATCH_CEILING: 10,
    dispatchSet: new Set<string>([AGENT_ID]),
    abortController: new AbortController(),
    agentNameMap: new Map<string, string>([[AGENT_ID, 'Ada']]),
    effectiveParallelDispatch: false,
    dispatchMode: 'all',
    threadRuntimeConfig: null,
    softDispatchThreshold: 5,
    hardDispatchCeiling: 10,
    agentTimeoutMs: 120000,
    wsService: { broadcastToChannel: wsBroadcast, sendToClient: wsSend },
  } as unknown as RunAgentTurnDeps;
}

function makeShared(): RunAgentTurnSharedState {
  return {
    runningAgents: new Set<string>(),
    agentMentionQueues: new Map<string, string[]>(),
    agentDispatchCount: new Map<string, number>(),
    agentSoftThresholdNotified: new Set<string>(),
    passedAgents: new Set<string>(),
    passKinds: new Map(),
    recentRepliesByAgent: new Map<string, string[]>(),
    stagnationStrikes: new Map<string, number>(),
    currentWaveResults: [],
    tokenTotals: { input: 0, output: 0 },
    conversationRound: 0,
  } as unknown as RunAgentTurnSharedState;
}

const READY_CTX = () => ({
  status: 'ready' as const,
  agent: { id: AGENT_ID, name: 'Ada', systemPrompt: '', disableModelFallback: false },
  agentTools: [],
  toolAccess: { mode: 'all', allowList: [], denyList: [] },
  modelCandidates: [
    { provider_id: 'openai', model_id: 'gpt-x', credential_id: 'c1', source: 'agent_default' },
  ],
  runtimeAgentTemplate: {
    id: AGENT_ID,
    name: 'Ada',
    provider: 'openai',
    modelId: 'gpt-x',
    credentialId: 'c1',
    systemPrompt: '',
    disableModelFallback: false,
  },
  systemBlocks: [],
  turnContextData: '',
  startedAt: Date.now(),
});

const ATTEMPT_CTX = () => ({
  toolRows: [],
  toolMap: new Map(),
  visibleToolIds: new Set<string>(),
  budget: { maxOutputTokens: 128, cacheTtl: '1h' },
  agentMessages: [],
  threadSummaryText: null,
  maxToolIterations: 5,
  shouldStreamThinking: true,
  compactionCarryForward: '',
  contextWatermark: null,
});

const cutOff = (reply = '') => ({
  result: { reply, toolCalls: undefined, stopReason: 'max_tokens', thinkingContent: '' },
  emittedTyping: false,
  latestThinking: '',
});
const answered = (reply: string) => ({
  result: { reply, toolCalls: [], stopReason: 'end_turn' },
  emittedTyping: false,
  latestThinking: '',
});

let agentMessages: Array<{ role: string; content: unknown }>;

beforeEach(() => {
  wsBroadcast.mockReset();
  wsSend.mockReset();
  runsCreate.mockReset().mockResolvedValue(undefined);
  runsMarkFailed.mockReset().mockResolvedValue(undefined);
  trackerFinish.mockReset();
  streamModelCallMock.mockReset();
  handleFinalReplyMock.mockReset().mockResolvedValue(undefined);
  assembleCtxMock.mockReset().mockResolvedValue(READY_CTX());
  agentMessages = [];
  prepareCtxMock.mockReset().mockImplementation(async () => ({
    ...ATTEMPT_CTX(),
    budget: { maxOutputTokens: 8192, modelMaxOutputTokens: 8192, cacheTtl: '1h' },
    agentMessages,
  }));
  persistRunErrorMock.mockReset().mockResolvedValue(null);
  dispatchToolCallsMock.mockReset().mockResolvedValue({ latestThinking: '' });
  helperTurnHeldMock.mockReset().mockResolvedValue(false);
});

describe('turnLoop — a reply cut off at the output limit', () => {
  it('asks the model once to continue when thinking used the whole budget, then posts the answer', async () => {
    streamModelCallMock
      .mockResolvedValueOnce(cutOff())
      .mockResolvedValueOnce(answered('Here is the plan.'));

    await runAgentTurnLoop(makeDeps(), makeShared(), AGENT_ID);

    expect(streamModelCallMock).toHaveBeenCalledTimes(2);
    // The continuation turn names the cut-off; nothing empty is replayed as the assistant.
    expect(agentMessages).toHaveLength(1);
    expect(agentMessages[0]).toMatchObject({ role: 'user' });
    expect(String(agentMessages[0]!.content)).toMatch(/stopped at the output limit/);
    expect(handleFinalReplyMock).toHaveBeenCalledTimes(1);
    const input = handleFinalReplyMock.mock.calls[0]![0] as Record<string, unknown>;
    expect((input.result as { reply: string }).reply).toBe('Here is the plan.');
    expect(input.cutOff).toBeUndefined();
  });

  it('keeps the partial text in context when it continues', async () => {
    streamModelCallMock
      .mockResolvedValueOnce(cutOff('The first half'))
      .mockResolvedValueOnce(answered(' and the rest.'));

    await runAgentTurnLoop(makeDeps(), makeShared(), AGENT_ID);

    expect(agentMessages[0]).toEqual({
      role: 'assistant',
      content: [{ type: 'text', text: 'The first half' }],
    });
    expect(agentMessages[1]).toMatchObject({ role: 'user' });
  });

  it('hands the final reply on with the output limit when it is cut off again', async () => {
    streamModelCallMock.mockResolvedValueOnce(cutOff()).mockResolvedValueOnce(cutOff());

    await runAgentTurnLoop(makeDeps(), makeShared(), AGENT_ID);

    expect(streamModelCallMock).toHaveBeenCalledTimes(2);
    expect(handleFinalReplyMock).toHaveBeenCalledTimes(1);
    const input = handleFinalReplyMock.mock.calls[0]![0] as Record<string, unknown>;
    expect((input.result as { reply: string; stopReason: string }).stopReason).toBe('max_tokens');
    expect(input.cutOff).toEqual({ maxOutputTokens: 8192 });
  });

  it('keeps the cut-off turn’s thinking, unchanged, and leaves out its truncated tool call', async () => {
    const thinking = { type: 'thinking', thinking: '', signature: 'sig-1' };
    streamModelCallMock
      .mockResolvedValueOnce({
        result: {
          reply: 'Half an answer ',
          toolCalls: [{ id: 't1', name: 'search', input: {} }],
          stopReason: 'max_tokens',
          assistantContent: [
            thinking,
            { type: 'text', text: 'Half an answer ' },
            { type: 'tool_use', id: 't1', name: 'search', input: {} },
          ],
        },
        emittedTyping: false,
        latestThinking: '',
      })
      .mockResolvedValueOnce(answered('The rest.'));

    await runAgentTurnLoop(makeDeps(), makeShared(), AGENT_ID);

    expect(agentMessages[0]).toEqual({
      role: 'assistant',
      content: [thinking, { type: 'text', text: 'Half an answer ' }],
    });
    expect(dispatchToolCallsMock).not.toHaveBeenCalled();
  });

  it('sends no assistant turn back when the cut-off reply was thinking alone', async () => {
    streamModelCallMock
      .mockResolvedValueOnce({
        result: {
          reply: '',
          stopReason: 'max_tokens',
          assistantContent: [{ type: 'thinking', thinking: '', signature: 'sig-1' }],
        },
        emittedTyping: false,
        latestThinking: '',
      })
      .mockResolvedValueOnce(answered('Answer.'));

    await runAgentTurnLoop(makeDeps(), makeShared(), AGENT_ID);

    expect(agentMessages.map((m) => m.role)).toEqual(['user']);
  });

  it('releases the speaking floor before continuing on a voice thread', async () => {
    (isThreadVoiceActive as jest.Mock).mockReturnValue(true);
    (Messages.getLastByThread as jest.Mock).mockResolvedValue(null);
    (Messages.listAfter as jest.Mock).mockResolvedValue([]);
    (acquireGenerationFloor as jest.Mock).mockClear();
    (releaseGenerationFloor as jest.Mock).mockClear();
    streamModelCallMock.mockResolvedValueOnce(cutOff()).mockResolvedValueOnce(answered('Done.'));
    try {
      await runAgentTurnLoop(makeDeps(), makeShared(), AGENT_ID);
    } finally {
      (isThreadVoiceActive as jest.Mock).mockReturnValue(false);
    }

    const acquires = (acquireGenerationFloor as jest.Mock).mock.invocationCallOrder;
    const releases = (releaseGenerationFloor as jest.Mock).mock.invocationCallOrder;
    expect(acquires).toHaveLength(2);
    // Released between the cut-off call and the continuation's acquire.
    expect(releases.some((at) => at > acquires[0]! && at < acquires[1]!)).toBe(true);
  });

  it('never runs a tool call from a cut-off reply', async () => {
    streamModelCallMock
      .mockResolvedValueOnce({
        result: {
          reply: '',
          toolCalls: [{ id: 't1', name: 'search', input: { q: 'pla' } }],
          stopReason: 'max_tokens',
        },
        emittedTyping: false,
        latestThinking: '',
      })
      .mockResolvedValueOnce(answered('Done.'));

    await runAgentTurnLoop(makeDeps(), makeShared(), AGENT_ID);

    expect(dispatchToolCallsMock).not.toHaveBeenCalled();
    expect(handleFinalReplyMock).toHaveBeenCalledTimes(1);
  });
});

describe('turnLoop — replayed thinking the provider refused', () => {
  it('drops the run’s thinking once and stops sending it', async () => {
    const tool = (id: string) => ({ type: 'tool_use', id, name: 'search', input: {} });
    streamModelCallMock
      .mockResolvedValueOnce({
        result: {
          reply: '',
          toolCalls: [{ id: 't1', name: 'search', input: {} }],
          stopReason: 'tool_use',
          assistantContent: [{ type: 'thinking', thinking: '', signature: 'sig-1' }, tool('t1')],
        },
        emittedTyping: false,
        latestThinking: '',
      })
      .mockResolvedValueOnce({
        result: {
          reply: '',
          toolCalls: [{ id: 't2', name: 'search', input: {} }],
          stopReason: 'tool_use',
          thinkingDropped: true,
          assistantContent: [{ type: 'thinking', thinking: '', signature: 'sig-2' }, tool('t2')],
        },
        emittedTyping: false,
        latestThinking: '',
      })
      .mockResolvedValueOnce(answered('Found it.'));

    await runAgentTurnLoop(makeDeps(), makeShared(), AGENT_ID);

    const assistantTurns = agentMessages.filter((m) => m.role === 'assistant');
    expect(assistantTurns.map((m) => m.content)).toEqual([[tool('t1')], [tool('t2')]]);
  });
});
