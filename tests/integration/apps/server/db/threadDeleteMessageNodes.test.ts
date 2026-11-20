/**
 * Deleting a thread removes its messages' `nodes` rows too. The thread delete
 * cascades the `messages` rows (thread_id -> threads), but that FK does not
 * reach their nodes, so the delete removes them itself; a dead `message` node
 * would keep a doc link to it alive. Checked for
 * DELETE /api/threads/:id and DELETE /api/archive/:id; a clear keeps the
 * thread and still reports what it deleted, and another thread's messages
 * are untouched. Database access is real.
 */

import { afterAll, beforeEach, describe, expect, it, jest } from '@jest/globals';
import express, { Router } from 'express';
import request from 'supertest';
import { getDb } from '@snaglet/db';

jest.mock('@server/services/WebSocketService', () => ({
  wsService: { broadcastToChannel: jest.fn(), sendToClient: jest.fn() },
}));
jest.mock('@server/realtime/surfaces/tree', () => ({
  ...jest.requireActual<object>('@server/realtime/surfaces/tree'),
  emitTreeNodeDeleted: jest.fn(),
}));
jest.mock('@server/realtime/surfaces/threads', () => ({
  ...jest.requireActual<object>('@server/realtime/surfaces/threads'),
  emitThreadDeleted: jest.fn(),
}));

import archiveRouter from '@server/routes/archive';
import { registerThreadCrudRoutes } from '@server/domains/threads/handlers/threadCrud';
import { errorHandler } from '@server/middleware';

const THREAD = 'thread-1111111111111-aaaaaaaaa';
const MESSAGES = ['message-1111111111111-aaaaaaaaa', 'message-1111111111111-bbbbbbbbb'];
const OTHER_THREAD = 'thread-2222222222222-bbbbbbbbb';
const OTHER_MESSAGE = 'message-2222222222222-aaaaaaaaa';
const ALL_IDS = [THREAD, OTHER_THREAD, ...MESSAGES, OTHER_MESSAGE];

const threadsRouter = Router();
registerThreadCrudRoutes(threadsRouter);
const app = express()
  .use(express.json())
  .use('/api/threads', threadsRouter)
  .use('/api/archive', archiveRouter)
  .use(errorHandler);

async function cleanup(): Promise<void> {
  await getDb().query(`DELETE FROM public.nodes WHERE id = ANY($1::text[])`, [ALL_IDS]);
}

async function createThread(threadId: string, messageIds: string[]): Promise<void> {
  const db = getDb();
  await db.query(`INSERT INTO public.nodes (id, type) VALUES ($1, 'thread')`, [threadId]);
  await db.query(`INSERT INTO public.threads (id, title) VALUES ($1, 'Test thread')`, [threadId]);
  for (const messageId of messageIds) {
    await db.query(`INSERT INTO public.nodes (id, type) VALUES ($1, 'message')`, [messageId]);
    await db.query(
      `INSERT INTO public.messages (id, thread_id, role, content) VALUES ($1, $2, 'user', 'Hello')`,
      [messageId, threadId]
    );
  }
}

/** Which of `ids` still have a `nodes` row. */
async function existingNodes(ids: string[]): Promise<string[]> {
  const { rows } = await getDb().query<{ id: string }>(
    `SELECT id FROM public.nodes WHERE id = ANY($1::text[]) ORDER BY id`,
    [ids]
  );
  return rows.map((row) => row.id);
}

describe('deleting a thread removes its message nodes', () => {
  beforeEach(async () => {
    await cleanup();
    await createThread(THREAD, MESSAGES);
    await createThread(OTHER_THREAD, [OTHER_MESSAGE]);
  });
  afterAll(cleanup);

  it('DELETE /api/threads/:id', async () => {
    await request(app).delete(`/api/threads/${THREAD}`).expect(200);
    expect(await existingNodes([THREAD, ...MESSAGES])).toEqual([]);
    expect(await existingNodes([OTHER_THREAD, OTHER_MESSAGE])).toEqual([
      OTHER_MESSAGE,
      OTHER_THREAD,
    ]);
  });

  it('DELETE /api/archive/:id', async () => {
    await getDb().query(
      `UPDATE public.nodes SET archived = true, archived_at = now() WHERE id = $1`,
      [THREAD]
    );
    await request(app).delete(`/api/archive/${THREAD}`).expect(200);
    expect(await existingNodes([THREAD, ...MESSAGES])).toEqual([]);
    expect(await existingNodes([OTHER_THREAD, OTHER_MESSAGE])).toEqual([
      OTHER_MESSAGE,
      OTHER_THREAD,
    ]);
  });

  it('POST /api/threads/:id/clear keeps the thread and counts the messages it deleted', async () => {
    const res = await request(app).post(`/api/threads/${THREAD}/clear`).expect(200);
    expect(res.body.data).toMatchObject({ deletedMessages: MESSAGES.length });
    expect(await existingNodes([THREAD, ...MESSAGES])).toEqual([THREAD]);
    expect(await existingNodes([OTHER_MESSAGE])).toEqual([OTHER_MESSAGE]);
  });
});
