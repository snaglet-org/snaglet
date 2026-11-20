/**
 * turnLoop — the interim utterance seam re-reads the roster before routing.
 *
 * Text an agent writes beside a tool call is posted, then its @-mentions are
 * routed. If an agent joined or left earlier in the run (the thread tool's
 * add_agents / remove_agents), deps.refreshRoster must have finished first,
 * so "add Nova, then @Nova ..." wakes her in the same turn. Collaborators are
 * stubbed as in turnLoop.chainScope.test.ts.
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
const persistUtteranceMock = jest.fn();
const routeSpokenMentionsMock = jest.fn();

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
    markSeedInjected: jest.fn(),
  },
}));

// The real queue and drain run; only the side channels the drain touches are
// stubbed (seed bookkeeping, subagent result visibility).
jest.mock('@server/services/subagents/resultVisibility', () => ({
  noteMessageInjected: jest.fn(),
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
  persistUtterance: (...a: unknown[]) => persistUtteranceMock(...a),
  routeSpokenMentions: (...a: unknown[]) => routeSpokenMentionsMock(...a),
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

const THREAD_ID = 'thread-roster-seam';
const LEAD = 'agent-lead';

function makeDeps(refreshRoster: () => Promise<void>): RunAgentTurnDeps {
  return {
    session: { threadId: THREAD_ID },
    sessionId: 's1',
    threadId: THREAD_ID,
    threadName: 'Pricing review',
    meta: {},
    isGroup: true,
    participantAgentIds: [LEAD, 'agent-orion'],
    activeRunIds: new Set<string>(),
    previewMessage: (s: string) => s,
    toToolText: (s: string) => s,
    triggerMessageId: undefined,
    wokenByMention: new Set<string>(),
    startAgent: () => {},
    HARD_DISPATCH_CEILING: 10,
    dispatchSet: new Set<string>([LEAD]),
    abortController: new AbortController(),
    agentNameMap: new Map<string, string>([[LEAD, 'Lead']]),
    effectiveParallelDispatch: true,
    dispatchMode: 'mentioned',
    threadRuntimeConfig: null,
    softDispatchThreshold: 5,
    hardDispatchCeiling: 10,
    agentTimeoutMs: 120000,
    refreshRoster,
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

const readyCtx = () => ({
  status: 'ready' as const,
  agent: { id: LEAD, name: 'Lead', systemPrompt: '', disableModelFallback: false },
  agentTools: [],
  toolAccess: { mode: 'all', allowList: [], denyList: [] },
  modelCandidates: [
    { provider_id: 'openai', model_id: 'gpt-x', credential_id: 'c1', source: 'agent_default' },
  ],
  runtimeAgentTemplate: {
    id: LEAD,
    name: 'Lead',
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

const attemptCtx = () => ({
  toolRows: [],
  toolMap: new Map(),
  visibleToolIds: new Set<string>(),
  budget: { maxOutputTokens: 128, cacheTtl: '1h' },
  agentMessages: [],
  threadSummaryText: null,
  maxToolIterations: 3,
  shouldStreamThinking: false,
  compactionCarryForward: '',
  contextWatermark: null,
});

/** One model call that speaks and calls a tool, then a final reply. */
function speakThenFinish(text: string) {
  let n = 0;
  streamModelCallMock.mockReset().mockImplementation(async () => {
    n += 1;
    return n === 1
      ? {
          result: {
            reply: text,
            toolCalls: [{ id: 'call-1', name: 'noop', input: {} }],
            stopReason: 'tool_use',
            usage: { inputTokens: 10, outputTokens: 1 },
          },
          emittedTyping: false,
          latestThinking: '',
        }
      : {
          result: {
            reply: 'Done.',
            toolCalls: [],
            stopReason: 'end_turn',
            usage: { inputTokens: 10, outputTokens: 1 },
          },
          emittedTyping: false,
          latestThinking: '',
        };
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  runsCreate.mockResolvedValue(undefined);
  runsMarkFailed.mockResolvedValue(undefined);
  persistRunErrorMock.mockResolvedValue(null);
  helperTurnHeldMock.mockResolvedValue(false);
  assembleCtxMock.mockImplementation(async () => readyCtx());
  prepareCtxMock.mockImplementation(async () => attemptCtx());
  dispatchToolCallsMock.mockResolvedValue({ latestThinking: '' });
});

describe('turnLoop — interim utterance seam', () => {
  it('awaits the roster refresh before routing the utterance’s mentions', async () => {
    let refreshed = false;
    const refreshRoster = jest.fn(async () => {
      await Promise.resolve();
      refreshed = true;
    });
    let refreshedWhenRouted: boolean | null = null;
    routeSpokenMentionsMock.mockImplementation(() => {
      refreshedWhenRouted = refreshed;
    });
    persistUtteranceMock.mockResolvedValue('message-1');
    speakThenFinish('@Nova what is your take on the pricing?');

    await runAgentTurnLoop(makeDeps(refreshRoster), makeShared(), LEAD);

    expect(routeSpokenMentionsMock).toHaveBeenCalledTimes(1);
    expect(routeSpokenMentionsMock.mock.calls[0]![0]).toMatchObject({
      content: '@Nova what is your take on the pricing?',
    });
    expect(refreshedWhenRouted).toBe(true);
  });

  it('routes nothing (and reads nothing) when the speaker was removed and its text dropped', async () => {
    const refreshRoster = jest.fn(async () => {});
    persistUtteranceMock.mockResolvedValue(null);
    speakThenFinish('@Nova one more thing.');

    await runAgentTurnLoop(makeDeps(refreshRoster), makeShared(), LEAD);

    expect(routeSpokenMentionsMock).not.toHaveBeenCalled();
    expect(refreshRoster).not.toHaveBeenCalled();
  });
});
