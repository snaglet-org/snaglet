/**
 * finalReply — a terminal reply that carries an unverified workspace id.
 *
 * Product decision: agents may write incorrect ids on purpose (examples,
 * hypotheticals), so Snaglet must not correct them. The reply is persisted as the
 * agent wrote it, no extra message is injected, the agent is not woken for a
 * corrective turn, and the only trace is a server warn log.
 *
 * Everything around handleFinalReply is stubbed; the real finalReply module and
 * its real persistFinalReply run against a mocked persistUtterance.
 */

const persistUtteranceMock = jest.fn();
const routeSpokenMentionsMock = jest.fn();
const lintMock = jest.fn();
const messagesCreate = jest.fn();
const logsWarn = jest.fn();
const wsBroadcast = jest.fn();

jest.mock('onnxruntime-node', () => ({
  InferenceSession: { create: jest.fn() },
  Tensor: class MockTensor {},
}));

jest.mock('@snaglet/db/tables/messages', () => ({
  Messages: { create: (...a: unknown[]) => messagesCreate(...a) },
}));
jest.mock('@snaglet/db/tables/runs', () => ({
  Runs: { markCompleted: jest.fn().mockResolvedValue(undefined) },
}));
jest.mock('@snaglet/db/tables/threads', () => ({ Threads: {} }));
jest.mock('@snaglet/db/tables/users', () => ({
  Users: { getOrCreateLocalUser: jest.fn().mockResolvedValue({ id: 'user-1' }) },
}));
jest.mock('@server/services/ActiveRunTracker', () => ({
  activeRunTracker: { finish: jest.fn(), drainMessages: jest.fn(() => []) },
}));
jest.mock('@server/services/HookService', () => ({ hooks: { emit: jest.fn() } }));
jest.mock('@server/services/EmbeddingService', () => ({
  syncMessageEmbedding: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('@server/services/SummaryService', () => ({
  summaryService: { generateSummary: jest.fn().mockResolvedValue({ status: 'not-due' }) },
}));
jest.mock('@server/services/summary/summaryHalt', () => ({
  haltOnSummaryFailure: jest.fn(),
}));
jest.mock('@server/services/summary/scheduleCompactionMemoryExtraction', () => ({
  scheduleCompactionMemoryExtraction: jest.fn(),
}));
jest.mock('@server/services/SocketService/outboundMessageLinter', () => ({
  lintWorkspaceReferencesInMessage: (...a: unknown[]) => lintMock(...a),
}));
jest.mock('@server/services/WebSocketService', () => ({
  wsService: {
    broadcastToChannel: (...a: unknown[]) => wsBroadcast(...a),
    sendToClient: jest.fn(),
  },
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
    warn: (...a: unknown[]) => logsWarn(...a),
  },
}));
jest.mock('@server/services/PendingAgentMessageService', () => ({
  pendingAgentMessages: { enqueue: jest.fn() },
}));
jest.mock('@server/services/SocketService/handlers/chatPhases/detectStagnation', () => ({
  STAGNATION_POLICY: { window: 3, strikesToPass: 2, embeddingThreshold: 0.9 },
  checkReplyStagnation: jest.fn(),
}));
jest.mock('@server/services/settings', () => ({ settingsService: { read: jest.fn() } }));
jest.mock('@server/services/settings/categories/dispatch', () => ({
  dispatchSettings: { stagnationSimilarity: {} },
}));
jest.mock('@server/services/SocketService/handlers/chatPhases/mentionRouter', () => ({
  resolveAllModeTargets: jest.fn(),
  routeMentions: jest.fn(),
}));
jest.mock('@server/services/SocketService/handlers/chatPhases/utteranceMessages', () => ({
  persistUtterance: (...a: unknown[]) => persistUtteranceMock(...a),
  routeSpokenMentions: (...a: unknown[]) => routeSpokenMentionsMock(...a),
}));

import { handleFinalReply } from '@server/services/SocketService/handlers/chatPhases/finalReply';
import type {
  RunAgentTurnDeps,
  RunAgentTurnSharedState,
} from '@server/services/SocketService/handlers/chatPhases/types';

const AGENT_ID = 'agent-venus';
const BAD_ID = 'doc-9999999999999-zzzzzzzzz';
const REPLY = `Here is an example reference: [Example](${BAD_ID})`;

function makeInput(wokenByMention: Set<string>) {
  const deps = {
    session: { threadId: 'thread-1' },
    sessionId: 'session-1',
    threadName: 'Test Thread',
    meta: { clientId: 'client-1' },
    isGroup: false,
    participantAgentIds: [AGENT_ID],
    previewMessage: (v: string) => v,
    wokenByMention,
    convBudget: { recordAgentTurn: jest.fn() },
    agentNameMap: new Map([[AGENT_ID, 'Venus']]),
    agentRoleMap: new Map(),
  } as unknown as RunAgentTurnDeps;
  const shared = {
    recentRepliesByAgent: new Map<string, string[]>(),
    passedAgents: new Set<string>(),
    passKinds: new Map(),
    stagnationStrikes: new Map<string, number>(),
    currentWaveResults: [],
    conversationRound: 0,
  } as unknown as RunAgentTurnSharedState;
  const agent = { id: AGENT_ID, name: 'Venus', role: 'assistant', modelId: 'm' };
  return {
    deps,
    shared,
    replyAgentId: AGENT_ID,
    agent,
    runtimeAgent: agent,
    agentMessages: [],
    result: { reply: REPLY },
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

describe('handleFinalReply — unverified workspace id in the terminal reply', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    persistUtteranceMock.mockResolvedValue('message-1');
    lintMock.mockResolvedValue({
      content: REPLY.replace(BAD_ID, `unverified: ${BAD_ID}`),
      issues: [{ id: BAD_ID, nodeType: 'doc', reason: 'not_found' }],
    });
  });

  it('persists the original reply, injects no message, and does not wake the agent', async () => {
    const wokenByMention = new Set<string>();
    const input = makeInput(wokenByMention);

    await handleFinalReply(input);

    // The reply is persisted exactly once, byte-identical to what the agent wrote.
    expect(persistUtteranceMock).toHaveBeenCalledTimes(1);
    const persisted = persistUtteranceMock.mock.calls[0]![0] as Record<string, unknown>;
    expect(persisted.content).toBe(REPLY);
    // The row is plain: no unverified-id metadata is handed to the persister.
    expect(persisted).not.toHaveProperty('fabricatedIds');

    // No corrective user message is created or broadcast.
    expect(messagesCreate).not.toHaveBeenCalled();
    const createdEvents = wsBroadcast.mock.calls.filter(
      ([, event]) => (event as { type?: string }).type === 'socket:chat:message_created'
    );
    expect(createdEvents).toHaveLength(0);

    // The agent is not queued for a corrective turn.
    expect(wokenByMention.has(AGENT_ID)).toBe(false);
    expect(wokenByMention.size).toBe(0);

    // Observability survives: a warn log names the unverified id.
    expect(logsWarn).toHaveBeenCalledWith(
      'outbound message failed integrity lint',
      expect.objectContaining({ unverifiedIds: [BAD_ID], messageId: 'message-1' })
    );
  });

  it('does not log the integrity warning when every id verifies', async () => {
    lintMock.mockResolvedValue({ content: REPLY, issues: [] });
    await handleFinalReply(makeInput(new Set<string>()));

    expect(persistUtteranceMock).toHaveBeenCalledTimes(1);
    expect(logsWarn).not.toHaveBeenCalledWith(
      'outbound message failed integrity lint',
      expect.anything()
    );
  });
});
