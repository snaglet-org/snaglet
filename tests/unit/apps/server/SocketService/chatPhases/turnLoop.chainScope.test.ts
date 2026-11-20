/**
 * turnLoop — a raised hook chain depth stays in its own run.
 *
 * Two agents run in one wave, concurrently, under one bound chain context.
 * One drains a hook-stamped injected message mid-run (the real
 * drainInjectablePeerMessages and pending-message queue), so its ambient chain
 * depth rises. The sibling run, and the wave's own context, must
 * stay at the depth the wave started at. Pins `runInOwnChainScope` in
 * runAgentTurnLoop: without it both runs share the wave's store and the raise
 * leaks into the sibling.
 *
 * Collaborators of the turn body are stubbed as in turnLoop.error.test.ts.
 */

// — Assertable handles (referenced inside jest.mock factories via wrappers) —
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
import { drainInjectablePeerMessages } from '@server/services/SocketService/handlers/chatPhases/peerInjection';
import { pendingAgentMessages } from '@server/services/PendingAgentMessageService';
import { currentChainDepth, currentHookChain, runAtChainDepth } from '@server/realtime/runContext';
import type {
  RunAgentTurnDeps,
  RunAgentTurnSharedState,
} from '@server/services/SocketService/handlers/chatPhases/types';

const THREAD_ID = 'thread-chain-scope';
const HOOKED = 'agent-hooked';
const SIBLING = 'agent-sibling';
const WAVE_DEPTH = 1;
const HOOK_DEPTH = 4;

type Seen = { afterDrain: number; hooks: readonly string[]; atBarrier: number };

function makeDeps(): RunAgentTurnDeps {
  return {
    session: { threadId: THREAD_ID },
    sessionId: 's1',
    threadId: THREAD_ID,
    threadName: 'T',
    meta: {},
    isGroup: true,
    participantAgentIds: [HOOKED, SIBLING],
    activeRunIds: new Set<string>(),
    previewMessage: (s: string) => s,
    toToolText: (s: string) => s,
    triggerMessageId: undefined,
    wokenByMention: false,
    startAgent: () => {},
    HARD_DISPATCH_CEILING: 10,
    dispatchSet: new Set<string>([HOOKED, SIBLING]),
    abortController: new AbortController(),
    agentNameMap: new Map<string, string>([
      [HOOKED, 'Hooked'],
      [SIBLING, 'Sibling'],
    ]),
    effectiveParallelDispatch: true,
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

const readyCtx = (id: string) => ({
  status: 'ready' as const,
  agent: { id, name: id, systemPrompt: '', disableModelFallback: false },
  agentTools: [],
  toolAccess: { mode: 'all', allowList: [], denyList: [] },
  modelCandidates: [
    { provider_id: 'openai', model_id: 'gpt-x', credential_id: 'c1', source: 'agent_default' },
  ],
  runtimeAgentTemplate: {
    id,
    name: id,
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
  maxToolIterations: 3,
  shouldStreamThinking: false,
  compactionCarryForward: '',
  contextWatermark: null,
});

const toolTurn = (id: string) => ({
  result: {
    reply: '',
    toolCalls: [{ id: `call-${id}`, name: 'noop', input: {} }],
    stopReason: 'tool_use',
    usage: { inputTokens: 10, outputTokens: 1 },
  },
  emittedTyping: false,
  latestThinking: '',
});

const finalTurn = () => ({
  result: {
    reply: 'Done.',
    toolCalls: [],
    stopReason: 'end_turn',
    usage: { inputTokens: 10, outputTokens: 1 },
  },
  emittedTyping: false,
  latestThinking: '',
});

let seen: Map<string, Seen>;

beforeEach(() => {
  pendingAgentMessages.resetForTests();
  seen = new Map();
  wsBroadcast.mockReset();
  wsSend.mockReset();
  runsCreate.mockReset().mockResolvedValue(undefined);
  runsMarkFailed.mockReset().mockResolvedValue(undefined);
  trackerFinish.mockReset();
  persistRunErrorMock.mockReset().mockResolvedValue(null);
  helperTurnHeldMock.mockReset().mockResolvedValue(false);
  assembleCtxMock
    .mockReset()
    .mockImplementation(async (a: { replyAgentId: string }) => readyCtx(a.replyAgentId));
  prepareCtxMock.mockReset().mockImplementation(async () => ATTEMPT_CTX());

  // One tool round per agent, then a final reply.
  const calls = new Map<string, number>();
  streamModelCallMock.mockReset().mockImplementation(async (a: { agent: { id: string } }) => {
    const n = (calls.get(a.agent.id) ?? 0) + 1;
    calls.set(a.agent.id, n);
    return n === 1 ? toolTurn(a.agent.id) : finalTurn();
  });

  // The tool seam, as toolDispatch runs it: drain this agent's queue (the real
  // drain, which raises the ambient chain), then wait until both runs reached
  // their seam, so they overlap, and read the depth each run then sees.
  let arrived = 0;
  let release!: () => void;
  const barrier = new Promise<void>((resolve) => (release = resolve));
  dispatchToolCallsMock.mockReset().mockImplementation(async (input: { agent: { id: string } }) => {
    const id = input.agent.id;
    drainInjectablePeerMessages({ threadId: THREAD_ID, agentId: id, mode: 'all' });
    const afterDrain = currentChainDepth();
    const hooks = currentHookChain();
    arrived += 1;
    if (arrived === 2) release();
    await barrier;
    seen.set(id, { afterDrain, hooks, atBarrier: currentChainDepth() });
    return { latestThinking: '' };
  });
});

describe('turnLoop — a raised hook chain depth stays in its own run', () => {
  it('raises the run that drained a hook-stamped message, not its wave sibling', async () => {
    pendingAgentMessages.enqueue({
      threadId: THREAD_ID,
      targetAgentId: HOOKED,
      senderAgentId: 'ghost',
      senderName: 'system',
      content: 'loop-dispatch says hi',
      reason: 'mentioned',
      chain: { depth: HOOK_DEPTH, hooks: ['loop-dispatch'] },
    });

    const deps = makeDeps();
    const shared = makeShared();
    let waveAfter = -1;
    await runAtChainDepth(WAVE_DEPTH, async () => {
      await Promise.all([
        runAgentTurnLoop(deps, shared, HOOKED),
        runAgentTurnLoop(deps, shared, SIBLING),
      ]);
      waveAfter = currentChainDepth();
    });

    const hooked = seen.get(HOOKED)!;
    const sibling = seen.get(SIBLING)!;
    // Both runs reached the tool seam (the harness really ran two turns).
    expect(hooked).toBeDefined();
    expect(sibling).toBeDefined();
    // The run that acted on the hook message took on its depth and chain…
    expect(hooked.afterDrain).toBe(HOOK_DEPTH);
    expect(hooked.atBarrier).toBe(HOOK_DEPTH);
    expect(hooked.hooks).toEqual(['loop-dispatch']);
    // …while its sibling, running at the same moment, kept the wave's depth.
    expect(sibling.afterDrain).toBe(WAVE_DEPTH);
    expect(sibling.atBarrier).toBe(WAVE_DEPTH);
    expect(sibling.hooks).toEqual([]);
    // And the wave's own context is unchanged after both runs end.
    expect(waveAfter).toBe(WAVE_DEPTH);
  });
});
