/**
 * utteranceMessages tests.
 *
 *  - persistUtterance: writes a non-injected assistant message row (role
 *    'assistant', messageType 'message', agentId + runId), broadcasts the
 *    snake_case socket:chat:message_created event, and syncs an embedding.
 *  - routeSpokenMentions: the one spoken-mention policy shared by interim
 *    utterances and the terminal reply — 1:1 no-op, all-mode fan-out, mentioned
 *    wake, and the double-wake idempotency inherited from
 *    routeMentions (a peer already running is queued, not re-woken).
 */

import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import type {
  RunAgentTurnDeps,
  RunAgentTurnSharedState,
} from '@server/services/SocketService/handlers/chatPhases/types';

// EmbeddingService transitively loads the ONNX runtime, which SIGABRTs inside
// jest's worker sandbox — stub it before anything can pull it in.
jest.mock('onnxruntime-node', () => ({
  InferenceSession: { create: jest.fn() },
  Tensor: class MockTensor {},
}));

const mockMessagesCreate = jest.fn(async () => undefined);
const mockSyncEmbedding = jest.fn(async () => undefined);
const mockBroadcast = jest.fn();
const mockIsAgentParticipant = jest.fn<() => Promise<boolean>>(async () => true);
const mockParseMentions =
  jest.fn<() => { mentionedAgentIds: string[]; hasMentions: boolean; rawMentions: string[] }>();

jest.mock('@snaglet/db/tables/messages', () => ({
  Messages: { create: (...args: unknown[]) => mockMessagesCreate(...(args as [])) },
}));
jest.mock('@snaglet/db/tables/thread_participants', () => ({
  ThreadParticipants: {
    isAgentParticipant: (...args: unknown[]) => mockIsAgentParticipant(...(args as [])),
  },
}));
jest.mock('@server/services/EmbeddingService', () => ({
  syncMessageEmbedding: (...args: unknown[]) => mockSyncEmbedding(...(args as [])),
}));
jest.mock('@server/services/WebSocketService', () => ({
  wsService: {
    broadcastToChannel: (...args: unknown[]) => mockBroadcast(...(args as [])),
    sendToClient: jest.fn(),
  },
}));
jest.mock('@server/services/MentionParser', () => ({
  parseMentions: (...args: unknown[]) => mockParseMentions(...(args as [])),
}));
jest.mock('@server/services/ActiveRunTracker', () => ({
  activeRunTracker: { reserveHandoff: jest.fn() },
}));

import {
  persistUtterance,
  routeSpokenMentions,
} from '@server/services/SocketService/handlers/chatPhases/utteranceMessages';
import { pendingAgentMessages } from '@server/services/PendingAgentMessageService';

const PARTICIPANTS = ['agent-nova', 'agent-max', 'agent-self'];

const AGENT = { id: 'agent-self', name: 'Self' } as never;
const RUNTIME_AGENT = { id: 'agent-self', name: 'Self', modelId: 'test-model' } as never;

function makeDeps(overrides: Record<string, unknown> = {}): RunAgentTurnDeps {
  return {
    session: { threadId: 'thread-1' },
    sessionId: 'session-1',
    threadName: 'Test thread',
    isGroup: true,
    dispatchMode: 'mentioned',
    participantAgentIds: PARTICIPANTS,
    agentNameMap: new Map([
      ['agent-nova', 'Nova'],
      ['agent-max', 'Max'],
      ['agent-self', 'Self'],
    ]),
    resolveParticipantId: (id: string) => (PARTICIPANTS.includes(id) ? id : undefined),
    isParticipantMention: (id: string) => PARTICIPANTS.includes(id),
    startAgent: jest.fn(),
    HARD_DISPATCH_CEILING: 10,
    softDispatchThreshold: 5,
    dispatchSet: new Set<string>(),
    wokenByMention: new Set<string>(),
    effectiveParallelDispatch: true,
    wsService: { broadcastToChannel: jest.fn(), sendToClient: jest.fn() },
    ...overrides,
  } as unknown as RunAgentTurnDeps;
}

function makeShared(overrides: Record<string, unknown> = {}): RunAgentTurnSharedState {
  return {
    runningAgents: new Set<string>(),
    agentDispatchCount: new Map<string, number>(),
    passedAgents: new Set<string>(),
    passKinds: new Map(),
    recentRepliesByAgent: new Map(),
    stagnationStrikes: new Map(),
    agentSoftThresholdNotified: new Set<string>(),
    ...overrides,
  } as unknown as RunAgentTurnSharedState;
}

beforeEach(() => {
  jest.clearAllMocks();
  // clearAllMocks wipes the default implementation — restore "still a
  // participant" so the persist path runs unless a test overrides it.
  mockIsAgentParticipant.mockResolvedValue(true);
  pendingAgentMessages.resetForTests();
});

