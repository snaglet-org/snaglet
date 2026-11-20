/**
 * The seams where a run resolves @-mentions re-read the roster first when an
 * agent joined or left during the run (deps.refreshRoster, liveRoster.ts):
 *
 * - the final reply (handleFinalReply): the refresh is awaited before the
 *   reply's mentions are routed, and a speaker that left wakes nobody;
 * - a person's mid-run message (drainToolLoopMidRunMessages): a mention of an
 *   agent added during the run wakes it, through the real mention router;
 * - a one-agent thread whose running agent just left: the person's message
 *   goes to the agent still there (mid-run and at the final reply).
 *
 * The interim utterance seam is in turnLoop.rosterRefresh.test.ts, and the
 * whole loop in dispatch/dispatchToThread.liveRoster.test.ts.
 */

const persistUtteranceMock = jest.fn();
const routeSpokenMentionsMock = jest.fn();
const drainMessagesMock = jest.fn();

jest.mock('onnxruntime-node', () => ({
  InferenceSession: { create: jest.fn() },
  Tensor: class MockTensor {},
}));
jest.mock('@snaglet/db/tables/messages', () => ({ Messages: { create: jest.fn() } }));
jest.mock('@snaglet/db/tables/runs', () => ({
  Runs: { markCompleted: jest.fn().mockResolvedValue(undefined) },
}));
jest.mock('@snaglet/db/tables/threads', () => ({ Threads: {} }));
jest.mock('@snaglet/db/tables/users', () => ({
  Users: {
    getOrCreateLocalUser: jest.fn().mockResolvedValue({ id: 'user-1' }),
    findById: jest.fn().mockResolvedValue({ id: 'user-1', name: 'Robin' }),
  },
}));
jest.mock('@server/services/ActiveRunTracker', () => ({
  activeRunTracker: {
    finish: jest.fn(),
    drainMessages: (...a: unknown[]) => drainMessagesMock(...a),
    reserveHandoff: jest.fn(),
  },
}));
jest.mock('@server/services/HookService', () => ({ hooks: { emit: jest.fn() } }));
jest.mock('@server/services/EmbeddingService', () => ({
  syncMessageEmbedding: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('@server/services/SummaryService', () => ({
  summaryService: { generateSummary: jest.fn().mockResolvedValue({ status: 'not-due' }) },
}));
jest.mock('@server/services/summary/summaryHalt', () => ({ haltOnSummaryFailure: jest.fn() }));
jest.mock('@server/services/summary/scheduleCompactionMemoryExtraction', () => ({
  scheduleCompactionMemoryExtraction: jest.fn(),
}));
jest.mock('@server/services/SocketService/outboundMessageLinter', () => ({
  lintWorkspaceReferencesInMessage: jest.fn().mockResolvedValue({ issues: [] }),
}));
jest.mock('@server/services/WebSocketService', () => ({
  wsService: { broadcastToChannel: jest.fn(), sendToClient: jest.fn() },
}));
jest.mock('@server/services/SocketService/handlers/chatHelpers', () => ({
  emitAgentStatus: jest.fn(),
  emitAgentTyping: jest.fn(),
  resolveMessageType: () => 'message',
  stripThinkingTags: (s: string) => ({ reply: s ?? '', thinking: '' }),
}));
jest.mock('@server/services/LogsService', () => ({
  LogsService: {
    socket: { event: jest.fn(), error: jest.fn() },
    user: { message: jest.fn() },
    warn: jest.fn(),
  },
}));
jest.mock('@server/services/SocketService/handlers/chatPhases/detectStagnation', () => ({
  STAGNATION_POLICY: { window: 3, strikesToPass: 2, embeddingThreshold: 0.9 },
  checkReplyStagnation: jest.fn(),
}));
jest.mock('@server/services/settings', () => ({ settingsService: { read: jest.fn() } }));
jest.mock('@server/services/settings/categories/dispatch', () => ({
  dispatchSettings: { stagnationSimilarity: {} },
}));
jest.mock('@server/services/SocketService/handlers/chatPhases/utteranceMessages', () => ({
  persistUtterance: (...a: unknown[]) => persistUtteranceMock(...a),
  routeSpokenMentions: (...a: unknown[]) => routeSpokenMentionsMock(...a),
}));

import { pendingAgentMessages } from '@server/services/PendingAgentMessageService';
import { handleFinalReply } from '@server/services/SocketService/handlers/chatPhases/finalReply';
import { drainToolLoopMidRunMessages } from '@server/services/SocketService/handlers/chatPhases/midRunMessages';
import type {
  RunAgentTurnDeps,
  RunAgentTurnSharedState,
} from '@server/services/SocketService/handlers/chatPhases/types';

const LEAD = { id: 'agent-lead', name: 'Lead', modelId: 'm' };
const NOVA = 'agent-nova';
const ORION = 'agent-orion';

/**
 * A roster that becomes `after` when refreshed, the way liveRoster does after
 * a change. Defaults: Lead and Orion, then Nova joins.
 */
function rosterDeps(
  over: Record<string, unknown> = {},
  start: string[] = [LEAD.id, ORION],
  after: string[] = [LEAD.id, ORION, NOVA]
) {
  const ids = [...start];
  const names = new Map([
    [LEAD.id, 'Lead'],
    [ORION, 'Orion'],
    [NOVA, 'Nova'],
  ]);
  let refreshed = false;
  const refreshRoster = jest.fn(async () => {
    await Promise.resolve();
    ids.splice(0, ids.length, ...after);
    refreshed = true;
  });
  const deps = {
    session: { threadId: 'thread-1' },
    sessionId: 'session-1',
    threadName: 'Pricing review',
    meta: { clientId: 'client-1' },
    get isGroup() {
      return ids.length > 1;
    },
    dispatchMode: 'mentioned',
    participantAgentIds: ids,
    agentNameMap: names,
    agentRoleMap: new Map(),
    resolveParticipantId: (id: string) => ids.find((p) => p.toLowerCase() === id.toLowerCase()),
    isParticipantMention: (id: string) => ids.some((p) => p.toLowerCase() === id.toLowerCase()),
    refreshRoster,
    previewMessage: (v: string) => v,
    wokenByMention: new Set<string>(),
    dispatchSet: new Set<string>([LEAD.id]),
    startAgent: jest.fn(),
    effectiveParallelDispatch: true,
    HARD_DISPATCH_CEILING: 10,
    softDispatchThreshold: 5,
    convBudget: { recordAgentTurn: jest.fn() },
    wsService: { broadcastToChannel: jest.fn(), sendToClient: jest.fn() },
    ...over,
  } as unknown as RunAgentTurnDeps;
  return { deps, refreshRoster, wasRefreshed: () => refreshed };
}

function makeShared(running: string[] = [LEAD.id]): RunAgentTurnSharedState {
  return {
    runningAgents: new Set<string>(running),
    agentDispatchCount: new Map<string, number>(),
    agentSoftThresholdNotified: new Set<string>(),
    recentRepliesByAgent: new Map<string, string[]>(),
    passedAgents: new Set<string>(),
    passKinds: new Map(),
    stagnationStrikes: new Map<string, number>(),
    currentWaveResults: [],
    conversationRound: 0,
  } as unknown as RunAgentTurnSharedState;
}

function finalReplyInput(
  deps: RunAgentTurnDeps,
  shared: RunAgentTurnSharedState,
  speaker: { id: string; name: string; modelId: string },
  reply: string
) {
  return {
    deps,
    shared,
    replyAgentId: speaker.id,
    agent: speaker,
    runtimeAgent: speaker,
    agentMessages: [],
    result: { reply },
    runId: 'run-1',
    budget: { contextWindowTokens: 1000 },
    startedAt: Date.now(),
    totalInputTokens: 1,
    totalOutputTokens: 1,
    runTokens: {
      billedInputTokens: 1,
      outputTokens: 1,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      providerCalls: 1,
    },
    iterations: 1,
    fanOutAllModeMidRunMessage: jest.fn(),
  } as unknown as Parameters<typeof handleFinalReply>[0];
}

const NOVA_SPEAKER = { id: NOVA, name: 'Nova', modelId: 'm' };

beforeEach(() => {
  jest.clearAllMocks();
  pendingAgentMessages.resetForTests();
  drainMessagesMock.mockReturnValue([]);
  persistUtteranceMock.mockResolvedValue('message-1');
});

describe('final reply seam', () => {
  it('awaits the roster refresh before routing the reply’s mentions', async () => {
    const { deps, refreshRoster, wasRefreshed } = rosterDeps();
    let refreshedWhenRouted: boolean | null = null;
    routeSpokenMentionsMock.mockImplementation(() => {
      refreshedWhenRouted = wasRefreshed();
    });

    await handleFinalReply({
      deps,
      shared: makeShared(),
      replyAgentId: LEAD.id,
      agent: LEAD,
      runtimeAgent: LEAD,
      agentMessages: [],
      result: { reply: '@Nova what is your take on the pricing?' },
      runId: 'run-1',
      budget: { contextWindowTokens: 1000 },
      startedAt: Date.now(),
      totalInputTokens: 1,
      totalOutputTokens: 1,
      runTokens: {
        billedInputTokens: 1,
        outputTokens: 1,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        providerCalls: 1,
      },
      iterations: 1,
      fanOutAllModeMidRunMessage: jest.fn(),
    } as unknown as Parameters<typeof handleFinalReply>[0]);

    expect(refreshRoster).toHaveBeenCalled();
    expect(routeSpokenMentionsMock).toHaveBeenCalledTimes(1);
    expect(refreshedWhenRouted).toBe(true);
  });

  it.each(['mentioned', 'all'])(
    'a speaker that left during its run wakes nobody with its reply (%s mode)',
    async (dispatchMode) => {
      // Nova was in the room and left (thread op leave) during this run.
      const { deps } = rosterDeps({ dispatchMode }, [LEAD.id, ORION, NOVA], [LEAD.id, ORION]);
      const shared = makeShared([NOVA]);
      const input = finalReplyInput(deps, shared, NOVA_SPEAKER, '@Lead over to you. Leaving.');

      await handleFinalReply(input);

      expect(routeSpokenMentionsMock).not.toHaveBeenCalled();
      expect(input.fanOutAllModeMidRunMessage).not.toHaveBeenCalled();
      expect(deps.startAgent).not.toHaveBeenCalled();
      expect(deps.wokenByMention.size).toBe(0);
    }
  );
});

describe('a one-agent thread whose running agent just left', () => {
  it('mid-run: the person’s message wakes the agent still there, not the leaver', async () => {
    const { deps } = rosterDeps({}, [LEAD.id, NOVA], [LEAD.id]);
    const shared = makeShared([NOVA]);
    shared.passedAgents.add(LEAD.id);
    drainMessagesMock.mockReturnValue([
      { id: 'msg-3', content: 'Thanks, what is next?', persisted: true },
    ]);

    await drainToolLoopMidRunMessages({
      deps,
      shared,
      replyAgentId: NOVA,
      agent: NOVA_SPEAKER as never,
      runtimeAgent: NOVA_SPEAKER as never,
      agentMessages: [],
      fanOutAllModeMidRunMessage: jest.fn(),
    });

    expect(deps.dispatchSet.has(LEAD.id)).toBe(true);
    expect(deps.wokenByMention.has(LEAD.id)).toBe(true);
    expect(shared.passedAgents.has(LEAD.id)).toBe(false);
    expect(deps.startAgent).toHaveBeenCalledWith(LEAD.id);
    expect(pendingAgentMessages.hasUnread('thread-1', NOVA)).toBe(false);
  });

  it('mid-run: when the agent still there is running, the message is queued for it', async () => {
    const { deps } = rosterDeps({}, [LEAD.id, NOVA], [LEAD.id]);
    drainMessagesMock.mockReturnValue([
      { id: 'msg-4', content: 'Thanks, what is next?', persisted: true },
    ]);

    await drainToolLoopMidRunMessages({
      deps,
      shared: makeShared([NOVA, LEAD.id]),
      replyAgentId: NOVA,
      agent: NOVA_SPEAKER as never,
      runtimeAgent: NOVA_SPEAKER as never,
      agentMessages: [],
      fanOutAllModeMidRunMessage: jest.fn(),
    });

    expect(pendingAgentMessages.listUnread('thread-1', LEAD.id).map((m) => m.content)).toEqual([
      'Thanks, what is next?',
    ]);
    expect(pendingAgentMessages.hasUnread('thread-1', NOVA)).toBe(false);
    expect(deps.startAgent).not.toHaveBeenCalled();
  });

  it('at the final reply: the message waiting for the leaver wakes the agent still there', async () => {
    const { deps } = rosterDeps({}, [LEAD.id, NOVA], [LEAD.id]);
    const shared = makeShared([NOVA]);
    drainMessagesMock.mockReturnValue([
      { id: 'msg-5', content: 'One more thing.', persisted: true },
    ]);

    await handleFinalReply(finalReplyInput(deps, shared, NOVA_SPEAKER, 'Done here.'));

    expect(deps.wokenByMention.has(LEAD.id)).toBe(true);
    expect(deps.wokenByMention.has(NOVA)).toBe(false);
    expect(deps.dispatchSet.has(LEAD.id)).toBe(true);
  });

  it('while the agent is still in the thread, the message goes to it as before', async () => {
    const { deps } = rosterDeps({}, [NOVA], [NOVA]);
    drainMessagesMock.mockReturnValue([
      { id: 'msg-6', content: 'Also check the trial.', persisted: true },
    ]);

    await drainToolLoopMidRunMessages({
      deps,
      shared: makeShared([NOVA]),
      replyAgentId: NOVA,
      agent: NOVA_SPEAKER as never,
      runtimeAgent: NOVA_SPEAKER as never,
      agentMessages: [],
      fanOutAllModeMidRunMessage: jest.fn(),
    });

    expect(pendingAgentMessages.hasUnread('thread-1', NOVA)).toBe(true);
    expect(deps.startAgent).not.toHaveBeenCalled();
  });
});

describe('mid-run message seam', () => {
  it('a person’s mid-run mention of an agent added during the run wakes it', async () => {
    const { deps, refreshRoster } = rosterDeps();
    drainMessagesMock.mockReturnValue([
      { id: 'msg-2', content: '@Nova can you double-check?', persisted: true },
    ]);

    await drainToolLoopMidRunMessages({
      deps,
      shared: makeShared(),
      replyAgentId: LEAD.id,
      agent: LEAD as never,
      runtimeAgent: LEAD as never,
      agentMessages: [],
      fanOutAllModeMidRunMessage: jest.fn(),
    });

    expect(refreshRoster).toHaveBeenCalledTimes(1);
    expect(deps.dispatchSet.has(NOVA)).toBe(true);
    expect(deps.startAgent).toHaveBeenCalledWith(NOVA);
  });

  it('does not re-read the roster when no message is waiting', async () => {
    const { deps, refreshRoster } = rosterDeps();
    await drainToolLoopMidRunMessages({
      deps,
      shared: makeShared(),
      replyAgentId: LEAD.id,
      agent: LEAD as never,
      runtimeAgent: LEAD as never,
      agentMessages: [],
      fanOutAllModeMidRunMessage: jest.fn(),
    });
    expect(refreshRoster).not.toHaveBeenCalled();
  });
});
