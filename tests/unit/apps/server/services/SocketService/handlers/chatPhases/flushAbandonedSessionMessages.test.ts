/**
 * flushAbandonedSessionMessages — the end-of-run drain that keeps queued
 * mid-run messages from being silently destroyed when the session's queue
 * dies with finishSession. Pins: every leftover is persisted (marked
 * injectedDuringRun) + broadcast, a failed persist skips the broadcast but
 * doesn't abort the rest, and an empty queue is a no-op.
 */

import { beforeEach, describe, expect, it, jest } from '@jest/globals';

const mockMessagesCreate = jest.fn<(row: Record<string, unknown>) => Promise<unknown>>();
const mockGetOrCreateLocalUser = jest.fn<() => Promise<{ id: string }>>();
const mockBroadcastToChannel = jest.fn();
const mockSyncMessageEmbedding = jest.fn<() => Promise<void>>();

jest.mock('@snaglet/db/tables/messages', () => ({
  Messages: { create: (row: Record<string, unknown>) => mockMessagesCreate(row) },
}));
jest.mock('@snaglet/db/tables/users', () => ({
  Users: { getOrCreateLocalUser: () => mockGetOrCreateLocalUser() },
}));
jest.mock('@server/services/WebSocketService', () => ({
  wsService: {
    broadcastToChannel: (...args: unknown[]) => mockBroadcastToChannel(...(args as [])),
  },
}));
jest.mock('@server/services/EmbeddingService', () => ({
  syncMessageEmbedding: () => mockSyncMessageEmbedding(),
}));
jest.mock('@server/services/PendingAgentMessageService', () => ({
  pendingAgentMessages: { enqueue: jest.fn() },
}));
// startSession/finishSession emit run-state events through the realtime
// surface, which would otherwise hit the wsService mock and skew counts.
jest.mock('@server/realtime/surfaces/threads', () => ({
  emitThreadRunStarted: jest.fn(),
  emitThreadRunFinished: jest.fn(),
}));

import {
  flushAbandonedSessionMessages,
  persistStragglers,
  finishSessionAndPersistStragglers,
} from '@server/services/SocketService/handlers/chatPhases/midRunMessages';
import { activeRunTracker } from '@server/services/ActiveRunTracker';

const openSessions: string[] = [];

beforeEach(() => {
  jest.clearAllMocks();
  mockGetOrCreateLocalUser.mockResolvedValue({ id: 'user-local' });
  mockMessagesCreate.mockResolvedValue({});
  mockSyncMessageEmbedding.mockResolvedValue();
});

afterEach(() => {
  // The tracker is a module singleton — release sessions even when an
  // assertion threw mid-test so later tests can re-claim their threads.
  for (const id of openSessions.splice(0)) activeRunTracker.finishSession(id);
});

/** Register a session and park messages on its queue via the public API. */
function seedQueue(
  sessionId: string,
  threadId: string,
  messages: Array<{ id: string; content: string }>
): void {
  expect(activeRunTracker.startSession(sessionId, threadId)).toBe(true);
  openSessions.push(sessionId);
  for (const m of messages) {
    expect(activeRunTracker.enqueueMessageForThread(threadId, m.id, m.content)).toBe(true);
  }
}

describe('flushAbandonedSessionMessages', () => {
  it('persists and broadcasts every leftover queued message', async () => {
    const sessionId = 'session-flush-a';
    const threadId = 'thread-flush-a';
    seedQueue(sessionId, threadId, [
      { id: 'msg-1', content: 'first follow-up' },
      { id: 'msg-2', content: 'second follow-up' },
    ]);

    await flushAbandonedSessionMessages({ sessionId, threadId, threadName: 'T' });

    expect(mockMessagesCreate).toHaveBeenCalledTimes(2);
    expect(mockMessagesCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'msg-1',
        threadId,
        role: 'user',
        content: 'first follow-up',
        injectedDuringRun: true,
      })
    );
    expect(mockBroadcastToChannel).toHaveBeenCalledTimes(2);
    expect(mockBroadcastToChannel).toHaveBeenCalledWith(
      threadId,
      expect.objectContaining({
        type: 'socket:chat:message_created',
        payload: expect.objectContaining({ id: 'msg-2', injected_during_run: true }),
      })
    );

    // Queue is drained — a second flush is a no-op.
    await flushAbandonedSessionMessages({ sessionId, threadId, threadName: 'T' });
    expect(mockMessagesCreate).toHaveBeenCalledTimes(2);
  });

  it('skips the broadcast for a failed persist but continues with the rest', async () => {
    const sessionId = 'session-flush-b';
    const threadId = 'thread-flush-b';
    seedQueue(sessionId, threadId, [
      { id: 'msg-bad', content: 'will fail' },
      { id: 'msg-good', content: 'will land' },
    ]);
    mockMessagesCreate.mockRejectedValueOnce(new Error('unique violation'));

    await flushAbandonedSessionMessages({ sessionId, threadId, threadName: 'T' });

    expect(mockMessagesCreate).toHaveBeenCalledTimes(2);
    expect(mockBroadcastToChannel).toHaveBeenCalledTimes(1);
    expect(mockBroadcastToChannel).toHaveBeenCalledWith(
      threadId,
      expect.objectContaining({ payload: expect.objectContaining({ id: 'msg-good' }) })
    );
  });

  it('is a no-op for a session with no queue', async () => {
    await flushAbandonedSessionMessages({
      sessionId: 'session-never-started',
      threadId: 'thread-flush-c',
      threadName: 'T',
    });

    expect(mockGetOrCreateLocalUser).not.toHaveBeenCalled();
    expect(mockMessagesCreate).not.toHaveBeenCalled();
  });
});

describe('persistStragglers', () => {
  it('persists and broadcasts every straggler finishSession() handed back', async () => {
    await persistStragglers(
      'session-straggler-a',
      [{ id: 'msg-straggler-1', content: 'raced in' }],
      { threadId: 'thread-straggler-a', threadName: 'T' }
    );

    expect(mockMessagesCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'msg-straggler-1',
        threadId: 'thread-straggler-a',
        content: 'raced in',
        injectedDuringRun: true,
      })
    );
    expect(mockBroadcastToChannel).toHaveBeenCalledWith(
      'thread-straggler-a',
      expect.objectContaining({
        payload: expect.objectContaining({ id: 'msg-straggler-1' }),
      })
    );
  });

  it('is a no-op for an empty array', async () => {
    await persistStragglers('session-straggler-b', [], {
      threadId: 'thread-straggler-b',
      threadName: 'T',
    });
    expect(mockMessagesCreate).not.toHaveBeenCalled();
  });
});

describe('finishSessionAndPersistStragglers', () => {
  it('persists a message still parked in the queue at an early-exit finishSession() call', async () => {
    // Mirrors chatHandlers.ts's early-return sites (e.g. "no active
    // participants", mention fan-out rejection, empty dispatch set): a
    // message can already be queued mid-run before one of those guards
    // fires and ends the session. It must not be dropped just because the
    // guard exits before the wave loop's own straggler-persist path runs.
    const sessionId = 'session-early-exit';
    const threadId = 'thread-early-exit';
    seedQueue(sessionId, threadId, [{ id: 'msg-early', content: 'queued before an early return' }]);

    await finishSessionAndPersistStragglers(sessionId, { threadId, threadName: 'T' });

    expect(mockMessagesCreate).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'msg-early', content: 'queued before an early return' })
    );
    expect(activeRunTracker.hasActiveSession(sessionId)).toBe(false);
  });
});