describe('persistUtterance', () => {
  it('writes a non-injected assistant message row and returns its id', async () => {
    const id = await persistUtterance({
      threadId: 'thread-1',
      threadName: 'Test thread',
      agentId: 'agent-self',
      runId: 'run-1',
      content: 'Let me check the logs.',
      previewMessage: (v) => v,
      logLabel: 'interim utterance persisted',
    });

    expect(typeof id).toBe('string');
    expect(mockMessagesCreate).toHaveBeenCalledTimes(1);
    const row = mockMessagesCreate.mock.calls[0]![0] as Record<string, unknown>;
    expect(row).toMatchObject({
      id,
      threadId: 'thread-1',
      role: 'assistant',
      content: 'Let me check the logs.',
      agentId: 'agent-self',
      messageType: 'message',
      runId: 'run-1',
    });
    // Not injectedDuringRun — spoken-while-running, not received-while-running.
    expect(row.injectedDuringRun).toBeUndefined();
  });

  it('drops the utterance (no row, no broadcast, null return) when the agent was removed mid-run', async () => {
    mockIsAgentParticipant.mockResolvedValue(false);

    const id = await persistUtterance({
      threadId: 'thread-1',
      threadName: 'Test thread',
      agentId: 'agent-removed',
      runId: 'run-1',
      content: 'I am still narrating even though I was removed.',
      previewMessage: (v) => v,
      logLabel: 'interim utterance persisted',
    });

    expect(id).toBeNull();
    expect(mockMessagesCreate).not.toHaveBeenCalled();
    expect(mockBroadcast).not.toHaveBeenCalled();
    expect(mockSyncEmbedding).not.toHaveBeenCalled();
    expect(mockIsAgentParticipant).toHaveBeenCalledWith('thread-1', 'agent-removed');
  });

  it('broadcasts socket:chat:message_created with the snake_case + run_id payload shape', async () => {
    const id = await persistUtterance({
      threadId: 'thread-1',
      threadName: 'Test thread',
      agentId: 'agent-self',
      runId: 'run-1',
      content: 'Found it.',
      previewMessage: (v) => v,
      logLabel: 'interim utterance persisted',
    });

    expect(mockBroadcast).toHaveBeenCalledTimes(1);
    const [channel, event] = mockBroadcast.mock.calls[0]! as [string, Record<string, unknown>];
    expect(channel).toBe('thread-1');
    expect(event.type).toBe('socket:chat:message_created');
    expect(event.payload).toMatchObject({
      id,
      threadId: 'thread-1',
      role: 'assistant',
      content: 'Found it.',
      agent_id: 'agent-self',
      message_type: 'message',
      injected_during_run: false,
      run_id: 'run-1',
    });
    expect(typeof (event.payload as Record<string, unknown>).created_at).toBe('string');
  });

  it('syncs an embedding for the persisted row', async () => {
    const id = await persistUtterance({
      threadId: 'thread-1',
      threadName: 'Test thread',
      agentId: 'agent-self',
      runId: 'run-1',
      content: 'Patching now.',
      previewMessage: (v) => v,
      logLabel: 'interim utterance persisted',
    });
    expect(mockSyncEmbedding).toHaveBeenCalledWith(id, 'Patching now.');
  });

  it('defaults messageType to "message" and omits usage when neither opt is passed', async () => {
    await persistUtterance({
      threadId: 'thread-1',
      threadName: 'Test thread',
      agentId: 'agent-self',
      runId: 'run-1',
      content: 'Interim.',
      previewMessage: (v) => v,
      logLabel: 'interim utterance persisted',
    });
    const row = mockMessagesCreate.mock.calls[0]![0] as Record<string, unknown>;
    expect(row.messageType).toBe('message');
    expect(row.usage).toBeUndefined();
    const [, event] = mockBroadcast.mock.calls[0]! as [string, Record<string, unknown>];
    const payload = event.payload as Record<string, unknown>;
    expect(payload.message_type).toBe('message');
    expect(payload.usage).toBeUndefined();
  });

  it('writes messageType + usage to the row and the broadcast when passed (terminal reply)', async () => {
    const usage = { inputTokens: 120, outputTokens: 40, contextWindowTokens: 200000 };
    await persistUtterance({
      threadId: 'thread-1',
      threadName: 'Test thread',
      agentId: 'agent-self',
      runId: 'run-1',
      content: 'Are we done?',
      previewMessage: (v) => v,
      logLabel: 'assistant message',
      messageType: 'question',
      usage,
    });

    const row = mockMessagesCreate.mock.calls[0]![0] as Record<string, unknown>;
    expect(row.messageType).toBe('question');
    expect(row.usage).toEqual(usage);

    const [, event] = mockBroadcast.mock.calls[0]! as [string, Record<string, unknown>];
    const payload = event.payload as Record<string, unknown>;
    // Row + broadcast carry the same usage — they cannot drift.
    expect(payload.message_type).toBe('question');
    expect(payload.usage).toEqual(usage);
  });
});

