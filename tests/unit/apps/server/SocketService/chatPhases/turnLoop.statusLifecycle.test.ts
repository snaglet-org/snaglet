/**
 * turnLoop — the agent's status bubble over a turn's whole life. It shows from
 * the moment the turn starts (context assembly runs before the run registers)
 * and goes idle on every exit: a turn that ends before its run registers sends
 * its own idle; a registered run's exits send theirs, even when recording the
 * failed run throws, and unregister the run first. A superseded turn leaves the
 * status to the newer turn.
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
// Status frames, run unregisters and failed-run writes, in the order they happen.
const events: string[] = [];

jest.mock('@server/services/WebSocketService', () => ({
  wsService: {
    broadcastToChannel: (...a: unknown[]) => wsBroadcast(...a),
    sendToClient: (...a: unknown[]) => wsSend(...a),
  },
}));

jest.mock('@snaglet/db/tables/runs', () => ({
  Runs: {
    create: (...a: unknown[]) => runsCreate(...a),
    markFailed: (...a: unknown[]) => {
      events.push('markFailed');
      return runsMarkFailed(...a);
    },
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
    finish: (...a: unknown[]) => {
      events.push('finish');
      return trackerFinish(...a);
    },
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
  emitAgentStatus: (
    _client: string,
    _session: string,
    agentId: string,
    status: string,
    ctx?: { beforeRun?: boolean }
  ) => events.push(`${agentId}:${status}${ctx?.beforeRun ? ' (before run)' : ''}`),
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
import type {
  RunAgentTurnDeps,
  RunAgentTurnSharedState,
} from '@server/services/SocketService/handlers/chatPhases/types';

const THREAD_ID = 'thread-1';
const AGENT_ID = 'agent-1';

function makeDeps(over: Record<string, unknown> = {}): RunAgentTurnDeps {
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
    ...over,
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
  agent: { id: AGENT_ID, name: 'Ada', systemPrompt: '', disableModelFallback: true },
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
    disableModelFallback: true,
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

const STARTED = `${AGENT_ID}:thinking (before run)`;
const IDLE = `${AGENT_ID}:idle`;
const abortError = () => Object.assign(new Error('aborted'), { name: 'AbortError' });

beforeEach(() => {
  events.length = 0;
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

describe('turnLoop — a turn that ends before its run registers', () => {
  it.each(['agent_not_found', 'agent_archived', 'no_model'] as const)(
    'shows thinking from the start, then idle (%s)',
    async (status) => {
      assembleCtxMock.mockResolvedValueOnce({ status, agent: { id: AGENT_ID, name: 'Ada' } });

      await runAgentTurnLoop(makeDeps(), makeShared(), AGENT_ID);

      expect(events).toEqual([STARTED, IDLE]);
      expect(runsCreate).not.toHaveBeenCalled();
    }
  );

  it('goes idle when context assembly throws', async () => {
    assembleCtxMock.mockRejectedValueOnce(new Error('memory recall failed'));

    await expect(runAgentTurnLoop(makeDeps(), makeShared(), AGENT_ID)).rejects.toThrow(
      'memory recall failed'
    );

    expect(events).toEqual([STARTED, IDLE]);
  });

  it('goes idle when the turn is aborted during context assembly', async () => {
    assembleCtxMock.mockRejectedValueOnce(abortError());

    await expect(runAgentTurnLoop(makeDeps(), makeShared(), AGENT_ID)).rejects.toThrow('aborted');

    expect(events).toEqual([STARTED, IDLE]);
  });

  it('shows nothing for a turn aborted before it starts', async () => {
    const abortController = new AbortController();
    abortController.abort();

    await runAgentTurnLoop(makeDeps({ abortController }), makeShared(), AGENT_ID, abortController);

    expect(events.filter((e) => e !== IDLE)).toEqual([]);
    expect(assembleCtxMock).not.toHaveBeenCalled();
  });

  it('leaves the status to a newer turn when this one is superseded', async () => {
    assembleCtxMock.mockResolvedValueOnce({
      status: 'agent_not_found',
      agent: { id: AGENT_ID, name: 'Ada' },
    });

    await runAgentTurnLoop(makeDeps({ isTurnSuperseded: () => true }), makeShared(), AGENT_ID);

    expect(events).toEqual([STARTED]);
  });
});

describe('turnLoop — a turn whose run registered', () => {
  it('leaves the end of a completed run to the final reply', async () => {
    prepareCtxMock.mockResolvedValueOnce({ ...ATTEMPT_CTX(), maxToolIterations: 5 });
    streamModelCallMock.mockResolvedValueOnce({
      result: { reply: 'done', toolCalls: [], stopReason: 'end_turn' },
      emittedTyping: false,
      latestThinking: '',
    });

    await runAgentTurnLoop(makeDeps(), makeShared(), AGENT_ID);

    // handleFinalReply (stubbed here) sends the idle, then any queued status.
    expect(events).toEqual([STARTED, `${AGENT_ID}:thinking`]);
  });

  it.each([
    ['fails', () => new Error('401 invalid api key')],
    ['is aborted', abortError],
  ])('unregisters it and goes idle when it %s', async (_label, error) => {
    streamModelCallMock.mockRejectedValueOnce(error());

    await runAgentTurnLoop(makeDeps(), makeShared(), AGENT_ID);

    expect(events).toEqual([STARTED, `${AGENT_ID}:thinking`, 'markFailed', 'finish', IDLE]);
  });

  it.each([
    ['fails', () => new Error('401 invalid api key')],
    ['is aborted', abortError],
  ])(
    'still unregisters it and goes idle when it %s and recording that throws',
    async (_label, error) => {
      streamModelCallMock.mockRejectedValueOnce(error());
      runsMarkFailed.mockRejectedValueOnce(new Error('database unavailable'));

      await expect(runAgentTurnLoop(makeDeps(), makeShared(), AGENT_ID)).rejects.toThrow(
        'database unavailable'
      );

      expect(trackerFinish).toHaveBeenCalledTimes(1);
      expect(events).toEqual([STARTED, `${AGENT_ID}:thinking`, 'markFailed', 'finish', IDLE]);
    }
  );
});
