/**
 * The REST manual-compaction route (POST /api/threads/:id/compact) is the same
 * "summarize now" gesture as the socket compact, so a summary pass that was
 * owed and could not be written halts the thread here too instead of answering
 * `compact:complete`. Everything is real against the DB except the WS seam
 * (mocked, as in chatHandlers.summaryHalt.test.ts) and `generateSummary`.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';

const sendToClient = jest.fn();
const broadcastToChannel = jest.fn();
jest.mock('@server/services/WebSocketService', () => ({
  wsService: {
    sendToClient: (...a: unknown[]) => sendToClient(...a),
    broadcastToChannel: (...a: unknown[]) => broadcastToChannel(...a),
    registerHandler: jest.fn(),
  },
}));

const generateSummary = jest.fn(async (): Promise<unknown> => ({ status: 'generated' }));
jest.mock('@server/services/SummaryService', () => ({
  summaryService: {
    generateSummary: (...a: unknown[]) => generateSummary(...a),
  },
}));

import { getDb, getDbClient, Messages, Threads, Users } from '@snaglet/db';
import { Agents } from '@snaglet/db/tables/agents';
import { ThreadParticipants } from '@snaglet/db/tables/thread_participants';
import { ensureBuiltinCatalog } from '@snaglet/db/migrations';
import { errorHandler } from '@server/middleware';
import { registerSummaryRoutes } from '@server/domains/threads/handlers/summaryHandlers';
import {
  isThreadSummaryHalted,
  resetSummaryHaltsForTests,
} from '@server/services/summary/summaryHalt';

const PREFIX = 'summary-halt-rest';
const THREAD_ID = `thread-${PREFIX}`;
const AGENT_ID = `agent-${PREFIX}`;

/** The failure this rule guards against: a retired model id. */
const RETIRED_MODEL = 'claude-3-haiku-20240307';

async function cleanup(): Promise<void> {
  const pool = getDb();
  await pool.query(`DELETE FROM messages WHERE thread_id = $1`, [THREAD_ID]);
  await pool.query(`DELETE FROM thread_participants WHERE thread_id = $1`, [THREAD_ID]);
  await pool.query(`DELETE FROM threads WHERE id = $1`, [THREAD_ID]);
  await pool.query(`DELETE FROM agents WHERE id = $1`, [AGENT_ID]);
  await pool.query(`DELETE FROM notifications WHERE thread_id = $1`, [THREAD_ID]);
  await pool.query(`DELETE FROM nodes WHERE id = ANY($1::text[])`, [[THREAD_ID, AGENT_ID]]);
}

function makeApp(): express.Application {
  const app = express();
  app.use(express.json());
  const router = express.Router();
  registerSummaryRoutes(router);
  app.use('/api/threads', router);
  app.use(errorHandler);
  return app;
}

function compact(app: express.Application) {
  return request(app).post(`/api/threads/${THREAD_ID}/compact`).send({ agentId: AGENT_ID });
}

function broadcastTypes(): string[] {
  return broadcastToChannel.mock.calls.map((call) => (call[1] as { type: string }).type);
}

function compactErrorMessage(): string | null {
  for (const call of broadcastToChannel.mock.calls) {
    const frame = call[1] as { type: string; payload?: { message?: string } };
    if (frame.type === 'socket:thread:compact:error') return frame.payload?.message ?? '';
  }
  return null;
}

async function threadEventContents(): Promise<string[]> {
  const rows = await Messages.listByThreadId(THREAD_ID);
  return rows.filter((m) => m.messageType === 'thread_event').map((m) => m.content);
}

let app: express.Application;
let priorCompactPolicy: string | undefined;

beforeAll(async () => {
  // The repo .env ships COMPACT_CONVERSATIONS=false; the route's disabled
  // guard would 503 every request before the halt path is ever reached.
  priorCompactPolicy = process.env.COMPACT_CONVERSATIONS;
  process.env.COMPACT_CONVERSATIONS = 'true';
  await cleanup();
  await ensureBuiltinCatalog(await getDbClient());
  await Users.getOrCreateLocalUser();
  await Agents.create({ id: AGENT_ID, name: `${PREFIX}-agent` });
  await Threads.create({ id: THREAD_ID, title: `${PREFIX} thread` });
  await ThreadParticipants.addParticipant({ threadId: THREAD_ID, agentId: AGENT_ID });
  app = makeApp();
});

