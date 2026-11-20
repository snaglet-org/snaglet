/**
 * Thread history trimming against the real database. Trimming is the only
 * destructive path that removes part of a thread, so it must hold:
 *   - the three replay sources (messages, runs, agent_activity_log) stay
 *     consistent, or the next turn replays deleted content;
 *   - a run is indivisible (replayAssembly renders a run from its activity
 *     even with no messages left), so no cut may split one;
 *   - `messages.id` references `nodes(id)`, so deletes go through the node spine;
 *   - `agent_activity_log.run_id` is ON DELETE SET NULL, so activity is
 *     deleted before its runs;
 *   - a summary survives unless the user asks to remove it, with its coverage
 *     bookkeeping repaired;
 *   - all of it is all-or-nothing.
 * Each test seeds its own thread so ordering between tests cannot matter.
 */

import { afterAll, beforeAll, describe, expect, it, jest } from '@jest/globals';
import { createServer, type Server } from 'node:http';
import express from 'express';
import request from 'supertest';

const broadcastToChannel = jest.fn();
jest.mock('@server/services/WebSocketService', () => ({
  wsService: { broadcastToChannel: (...a: unknown[]) => broadcastToChannel(...a) },
}));

import { getDb, Messages, Threads, Users } from '@snaglet/db';
import { Agents } from '@snaglet/db/tables/agents';
import { AgentActivityLog } from '@snaglet/db/tables/agent_activity_log';
import { Runs } from '@snaglet/db/tables/runs';
import { ThreadSummaries } from '@snaglet/db/tables/thread_summaries';
import { errorHandler } from '@server/middleware';
import { registerTrimRoutes } from '@server/domains/threads/handlers/trimHandlers';
import { activeRunTracker } from '@server/services/ActiveRunTracker';
import { withReservedThreadTransaction } from '@server/services/ThreadExecutionPurgeService';
import type { ThreadTrimPreview, ThreadTrimStats } from '@snaglet/shared/types';

const PREFIX = 'trim-it';
const AGENT_ID = `agent-${PREFIX}`;
const BASE_TIME = Date.parse('2026-05-01T00:00:00.000Z');

function makeApp() {
  const app = express();
  app.use(express.json());
  const router = express.Router();
  registerTrimRoutes(router);
  app.use('/threads', router);
  app.use(errorHandler);
  return app;
}

/**
 * One server per file, bound explicitly to 127.0.0.1 (the address supertest
 * dials). `request(server)` listens on the dual-stack `::` wildcard, and on
 * macOS another process can still bind 127.0.0.1 on that same port and answer
 * instead — a foreign 404 under parallel load.
 */
let server: Server;

async function startServer(): Promise<void> {
  server = createServer(makeApp());
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
}

async function stopServer(): Promise<void> {
  if (!server?.listening) return;
  await new Promise<void>((resolve, reject) =>
    server.close((err) => (err ? reject(err) : resolve()))
  );
}

// Fixture builders

/** One timeline entry: a bare user message, or a run with messages + activity. */
type Entry =
  | { kind: 'user'; content?: string }
  | { kind: 'run'; runId: string; replies: number; activity: number; status?: string };

interface SeededThread {
  threadId: string;
  /** Message ids in `(created_at, id)` order — index i is ordinal i. */
  ids: string[];
  runIds: string[];
}

let userId = '';

/**
 * Seed a thread whose ordering is fully deterministic.
 *
 * `Messages.create` stamps `now()`, which would make ordinals depend on wall
 * clock and could collide inside a millisecond, so every row's `created_at` is
 * rewritten to `BASE_TIME + n seconds` afterward. That makes ordinal N in the
 * test the same row the server's `(created_at, id)` keyset calls ordinal N.
 */
async function seedThread(suffix: string, entries: Entry[]): Promise<SeededThread> {
  const threadId = `thread-${PREFIX}-${suffix}`;
  await Threads.create({ id: threadId, title: `${PREFIX} ${suffix}` });

  const ids: string[] = [];
  const runIds: string[] = [];
  let seq = 0;

  for (const entry of entries) {
    if (entry.kind === 'user') {
      const id = `message-${PREFIX}-${suffix}-${String(seq).padStart(4, '0')}`;
      await Messages.create({
        id,
        threadId,
        role: 'user',
        content: entry.content ?? `user ${seq}`,
        agentId: null,
        userId,
      });
      await stampCreatedAt('messages', id, seq);
      ids.push(id);
      seq += 1;
      continue;
    }

    const runId = `run-${PREFIX}-${suffix}-${entry.runId}`;
    runIds.push(runId);
    await Runs.create({
      id: runId,
      threadId,
      agentId: AGENT_ID,
      providerId: 'anthropic',
      model: 'claude-haiku-4-5-20251001',
      status: entry.status ?? 'completed',
      startedAt: new Date(BASE_TIME + seq * 1000).toISOString(),
    });
    for (let i = 0; i < entry.activity; i += 1) {
      await AgentActivityLog.logActivity({
        agentId: AGENT_ID,
        runId,
        actionType: 'tool_call',
        triggerType: 'manual',
        tool: 'workspace_search',
        toolInput: { query: `${suffix} ${entry.runId} ${i}` },
        toolOutput: { hits: i },
      });
    }
    for (let i = 0; i < entry.replies; i += 1) {
      const id = `message-${PREFIX}-${suffix}-${String(seq).padStart(4, '0')}`;
      await Messages.create({
        id,
        threadId,
        role: 'assistant',
        content: `reply ${seq} of ${entry.runId}`,
        agentId: AGENT_ID,
        userId: null,
        runId,
      });
      await stampCreatedAt('messages', id, seq);
      ids.push(id);
      seq += 1;
    }
  }

  return { threadId, ids, runIds };
}

async function stampCreatedAt(table: string, id: string, seq: number): Promise<void> {
  await getDb().query(`UPDATE public.${table} SET created_at = $2 WHERE id = $1`, [
    id,
    new Date(BASE_TIME + seq * 1000).toISOString(),
  ]);
}

/** Attach a summary covering the thread through `lastMessageId`. */
async function seedSummary(
  threadId: string,
  suffix: string,
  lastMessageId: string | null,
  messagesCovered: number
): Promise<string> {
  const id = `thread_summary-${PREFIX}-${suffix}`;
  const row = await ThreadSummaries.insertNewVersion({
    id,
    threadId,
    agentId: null,
    summaryText: `summary ${suffix} — the compressed memory of this thread`,
    messagesCovered,
    ...(lastMessageId ? { lastMessageId } : {}),
  });
  expect(row.id).toBe(id);
  return id;
}

/** The bookkeeping fields a trim is allowed to touch, plus the ones it is not. */
async function summaryState(id: string): Promise<{
  messagesCovered: number;
  lastMessageId: string | null;
  version: number;
  isCurrent: boolean;
  summaryText: string;
} | null> {
  const row = await ThreadSummaries.findByIdWithNode(id);
  if (!row) return null;
  return {
    messagesCovered: row.messagesCovered,
    lastMessageId: row.lastMessageId,
    version: row.version,
    isCurrent: row.isCurrent,
    summaryText: row.summaryText,
  };
}

