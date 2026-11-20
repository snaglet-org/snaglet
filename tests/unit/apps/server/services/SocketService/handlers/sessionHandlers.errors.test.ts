/**
 * `session:resume` rejections carry the requested threadId, so a client with
 * several chat panes can route the error to the pane that asked.
 */

import { beforeEach, describe, expect, it, jest } from '@jest/globals';

type Handler = (
  payload: { threadId?: string; sessionId?: string; agentId?: string },
  meta: { clientId: string }
) => Promise<void>;

const handlers = new Map<string, Handler>();
const sendToClient = jest.fn();
jest.mock('@server/services/WebSocketService', () => ({
  wsService: {
    registerHandler: (type: string, handler: Handler) => handlers.set(type, handler),
    sendToClient: (...a: unknown[]) => sendToClient(...a),
    broadcastToChannel: jest.fn(),
  },
}));

const findThread = jest.fn<(id: string) => Promise<unknown>>();
jest.mock('@snaglet/db/tables/threads', () => ({
  Threads: { findById: (id: string) => findThread(id), create: jest.fn() },
}));

const listParticipants = jest.fn<(id: string) => Promise<Array<{ agentId: string | null }>>>();
jest.mock('@snaglet/db/tables/thread_participants', () => ({
  ThreadParticipants: {
    listByThread: (id: string) => listParticipants(id),
    addParticipant: jest.fn(),
  },
}));

const getAgent = jest.fn<(id: string) => Promise<unknown>>();
jest.mock('@server/services/AgentService', () => ({
  agentService: { get: (id: string) => getAgent(id) },
}));

import { registerSessionHandlers } from '@server/services/SocketService/handlers/sessionHandlers';

const THREAD = 'thread-1111111111111-aaaaaaaaa';

async function resume(): Promise<Record<string, unknown>> {
  await handlers.get('socket:session:resume')!({ threadId: THREAD }, { clientId: 'client-1' });
  const frame = sendToClient.mock.calls[0]![1] as {
    type: string;
    payload: Record<string, unknown>;
  };
  expect(frame.type).toBe('socket:error');
  return frame.payload;
}

beforeEach(() => {
  jest.clearAllMocks();
  handlers.clear();
  registerSessionHandlers();
});

describe('session:resume rejections name the thread', () => {
  it('thread not found', async () => {
    findThread.mockResolvedValue(null);
    await expect(resume()).resolves.toMatchObject({ threadId: THREAD });
  });

  it('no participants', async () => {
    findThread.mockResolvedValue({ id: THREAD, title: 'Test thread' });
    listParticipants.mockResolvedValue([]);
    await expect(resume()).resolves.toMatchObject({ threadId: THREAD });
  });

  it('no valid agent', async () => {
    findThread.mockResolvedValue({ id: THREAD, title: 'Test thread' });
    listParticipants.mockResolvedValue([{ agentId: 'test-agent-a' }]);
    getAgent.mockResolvedValue(undefined);
    await expect(resume()).resolves.toMatchObject({ threadId: THREAD });
  });
});

describe('session:create rejections name what the client sent', () => {
  it('unknown agent echoes the requested ids so a pane can route the error', async () => {
    getAgent.mockResolvedValue(undefined);
    await handlers.get('socket:session:create')!(
      { agentId: 'test-agent-a', threadId: THREAD, sessionId: 'session-1' },
      { clientId: 'client-1' }
    );
    const frame = sendToClient.mock.calls[0]![1] as {
      type: string;
      payload: Record<string, unknown>;
    };
    expect(frame.type).toBe('socket:error');
    expect(frame.payload).toEqual({
      message: 'Unknown agent: test-agent-a',
      agentId: 'test-agent-a',
      threadId: THREAD,
      sessionId: 'session-1',
    });
  });

  it('unknown agent without client ids keeps the original message and omits the id fields', async () => {
    getAgent.mockResolvedValue(undefined);
    await handlers.get('socket:session:create')!(
      { agentId: 'test-agent-a' },
      { clientId: 'client-1' }
    );
    const frame = sendToClient.mock.calls[0]![1] as { payload: Record<string, unknown> };
    expect(frame.payload).toEqual({
      message: 'Unknown agent: test-agent-a',
      agentId: 'test-agent-a',
    });
  });
});
