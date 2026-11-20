/**
 * The terminal drain (handleFinalReply): a person's message that arrived during
 * the run's final model call re-wakes the agent for the next wave. The agent is
 * announced `queued` after its run's idle and done, so its bubble reads queued
 * until the next turn starts; nothing is announced when no re-wake happens. A
 * message persisted on receipt was already broadcast then, so the drain does
 * not broadcast it again.
 */

const drainMessagesMock = jest.fn();
const events: string[] = [];

jest.mock('onnxruntime-node', () => ({
  InferenceSession: { create: jest.fn() },
  Tensor: class MockTensor {},
}));
jest.mock('@snaglet/db/tables/messages', () => ({
  Messages: { create: jest.fn().mockResolvedValue(undefined) },
}));
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
jest.mock('@server/services/SocketService/outboundMessageLinter', () => ({
  lintWorkspaceReferencesInMessage: jest.fn().mockResolvedValue({ issues: [] }),
}));
jest.mock('@server/services/WebSocketService', () => ({
  wsService: {
    broadcastToChannel: (_channel: string, frame: { type: string; payload: { id?: string } }) =>
      events.push(
        frame.type === 'socket:chat:message_created'
          ? `message_created:${frame.payload.id}`
          : frame.type
      ),
    sendToClient: jest.fn(),
  },
}));
jest.mock('@server/services/SocketService/handlers/chatHelpers', () => ({
  emitAgentStatus: (_client: string, _session: string, agentId: string, status: string) =>
    events.push(`status:${agentId}:${status}`),
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
  checkReplyStagnation: jest.fn().mockResolvedValue({ similar: false }),
}));
jest.mock('@server/services/settings', () => ({ settingsService: { read: jest.fn() } }));
jest.mock('@server/services/settings/categories/dispatch', () => ({
  dispatchSettings: { stagnationSimilarity: {} },
}));
jest.mock('@server/services/SocketService/handlers/chatPhases/utteranceMessages', () => ({
  persistUtterance: jest.fn().mockResolvedValue('message-reply'),
  routeSpokenMentions: jest.fn(),
}));

import { pendingAgentMessages } from '@server/services/PendingAgentMessageService';
import { handleFinalReply } from '@server/services/SocketService/handlers/chatPhases/finalReply';
import type {
  RunAgentTurnDeps,
  RunAgentTurnSharedState,
} from '@server/services/SocketService/handlers/chatPhases/types';

const LEAD = { id: 'agent-lead', name: 'Lead', modelId: 'm' };
const ORION = 'agent-orion';

function makeDeps(participants: string[], dispatchMode: 'all' | 'mentioned') {
  return {
    session: { threadId: 'thread-1' },
    sessionId: 'session-1',
    threadName: 'Pricing review',
    meta: { clientId: 'client-1' },
    isGroup: participants.length > 1,
    dispatchMode,
    participantAgentIds: participants,
    agentNameMap: new Map([
      [LEAD.id, 'Lead'],
      [ORION, 'Orion'],
    ]),
    agentRoleMap: new Map(),
    resolveParticipantId: (id: string) => participants.find((p) => p === id),
    isParticipantMention: (id: string) => participants.includes(id),
    refreshRoster: jest.fn().mockResolvedValue(undefined),
    previewMessage: (v: string) => v,
    wokenByMention: new Set<string>(),
    dispatchSet: new Set<string>(participants),
    startAgent: jest.fn(),
    effectiveParallelDispatch: true,
    HARD_DISPATCH_CEILING: 10,
    softDispatchThreshold: 5,
    convBudget: { recordAgentTurn: jest.fn() },
    wsService: { broadcastToChannel: jest.fn(), sendToClient: jest.fn() },
  } as unknown as RunAgentTurnDeps;
}

function makeShared(conversationRound = 0): RunAgentTurnSharedState {
  return {
    runningAgents: new Set<string>([LEAD.id]),
    agentDispatchCount: new Map<string, number>(),
    agentSoftThresholdNotified: new Set<string>(),
    recentRepliesByAgent: new Map<string, string[]>(),
    passedAgents: new Set<string>(),
    passKinds: new Map(),
    stagnationStrikes: new Map<string, number>(),
    currentWaveResults: [],
    conversationRound,
  } as unknown as RunAgentTurnSharedState;
}

async function finalReply(
  deps: RunAgentTurnDeps,
  reply = 'Here is the plan.',
  shared = makeShared()
): Promise<void> {
  await handleFinalReply({
    deps,
    shared,
    replyAgentId: LEAD.id,
    agent: LEAD,
    runtimeAgent: LEAD,
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
  } as unknown as Parameters<typeof handleFinalReply>[0]);
}

const parked = (id: string, persisted = true) => ({ id, content: 'and one more thing', persisted });

beforeEach(() => {
  jest.clearAllMocks();
  pendingAgentMessages.resetForTests();
  events.length = 0;
  drainMessagesMock.mockReturnValue([]);
});

describe('the terminal drain announces the re-woken agent as queued', () => {
  it.each([
    ['a one-agent thread', [LEAD.id], 'all'],
    ['a mentioned-mode group', [LEAD.id, ORION], 'mentioned'],
    ['an all-mode group', [LEAD.id, ORION], 'all'],
  ] as const)('in %s, after its run’s idle and done', async (_label, participants, mode) => {
    drainMessagesMock.mockReturnValueOnce([parked('message-2')]);
    const deps = makeDeps([...participants], mode);

    await finalReply(deps);

    expect(deps.wokenByMention.has(LEAD.id)).toBe(true);
    const statuses = events.filter((e) => e.startsWith('status:') || e === 'socket:done');
    expect(statuses).toEqual([`status:${LEAD.id}:idle`, 'socket:done', `status:${LEAD.id}:queued`]);
  });

  it('announces nothing when no message arrived during the run', async () => {
    await finalReply(makeDeps([LEAD.id], 'all'));

    expect(events).not.toContain(`status:${LEAD.id}:queued`);
  });

  it('announces nothing for an agent that passes, which is not run again', async () => {
    drainMessagesMock.mockReturnValueOnce([parked('message-2')]);

    await finalReply(makeDeps([LEAD.id, ORION], 'mentioned'), '[PASS]', makeShared(1));

    expect(events).toContain(`status:${LEAD.id}:idle`);
    expect(events).not.toContain(`status:${LEAD.id}:queued`);
  });
});

describe('the all-mode terminal drain broadcasts each message once', () => {
  it('does not re-broadcast a message persisted (and broadcast) on receipt', async () => {
    drainMessagesMock.mockReturnValueOnce([parked('message-2', true)]);

    await finalReply(makeDeps([LEAD.id, ORION], 'all'));

    expect(events.filter((e) => e === 'message_created:message-2')).toHaveLength(0);
  });

  it('broadcasts a message it persists itself exactly once', async () => {
    drainMessagesMock.mockReturnValueOnce([parked('message-3', false)]);

    await finalReply(makeDeps([LEAD.id, ORION], 'all'));

    expect(events.filter((e) => e === 'message_created:message-3')).toHaveLength(1);
  });
});
