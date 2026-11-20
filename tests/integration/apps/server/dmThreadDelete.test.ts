/**
 * Deleting a DM conversation from the DM pane goes through the ordinary
 * thread route, `DELETE /api/threads/:id`. Against a real database: an
 * agent-to-agent DM is removed with its messages and participants, the tree
 * and thread deleted events go out, and the next DM between the pair opens a
 * fresh thread. The user's home thread with an agent is refused (403, use
 * Clear) and left exactly as it was.
 *
 * Only socket fan-out and the dispatch wave are stubbed.
 */
import { beforeAll, beforeEach, describe, expect, it, jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';

const broadcastToChannel = jest.fn();
jest.mock('@server/services/WebSocketService', () => ({
  wsService: {
    sendToClient: jest.fn(),
    broadcastToChannel: (...a: unknown[]) => broadcastToChannel(...a),
    registerHandler: jest.fn(),
  },
  addChannelObserver: jest.fn(),
}));
jest.mock('@server/services/SocketService/dispatch/dispatchToThread', () => ({
  dispatchToThread: jest.fn(async () => ({
    ok: true as const,
    wakeCount: 0,
    capHit: false,
    reason: 'completed' as const,
  })),
  dispatchToThreadInternal: jest.fn(),
  redispatchPersistedMessage: jest.fn(async () => undefined),
}));

import { getDb } from '@snaglet/db';
import { Agents } from '@snaglet/db/tables/agents';
import { Threads } from '@snaglet/db/tables/threads';
import { Users } from '@snaglet/db/tables/users';
import { WORKSPACE_EVENT_CHANNEL } from '@snaglet/shared/types/workspace-events';
import { errorHandler } from '@server/middleware';
import { registerDmRoutes } from '@server/domains/threads/handlers/dmHandlers';
import { registerThreadCrudRoutes } from '@server/domains/threads/handlers/threadCrud';
import { DmService } from '@server/services/dm/DmService';

const AGENT_A = 'test-agent-a';
const AGENT_B = 'test-agent-b';

async function count(sql: string, params: unknown[] = []): Promise<number> {
  const { rows } = await getDb().query<{ n: number }>(sql, params);
  return Number(rows[0]?.n ?? 0);
}

/** Workspace events broadcast so far, as `{ type, id }`. */
function workspaceEvents(): Array<{ type: unknown; id: unknown }> {
  return broadcastToChannel.mock.calls
    .filter(([channel]) => channel === WORKSPACE_EVENT_CHANNEL)
    .map(([, message]) => {
      const payload = (message as { payload?: { type?: unknown; id?: unknown } }).payload;
      return { type: payload?.type, id: payload?.id };
    });
}

let app: express.Application;
let userId: string;

beforeAll(async () => {
  if (!(await Agents.findById(AGENT_A))) await Agents.create({ id: AGENT_A, name: 'Test Agent A' });
  if (!(await Agents.findById(AGENT_B))) await Agents.create({ id: AGENT_B, name: 'Test Agent B' });
  // The routes act as the local user; resolve the same one they will.
  const user = (await Users.getActiveUser()) ?? (await Users.getOrCreateLocalUser());
  userId = user.id;

  app = express();
  app.use(express.json());
  const router = express.Router();
  // Same order as threads.routes.ts: the DM routes before the `/:id` routes.
  registerDmRoutes(router);
  registerThreadCrudRoutes(router);
  app.use('/api/threads', router);
  app.use(errorHandler);
});

beforeEach(async () => {
  await getDb().query(
    `DELETE FROM public.nodes WHERE id IN (SELECT id FROM public.threads WHERE kind = 'dm')`
  );
  broadcastToChannel.mockClear();
});

const messagesIn = (threadId: string) =>
  count(`SELECT count(*)::int AS n FROM public.messages WHERE thread_id = $1`, [threadId]);
const participantsIn = (threadId: string) =>
  count(`SELECT count(*)::int AS n FROM public.thread_participants WHERE thread_id = $1`, [
    threadId,
  ]);

describe('DELETE /api/threads/:id on a DM thread', () => {
  it('removes an agent-to-agent DM, broadcasts the deletes, and the next DM opens a fresh thread', async () => {
    const { threadId } = await DmService.send({
      from: { kind: 'agent', agentId: AGENT_A },
      to: { kind: 'agent', agentId: AGENT_B },
      content: 'hello from test-agent-a',
    });
    expect(await messagesIn(threadId)).toBe(1);
    broadcastToChannel.mockClear();

    const deleted = await request(app).delete(`/api/threads/${threadId}`);

    expect(deleted.status).toBe(200);
    expect(await Threads.findById(threadId)).toBeFalsy();
    expect(await messagesIn(threadId)).toBe(0);
    expect(await participantsIn(threadId)).toBe(0);
    expect(workspaceEvents()).toEqual(
      expect.arrayContaining([
        { type: 'workspace.deleted', id: threadId },
        { type: 'thread.deleted', id: threadId },
      ])
    );

    const again = await DmService.send({
      from: { kind: 'agent', agentId: AGENT_A },
      to: { kind: 'agent', agentId: AGENT_B },
      content: 'hello again',
    });
    expect(again.threadId).not.toBe(threadId);
    expect(await messagesIn(again.threadId)).toBe(1);
  });

  it('refuses the home thread, says to use Clear, and leaves it as it was', async () => {
    const opened = await request(app).post('/api/threads/dm').send({ agentId: AGENT_A });
    expect(opened.status).toBe(200);
    const threadId: string = opened.body.data.thread.id;
    await DmService.send({
      from: { kind: 'agent', agentId: AGENT_A },
      to: { kind: 'user', userId },
      content: 'hello from test-agent-a',
    });
    broadcastToChannel.mockClear();

    const refused = await request(app).delete(`/api/threads/${threadId}`);

    expect(refused.status).toBe(403);
    expect(refused.body).toMatchObject({
      success: false,
      error: {
        code: 'FORBIDDEN',
        message: "The home thread can't be deleted. Use Clear to remove its messages.",
      },
    });
    expect(await Threads.findById(threadId)).toBeTruthy();
    expect(await messagesIn(threadId)).toBe(1);
    expect(await participantsIn(threadId)).toBe(2);
    expect(workspaceEvents()).toEqual([]);

    // Clear still empties it, and the thread stays.
    const cleared = await request(app).post(`/api/threads/${threadId}/clear`).send({});
    expect(cleared.status).toBe(200);
    expect(await messagesIn(threadId)).toBe(0);
    expect(await Threads.findById(threadId)).toBeTruthy();
  });
});
