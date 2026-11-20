/**
 * ThreadDeliveryPolicyService.postAgentMessageToThread — the `thread_send`
 * agent-to-agent path. Focus here: the `message:create`
 * lifecycle emit, proven end-to-end through the real HookService bus (only
 * the DB/socket/dispatch boundaries are mocked).
 *
 * The lifecycle emit remains a generic hook contract, so the second test
 * attaches its own listener and asserts the payload.
 */

const findById = jest.fn();
const messagesCreate = jest.fn();
const dispatchToThread = jest.fn();
const broadcastToChannel = jest.fn();

jest.mock('@server/config/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

// ThreadDeliveryPolicyService's own DB imports.
jest.mock('@snaglet/db/tables/threads', () => ({
  Threads: { findById: (...args: unknown[]) => findById(...args) },
}));
jest.mock('@snaglet/db/tables/messages', () => ({
  Messages: { create: (...args: unknown[]) => messagesCreate(...args) },
}));

jest.mock('@server/services/WebSocketService', () => ({
  wsService: { broadcastToChannel: (...args: unknown[]) => broadcastToChannel(...args) },
}));
jest.mock('@snaglet/db/tables/users', () => ({
  Users: {
    getActiveUser: async () => ({ id: 'user-local' }),
    getOrCreateLocalUser: async () => ({ id: 'user-local' }),
  },
}));
jest.mock('@server/services/SocketService/dispatch/dispatchToThread', () => ({
  dispatchToThread: (...args: unknown[]) => dispatchToThread(...args),
}));
jest.mock('@server/services/LogsService', () => ({
  LogsService: {
    socket: { event: jest.fn() },
    error: jest.fn(),
    warn: jest.fn(),
  },
}));

// Note: @server/services/HookService is deliberately not mocked — the real
// emitter bus carries the event from the service to the listener.

import { describe, expect, it, jest, beforeEach } from '@jest/globals';
import {
  postAgentMessageToThread,
  postExternalMessageToThread,
} from '@server/services/ThreadDeliveryPolicyService';

beforeEach(() => {
  jest.clearAllMocks();
  findById.mockResolvedValue({ id: 'thread-1', title: 'T' });
  messagesCreate.mockResolvedValue({ id: 'msg-x' });
  dispatchToThread.mockResolvedValue({ ok: true, reason: 'dispatched', wakeCount: 1 });
});

describe('postAgentMessageToThread — message:create emit (thread_send path)', () => {
  it('persists and dispatches normally when no listener is registered', async () => {
    const result = await postAgentMessageToThread({
      threadId: 'thread-1',
      agentId: 'agent-a',
      content: 'hello',
    });
    expect(result.messageId).toEqual(expect.any(String));
    expect(messagesCreate).toHaveBeenCalledTimes(1);
    expect(broadcastToChannel).toHaveBeenCalledTimes(1);
    expect(dispatchToThread).toHaveBeenCalledTimes(1);
  });

  it('emits message:create with the char count through the real hook bus', async () => {
    const { hooks } = await import('@server/services/HookService');
    const received: Array<{ threadId: string; chars?: number }> = [];
    hooks.on('message:create', (payload: { threadId: string; chars?: number }) => {
      received.push(payload);
    });

    const content = 'An agent-to-agent update about the sprint.';
    await postAgentMessageToThread({
      threadId: 'thread-1',
      agentId: 'agent-a',
      content,
    });

    expect(messagesCreate).toHaveBeenCalledTimes(1); // persisted first
    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({ threadId: 'thread-1', chars: content.length });
  });
});

// Busy-thread in-run delivery: both thread_send paths hand dispatchToThread the
// sender identity it needs to queue the seed into running targets' next tool
// seam (see dispatch/seedInjection.ts). Without `sender`, the busy branch only
// records the seed for after the run, and running targets miss mid-run posts.
describe('thread_send paths pass the sender for mid-run delivery', () => {
  it('agent → other-thread thread_send dispatches as a peer agent', async () => {
    await postAgentMessageToThread({ threadId: 'thread-1', agentId: 'agent-a', content: 'hi' });
    expect(dispatchToThread).toHaveBeenCalledWith(
      expect.objectContaining({ senderId: 'agent-a', sender: { kind: 'agent' } })
    );
  });

  it('external MCP thread_send dispatches as the user voice with the member name', async () => {
    await postExternalMessageToThread({
      threadId: 'thread-1',
      memberId: 'member-cc',
      memberName: 'Claude Code',
      content: '@Venus hi',
    });
    expect(dispatchToThread).toHaveBeenCalledWith(
      expect.objectContaining({
        senderId: 'member-cc',
        sender: { kind: 'user', name: 'Claude Code', userId: 'user-local' },
      })
    );
  });
});

describe('postAgentMessageToThread — how its dispatch ended', () => {
  it('hands the dispatch result to onDispatchSettled', async () => {
    const outcomes: unknown[] = [];
    await postAgentMessageToThread({
      threadId: 'thread-1',
      agentId: 'agent-a',
      content: 'hello',
      onDispatchSettled: (outcome) => outcomes.push(outcome),
    });
    await new Promise((r) => setImmediate(r));
    expect(outcomes).toEqual([{ result: { ok: true, reason: 'dispatched', wakeCount: 1 } }]);
  });

  it('hands a failed dispatch its error, and survives a callback that throws', async () => {
    const failure = new Error('dispatch blew up');
    dispatchToThread.mockRejectedValueOnce(failure);
    const outcomes: unknown[] = [];
    await postAgentMessageToThread({
      threadId: 'thread-1',
      agentId: 'agent-a',
      content: 'hello',
      onDispatchSettled: (outcome) => {
        outcomes.push(outcome);
        throw new Error('callback blew up');
      },
    });
    await new Promise((r) => setImmediate(r));
    expect(outcomes).toEqual([{ error: failure }]);
  });
});
