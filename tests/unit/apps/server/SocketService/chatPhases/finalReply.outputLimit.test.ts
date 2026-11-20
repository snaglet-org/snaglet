/**
 * finalReply — a reply that ended at the model's output limit, e.g. Claude
 * Fable 5.2 thinking until `max_tokens` (8,192) with no text in the response.
 * The thread gets a "Reply cut off" notice (a run_error row of kind
 * `output_limit` saying what to do) and the run is recorded as failed with
 * that reason, never as a quiet completion. Any text that did arrive posts.
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
const runsMarkCompleted = jest.fn().mockResolvedValue(undefined);
const runsMarkFailed = jest.fn().mockResolvedValue(undefined);
jest.mock('@snaglet/db/tables/runs', () => ({
  Runs: {
    markCompleted: (...a: unknown[]) => runsMarkCompleted(...a),
    markFailed: (...a: unknown[]) => runsMarkFailed(...a),
  },
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

const AGENT_ID = 'agent-patty';

function makeInput(reply: string, cutOffAtTokens?: number | null, conversationRound = 0) {
  const deps = {
    session: { threadId: 'thread-1' },
    sessionId: 'session-1',
    threadName: 'Plan my week',
    meta: { clientId: 'client-1' },
    isGroup: false,
    participantAgentIds: [AGENT_ID],
    previewMessage: (v: string) => v,
    wokenByMention: new Set<string>(),
    convBudget: { recordAgentTurn: jest.fn() },
    agentNameMap: new Map([[AGENT_ID, 'Patty']]),
    agentRoleMap: new Map(),
  } as unknown as RunAgentTurnDeps;
  const shared = {
    recentRepliesByAgent: new Map<string, string[]>(),
    passedAgents: new Set<string>(),
    passKinds: new Map(),
    stagnationStrikes: new Map<string, number>(),
    currentWaveResults: [],
    conversationRound,
  } as unknown as RunAgentTurnSharedState;
  const agent = {
    id: AGENT_ID,
    name: 'Patty',
    role: 'assistant',
    provider: 'anthropic',
    modelId: 'claude-fable-5-2',
  };
  return {
    deps,
    shared,
    replyAgentId: AGENT_ID,
    agent,
    runtimeAgent: agent,
    agentMessages: [],
    // Thinking only: stop_reason max_tokens, no text.
    result: { reply, stopReason: 'max_tokens', thinkingContent: '' },
    runId: 'run-1',
    budget: { contextWindowTokens: 200_000, maxOutputTokens: 8192 },
    startedAt: Date.now(),
    totalInputTokens: 54_160,
    totalOutputTokens: 8192,
    runTokens: {
      billedInputTokens: 54_160,
      outputTokens: 8192,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      providerCalls: 1,
    },
    iterations: 1,
    fanOutAllModeMidRunMessage: jest.fn(),
    ...(cutOffAtTokens !== undefined ? { cutOff: { maxOutputTokens: cutOffAtTokens } } : {}),
  } as unknown as Parameters<typeof handleFinalReply>[0];
}

const created = () =>
  wsBroadcast.mock.calls
    .map(([, event]) => event as { type?: string; payload?: Record<string, unknown> })
    .filter((event) => event.type === 'socket:chat:message_created');

describe('handleFinalReply — a reply cut off at the output limit', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    persistUtteranceMock.mockResolvedValue('message-1');
    lintMock.mockResolvedValue({ content: '', issues: [] });
    messagesCreate.mockResolvedValue(undefined);
  });

  it('posts a notice and records the run as failed when thinking used the whole limit', async () => {
    await handleFinalReply(makeInput('', 8192));

    // No empty agent message.
    expect(persistUtteranceMock).not.toHaveBeenCalled();
    // The notice row: a run_error of kind output_limit that says what happened and what to do.
    expect(messagesCreate).toHaveBeenCalledTimes(1);
    const row = messagesCreate.mock.calls[0]![0] as {
      content: string;
      runId: string;
      metadata: { run_error: { kind: string; summary: string } };
    };
    expect(row.runId).toBe('run-1');
    expect(row.metadata.run_error.kind).toBe('output_limit');
    expect(row.content).toContain('Reply cut off (anthropic/claude-fable-5-2)');
    expect(row.content).toContain('output limit (8,192 tokens)');
    expect(row.content).toContain('Ask the agent to continue');
    expect(created()).toHaveLength(1);
    // The run is not a quiet completion.
    expect(runsMarkCompleted).not.toHaveBeenCalled();
    expect(runsMarkFailed).toHaveBeenCalledTimes(1);
    expect(runsMarkFailed.mock.calls[0]![0]).toBe('run-1');
    expect(String(runsMarkFailed.mock.calls[0]![1])).toContain('output limit');
  });

  it('posts the partial text first, then the notice', async () => {
    await handleFinalReply(makeInput('Here is the first half of the', 8192));

    expect(persistUtteranceMock).toHaveBeenCalledTimes(1);
    expect((persistUtteranceMock.mock.calls[0]![0] as { content: string }).content).toBe(
      'Here is the first half of the'
    );
    expect(messagesCreate).toHaveBeenCalledTimes(1);
    expect(runsMarkFailed).toHaveBeenCalledTimes(1);
  });

  it('posts the notice when the cut-off reply was a pass', async () => {
    // A continuation round where the cut-off text ends in the pass token.
    await handleFinalReply(makeInput('[PASS]', 8192, 1));

    expect(persistUtteranceMock).not.toHaveBeenCalled();
    expect(messagesCreate).toHaveBeenCalledTimes(1);
    expect(runsMarkCompleted).not.toHaveBeenCalled();
    expect(runsMarkFailed).toHaveBeenCalledTimes(1);
  });

  it('says "output limit" without a number when the request named none', async () => {
    await handleFinalReply(makeInput('', null));

    const row = messagesCreate.mock.calls[0]![0] as { content: string };
    expect(row.content).toContain("this model's output limit before it was finished");
  });

  it('completes normally when the reply was not cut off', async () => {
    await handleFinalReply(makeInput('All done.'));

    expect(messagesCreate).not.toHaveBeenCalled();
    expect(runsMarkCompleted).toHaveBeenCalledTimes(1);
    expect(runsMarkFailed).not.toHaveBeenCalled();
  });
});
