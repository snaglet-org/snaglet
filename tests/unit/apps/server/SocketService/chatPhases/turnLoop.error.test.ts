/**
 * turnLoop — run-terminating failure surfacing. When a model call rejects
 * (non-abort) and the candidate chain is exhausted, the turn broadcasts
 * exactly one structured `socket:error` (agentId + runId) to the thread
 * channel, so every participant sees the run died instead of a stuck
 * "Thinking…" bubble; `Runs.markFailed` still runs. Aborts emit
 * `socket:chat:aborted`, never `socket:error`.
 *
 * Every collaborator of the turn body is stubbed so the test drives a single
 * attempt deterministically; `decideFallback` runs for real (pure).
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

jest.mock('@server/services/SocketService/handlers/chatPhases/finalReply', () => ({
  handleFinalReply: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('@server/services/SocketService/handlers/chatPhases/midRunMessages', () => ({
  drainToolLoopMidRunMessages: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('@server/services/SocketService/handlers/chatPhases/promptBuilder', () => ({
  buildAssistantContentBlocks: jest.fn(() => []),
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
  maxToolIterations: 1,
  shouldStreamThinking: true,
  compactionCarryForward: '',
  contextWatermark: null,
});

function errorBroadcasts(): WsCall[] {
  return (wsBroadcast.mock.calls as WsCall[]).filter(([, msg]) => msg?.type === 'socket:error');
}

beforeEach(() => {
  wsBroadcast.mockReset();
  wsSend.mockReset();
  runsCreate.mockReset().mockResolvedValue(undefined);
  runsMarkFailed.mockReset().mockResolvedValue(undefined);
  trackerFinish.mockReset();
  streamModelCallMock.mockReset();
  assembleCtxMock.mockReset().mockResolvedValue(READY_CTX());
  prepareCtxMock.mockReset().mockResolvedValue(ATTEMPT_CTX());
  persistRunErrorMock.mockReset().mockResolvedValue(null);
  dispatchToolCallsMock.mockReset().mockResolvedValue({ latestThinking: '' });
  helperTurnHeldMock.mockReset().mockResolvedValue(false);
});

describe('turnLoop — a paused or removed subagent helper', () => {
  it('drops the held turn before any context, run or model call', async () => {
    helperTurnHeldMock.mockResolvedValueOnce(true);
    const shared = makeShared();
    await runAgentTurnLoop(
      { ...makeDeps(), triggerMessageId: 'message-1111111111111-queuedaaa' } as RunAgentTurnDeps,
      shared,
      AGENT_ID
    );

    expect(helperTurnHeldMock).toHaveBeenCalledWith(AGENT_ID, 'message-1111111111111-queuedaaa');
    expect(assembleCtxMock).not.toHaveBeenCalled();
    expect(runsCreate).not.toHaveBeenCalled();
    expect(streamModelCallMock).not.toHaveBeenCalled();
    expect(shared.runningAgents.size).toBe(0);
  });
});

describe('turnLoop — a subagent helper turn that never starts a run', () => {
  const HELPER = 'subagent-11111111-1111-4111-8111-111111111111';

  beforeEach(() => resetHelperTurnFailuresForTests());

  it.each([
    ['no_model', 'it has no model configured'],
    ['agent_archived', 'its agent is archived'],
    ['agent_not_found', 'its agent record was not found'],
  ] as const)('notes why (%s) for its orchestrator, with no run', async (status, reason) => {
    assembleCtxMock.mockResolvedValueOnce({
      status,
      agentId: HELPER,
      agent: { id: HELPER, name: 'Scout' },
    });
    await runAgentTurnLoop(makeDeps(), makeShared(), HELPER);
    expect(runsCreate).not.toHaveBeenCalled();
    expect(takeHelperTurnFailure(THREAD_ID)).toBe(reason);
  });

  it('notes a crash while its context is built, and still re-throws it', async () => {
    assembleCtxMock.mockRejectedValueOnce(new Error('tool policy lookup failed'));
    await expect(runAgentTurnLoop(makeDeps(), makeShared(), HELPER)).rejects.toThrow(
      'tool policy lookup failed'
    );
    expect(takeHelperTurnFailure(THREAD_ID)).toBe('tool policy lookup failed');
  });

  it('notes nothing for an ordinary agent', async () => {
    assembleCtxMock.mockResolvedValueOnce({ status: 'no_model', agent: { id: AGENT_ID } });
    await runAgentTurnLoop(makeDeps(), makeShared(), AGENT_ID);
    expect(takeHelperTurnFailure(THREAD_ID)).toBeNull();
  });
});

describe('turnLoop — an agent with no model', () => {
  const NO_MODEL_CTX = () => ({
    status: 'no_model' as const,
    agent: { id: AGENT_ID, name: 'Ada' },
  });

  it('broadcasts one socket:error of kind no_model that says what to do', async () => {
    assembleCtxMock.mockResolvedValueOnce(NO_MODEL_CTX());
    await runAgentTurnLoop(makeDeps(), makeShared(), AGENT_ID);

    const errs = errorBroadcasts();
    expect(errs).toHaveLength(1);
    const [channel, msg] = errs[0]!;
    expect(channel).toBe(THREAD_ID);
    expect(msg.payload).toMatchObject({
      agentId: AGENT_ID,
      threadId: THREAD_ID,
      kind: 'no_model',
      message: 'Pick a provider and model for Ada to answer.',
    });
    expect(runsCreate).not.toHaveBeenCalled();
    expect(streamModelCallMock).not.toHaveBeenCalled();
  });

  it('persists the failure as a run_error row of kind no_model, with no run', async () => {
    assembleCtxMock.mockResolvedValueOnce(NO_MODEL_CTX());
    await runAgentTurnLoop(makeDeps(), makeShared(), AGENT_ID);

    expect(persistRunErrorMock).toHaveBeenCalledTimes(1);
    expect(persistRunErrorMock.mock.calls[0]![0]).toMatchObject({
      threadId: THREAD_ID,
      agentId: AGENT_ID,
      agentName: 'Ada',
      runId: null,
      kind: 'no_model',
      rawError: 'Pick a provider and model for Ada to answer.',
    });
  });
});

describe('turnLoop — run-terminating failure surfacing', () => {
  it('a rejecting streamModelCall (non-abort) broadcasts exactly one socket:error with runId+agentId and still marks the run failed', async () => {
    streamModelCallMock.mockRejectedValue(new Error('401 invalid api key'));

    await runAgentTurnLoop(makeDeps(), makeShared(), AGENT_ID);

    // Exactly one socket:error — broadcast on the thread channel, not send-to-client.
    const errs = errorBroadcasts();
    expect(errs).toHaveLength(1);
    const [channel, msg] = errs[0]!;
    expect(channel).toBe(THREAD_ID);
    expect(msg.payload.agentId).toBe(AGENT_ID);
    expect(typeof msg.payload.runId).toBe('string');
    expect(String(msg.payload.message)).toContain('401 invalid api key');

    // The failure must not have been sent as a client-only socket:error.
    const clientErrs = (wsSend.mock.calls as WsCall[]).filter(
      ([, m]) => m?.type === 'socket:error'
    );
    expect(clientErrs).toHaveLength(0);

    // Persisted state stays correct: markFailed ran once for the same run.
    expect(runsMarkFailed).toHaveBeenCalledTimes(1);
    expect(runsMarkFailed.mock.calls[0]![0]).toBe(msg.payload.runId);
  });

  it('an aborted run stays distinct — socket:chat:aborted, never socket:error', async () => {
    streamModelCallMock.mockRejectedValue(
      Object.assign(new Error('aborted by user'), { name: 'AbortError' })
    );

    await runAgentTurnLoop(makeDeps(), makeShared(), AGENT_ID);

    // No error surfaced.
    expect(errorBroadcasts()).toHaveLength(0);
    // The abort was broadcast instead.
    const aborts = (wsBroadcast.mock.calls as WsCall[]).filter(
      ([, m]) => m?.type === 'socket:chat:aborted'
    );
    expect(aborts).toHaveLength(1);
    expect(aborts[0]![1].payload.agentId).toBe(AGENT_ID);
    // Still marked failed, but with the abort reason (not an error).
    expect(runsMarkFailed).toHaveBeenCalledTimes(1);
    expect(runsMarkFailed.mock.calls[0]![1]).toBe('Aborted by user');
  });
});

describe('turnLoop — stream-idle stall retry', () => {
  const ok = () => ({
    result: { reply: 'done', toolCalls: [], stopReason: 'end_turn' },
    emittedTyping: false,
    latestThinking: '',
  });

  it('passes streamIdleTimeoutMs from deps into streamModelCall', async () => {
    streamModelCallMock.mockResolvedValueOnce(ok());
    await runAgentTurnLoop(
      { ...makeDeps(), streamIdleTimeoutMs: 300_000 } as unknown as RunAgentTurnDeps,
      makeShared(),
      AGENT_ID
    );
    const call = streamModelCallMock.mock.calls[0]![0] as { streamIdleTimeoutMs: number };
    expect(call.streamIdleTimeoutMs).toBe(300_000);
  });

  it('retries a stalled model call once (clearing the bubble) and completes', async () => {
    streamModelCallMock
      .mockRejectedValueOnce(new ProviderStreamStallError(300_000, 'openai'))
      .mockResolvedValueOnce(ok());
    await runAgentTurnLoop(makeDeps(), makeShared(), AGENT_ID);
    expect(streamModelCallMock).toHaveBeenCalledTimes(2);
    const retries = (wsBroadcast.mock.calls as WsCall[]).filter(
      ([, m]) => m?.type === 'socket:agent:stream:retry'
    );
    expect(retries).toHaveLength(1);
    expect(retries[0]![1].payload.delayMs).toBe(0);
    // (This harness caps tool iterations at 1, so the completed turn ends via
    // that path — what matters is that it was not failed by the stall.)
    for (const [, reason] of runsMarkFailed.mock.calls as [string, string][]) {
      expect(reason).not.toContain('stalled');
    }
    expect(errorBroadcasts().some(([, m]) => String(m.payload.message).includes('stalled'))).toBe(
      false
    );
  });

  it('a second stall fails the turn with a clear "Model stream stalled" notice', async () => {
    streamModelCallMock.mockRejectedValue(new ProviderStreamStallError(300_000, 'openai'));
    await runAgentTurnLoop(makeDeps(), makeShared(), AGENT_ID);
    expect(streamModelCallMock).toHaveBeenCalledTimes(2);
    expect(runsMarkFailed).toHaveBeenCalledTimes(1);
    expect(runsMarkFailed.mock.calls[0]![1]).toContain('Model stream stalled');
    const errors = (wsBroadcast.mock.calls as WsCall[]).filter(
      ([, m]) => m?.type === 'socket:error'
    );
    expect(errors).toHaveLength(1);
    expect(errors[0]![1].payload.message).toContain(
      'Model stream stalled: no output from openai for 5m'
    );
    expect(persistRunErrorMock).toHaveBeenCalledTimes(1);
    const persisted = persistRunErrorMock.mock.calls[0]![0] as { rawError: Error };
    expect(persisted.rawError).toBeInstanceOf(ProviderStreamStallError);
  });
});

describe('turnLoop — advertised tools stay fixed for the whole run', () => {
  it('does not add a tool fetched with get_tool_schema to the next model call', async () => {
    const gmailRow = {
      id: 'google_gmail',
      name: 'Google Gmail',
      description: 'Send and manage email.',
      type: 'builtin',
      parametersSchema: { type: 'object' },
    };
    prepareCtxMock.mockResolvedValue({
      ...ATTEMPT_CTX(),
      toolRows: [{ id: 'search_tools' }, { id: 'get_tool_schema' }, { id: 'action' }],
      toolMap: new Map([
        [
          'google_gmail',
          {
            agentId: AGENT_ID,
            tool: gmailRow,
            settings: {},
            requiresConfirmation: false,
          },
        ],
      ]),
      visibleToolIds: new Set(['google_gmail']),
      maxToolIterations: 4,
    });
    streamModelCallMock
      .mockResolvedValueOnce({
        result: {
          reply: '',
          toolCalls: [
            { id: 'schema-call', name: 'get_tool_schema', input: { tool: 'google_gmail' } },
          ],
          stopReason: 'tool_use',
        },
        emittedTyping: false,
        latestThinking: '',
      })
      .mockResolvedValueOnce({
        result: {
          reply: '',
          toolCalls: [
            { id: 'gateway-call', name: 'action', input: { tool: 'google_gmail', params: {} } },
          ],
          stopReason: 'tool_use',
        },
        emittedTyping: false,
        latestThinking: '',
      })
      .mockResolvedValueOnce({
        result: { reply: 'done', toolCalls: [], stopReason: 'end_turn' },
        emittedTyping: false,
        latestThinking: '',
      });

    await runAgentTurnLoop(makeDeps(), makeShared(), AGENT_ID);

    expect(streamModelCallMock).toHaveBeenCalledTimes(3);
    const advertised = streamModelCallMock.mock.calls.map(([input]) =>
      (input as { toolRows: Array<{ id: string }> }).toolRows.map((row) => row.id)
    );
    // Same tools on every request of the run, so the cached prefix stays warm.
    for (const ids of advertised) {
      expect(ids).toEqual(['search_tools', 'get_tool_schema', 'action']);
    }
  });
});

describe('turnLoop — prior-run hint wiring', () => {
  it('hands the run it just created to the attempt context, so the hint looks past it', async () => {
    // The run row exists before the context is built; without its id the
    // prior-run lookup would find this very run and never hint (seen live).
    streamModelCallMock.mockRejectedValue(new Error('401 invalid api key'));

    await runAgentTurnLoop(makeDeps(), makeShared(), AGENT_ID);

    expect(runsCreate).toHaveBeenCalledTimes(1);
    const createdId = (runsCreate.mock.calls[0]![0] as { id: string }).id;
    expect(prepareCtxMock).toHaveBeenCalledWith(
      expect.objectContaining({ currentRunId: createdId })
    );
    expect(runsCreate.mock.invocationCallOrder[0]!).toBeLessThan(
      prepareCtxMock.mock.invocationCallOrder[0]!
    );
  });
});