async function countRows(sql: string, params: unknown[]): Promise<number> {
  const { rows } = await getDb().query<{ n: string }>(sql, params);
  return Number(rows[0]?.n ?? 0);
}

const orphanMessageNodes = (threadId: string): Promise<number> =>
  countRows(
    `SELECT count(*)::text AS n FROM public.nodes n
      WHERE n.type = 'message' AND n.id LIKE $1
        AND NOT EXISTS (SELECT 1 FROM public.messages m WHERE m.id = n.id)`,
    [`message-${PREFIX}-${threadId.replace(`thread-${PREFIX}-`, '')}-%`]
  );

const strandedActivity = (): Promise<number> =>
  countRows(
    `SELECT count(*)::text AS n FROM public.agent_activity_log WHERE agent_id = $1 AND run_id IS NULL`,
    [AGENT_ID]
  );

// Request helpers

async function getStats(threadId: string): Promise<ThreadTrimStats> {
  const res = await request(server).get(`/threads/${threadId}/trim/stats`);
  expect(res.status).toBe(200);
  return res.body.data as ThreadTrimStats;
}

async function preview(
  threadId: string,
  body: Record<string, unknown>
): Promise<ThreadTrimPreview> {
  const res = await request(server).post(`/threads/${threadId}/trim/preview`).send(body);
  expect(res.status).toBe(200);
  return res.body.data as ThreadTrimPreview;
}

function applyFrom(threadId: string, p: ThreadTrimPreview) {
  return request(server).post(`/threads/${threadId}/trim/apply`).send({
    firstRetainedMessageId: p.firstRetained.messageId,
    lastRetainedMessageId: p.lastRetained.messageId,
    removeSummaries: p.removeSummaries,
    token: p.token,
  });
}

async function orderedMessageIds(threadId: string): Promise<string[]> {
  const { rows } = await getDb().query<{ id: string }>(
    `SELECT id FROM public.messages WHERE thread_id = $1 ORDER BY created_at ASC, id ASC`,
    [threadId]
  );
  return rows.map((r) => r.id);
}

async function cleanup(): Promise<void> {
  const pool = getDb();
  await pool.query(`DROP TABLE IF EXISTS public.trim_rollback_guard`);
  await pool.query(`DROP TABLE IF EXISTS public.trim_repair_guard`);
  await pool.query(`DELETE FROM public.agent_activity_log WHERE agent_id = $1`, [AGENT_ID]);
  await pool.query(`DELETE FROM public.runs WHERE id LIKE $1`, [`run-${PREFIX}-%`]);
  await pool.query(`DELETE FROM public.messages WHERE thread_id LIKE $1`, [`thread-${PREFIX}-%`]);
  await pool.query(`DELETE FROM public.thread_summaries WHERE thread_id LIKE $1`, [
    `thread-${PREFIX}-%`,
  ]);
  await pool.query(`DELETE FROM public.threads WHERE id LIKE $1`, [`thread-${PREFIX}-%`]);
  await pool.query(`DELETE FROM public.nodes WHERE id LIKE $1 OR id LIKE $2 OR id LIKE $3`, [
    `thread-${PREFIX}-%`,
    `message-${PREFIX}-%`,
    `thread_summary-${PREFIX}-%`,
  ]);
  await pool.query(`DELETE FROM public.agents WHERE id = $1`, [AGENT_ID]);
}

