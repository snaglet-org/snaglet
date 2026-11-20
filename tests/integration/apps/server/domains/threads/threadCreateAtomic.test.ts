/**
 * POST /api/threads creates the thread and its first participants as one unit.
 * A failed participant write leaves no orphan thread or half roster and
 * broadcasts nothing; the failure is injected into the user-participant write
 * after the thread row and agent participant are written, so those roll back
 * too. Realtime goes out only after the commit, in route order
 * (workspace.created, thread.created, then the thread:create hook), and a
 * separate connection already sees the whole roster at the first broadcast.
 * The route and DB are real; the socket fan-out and hook bus are observed.
 */

import { afterEach, beforeAll, describe, expect, it, jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';
import { Agents, ThreadParticipants, Users, getDb } from '@snaglet/db';
import type { WsMessage } from '@snaglet/shared/types';
import { errorHandler } from '@server/middleware';
import { registerThreadCrudRoutes } from '@server/domains/threads/handlers/threadCrud';
import { hooks, type HookEventMap } from '@server/services/HookService';
import { wsService } from '@server/services/WebSocketService';

const AGENT_ID = 'test-agent-a';

interface Persisted {
  threads: number;
  nodes: number;
  participants: number;
}

interface Broadcast {
  type: string;
  id: string | undefined;
  /** What a separate connection saw for that id when the broadcast went out. */
  visible: Promise<Persisted> | null;
}

let app: express.Application;
let userId: string;

beforeAll(async () => {
  await Agents.create({ id: AGENT_ID, name: 'Test Agent A' });
  userId = (await Users.getOrCreateLocalUser()).id;
  const instance = express();
  instance.use(express.json());
  const router = express.Router();
  registerThreadCrudRoutes(router);
  instance.use('/api/threads', router);
  instance.use(errorHandler);
  app = instance;
});

afterEach(() => {
  jest.restoreAllMocks();
});

/** Rows a separate (pool) connection sees for a thread id. */
async function persisted(threadId: string): Promise<Persisted> {
  const { rows } = await getDb().query<{ threads: string; nodes: string; participants: string }>(
    `SELECT (SELECT count(*) FROM public.threads WHERE id = $1) AS threads,
            (SELECT count(*) FROM public.nodes WHERE id = $1) AS nodes,
            (SELECT count(*) FROM public.thread_participants WHERE thread_id = $1) AS participants`,
    [threadId]
  );
  const row = rows[0]!;
  return {
    threads: Number(row.threads),
    nodes: Number(row.nodes),
    participants: Number(row.participants),
  };
}

/** Record every workspace broadcast and what was committed at that moment. */
function observeBroadcasts(): Broadcast[] {
  const seen: Broadcast[] = [];
  jest
    .spyOn(wsService, 'broadcastToChannel')
    .mockImplementation((_channel: string, message: WsMessage<unknown>) => {
      const payload = message.payload as { node?: { id?: string }; thread?: { id?: string } };
      const id = payload.node?.id ?? payload.thread?.id;
      seen.push({ type: message.type, id, visible: id ? persisted(id) : null });
    });
  return seen;
}

/** Capture `thread:create` hook emits (and keep real hooks from running). */
function observeThreadCreateHook(): {
  emits: Array<HookEventMap['thread:create']>;
  next: Promise<HookEventMap['thread:create']>;
} {
  const emits: Array<HookEventMap['thread:create']> = [];
  let resolveNext: (payload: HookEventMap['thread:create']) => void = () => {};
  const next = new Promise<HookEventMap['thread:create']>((resolve) => {
    resolveNext = resolve;
  });
  jest.spyOn(hooks, 'emit').mockImplementation((event, payload) => {
    if (event !== 'thread:create') return;
    const created = payload as HookEventMap['thread:create'];
    emits.push(created);
    resolveNext(created);
  });
  return { emits, next };
}

describe('POST /api/threads atomicity', () => {
  it('leaves no thread, node or participant and broadcasts nothing when a participant write fails', async () => {
    const broadcasts = observeBroadcasts();
    const hook = observeThreadCreateHook();
    const attempted: string[] = [];
    const real = ThreadParticipants.addUserParticipant.bind(ThreadParticipants);
    jest
      .spyOn(ThreadParticipants, 'addUserParticipant')
      .mockImplementation(async (...args: Parameters<typeof real>) => {
        attempted.push(args[0].threadId);
        await real(...args);
        throw new Error('injected participant failure');
      });

    const res = await request(app)
      .post('/api/threads')
      .send({ title: 'Test thread', agentId: AGENT_ID, userId });

    expect(res.status).toBe(500);
    expect(attempted).toHaveLength(1);
    expect(await persisted(attempted[0]!)).toEqual({ threads: 0, nodes: 0, participants: 0 });
    expect(broadcasts).toEqual([]);
    expect(hook.emits).toEqual([]);
  });

  it('creates the thread with both participants and broadcasts only after the commit, in order', async () => {
    const broadcasts = observeBroadcasts();
    const hook = observeThreadCreateHook();

    const res = await request(app)
      .post('/api/threads')
      .send({ title: 'Test thread', agentId: AGENT_ID, userId });

    expect(res.status).toBe(201);
    const id = res.body.data.id as string;
    expect(await persisted(id)).toEqual({ threads: 1, nodes: 1, participants: 2 });

    const forThread = broadcasts.filter((b) => b.id === id);
    expect(forThread.map((b) => b.type)).toEqual(['workspace.created', 'thread.created']);
    // The first broadcast already sees the committed thread and full roster.
    expect(await forThread[0]!.visible).toEqual({ threads: 1, nodes: 1, participants: 2 });

    // The hook builder reads the roster through the pool, so a complete
    // roster here means it ran after the commit too.
    const created = await hook.next;
    expect(created.id).toBe(id);
    expect(created.participants.map((p) => `${p.kind}:${p.id}`).sort()).toEqual([
      `agent:${AGENT_ID}`,
      `user:${userId}`,
    ]);
  });
});