describe('REST compact halts the thread when the summary pass cannot be written', () => {
  // Nested so this DB-querying afterAll unwinds before the shared
  // closeDatabase() registered by pgPerFileTeardown.
  afterAll(async () => {
    if (priorCompactPolicy === undefined) {
      delete process.env.COMPACT_CONVERSATIONS;
    } else {
      process.env.COMPACT_CONVERSATIONS = priorCompactPolicy;
    }
    resetSummaryHaltsForTests();
    await cleanup();
  });

  beforeEach(async () => {
    jest.clearAllMocks();
    resetSummaryHaltsForTests();
    const pool = getDb();
    await pool.query(`DELETE FROM messages WHERE thread_id = $1 AND message_type = $2`, [
      THREAD_ID,
      'thread_event',
    ]);
    await pool.query(`DELETE FROM notifications WHERE thread_id = $1`, [THREAD_ID]);
  });

  it('completes normally while the summarizer is healthy', async () => {
    generateSummary.mockResolvedValueOnce({
      status: 'generated',
      providerId: 'ollama',
      modelId: 'qwen2.5:3b',
      summaryId: `ts-${PREFIX}`,
    });

    const res = await compact(app);

    expect(res.status).toBe(200);
    expect(res.body.data.agentId).toBe(AGENT_ID);
    expect(broadcastTypes()).toEqual([
      'socket:thread:compact:started',
      'socket:thread:compact:complete',
    ]);
    expect(isThreadSummaryHalted(THREAD_ID)).toBe(false);
  });

  it('a benign cadence skip still completes — it is not a broken summarizer', async () => {
    generateSummary.mockResolvedValueOnce({ status: 'skipped', reason: 'no-new-messages' });

    const res = await compact(app);

    expect(res.status).toBe(200);
    expect(broadcastTypes()).toContain('socket:thread:compact:complete');
    expect(isThreadSummaryHalted(THREAD_ID)).toBe(false);
  });

  it('no summary model configured → 503, compact:error, halt — never compact:complete', async () => {
    generateSummary.mockResolvedValueOnce({
      status: 'skipped',
      reason: 'no-summary-model-configured',
      detail: 'agent has no summary model',
    });

    const res = await compact(app);

    expect(res.status).toBe(503);
    // The refusal is the fix instruction: this shape says set a model.
    expect(res.body.error.message).toContain('no summary model is available');
    expect(res.body.error.message).toContain('Set a summary model');
    expect(broadcastTypes()).toContain('socket:thread:compact:error');
    expect(broadcastTypes()).not.toContain('socket:thread:compact:complete');
    expect(compactErrorMessage()).toContain('no summary model is available');
    expect(isThreadSummaryHalted(THREAD_ID)).toBe(true);
  });

  it('model failing → 503 naming the model, no substitute, halt — never compact:complete', async () => {
    generateSummary.mockResolvedValueOnce({
      status: 'skipped',
      reason: 'generation-failed',
      detail: 'status=404, type=not_found_error',
      providerId: 'anthropic',
      modelId: RETIRED_MODEL,
    });

    const res = await compact(app);

    expect(res.status).toBe(503);
    // This shape names the dead model and refuses to pick another.
    expect(res.body.error.message).toContain(`anthropic/${RETIRED_MODEL}`);
    expect(res.body.error.message).toContain('no fallback model will be chosen for you');
    expect(broadcastTypes()).not.toContain('socket:thread:compact:complete');
    expect(compactErrorMessage()).toContain(`anthropic/${RETIRED_MODEL}`);
    expect(isThreadSummaryHalted(THREAD_ID)).toBe(true);
  });

  it('the halt narrates and notifies through the real machinery', async () => {
    generateSummary.mockResolvedValueOnce({
      status: 'skipped',
      reason: 'generation-failed',
      detail: 'status=404, type=not_found_error',
      providerId: 'anthropic',
      modelId: RETIRED_MODEL,
    });

    await compact(app);

    const events = await threadEventContents();
    expect(events).toHaveLength(1);
    expect(events[0]).toContain(`anthropic/${RETIRED_MODEL}`);
    expect(events[0]).toContain('blocked');

    const pool = getDb();
    const { rows } = await pool.query<{ title: string }>(
      `SELECT title FROM notifications WHERE thread_id = $1`,
      [THREAD_ID]
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.title).toContain(RETIRED_MODEL);
  });

  it('a fatal pass still releases the per-agent compacting latch', async () => {
    generateSummary.mockResolvedValueOnce({
      status: 'skipped',
      reason: 'no-summary-model-configured',
      detail: 'agent has no summary model',
    });

    await compact(app);

    const res = await request(app)
      .get(`/api/threads/${THREAD_ID}/compact-status`)
      .query({ agentId: AGENT_ID });
    expect(res.status).toBe(200);
    expect(res.body.data.compacting).toBe(false);
  });
});
