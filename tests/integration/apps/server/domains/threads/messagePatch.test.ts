/**
 * PATCH /api/threads/:threadId/messages/:messageId, the message-content edit
 * (the chat's checkbox-toggle autosave). The edit lands only on a message in
 * that thread; an id from another thread is a 404 NOT_FOUND like a missing one
 * and is left untouched. A saved edit is broadcast as
 * `socket:chat:message_updated` to the thread's room; a refused edit broadcasts
 * nothing. Only the socket fan-out is stubbed.
 */

import { beforeAll, beforeEach, describe, expect, it, jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';

const broadcastToChannel = jest.fn();
jest.mock('@server/services/WebSocketService', () => ({
  wsService: { broadcastToChannel: (...a: unknown[]) => broadcastToChannel(...a) },
}));

import { Messages, Threads, Users } from '@snaglet/db';
import { errorHandler } from '@server/middleware';
import { registerMessageRoutes } from '@server/domains/threads/handlers/messageHandlers';

const PREFIX = 'message-patch';
const THREAD_A = `thread-${PREFIX}-a`;
const THREAD_B = `thread-${PREFIX}-b`;
const MESSAGE_IN_B = `message-${PREFIX}-b-1`;
const ORIGINAL = '- [ ] first item';

function makeApp(): express.Application {
  const app = express();
  app.use(express.json());
  const router = express.Router();
  registerMessageRoutes(router);
  app.use('/api/threads', router);
  app.use(errorHandler);
  return app;
}

let app: express.Application;

beforeAll(async () => {
  const user = await Users.getOrCreateLocalUser();
  await Threads.create({ id: THREAD_A, title: `${PREFIX} a` });
  await Threads.create({ id: THREAD_B, title: `${PREFIX} b` });
  await Messages.create({
    id: MESSAGE_IN_B,
    threadId: THREAD_B,
    role: 'user',
    content: ORIGINAL,
    agentId: null,
    userId: user.id,
  });
  app = makeApp();
});

beforeEach(() => broadcastToChannel.mockClear());

describe('PATCH /api/threads/:threadId/messages/:messageId', () => {
  it('refuses a message that belongs to another thread with 404 and leaves it unchanged', async () => {
    const res = await request(app)
      .patch(`/api/threads/${THREAD_A}/messages/${MESSAGE_IN_B}`)
      .send({ content: '- [x] first item' });

    expect(res.status).toBe(404);
    expect(res.body.success).toBe(false);
    expect(res.body.error.code).toBe('NOT_FOUND');
    expect((await Messages.findById(MESSAGE_IN_B))?.content).toBe(ORIGINAL);
    expect(broadcastToChannel).not.toHaveBeenCalled();
  });

  it('reports an unknown message id the same way', async () => {
    const res = await request(app)
      .patch(`/api/threads/${THREAD_A}/messages/message-${PREFIX}-missing`)
      .send({ content: 'anything' });

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
    expect(broadcastToChannel).not.toHaveBeenCalled();
  });

  it('refuses a body without string content and broadcasts nothing', async () => {
    const res = await request(app)
      .patch(`/api/threads/${THREAD_B}/messages/${MESSAGE_IN_B}`)
      .send({ content: 42 });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect((await Messages.findById(MESSAGE_IN_B))?.content).toBe(ORIGINAL);
    expect(broadcastToChannel).not.toHaveBeenCalled();
  });

  it('updates a message addressed through its own thread', async () => {
    const res = await request(app)
      .patch(`/api/threads/${THREAD_B}/messages/${MESSAGE_IN_B}`)
      .send({ content: '- [x] first item' });

    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ id: MESSAGE_IN_B, content: '- [x] first item' });
    expect((await Messages.findById(MESSAGE_IN_B))?.content).toBe('- [x] first item');
  });

  it('broadcasts the saved edit once, to its thread room, with exactly four fields', async () => {
    const res = await request(app)
      .patch(`/api/threads/${THREAD_B}/messages/${MESSAGE_IN_B}`)
      .send({ content: '- [x] first item\n- [ ] second item' });

    expect(res.status).toBe(200);
    expect(broadcastToChannel).toHaveBeenCalledTimes(1);
    const [room, frame] = broadcastToChannel.mock.calls[0] as [
      string,
      { type: string; payload: Record<string, unknown> },
    ];
    expect(room).toBe(THREAD_B);
    expect(frame.type).toBe('socket:chat:message_updated');
    expect(Object.keys(frame.payload).sort()).toEqual(['content', 'id', 'threadId', 'updatedAt']);
    expect(frame.payload).toEqual({
      threadId: THREAD_B,
      id: MESSAGE_IN_B,
      content: '- [x] first item\n- [ ] second item',
      updatedAt: expect.any(String),
    });
    const updatedAt = frame.payload.updatedAt as string;
    expect(new Date(updatedAt).toISOString()).toBe(updatedAt);
  });
});
