/**
 * PATCH /threads/:threadId/messages/:messageId → socket:chat:message_updated.
 *
 * Other open views of a thread only learn about a content edit (e.g. a
 * checkbox toggle) through this broadcast. It goes out once, to the thread's
 * room, after the update succeeds, carrying exactly
 * {threadId, id, content, updatedAt}. A refused or failed PATCH broadcasts
 * nothing, so no viewer paints content that was never saved.
 */
import express from 'express';
import request from 'supertest';

const mockFindThread = jest.fn();
const mockFindMessage = jest.fn();
const mockUpdateMessage = jest.fn();
const mockBroadcastToChannel = jest.fn();
jest.mock('@snaglet/db/tables/threads', () => ({
  Threads: { findById: (...args: unknown[]) => mockFindThread(...args) },
}));
jest.mock('@snaglet/db/tables/messages', () => ({
  Messages: {
    findById: (...args: unknown[]) => mockFindMessage(...args),
    update: (...args: unknown[]) => mockUpdateMessage(...args),
  },
}));
jest.mock('@server/services/WebSocketService', () => ({
  wsService: { broadcastToChannel: (...args: unknown[]) => mockBroadcastToChannel(...args) },
}));
jest.mock('@server/config/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import { registerMessageRoutes } from '@server/domains/threads/handlers/messageHandlers';
import { errorHandler } from '@server/middleware/errorHandler';
import { emitThreadMessageUpdated } from '@server/realtime/surfaces/threads';

const THREAD = 'thread-test-a';
const OTHER_THREAD = 'thread-test-b';
const MESSAGE = 'message-test-1';
const BEFORE = '- [ ] first item';
const AFTER = '- [x] first item';

function savedRow(content: string) {
  // The full MessageRow shape: everything past the four wire fields must stay
  // off the broadcast.
  return {
    id: MESSAGE,
    threadId: THREAD,
    agentId: null,
    userId: 'user-test',
    role: 'user',
    content,
    messageType: 'message',
    resolved: false,
    createdAt: '2026-01-01T00:00:00.000Z',
    responseOptions: null,
    thinkingContent: null,
    toolActivity: null,
    injectedDuringRun: false,
    usage: null,
    runId: null,
    runError: null,
  };
}

describe('PATCH /threads/:threadId/messages/:messageId broadcast', () => {
  const app = express();
  app.use(express.json());
  const router = express.Router();
  registerMessageRoutes(router);
  app.use('/threads', router);
  app.use(errorHandler);

  beforeEach(() => {
    jest.clearAllMocks();
    mockFindThread.mockResolvedValue({ id: THREAD });
    mockFindMessage.mockResolvedValue({ id: MESSAGE, threadId: THREAD, content: BEFORE });
    mockUpdateMessage.mockResolvedValue(savedRow(AFTER));
  });

  it('emits once, after the save, to the thread room with exactly {threadId, id, content, updatedAt}', async () => {
    const res = await request(app)
      .patch(`/threads/${THREAD}/messages/${MESSAGE}`)
      .send({ content: AFTER });

    expect(res.status).toBe(200);
    expect(mockBroadcastToChannel).toHaveBeenCalledTimes(1);
    const [room, frame] = mockBroadcastToChannel.mock.calls[0] as [
      string,
      { type: string; payload: Record<string, unknown> },
    ];
    expect(room).toBe(THREAD);
    expect(Object.keys(frame).sort()).toEqual(['payload', 'type']);
    expect(frame.type).toBe('socket:chat:message_updated');
    expect(Object.keys(frame.payload).sort()).toEqual(['content', 'id', 'threadId', 'updatedAt']);
    expect(frame.payload).toEqual({
      threadId: THREAD,
      id: MESSAGE,
      content: AFTER,
      updatedAt: expect.any(String),
    });
    const updatedAt = frame.payload.updatedAt as string;
    expect(new Date(updatedAt).toISOString()).toBe(updatedAt);
    // The broadcast follows the write, never precedes it.
    expect(mockUpdateMessage.mock.invocationCallOrder[0]).toBeLessThan(
      mockBroadcastToChannel.mock.invocationCallOrder[0]!
    );
  });

  it('does not emit when the thread does not exist', async () => {
    mockFindThread.mockResolvedValue(null);
    const res = await request(app)
      .patch(`/threads/${THREAD}/messages/${MESSAGE}`)
      .send({ content: AFTER });

    expect(res.status).toBe(404);
    expect(mockUpdateMessage).not.toHaveBeenCalled();
    expect(mockBroadcastToChannel).not.toHaveBeenCalled();
  });

  it('does not emit when content is missing', async () => {
    const res = await request(app).patch(`/threads/${THREAD}/messages/${MESSAGE}`).send({});

    expect(res.status).toBe(400);
    expect(mockUpdateMessage).not.toHaveBeenCalled();
    expect(mockBroadcastToChannel).not.toHaveBeenCalled();
  });

  it('does not emit for a message that belongs to another thread', async () => {
    mockFindMessage.mockResolvedValue({ id: MESSAGE, threadId: OTHER_THREAD, content: BEFORE });
    const res = await request(app)
      .patch(`/threads/${THREAD}/messages/${MESSAGE}`)
      .send({ content: AFTER });

    expect(res.status).toBe(404);
    expect(mockUpdateMessage).not.toHaveBeenCalled();
    expect(mockBroadcastToChannel).not.toHaveBeenCalled();
  });

  it('does not emit when the update finds no row', async () => {
    mockUpdateMessage.mockResolvedValue(null);
    const res = await request(app)
      .patch(`/threads/${THREAD}/messages/${MESSAGE}`)
      .send({ content: AFTER });

    expect(res.status).toBe(404);
    expect(mockBroadcastToChannel).not.toHaveBeenCalled();
  });

  it('does not emit when the update fails', async () => {
    mockUpdateMessage.mockRejectedValue(new Error('write failed'));
    const res = await request(app)
      .patch(`/threads/${THREAD}/messages/${MESSAGE}`)
      .send({ content: AFTER });

    expect(res.status).toBe(500);
    expect(mockBroadcastToChannel).not.toHaveBeenCalled();
  });
});

describe('emitThreadMessageUpdated', () => {
  beforeEach(() => jest.clearAllMocks());

  it('puts only the four wire fields on the frame, even when handed a wider object', () => {
    const wider = {
      ...savedRow(AFTER),
      updatedAt: '2026-01-01T00:00:01.000Z',
    };
    emitThreadMessageUpdated(wider);

    expect(mockBroadcastToChannel).toHaveBeenCalledTimes(1);
    expect(mockBroadcastToChannel).toHaveBeenCalledWith(THREAD, {
      type: 'socket:chat:message_updated',
      payload: {
        threadId: THREAD,
        id: MESSAGE,
        content: AFTER,
        updatedAt: '2026-01-01T00:00:01.000Z',
      },
    });
  });
});