describe('thread history trimming', () => {
  beforeAll(async () => {
    await cleanup();
    await Agents.create({ id: AGENT_ID, name: `${PREFIX}-agent` });
    userId = (await Users.getOrCreateLocalUser()).id;
    await startServer();
  });
  afterAll(async () => {
    await stopServer();
    await cleanup();
  });

  // Stats

  describe('GET /:id/trim/stats — canonical totals', () => {
    it('reports message count and byte weight across all four record kinds', async () => {
      const { threadId } = await seedThread('stats', [
        { kind: 'user' },
        { kind: 'run', runId: 'a', replies: 2, activity: 3 },
      ]);
      await seedSummary(threadId, 'stats', null, 3);

      const stats = await getStats(threadId);
      expect(stats.messageCount).toBe(3);
      expect(stats.totals.messages).toBe(3);
      expect(stats.totals.runs).toBe(1);
      expect(stats.totals.activity).toBe(3);
      expect(stats.totals.summaries).toBe(1);
      expect(stats.totals.bytes.messages).toBeGreaterThan(0);
      expect(stats.totals.bytes.activity).toBeGreaterThan(0);
      expect(stats.totals.bytes.summaries).toBeGreaterThan(0);
      // The reported total is exactly the sum of its parts.
      const b = stats.totals.bytes;
      expect(b.total).toBe(
        b.messages + b.messageEmbeddings + b.runs + b.activity + b.summaries + b.summaryEmbeddings
      );
    });

    it('404s for a thread that does not exist', async () => {
      const res = await request(server).get(`/threads/thread-${PREFIX}-missing/trim/stats`);
      expect(res.status).toBe(404);
    });

    it('reports zeroes for a thread with no messages', async () => {
      const { threadId } = await seedThread('empty-stats', []);
      const stats = await getStats(threadId);
      expect(stats.messageCount).toBe(0);
      expect(stats.totals.messages).toBe(0);
      expect(stats.totals.bytes.total).toBe(0);
    });
  });

  // Preview

  describe('POST /:id/trim/preview', () => {
    it('rejects trimming a thread with no messages', async () => {
      const { threadId } = await seedThread('empty-preview', []);
      const res = await request(server)
        .post(`/threads/${threadId}/trim/preview`)
        .send({ removeSummaries: false });
      expect(res.status).toBe(400);
    });

    it('reports a no-op on a one-message thread', async () => {
      const { threadId } = await seedThread('one-message', [{ kind: 'user' }]);
      const p = await preview(threadId, {
        firstRetainedIndex: 0,
        lastRetainedIndex: 0,
        removeSummaries: false,
      });
      expect(p.noop).toBe(true);
      expect(p.removed.messages).toBe(0);
      expect(p.remaining.messages).toBe(1);
    });

    it('counts an inclusive retained interval exactly', async () => {
      const { threadId, ids } = await seedThread(
        'inclusive',
        Array.from({ length: 10 }, () => ({ kind: 'user' as const }))
      );
      const p = await preview(threadId, {
        firstRetainedIndex: 3,
        lastRetainedIndex: 6,
        removeSummaries: false,
      });
      // Retain 3,4,5,6 → 4 kept, 6 removed. Boundaries are themselves retained.
      expect(p.firstRetained.messageId).toBe(ids[3]);
      expect(p.lastRetained.messageId).toBe(ids[6]);
      expect(p.remaining.messages).toBe(4);
      expect(p.removed.messages).toBe(6);
      expect(p.removed.messages + p.remaining.messages).toBe(p.totals.messages);
    });

    /**
     * There is one operation, so which sides get cut has to fall out of the
     * handle positions alone. A handle left at its extreme cuts nothing on that
     * side, which is how "remove only older" and "remove only newer" are
     * expressed without a mode.
     */
    it('derives the cut sides from the handle positions', async () => {
      const { threadId, ids } = await seedThread(
        'sides',
        Array.from({ length: 8 }, () => ({ kind: 'user' as const }))
      );

      // Left handle moved, right handle at the newest message → older only.
      const older = await preview(threadId, {
        firstRetainedIndex: 3,
        lastRetainedIndex: 7,
        removeSummaries: false,
      });
      expect(older.sides).toBe('prefix');
      expect(older.lastRetained.messageId).toBe(ids[7]);
      expect(older.removed.messages).toBe(3);

      // Right handle moved, left handle at the oldest message → newer only.
      const newer = await preview(threadId, {
        firstRetainedIndex: 0,
        lastRetainedIndex: 5,
        removeSummaries: false,
      });
      expect(newer.sides).toBe('tail');
      expect(newer.firstRetained.messageId).toBe(ids[0]);
      expect(newer.removed.messages).toBe(2);

      // Both moved → both sides.
      const both = await preview(threadId, {
        firstRetainedIndex: 3,
        lastRetainedIndex: 5,
        removeSummaries: false,
      });
      expect(both.sides).toBe('both');
      expect(both.removed.messages).toBe(5);

      // Neither moved → nothing is cut, and the plan says so.
      const none = await preview(threadId, {
        firstRetainedIndex: 0,
        lastRetainedIndex: 7,
        removeSummaries: false,
      });
      expect(none.sides).toBe('none');
      expect(none.noop).toBe(true);
    });

    /** An omitted edge means "do not cut this side". */
    it('defaults an omitted boundary to the end of the thread', async () => {
      const { threadId, ids } = await seedThread(
        'defaults',
        Array.from({ length: 6 }, () => ({ kind: 'user' as const }))
      );

      const noLast = await preview(threadId, { firstRetainedIndex: 2, removeSummaries: false });
      expect(noLast.lastRetained.messageId).toBe(ids[5]);
      expect(noLast.sides).toBe('prefix');

      const noFirst = await preview(threadId, { lastRetainedIndex: 3, removeSummaries: false });
      expect(noFirst.firstRetained.messageId).toBe(ids[0]);
      expect(noFirst.sides).toBe('tail');
    });

    /**
     * `timestamptz` stores microseconds; a JS `Date` holds milliseconds.
     * Resolving the boundary through `Date` would truncate the keyset below the
     * real row, so `created_at > boundary` would match the boundary row itself
     * and delete the message the user confirmed as last retained. Every other
     * fixture here stamps whole milliseconds, so only this one catches it.
     */
    it('keeps both boundary messages when timestamps carry microseconds', async () => {
      const { threadId, ids } = await seedThread(
        'microseconds',
        Array.from({ length: 8 }, () => ({ kind: 'user' as const }))
      );
      // Re-stamp with a non-zero microsecond remainder, preserving the order.
      await getDb().query(
        `UPDATE public.messages m
            SET created_at = $2::timestamptz
                             + (o.ord || ' seconds')::interval
                             + '437 microseconds'::interval
           FROM (SELECT id, ROW_NUMBER() OVER (ORDER BY created_at, id) - 1 AS ord
                   FROM public.messages WHERE thread_id = $1) o
          WHERE m.id = o.id`,
        [threadId, new Date(BASE_TIME).toISOString()]
      );

      const p = await preview(threadId, {
        firstRetainedIndex: 2,
        lastRetainedIndex: 5,
        removeSummaries: false,
      });
      // Retaining 2,3,4,5 inclusive → 4 kept, 4 removed.
      expect(p.firstRetained.messageId).toBe(ids[2]);
      expect(p.lastRetained.messageId).toBe(ids[5]);
      expect(p.remaining.messages).toBe(4);
      expect(p.removed.messages).toBe(4);

      const res = await applyFrom(threadId, p);
      expect(res.status).toBe(200);
      // The confirmed boundaries are still here — that is the whole point.
      expect(await orderedMessageIds(threadId)).toEqual([ids[2], ids[3], ids[4], ids[5]]);
    });

    it('expands the retained interval so a run is never split', async () => {
      // ordinals: 0 user | 1,2,3 run-a | 4 user | 5,6 run-b | 7 user
      const { threadId, ids } = await seedThread('atomicity', [
        { kind: 'user' },
        { kind: 'run', runId: 'a', replies: 3, activity: 2 },
        { kind: 'user' },
        { kind: 'run', runId: 'b', replies: 2, activity: 2 },
        { kind: 'user' },
      ]);

      // Ask to retain 2..5 — that slices run-a (1-3) and run-b (5-6) in half.
      const p = await preview(threadId, {
        firstRetainedIndex: 2,
        lastRetainedIndex: 5,
        removeSummaries: false,
      });

      expect(p.expandedForRunAtomicity).toBe(true);
      expect(p.firstRetained.messageId).toBe(ids[1]);
      expect(p.lastRetained.messageId).toBe(ids[6]);
      expect(p.removed.messages).toBe(2); // ordinals 0 and 7
      expect(p.removed.runs).toBe(0); // both runs survive whole
      expect(p.removed.activity).toBe(0);
    });

    it('accepts a boundary given as a message id and returns its ordinal', async () => {
      const { threadId, ids } = await seedThread(
        'by-id',
        Array.from({ length: 6 }, () => ({ kind: 'user' as const }))
      );
      const p = await preview(threadId, {
        firstRetainedMessageId: ids[2],
        lastRetainedMessageId: ids[4],
        removeSummaries: false,
      });
      expect(p.requested).toEqual({ firstRetainedIndex: 2, lastRetainedIndex: 4 });
      expect(p.firstRetained.index).toBe(2);
      expect(p.lastRetained.index).toBe(4);
    });

    it('rejects a boundary id belonging to a different thread', async () => {
      const a = await seedThread('cross-a', [{ kind: 'user' }, { kind: 'user' }]);
      const b = await seedThread('cross-b', [{ kind: 'user' }, { kind: 'user' }]);
      const res = await request(server)
        .post(`/threads/${a.threadId}/trim/preview`)
        .send({ firstRetainedMessageId: b.ids[0], removeSummaries: false });
      expect(res.status).toBe(400);
      expect(res.body.error.message).toMatch(/does not belong to this thread/i);
    });

    it('orders same-timestamp messages stably by id', async () => {
      const { threadId, ids } = await seedThread(
        'same-ts',
        Array.from({ length: 4 }, () => ({ kind: 'user' as const }))
      );
      // Collapse every row onto one instant; only the id tiebreaker can order them.
      await getDb().query(`UPDATE public.messages SET created_at = $2 WHERE thread_id = $1`, [
        threadId,
        new Date(BASE_TIME).toISOString(),
      ]);
      const sorted = [...ids].sort();
      const p = await preview(threadId, {
        firstRetainedIndex: 1,
        lastRetainedIndex: 2,
        removeSummaries: false,
      });
      expect(p.firstRetained.messageId).toBe(sorted[1]);
      expect(p.lastRetained.messageId).toBe(sorted[2]);
      expect(p.removed.messages).toBe(2);
    });

    it('handles a large thread without loading the transcript', async () => {
      const threadId = `thread-${PREFIX}-large`;
      await Threads.create({ id: threadId, title: `${PREFIX} large` });
      // Bulk insert 600 messages through the node spine.
      await getDb().query(
        `INSERT INTO public.nodes (id, type)
         SELECT 'message-${PREFIX}-large-' || lpad(g::text, 5, '0'), 'message'
           FROM generate_series(0, 599) g`
      );
      await getDb().query(
        `INSERT INTO public.messages (id, thread_id, user_id, role, content, created_at)
         SELECT 'message-${PREFIX}-large-' || lpad(g::text, 5, '0'), $1, $2, 'user',
                'bulk ' || g, $3::timestamptz + (g || ' seconds')::interval
           FROM generate_series(0, 599) g`,
        [threadId, userId, new Date(BASE_TIME).toISOString()]
      );

      const stats = await getStats(threadId);
      expect(stats.messageCount).toBe(600);

      const p = await preview(threadId, {
        firstRetainedIndex: 100,
        lastRetainedIndex: 499,
        removeSummaries: false,
      });
      expect(p.firstRetained.messageId).toBe(`message-${PREFIX}-large-00100`);
      expect(p.lastRetained.messageId).toBe(`message-${PREFIX}-large-00499`);
      expect(p.remaining.messages).toBe(400);
      expect(p.removed.messages).toBe(200);
    });

    it('rejects a malformed body rather than guessing defaults', async () => {
      const { threadId } = await seedThread('bad-body', [{ kind: 'user' }]);
      const app = server;
      // `removeSummaries` missing entirely — never defaulted for a destructive op.
      await request(app).post(`/threads/${threadId}/trim/preview`).send({}).expect(400);
      await request(app)
        .post(`/threads/${threadId}/trim/preview`)
        .send({ removeSummaries: 'yes' })
        .expect(400);
      // A boundary must be a non-negative ordinal or a non-empty id.
      await request(app)
        .post(`/threads/${threadId}/trim/preview`)
        .send({ removeSummaries: false, firstRetainedIndex: -1 })
        .expect(400);
      await request(app)
        .post(`/threads/${threadId}/trim/preview`)
        .send({ removeSummaries: false, lastRetainedMessageId: '' })
        .expect(400);
    });
  });

  // Apply — one control, three reachable cuts

  describe('POST /:id/trim/apply — first handle moved (older history)', () => {
    it('removes older history with its runs, activity and node rows', async () => {
      // 0 user | 1,2 run-a (2 activity) | 3 user | 4,5 run-b (3 activity)
      const { threadId, ids, runIds } = await seedThread('prefix', [
        { kind: 'user' },
        { kind: 'run', runId: 'a', replies: 2, activity: 2 },
        { kind: 'user' },
        { kind: 'run', runId: 'b', replies: 2, activity: 3 },
      ]);

      const p = await preview(threadId, {
        firstRetainedIndex: 3,
        removeSummaries: false,
      });
      expect(p.removed.messages).toBe(3);
      expect(p.removed.runs).toBe(1);
      expect(p.removed.activity).toBe(2);

      const res = await applyFrom(threadId, p);
      expect(res.status).toBe(200);
      expect(res.body.data.removed.messages).toBe(3);
      expect(res.body.data.sides).toBe('prefix');
      expect(res.body.data.anchorMessageId).toBe(ids[3]);

      expect(await orderedMessageIds(threadId)).toEqual([ids[3], ids[4], ids[5]]);
      expect((await Runs.listByThreadId(threadId)).map((r) => r.id)).toEqual([runIds[1]]);
      expect(await AgentActivityLog.getByThreadId(threadId)).toHaveLength(3);

      // No orphan node rows, no stranded activity.
      expect(await orphanMessageNodes(threadId)).toBe(0);
      expect(await strandedActivity()).toBe(0);

      expect(broadcastToChannel).toHaveBeenCalledWith(
        threadId,
        expect.objectContaining({
          type: 'socket:thread:trimmed',
          payload: expect.objectContaining({ threadId, sides: 'prefix', removedMessages: 3 }),
        })
      );
    });
  });

  describe('POST /:id/trim/apply — persisted compactions', () => {
    it('drops a compaction when history is removed, and keeps the other tool rows', async () => {
      // 0 user | 1,2 run-a (1 activity) | 3 user | 4,5 run-b (1 activity)
      const { threadId, ids, runIds } = await seedThread('compaction', [
        { kind: 'user' },
        { kind: 'run', runId: 'a', replies: 2, activity: 1 },
        { kind: 'user' },
        { kind: 'run', runId: 'b', replies: 2, activity: 1 },
      ]);
      // A compaction recorded on the run that is kept: its summary describes turns that go.
      await AgentActivityLog.logActivity({
        agentId: AGENT_ID,
        runId: runIds[1]!,
        actionType: 'tool_call',
        triggerType: 'cron',
        tool: 'compaction_summary',
        toolOutput: { summary: 'Describes the removed turns.' },
      });
      const rowsOf = async (tool: string) =>
        (await AgentActivityLog.getByThreadId(threadId)).filter((r) => r.tool === tool).length;
      expect(await rowsOf('compaction_summary')).toBe(1);

      const p = await preview(threadId, { firstRetainedIndex: 3, removeSummaries: false });
      const res = await applyFrom(threadId, p);
      expect(res.status).toBe(200);

      expect(await orderedMessageIds(threadId)).toEqual([ids[3], ids[4], ids[5]]);
      expect(await rowsOf('compaction_summary')).toBe(0);
      expect(await rowsOf('workspace_search')).toBe(1);
    });

    it('stops applying a fold saved as a thread summary when history is removed, and keeps its text', async () => {
      const { threadId, ids, runIds } = await seedThread('fold-summary', [
        { kind: 'user' },
        { kind: 'run', runId: 'a', replies: 2, activity: 0 },
        { kind: 'user' },
        { kind: 'run', runId: 'b', replies: 2, activity: 0 },
      ]);
      const foldId = `thread_summary-${PREFIX}-fold-summary`;
      await ThreadSummaries.insertNewVersion({
        id: foldId,
        threadId,
        agentId: AGENT_ID,
        summaryText: 'Describes the removed turns.',
        messagesCovered: 3,
        compaction: {
          through: { effectiveStart: 'x', startAt: 'x', sortId: ids[2]! },
          folded_units: 3,
          carry_forward: null,
        },
      });
      expect(await ThreadSummaries.getLatestCompaction(threadId, AGENT_ID)).not.toBeNull();
      expect(runIds).toHaveLength(2);

      const p = await preview(threadId, { firstRetainedIndex: 3, removeSummaries: false });
      const res = await applyFrom(threadId, p);
      expect(res.status).toBe(200);

      // Replay finds no cut to apply; the summary text is still there as a summary.
      expect(await ThreadSummaries.getLatestCompaction(threadId, AGENT_ID)).toBeNull();
      const kept = await ThreadSummaries.findByIdWithNode(foldId);
      expect(kept?.summaryText).toBe('Describes the removed turns.');
      expect(kept?.compaction).toBeNull();
      // Folded units are not messages; the digest's watermark must not read them as such.
      expect(kept?.messagesCovered).toBe(0);
      expect(kept?.lastMessageId).toBeNull();
    });

    it('leaves a compaction alone when nothing is removed', async () => {
      const { threadId, runIds } = await seedThread('compaction-keep', [
        { kind: 'user' },
        { kind: 'run', runId: 'a', replies: 1, activity: 0 },
      ]);
      await AgentActivityLog.logActivity({
        agentId: AGENT_ID,
        runId: runIds[0]!,
        actionType: 'tool_call',
        triggerType: 'cron',
        tool: 'compaction_summary',
        toolOutput: { summary: 'Still valid.' },
      });
      const p = await preview(threadId, { firstRetainedIndex: 0, removeSummaries: false });
      expect(p.removed.messages).toBe(0);
      expect(
        (await AgentActivityLog.getByThreadId(threadId)).filter(
          (r) => r.tool === 'compaction_summary'
        )
      ).toHaveLength(1);
    });
  });

  describe('POST /:id/trim/apply — last handle moved (newer history)', () => {
    it('removes newer history and corrects the last-message watermark', async () => {
      const { threadId, ids, runIds } = await seedThread('tail', [
        { kind: 'user' },
        { kind: 'run', runId: 'a', replies: 2, activity: 2 },
        { kind: 'user' },
        { kind: 'run', runId: 'b', replies: 2, activity: 3 },
      ]);

      const p = await preview(threadId, {
        lastRetainedIndex: 2,
        removeSummaries: false,
      });
      expect(p.removed.messages).toBe(3);
      expect(p.removed.runs).toBe(1);
      expect(p.removed.activity).toBe(3);

      const res = await applyFrom(threadId, p);
      expect(res.status).toBe(200);
      expect(res.body.data.sides).toBe('tail');
      expect(res.body.data.anchorMessageId).toBe(ids[2]);

      expect(await orderedMessageIds(threadId)).toEqual([ids[0], ids[1], ids[2]]);
      expect((await Runs.listByThreadId(threadId)).map((r) => r.id)).toEqual([runIds[0]]);
      expect(await AgentActivityLog.getByThreadId(threadId)).toHaveLength(2);
      expect(await strandedActivity()).toBe(0);

      // The maintaining trigger is INSERT-only, so a tail cut must reset it here.
      const { rows } = await getDb().query<{ last_message_at: Date | null }>(
        `SELECT last_message_at FROM public.threads WHERE id = $1`,
        [threadId]
      );
      const survivor = await Messages.findById(ids[2]!);
      expect(new Date(rows[0]!.last_message_at as Date).toISOString()).toBe(
        new Date(survivor!.createdAt).toISOString()
      );
    });
  });

  describe('POST /:id/trim/apply — both handles moved', () => {
    it('keeps only the selected interval', async () => {
      const { threadId, ids } = await seedThread(
        'both',
        Array.from({ length: 12 }, () => ({ kind: 'user' as const }))
      );
      const p = await preview(threadId, {
        firstRetainedIndex: 4,
        lastRetainedIndex: 7,
        removeSummaries: false,
      });
      expect(p.removed.messages).toBe(8);

      const res = await applyFrom(threadId, p);
      expect(res.status).toBe(200);
      expect(res.body.data.sides).toBe('both');
      expect(await orderedMessageIds(threadId)).toEqual([ids[4], ids[5], ids[6], ids[7]]);
      expect(await orphanMessageNodes(threadId)).toBe(0);
    });

    it('agrees with its own preview before and after the delete', async () => {
      const { threadId } = await seedThread('agreement', [
        { kind: 'user' },
        { kind: 'run', runId: 'a', replies: 3, activity: 4 },
        { kind: 'user' },
        { kind: 'run', runId: 'b', replies: 2, activity: 2 },
        { kind: 'user' },
      ]);

      const before = await getStats(threadId);
      const p = await preview(threadId, {
        firstRetainedIndex: 1,
        lastRetainedIndex: 5,
        removeSummaries: false,
      });

      // removed + remaining reconciles to the totals, field by field.
      expect(p.removed.messages + p.remaining.messages).toBe(before.totals.messages);
      expect(p.removed.runs + p.remaining.runs).toBe(before.totals.runs);
      expect(p.removed.activity + p.remaining.activity).toBe(before.totals.activity);
      expect(p.removed.bytes.total + p.remaining.bytes.total).toBe(before.totals.bytes.total);

      expect((await applyFrom(threadId, p)).status).toBe(200);

      // And the post-delete recount lands exactly on the predicted remainder.
      const after = await getStats(threadId);
      expect(after.totals.messages).toBe(p.remaining.messages);
      expect(after.totals.runs).toBe(p.remaining.runs);
      expect(after.totals.activity).toBe(p.remaining.activity);
      expect(after.totals.bytes.total).toBe(p.remaining.bytes.total);
    });
  });

  // Dependent-record cleanup

  describe('dependent record cleanup', () => {
    it('cascades embeddings and links off deleted messages but spares shared nodes', async () => {
      const { threadId, ids } = await seedThread(
        'cascade',
        Array.from({ length: 6 }, () => ({ kind: 'user' as const }))
      );
      const pool = getDb();
      const { rows: models } = await pool.query<{ id: string }>(
        `SELECT id FROM public.models LIMIT 1`
      );
      const modelId = models[0]?.id ?? null;

      if (modelId) {
        // An embedding on a message node — the trim must reclaim it.
        await pool.query(
          `INSERT INTO public.embeddings (id, node_id, model_id, vector, content_hash)
           VALUES ($1, $2, $3, $4::vector, 'hash-doomed')`,
          [`emb-${PREFIX}-doomed`, ids[0], modelId, `[${Array(768).fill(0).join(',')}]`]
        );
        await pool.query(
          `INSERT INTO public.embeddings (id, node_id, model_id, vector, content_hash)
           VALUES ($1, $2, $3, $4::vector, 'hash-kept')`,
          [`emb-${PREFIX}-kept`, ids[5], modelId, `[${Array(768).fill(1).join(',')}]`]
        );
      }

      // message → message link inside the removed range.
      await pool.query(
        `INSERT INTO public.links (id, source_id, target_id, relation)
         VALUES ($1, $2, $3, 'context')`,
        [`link-${PREFIX}-doomed`, ids[0], ids[1]]
      );
      // A link from a doomed message to a surviving one: the link goes, the
      // surviving message must not.
      await pool.query(
        `INSERT INTO public.links (id, source_id, target_id, relation)
         VALUES ($1, $2, $3, 'context')`,
        [`link-${PREFIX}-crossing`, ids[1], ids[5]]
      );

      const p = await preview(threadId, {
        firstRetainedIndex: 4,
        removeSummaries: false,
      });
      if (modelId) {
        expect(p.removed.bytes.messageEmbeddings).toBeGreaterThan(0);
      }
      expect((await applyFrom(threadId, p)).status).toBe(200);

      expect(
        await countRows(`SELECT count(*)::text AS n FROM public.links WHERE id LIKE $1`, [
          `link-${PREFIX}-%`,
        ])
      ).toBe(0);
      if (modelId) {
        const { rows: left } = await pool.query<{ id: string }>(
          `SELECT id FROM public.embeddings WHERE id LIKE $1 ORDER BY id`,
          [`emb-${PREFIX}-%`]
        );
        expect(left.map((r) => r.id)).toEqual([`emb-${PREFIX}-kept`]);
      }
      // The surviving message the crossing link pointed at is untouched.
      expect(await Messages.findById(ids[5]!)).not.toBeNull();
      expect(await orphanMessageNodes(threadId)).toBe(0);
    });

    it('removes an activity-only run whose start falls in the cut', async () => {
      // A run that aborted before persisting a reply still owns activity rows,
      // and replayAssembly renders it — so the cut must take it by start time.
      const { threadId, ids } = await seedThread('abort-gap', [
        { kind: 'user' },
        { kind: 'user' },
        { kind: 'user' },
        { kind: 'user' },
      ]);
      const ghostRun = `run-${PREFIX}-abort-gap-ghost`;
      await Runs.create({
        id: ghostRun,
        threadId,
        agentId: AGENT_ID,
        providerId: 'anthropic',
        model: 'claude-haiku-4-5-20251001',
        status: 'failed',
        startedAt: new Date(BASE_TIME).toISOString(),
      });
      await AgentActivityLog.logActivity({
        agentId: AGENT_ID,
        runId: ghostRun,
        actionType: 'thinking',
        triggerType: 'manual',
        content: 'partial work that must not resurrect',
      });

      const p = await preview(threadId, {
        firstRetainedIndex: 2,
        removeSummaries: false,
      });
      expect(p.removed.runs).toBe(1);
      expect(p.removed.activity).toBe(1);
      expect((await applyFrom(threadId, p)).status).toBe(200);

      expect(await Runs.listByThreadId(threadId)).toEqual([]);
      expect(await AgentActivityLog.getByThreadId(threadId)).toEqual([]);
      expect(await strandedActivity()).toBe(0);
      expect(await orderedMessageIds(threadId)).toEqual([ids[2], ids[3]]);
    });
  });

  // Summaries

  /**
   * Trimming reclaims context; it does not expunge. A summary is the compressed
   * memory of the history being removed, so deleting both the messages and the
   * summary loses the information outright. Only the explicit "remove
   * summaries" choice deletes one; otherwise the row is kept and its coverage
   * bookkeeping is repaired so it stops accounting for messages that are gone.
   */
  describe('summary handling', () => {
    it('leaves a summary covering only retained messages completely untouched', async () => {
      const { threadId, ids } = await seedThread(
        'summary-keep',
        Array.from({ length: 8 }, () => ({ kind: 'user' as const }))
      );
      const keptId = await seedSummary(threadId, 'summary-keep', ids[2]!, 3);
      const before = await summaryState(keptId);

      const p = await preview(threadId, {
        lastRetainedIndex: 5,
        removeSummaries: false,
      });
      expect(p.summaryImpact.preserved).toBe(1);
      expect(p.summaryImpact.removed).toBe(0);
      expect(p.summaryImpact.repairedCoverage).toBe(0);

      expect((await applyFrom(threadId, p)).status).toBe(200);
      // Not merely alive — byte-for-byte the row it was.
      expect(await summaryState(keptId)).toEqual(before);
    });

    it('keeps a summary whose coverage reached into the deleted tail, repairing its bookkeeping', async () => {
      const { threadId, ids } = await seedThread(
        'summary-stale-tail',
        Array.from({ length: 8 }, () => ({ kind: 'user' as const }))
      );
      const keptId = await seedSummary(threadId, 'summary-stale-tail', ids[6]!, 7);
      const before = await summaryState(keptId);

      const p = await preview(threadId, {
        lastRetainedIndex: 4,
        removeSummaries: false,
      });
      // The user did not ask to lose it, so nothing is deleted — but its
      // coverage is now wrong, so the plan promises to repair it.
      expect(p.summaryImpact.repairedCoverage).toBe(1);
      expect(p.summaryImpact.preserved).toBe(1);
      expect(p.summaryImpact.removed).toBe(0);
      expect(p.summaryImpact.removedAsInvalidated).toBe(0);
      expect(p.summaryImpact.removedByChoice).toBe(0);
      expect(p.removed.summaries).toBe(0);

      expect((await applyFrom(threadId, p)).status).toBe(200);
      expect(await summaryState(keptId)).toEqual({
        // Zero, not the stale 7: `shouldSummarize` subtracts this from the live
        // message count, and a value larger than the thread would freeze
        // summarization until it grew back past the stale value.
        messagesCovered: 0,
        // The anchor pointed at a deleted message. There is no honest
        // replacement for it — the summary is anchored nowhere now.
        lastMessageId: null,
        // Untouched: version is a revision counter, and clearing is_current
        // would hide the memory from prompt assembly.
        version: before!.version,
        isCurrent: true,
        summaryText: before!.summaryText,
      });
    });

    it('keeps and repairs every covering summary on a prefix cut', async () => {
      const { threadId, ids } = await seedThread(
        'summary-prefix',
        Array.from({ length: 8 }, () => ({ kind: 'user' as const }))
      );
      // Anchored at a message the cut retains, but coverage starts at the
      // thread's first message, which the prefix cut removes — so the anchor
      // survives the FK and only our own repair can correct the row.
      const keptId = await seedSummary(threadId, 'summary-prefix', ids[6]!, 7);

      const p = await preview(threadId, {
        firstRetainedIndex: 4,
        removeSummaries: false,
      });
      expect(p.summaryImpact.repairedCoverage).toBe(1);
      expect(p.summaryImpact.removed).toBe(0);

      expect((await applyFrom(threadId, p)).status).toBe(200);
      const after = await summaryState(keptId);
      expect(after).not.toBeNull();
      expect(after!.messagesCovered).toBe(0);
      expect(after!.lastMessageId).toBeNull();
    });

    it('never repairs the same summary twice — a repaired row claims nothing', async () => {
      const { threadId, ids } = await seedThread(
        'summary-idempotent',
        Array.from({ length: 10 }, () => ({ kind: 'user' as const }))
      );
      const keptId = await seedSummary(threadId, 'summary-idempotent', ids[8]!, 9);

      const first = await preview(threadId, { lastRetainedIndex: 6, removeSummaries: false });
      expect(first.summaryImpact.repairedCoverage).toBe(1);
      expect((await applyFrom(threadId, first)).status).toBe(200);

      // Second trim on the already-repaired thread: nothing left to repair.
      const second = await preview(threadId, { lastRetainedIndex: 4, removeSummaries: false });
      expect(second.summaryImpact.repairedCoverage).toBe(0);
      expect(second.summaryImpact.preserved).toBe(1);
      expect((await applyFrom(threadId, second)).status).toBe(200);
      expect(await summaryState(keptId)).toMatchObject({
        messagesCovered: 0,
        lastMessageId: null,
      });
    });

    it('still deletes a coverage-stale summary when the user asks for removal', async () => {
      const { threadId, ids } = await seedThread(
        'summary-expunge',
        Array.from({ length: 8 }, () => ({ kind: 'user' as const }))
      );
      const doomed = await seedSummary(threadId, 'summary-expunge', ids[6]!, 7);

      const p = await preview(threadId, {
        lastRetainedIndex: 4,
        removeSummaries: true,
      });
      expect(p.removed.summaries).toBe(1);
      expect(p.summaryImpact.removedAsInvalidated).toBe(1);
      expect(p.summaryImpact.repairedCoverage).toBe(0);
      expect(p.summaryImpact.preserved).toBe(0);

      expect((await applyFrom(threadId, p)).status).toBe(200);
      expect(await ThreadSummaries.findByIdWithNode(doomed)).toBeNull();
      // Node spine cleaned too — no orphan summary node left behind.
      expect(
        await countRows(`SELECT count(*)::text AS n FROM public.nodes WHERE id = $1`, [doomed])
      ).toBe(0);
    });

    it('removes every summary when the user asks, splitting the two reasons', async () => {
      const { threadId, ids } = await seedThread(
        'summary-explicit',
        Array.from({ length: 8 }, () => ({ kind: 'user' as const }))
      );
      await seedSummary(threadId, 'summary-explicit-a', ids[1]!, 2);
      await seedSummary(threadId, 'summary-explicit-b', ids[7]!, 8);

      const p = await preview(threadId, {
        lastRetainedIndex: 4,
        removeSummaries: true,
      });
      expect(p.removed.summaries).toBe(2);
      // b covered deleted history anyway; only a is billed to the checkbox.
      expect(p.summaryImpact.removedAsInvalidated).toBe(1);
      expect(p.summaryImpact.removedByChoice).toBe(1);
      expect(p.summaryImpact.repairedCoverage).toBe(0);
      expect(p.summaryImpact.removedBytes).toBeGreaterThan(0);

      expect((await applyFrom(threadId, p)).status).toBe(200);
      expect(await ThreadSummaries.getHistoryByThread(threadId)).toEqual([]);
    });

    /**
     * Preview and apply return the same shape, so they must be equal and the
     * database must agree with both; otherwise the panel promises one thing and
     * the delete does another.
     */
    it('applies exactly the summary outcome the preview promised', async () => {
      const { threadId, ids } = await seedThread(
        'summary-agreement',
        Array.from({ length: 10 }, () => ({ kind: 'user' as const }))
      );
      const stale = await seedSummary(threadId, 'summary-agreement-stale', ids[8]!, 9);
      const untouched = await seedSummary(threadId, 'summary-agreement-fresh', ids[1]!, 2);

      const p = await preview(threadId, { lastRetainedIndex: 5, removeSummaries: false });
      expect(p.summaryImpact).toEqual({
        removedByChoice: 0,
        removedAsInvalidated: 0,
        preserved: 2,
        repairedCoverage: 1,
        removed: 0,
        removedBytes: 0,
      });

      const res = await applyFrom(threadId, p);
      expect(res.status).toBe(200);
      expect(res.body.data.summaryImpact).toEqual(p.summaryImpact);

      // …and the rows themselves are what both of them claimed.
      expect(await summaryState(stale)).toMatchObject({
        messagesCovered: 0,
        lastMessageId: null,
      });
      expect(await summaryState(untouched)).toMatchObject({
        messagesCovered: 2,
        lastMessageId: ids[1],
      });
      expect((await getStats(threadId)).totals.summaries).toBe(2);
    });
  });

  // Safety: stale plans, active runs, authorization, rollback

  describe('stale-plan rejection', () => {
    it('refuses a plan after a new message arrives, deleting nothing', async () => {
      const { threadId, ids } = await seedThread(
        'stale',
        Array.from({ length: 6 }, () => ({ kind: 'user' as const }))
      );
      const p = await preview(threadId, {
        firstRetainedIndex: 3,
        removeSummaries: false,
      });

      const lateId = `message-${PREFIX}-stale-late`;
      await Messages.create({
        id: lateId,
        threadId,
        role: 'user',
        content: 'arrived after the preview',
        agentId: null,
        userId,
      });
      // Pin it right after the seeded six so ordering comes from BASE_TIME,
      // never from the wall clock.
      await stampCreatedAt('messages', lateId, ids.length);

      // Explicit precondition: the thread is still there and the plan really
      // is stale (6 -> 7). If this ever fails, it fails here, not as a 404.
      expect(await Threads.findById(threadId)).not.toBeNull();
      expect((await getStats(threadId)).messageCount).toBe(ids.length + 1);

      const res = await applyFrom(threadId, p);
      // Status and body together, so a failure shows who answered and why.
      expect({ status: res.status, message: res.body?.error?.message }).toEqual({
        status: 409,
        message: expect.stringMatching(/changed after the trim preview/i),
      });
      // Nothing was deleted.
      expect(await Messages.listByThreadId(threadId)).toHaveLength(7);
      expect(await orderedMessageIds(threadId)).toEqual([...ids, `message-${PREFIX}-stale-late`]);
    });

    it('refuses a plan after a message is deleted underneath it', async () => {
      const { threadId, ids } = await seedThread(
        'stale-delete',
        Array.from({ length: 6 }, () => ({ kind: 'user' as const }))
      );
      const p = await preview(threadId, {
        firstRetainedIndex: 3,
        removeSummaries: false,
      });
      await getDb().query(`DELETE FROM public.nodes WHERE id = $1`, [ids[5]]);

      const res = await applyFrom(threadId, p);
      expect(res.status).toBe(409);
      expect(await Messages.listByThreadId(threadId)).toHaveLength(5);
    });

    it('refuses a forged or tampered token', async () => {
      const { threadId, ids } = await seedThread(
        'forged',
        Array.from({ length: 6 }, () => ({ kind: 'user' as const }))
      );
      const p = await preview(threadId, {
        firstRetainedIndex: 3,
        removeSummaries: false,
      });

      const app = server;
      const base = {
        firstRetainedMessageId: p.firstRetained.messageId,
        lastRetainedMessageId: p.lastRetained.messageId,
        removeSummaries: false,
      };
      await request(app)
        .post(`/threads/${threadId}/trim/apply`)
        .send({ ...base, token: 'not-a-token' })
        .expect(400);
      await request(app)
        .post(`/threads/${threadId}/trim/apply`)
        .send({ ...base, token: `${p.token}x` })
        .expect(400);
      // A valid token cannot be re-pointed at different boundaries.
      await request(app)
        .post(`/threads/${threadId}/trim/apply`)
        .send({ ...base, firstRetainedMessageId: ids[1], token: p.token })
        .expect(400);
      // …nor at a different summary choice than the one reviewed.
      await request(app)
        .post(`/threads/${threadId}/trim/apply`)
        .send({ ...base, removeSummaries: true, token: p.token })
        .expect(400);

      expect(await Messages.listByThreadId(threadId)).toHaveLength(6);
    });

    it('refuses a token minted for another thread', async () => {
      const a = await seedThread(
        'token-a',
        Array.from({ length: 5 }, () => ({ kind: 'user' as const }))
      );
      const b = await seedThread(
        'token-b',
        Array.from({ length: 5 }, () => ({ kind: 'user' as const }))
      );
      const p = await preview(a.threadId, {
        firstRetainedIndex: 2,
        removeSummaries: false,
      });

      const res = await request(server).post(`/threads/${b.threadId}/trim/apply`).send({
        firstRetainedMessageId: p.firstRetained.messageId,
        lastRetainedMessageId: p.lastRetained.messageId,
        removeSummaries: false,
        token: p.token,
      });
      expect(res.status).toBe(400);
      expect(await Messages.listByThreadId(a.threadId)).toHaveLength(5);
      expect(await Messages.listByThreadId(b.threadId)).toHaveLength(5);
    });

    it('refuses a plan that would remove nothing', async () => {
      const { threadId } = await seedThread(
        'noop-apply',
        Array.from({ length: 4 }, () => ({ kind: 'user' as const }))
      );
      const p = await preview(threadId, {
        firstRetainedIndex: 0,
        lastRetainedIndex: 3,
        removeSummaries: false,
      });
      expect(p.noop).toBe(true);
      const res = await applyFrom(threadId, p);
      expect(res.status).toBe(400);
      expect(await Messages.listByThreadId(threadId)).toHaveLength(4);
    });
  });

  describe('active run handling', () => {
    it('refuses to trim while the thread is in flight, deleting nothing', async () => {
      const { threadId } = await seedThread('active', [
        { kind: 'user' },
        { kind: 'run', runId: 'a', replies: 2, activity: 2 },
        { kind: 'user' },
      ]);
      const p = await preview(threadId, {
        firstRetainedIndex: 2,
        removeSummaries: false,
      });

      const session = `session-${PREFIX}-active`;
      expect(activeRunTracker.startSession(session, threadId)).toBe(true);
      try {
        const res = await applyFrom(threadId, p);
        expect(res.status).toBe(409);
        expect(await Messages.listByThreadId(threadId)).toHaveLength(4);
        expect(await Runs.listByThreadId(threadId)).toHaveLength(1);
        expect(await AgentActivityLog.getByThreadId(threadId)).toHaveLength(2);
      } finally {
        activeRunTracker.finishSession(session);
      }
    });

    it('reports the busy state on stats and preview so the UI can disable Trim', async () => {
      const { threadId } = await seedThread('busy-flag', [{ kind: 'user' }, { kind: 'user' }]);
      const session = `session-${PREFIX}-busy`;
      expect(activeRunTracker.startSession(session, threadId)).toBe(true);
      try {
        expect((await getStats(threadId)).threadBusy).toBe(true);
        const p = await preview(threadId, {
          firstRetainedIndex: 1,
          removeSummaries: false,
        });
        expect(p.threadBusy).toBe(true);
      } finally {
        activeRunTracker.finishSession(session);
      }
      expect((await getStats(threadId)).threadBusy).toBe(false);
    });

    it('blocks a new session for the duration of the trim transaction', async () => {
      const { threadId } = await seedThread('hold', [{ kind: 'user' }, { kind: 'user' }]);
      let entered!: () => void;
      const reached = new Promise<void>((resolve) => {
        entered = resolve;
      });
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });

      const held = withReservedThreadTransaction([threadId], async () => {
        entered();
        await gate;
      });
      await reached;
      expect(activeRunTracker.startSession(`session-${PREFIX}-hold`, threadId)).toBe(false);
      release();
      await held;
      expect(activeRunTracker.startSession(`session-${PREFIX}-hold`, threadId)).toBe(true);
      activeRunTracker.finishSession(`session-${PREFIX}-hold`);
    });
  });

  describe('transactional rollback', () => {
    it('restores runs, activity and summaries when the message delete fails', async () => {
      const { threadId, ids } = await seedThread('rollback', [
        { kind: 'user' },
        { kind: 'run', runId: 'a', replies: 2, activity: 3 },
        { kind: 'user' },
        { kind: 'run', runId: 'b', replies: 2, activity: 2 },
      ]);
      await seedSummary(threadId, 'rollback', ids[1]!, 2);

      const p = await preview(threadId, {
        firstRetainedIndex: 3,
        removeSummaries: true,
      });

      // Induce a failure at the last step. Activity, runs and summaries are
      // deleted before messages, so a RESTRICT reference to a doomed message
      // aborts the transaction only after those deletes have already happened —
      // exactly the point where a non-transactional implementation would leave
      // the thread shredded.
      await getDb().query(
        `CREATE TABLE public.trim_rollback_guard (
           message_id text REFERENCES public.messages(id) ON DELETE RESTRICT
         )`
      );
      await getDb().query(`INSERT INTO public.trim_rollback_guard VALUES ($1)`, [ids[0]]);

      try {
        const res = await applyFrom(threadId, p);
        expect(res.status).toBeGreaterThanOrEqual(400);

        // Everything is exactly as it was.
        expect(await orderedMessageIds(threadId)).toEqual(ids);
        expect(await Runs.listByThreadId(threadId)).toHaveLength(2);
        expect(await AgentActivityLog.getByThreadId(threadId)).toHaveLength(5);
        expect(await ThreadSummaries.getHistoryByThread(threadId)).toHaveLength(1);
        expect(await strandedActivity()).toBe(0);
      } finally {
        await getDb().query(`DROP TABLE IF EXISTS public.trim_rollback_guard`);
      }
    });

    /**
     * The repair is a mutation of rows the trim is keeping, so it has to live
     * or die with the deletes around it. A repair that committed while the
     * message delete rolled back would leave a summary claiming to cover
     * nothing on a thread that still has all its history — a silent memory hole
     * with no failure anywhere to explain it.
     */
    it('leaves a kept summary untouched when the trim fails', async () => {
      const { threadId, ids } = await seedThread(
        'repair-rollback',
        Array.from({ length: 8 }, () => ({ kind: 'user' as const }))
      );
      const keptId = await seedSummary(threadId, 'repair-rollback', ids[6]!, 7);
      const before = await summaryState(keptId);

      const p = await preview(threadId, { lastRetainedIndex: 4, removeSummaries: false });
      expect(p.summaryImpact.repairedCoverage).toBe(1);

      // The repair runs before the message delete, so a RESTRICT reference to a
      // doomed message aborts the transaction after it has already happened.
      await getDb().query(
        `CREATE TABLE public.trim_repair_guard (
           message_id text REFERENCES public.messages(id) ON DELETE RESTRICT
         )`
      );
      await getDb().query(`INSERT INTO public.trim_repair_guard VALUES ($1)`, [ids[7]]);

      try {
        expect((await applyFrom(threadId, p)).status).toBeGreaterThanOrEqual(400);
        expect(await orderedMessageIds(threadId)).toEqual(ids);
        expect(await summaryState(keptId)).toEqual(before);
      } finally {
        await getDb().query(`DROP TABLE IF EXISTS public.trim_repair_guard`);
      }
    });

    it('releases the thread reservation after a failed trim', async () => {
      const { threadId } = await seedThread('release', [{ kind: 'user' }, { kind: 'user' }]);
      const session = `session-${PREFIX}-release`;
      expect(activeRunTracker.startSession(session, threadId)).toBe(true);
      activeRunTracker.finishSession(session);
      // A reservation leaked by the failing test above would make this false.
      expect(activeRunTracker.startSession(session, threadId)).toBe(true);
      activeRunTracker.finishSession(session);
    });
  });

  describe('authorization boundaries', () => {
    it('404s preview and apply for an unknown thread', async () => {
      const app = server;
      await request(app)
        .post(`/threads/thread-${PREFIX}-nope/trim/preview`)
        .send({ removeSummaries: false })
        .expect(404);
      await request(app)
        .post(`/threads/thread-${PREFIX}-nope/trim/apply`)
        .send({
          firstRetainedMessageId: 'message-x',
          lastRetainedMessageId: 'message-y',
          removeSummaries: false,
          token: 'irrelevant',
        })
        .expect(404);
    });
  });
});