describe('routeSpokenMentions — per-mode dispatch', () => {
  function route(deps: RunAgentTurnDeps, shared: RunAgentTurnSharedState, fanOut = jest.fn()) {
    routeSpokenMentions({
      deps,
      shared,
      agent: AGENT,
      runtimeAgent: RUNTIME_AGENT,
      replyAgentId: 'agent-self',
      content: 'hey @Nova',
      fanOutAllModeMidRunMessage: fanOut,
      logContext: 'utterance',
    });
    return fanOut;
  }

  it('1:1 (not a group) is a no-op — no fan-out, no wake', () => {
    mockParseMentions.mockReturnValue({
      mentionedAgentIds: ['agent-nova'],
      hasMentions: true,
      rawMentions: ['@Nova'],
    });
    const deps = makeDeps({ isGroup: false });
    const shared = makeShared();
    const fanOut = route(deps, shared);

    expect(fanOut).not.toHaveBeenCalled();
    expect(deps.dispatchSet.size).toBe(0);
  });

  it('mentioned mode wakes an idle under-cap peer into the wave', () => {
    mockParseMentions.mockReturnValue({
      mentionedAgentIds: ['agent-nova'],
      hasMentions: true,
      rawMentions: ['@Nova'],
    });
    const deps = makeDeps({ dispatchMode: 'mentioned' });
    const shared = makeShared();
    route(deps, shared);

    expect(deps.dispatchSet.has('agent-nova')).toBe(true);
    expect(deps.wokenByMention.has('agent-nova')).toBe(true);
    expect(deps.startAgent).toHaveBeenCalledWith('agent-nova');
  });

  it('all mode fans out to the resolved targets (not routeMentions)', () => {
    mockParseMentions.mockReturnValue({
      mentionedAgentIds: ['agent-nova'],
      hasMentions: true,
      rawMentions: ['@Nova'],
    });
    const deps = makeDeps({ dispatchMode: 'all' });
    const shared = makeShared();
    const fanOut = route(deps, shared);

    expect(fanOut).toHaveBeenCalledTimes(1);
    const [content, targets, meta] = fanOut.mock.calls[0]! as [string, string[], unknown];
    expect(content).toBe('hey @Nova');
    expect(targets).toEqual(['agent-nova']);
    expect(meta).toEqual({ senderAgentId: 'agent-self', senderName: 'Self' });
    // All-mode never touches the wave dispatch set directly (fan-out owns waking).
    expect(deps.dispatchSet.size).toBe(0);
  });

  it('double-wake idempotency: a peer already running is queued, not re-woken', () => {
    mockParseMentions.mockReturnValue({
      mentionedAgentIds: ['agent-nova'],
      hasMentions: true,
      rawMentions: ['@Nova'],
    });
    const deps = makeDeps({ dispatchMode: 'mentioned' });
    const shared = makeShared({ runningAgents: new Set(['agent-nova']) });
    route(deps, shared);

    // Not re-woken into the wave...
    expect(deps.dispatchSet.has('agent-nova')).toBe(false);
    expect(deps.startAgent).not.toHaveBeenCalled();
    // ...but queued for delivery between the running peer's tool iterations.
    const queued = pendingAgentMessages.listUnread('thread-1', 'agent-nova');
    expect(queued).toHaveLength(1);
    expect(queued[0]).toMatchObject({
      senderAgentId: 'agent-self',
      senderName: 'Self',
      reason: 'mentioned',
      content: 'hey @Nova',
    });
  });

  it('holds an untagged message for a running teammate so a later mention can bring it along', () => {
    mockParseMentions.mockReturnValue({
      mentionedAgentIds: ['agent-nova'],
      hasMentions: true,
      rawMentions: ['@Nova'],
    });
    const deps = makeDeps({ dispatchMode: 'mentioned' });
    // Nova is tagged; Max is mid-run and was not.
    const shared = makeShared({ runningAgents: new Set(['agent-nova', 'agent-max']) });
    route(deps, shared);

    const toNova = pendingAgentMessages.listUnread('thread-1', 'agent-nova');
    const toMax = pendingAgentMessages.listUnread('thread-1', 'agent-max');
    expect(toNova.map((m) => m.reason)).toEqual(['mentioned']);
    expect(toMax).toHaveLength(1);
    expect(toMax[0]).toMatchObject({
      senderAgentId: 'agent-self',
      senderName: 'Self',
      reason: 'thread-message',
      content: 'hey @Nova',
    });
  });

  it('never holds a message for the speaker itself or for an idle teammate', () => {
    mockParseMentions.mockReturnValue({
      mentionedAgentIds: [],
      hasMentions: false,
      rawMentions: [],
    });
    const deps = makeDeps({ dispatchMode: 'mentioned' });
    const shared = makeShared({ runningAgents: new Set(['agent-self']) });
    route(deps, shared);

    expect(pendingAgentMessages.listUnread('thread-1', 'agent-self')).toEqual([]);
    expect(pendingAgentMessages.listUnread('thread-1', 'agent-max')).toEqual([]);
  });
});
