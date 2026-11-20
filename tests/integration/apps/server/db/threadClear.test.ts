/**
 * POST /threads/:id/clear against the real database purges all three replay
 * sources (messages, runs, agent_activity_log), since turn replay
 * (chatPhases/replayLoader.ts) rebuilds an agent's context from all three.
 * Activity is deleted before runs (the run_id FK is SET NULL, so the reverse
 * order would strand orphans); the thread itself and other threads' rows are
 * untouched; the response reports all three counts.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';

const broadcastToChannel = jest.fn();
jest.mock('@server/services/WebSocketService', () => ({
  wsService: { broadcastToChannel: (...a: unknown[]) => broadcastToChannel(...a) },
}));

import { getDb, Messages, Nodes, Threads, Users } from '@snaglet/db';
import { Agents } from '@snaglet/db/tables/agents';
import { AgentActivityLog } from '@snaglet/db/tables/agent_activity_log';
import { Runs } from '@snaglet/db/tables/runs';
import { ThreadSummaries } from '@snaglet/db/tables/thread_summaries';
import { errorHandler } from '@server/middleware';
import { registerThreadCrudRoutes } from '@server/domains/threads/handlers/threadCrud';
import { activeRunTracker } from '@server/services/ActiveRunTracker';
import { withThreadExecutionPurge } from '@server/services/ThreadExecutionPurgeService';

const PREFIX = 'thread-clear-it';
const THREAD_ID = `thread-${PREFIX}`;
const OTHER_THREAD_ID = `thread-${PREFIX}-other`;
const DELETE_THREAD_ID = `thread-${PREFIX}-delete`;
const ACTIVE_THREAD_ID = `thread-${PREFIX}-active`;
const ROLLBACK_MESSAGE_THREAD_ID = `thread-${PREFIX}-rollback-message`;
const ROLLBACK_NODE_THREAD_ID = `thread-${PREFIX}-rollback-node`;
const HOLD_THREAD_ID = `thread-${PREFIX}-hold`;
const AGENT_ID = `agent-${PREFIX}`;
const RUN_ID = `run-${PREFIX}`;
const OTHER_RUN_ID = `run-${PREFIX}-other`;
const DELETE_RUN_ID = `run-${PREFIX}-delete`;
const ACTIVE_RUN_ID = `run-${PREFIX}-active`;
const ROLLBACK_MESSAGE_RUN_ID = `run-${PREFIX}-rollback-message`;
const ROLLBACK_NODE_RUN_ID = `run-${PREFIX}-rollback-node`;
const HOLD_RUN_ID = `run-${PREFIX}-hold`;

const THREAD_IDS = [
  THREAD_ID,
  OTHER_THREAD_ID,
  DELETE_THREAD_ID,
  ACTIVE_THREAD_ID,
  ROLLBACK_MESSAGE_THREAD_ID,
  ROLLBACK_NODE_THREAD_ID,
  HOLD_THREAD_ID,
];

const RUN_IDS = [
  RUN_ID,
  OTHER_RUN_ID,
  DELETE_RUN_ID,
  ACTIVE_RUN_ID,
  ROLLBACK_MESSAGE_RUN_ID,
  ROLLBACK_NODE_RUN_ID,
  HOLD_RUN_ID,
];

function makeApp() {
  const app = express();
  app.use(express.json());
  const router = express.Router();
  registerThreadCrudRoutes(router);
  app.use('/threads', router);
  app.use(errorHandler);
  return app;
}

const FOLD_ID = `thread_summary-${PREFIX}-fold`;
const OTHER_FOLD_ID = `thread_summary-${PREFIX}-other-fold`;

async function cleanup(): Promise<void> {
  const pool = getDb();
  await pool.query(
    `DELETE FROM public.nodes WHERE id IN (SELECT id FROM public.thread_summaries WHERE thread_id = ANY($1))`,
    [THREAD_IDS]
  );
  await pool.query(
    `DELETE FROM public.agent_activity_log WHERE run_id = ANY($1) OR agent_id = $2`,
    [RUN_IDS, AGENT_ID]
  );
  await pool.query(`DELETE FROM public.runs WHERE id = ANY($1)`, [RUN_IDS]);
  await pool.query(`DELETE FROM public.messages WHERE thread_id = ANY($1)`, [THREAD_IDS]);
  await pool.query(`DELETE FROM public.threads WHERE id = ANY($1)`, [THREAD_IDS]);
  await pool.query(`DELETE FROM public.nodes WHERE id = ANY($1) OR id LIKE $2`, [
    THREAD_IDS,
    `message-${PREFIX}-%`,
  ]);
  await pool.query(`DELETE FROM public.agents WHERE id = $1`, [AGENT_ID]);
}

async function seed(): Promise<void> {
  await Threads.create({ id: THREAD_ID, title: `${PREFIX} thread` });
  await Threads.create({ id: OTHER_THREAD_ID, title: `${PREFIX} other thread` });
  await Threads.create({ id: DELETE_THREAD_ID, title: `${PREFIX} delete thread` });
  await Threads.create({ id: ACTIVE_THREAD_ID, title: `${PREFIX} active thread` });
  await Threads.create({
    id: ROLLBACK_MESSAGE_THREAD_ID,
    title: `${PREFIX} rollback message thread`,
  });
  await Threads.create({ id: ROLLBACK_NODE_THREAD_ID, title: `${PREFIX} rollback node thread` });
  await Threads.create({ id: HOLD_THREAD_ID, title: `${PREFIX} hold thread` });
  await Agents.create({ id: AGENT_ID, name: `${PREFIX}-agent` });
  const user = await Users.getOrCreateLocalUser();

  await Messages.create({
    id: `message-${PREFIX}-user`,
    threadId: THREAD_ID,
    role: 'user',
    content: 'clear me',
    agentId: null,
    userId: user.id,
  });
  await Runs.create({
    id: RUN_ID,
    threadId: THREAD_ID,
    agentId: AGENT_ID,
    providerId: 'anthropic',
    model: 'claude-haiku-4-5-20251001',
    status: 'completed',
  });
  await Messages.create({
    id: `message-${PREFIX}-reply`,
    threadId: THREAD_ID,
    role: 'assistant',
    content: 'a reply that must not resurrect',
    agentId: AGENT_ID,
    userId: null,
    runId: RUN_ID,
  });
  await AgentActivityLog.logActivity({
    agentId: AGENT_ID,
    runId: RUN_ID,
    actionType: 'tool_call',
    triggerType: 'manual',
    tool: 'workspace_search',
    toolInput: { query: 'secret cleared content' },
    toolOutput: { hits: 3 },
  });
  await AgentActivityLog.logActivity({
    agentId: AGENT_ID,
    runId: RUN_ID,
    actionType: 'thinking',
    triggerType: 'manual',
    content: 'private reasoning that must not resurrect',
  });

  // A fold on each thread: the summary of the conversation, applied as the first message of replay.
  const fold = { through: { effectiveStart: 'x', startAt: 'x', sortId: 'm' }, folded_units: 3 };
  for (const [id, threadId] of [
    [FOLD_ID, THREAD_ID],
    [OTHER_FOLD_ID, OTHER_THREAD_ID],
  ] as const) {
    await ThreadSummaries.insertNewVersion({
      id,
      threadId,
      agentId: AGENT_ID,
      summaryText: 'Summary of the conversation that is about to be cleared.',
      messagesCovered: 3,
      compaction: fold,
    });
  }

  // A second thread's run + activity prove the purge is thread-scoped.
  await Runs.create({
    id: OTHER_RUN_ID,
    threadId: OTHER_THREAD_ID,
    agentId: AGENT_ID,
    providerId: 'anthropic',
    model: 'claude-haiku-4-5-20251001',
    status: 'completed',
  });
  await AgentActivityLog.logActivity({
    agentId: AGENT_ID,
    runId: OTHER_RUN_ID,
    actionType: 'tool_call',
    triggerType: 'manual',
    tool: 'workspace_search',
    toolInput: { query: 'other thread, keep me' },
  });

  await Runs.create({
    id: DELETE_RUN_ID,
    threadId: DELETE_THREAD_ID,
    agentId: AGENT_ID,
    providerId: 'anthropic',
    model: 'claude-haiku-4-5-20251001',
    status: 'completed',
  });
  await AgentActivityLog.logActivity({
    agentId: AGENT_ID,
    runId: DELETE_RUN_ID,
    actionType: 'thinking',
    triggerType: 'manual',
    content: 'delete thread activity',
  });

  await Messages.create({
    id: `message-${PREFIX}-active`,
    threadId: ACTIVE_THREAD_ID,
    role: 'user',
    content: 'must survive a conflicting clear',
    agentId: null,
    userId: user.id,
  });
  await Runs.create({
    id: ACTIVE_RUN_ID,
    threadId: ACTIVE_THREAD_ID,
    agentId: AGENT_ID,
    providerId: 'anthropic',
    model: 'claude-haiku-4-5-20251001',
    status: 'running',
  });
  await AgentActivityLog.logActivity({
    agentId: AGENT_ID,
    runId: ACTIVE_RUN_ID,
    actionType: 'thinking',
    triggerType: 'manual',
    content: 'active execution state',
  });

  await Messages.create({
    id: `message-${PREFIX}-rollback-message`,
    threadId: ROLLBACK_MESSAGE_THREAD_ID,
    role: 'user',
    content: 'must roll back with the owner failure',
    agentId: null,
    userId: user.id,
  });
  await Runs.create({
    id: ROLLBACK_MESSAGE_RUN_ID,
    threadId: ROLLBACK_MESSAGE_THREAD_ID,
    agentId: AGENT_ID,
    providerId: 'anthropic',
    model: 'claude-haiku-4-5-20251001',
    status: 'completed',
  });
  await AgentActivityLog.logActivity({
    agentId: AGENT_ID,
    runId: ROLLBACK_MESSAGE_RUN_ID,
    actionType: 'thinking',
    triggerType: 'manual',
    content: 'rollback message activity',
  });

  await Runs.create({
    id: ROLLBACK_NODE_RUN_ID,
    threadId: ROLLBACK_NODE_THREAD_ID,
    agentId: AGENT_ID,
    providerId: 'anthropic',
    model: 'claude-haiku-4-5-20251001',
    status: 'completed',
  });
  await AgentActivityLog.logActivity({
    agentId: AGENT_ID,
    runId: ROLLBACK_NODE_RUN_ID,
    actionType: 'thinking',
    triggerType: 'manual',
    content: 'rollback node activity',
  });

  await Runs.create({
    id: HOLD_RUN_ID,
    threadId: HOLD_THREAD_ID,
    agentId: AGENT_ID,
    providerId: 'anthropic',
    model: 'claude-haiku-4-5-20251001',
    status: 'completed',
  });
}

describe('POST /threads/:id/clear — purges messages, runs, and activity', () => {
  beforeAll(async () => {
    await cleanup();
    await seed();
  });
  afterAll(cleanup);
  beforeEach(() => broadcastToChannel.mockClear());

  it('returns conflict with zero partial deletion while the thread is in flight', async () => {
    expect(activeRunTracker.startSession(`session-${PREFIX}-active`, ACTIVE_THREAD_ID)).toBe(true);
    try {
      const res = await request(makeApp()).post(`/threads/${ACTIVE_THREAD_ID}/clear`);

      expect(res.status).toBe(409);
      expect(await Messages.listByThreadId(ACTIVE_THREAD_ID)).toHaveLength(1);
      expect(await Runs.listByThreadId(ACTIVE_THREAD_ID)).toHaveLength(1);
      expect(await AgentActivityLog.getByThreadId(ACTIVE_THREAD_ID)).toHaveLength(1);
    } finally {
      activeRunTracker.finishSession(`session-${PREFIX}-active`);
    }
  });

  it('rolls back activity, runs, and messages when the owner clear mutation throws', async () => {
    await expect(
      withThreadExecutionPurge([ROLLBACK_MESSAGE_THREAD_ID], async ({ tx }) => {
        await Messages.deleteByThread(ROLLBACK_MESSAGE_THREAD_ID, tx);
        throw new Error('deliberate clear owner failure');
      })
    ).rejects.toThrow('deliberate clear owner failure');

    expect(await Messages.listByThreadId(ROLLBACK_MESSAGE_THREAD_ID)).toHaveLength(1);
    expect(await Runs.listByThreadId(ROLLBACK_MESSAGE_THREAD_ID)).toHaveLength(1);
    expect(await AgentActivityLog.getByThreadId(ROLLBACK_MESSAGE_THREAD_ID)).toHaveLength(1);
    expect(await Threads.findById(ROLLBACK_MESSAGE_THREAD_ID)).not.toBeNull();
  });

  it('rolls back activity, runs, and the thread node when permanent delete throws', async () => {
    await expect(
      withThreadExecutionPurge([ROLLBACK_NODE_THREAD_ID], async ({ tx }) => {
        await Nodes.deleteOfType(ROLLBACK_NODE_THREAD_ID, 'thread', tx);
        throw new Error('deliberate node owner failure');
      })
    ).rejects.toThrow('deliberate node owner failure');

    expect(await Threads.findById(ROLLBACK_NODE_THREAD_ID)).not.toBeNull();
    expect(await Runs.listByThreadId(ROLLBACK_NODE_THREAD_ID)).toHaveLength(1);
    expect(await AgentActivityLog.getByThreadId(ROLLBACK_NODE_THREAD_ID)).toHaveLength(1);
  });

  it('blocks a new session until the reserved transaction completes', async () => {
    let markEntered!: () => void;
    const entered = new Promise<void>((resolve) => {
      markEntered = resolve;
    });
    let releaseOperation!: () => void;
    const operationGate = new Promise<void>((resolve) => {
      releaseOperation = resolve;
    });

    const purge = withThreadExecutionPurge([HOLD_THREAD_ID], async () => {
      markEntered();
      await operationGate;
    });
    await entered;

    expect(activeRunTracker.startSession(`session-${PREFIX}-hold`, HOLD_THREAD_ID)).toBe(false);
    releaseOperation();
    await purge;

    expect(activeRunTracker.startSession(`session-${PREFIX}-hold`, HOLD_THREAD_ID)).toBe(true);
    activeRunTracker.finishSession(`session-${PREFIX}-hold`);
  });

  it('deletes all three replay sources for the thread and reports the counts', async () => {
    const res = await request(makeApp()).post(`/threads/${THREAD_ID}/clear`);

    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      deletedMessages: 2,
      deletedRuns: 1,
      deletedActivity: 2,
    });

    // Every replay source is empty — nothing left to resurrect.
    expect(await Messages.listByThreadId(THREAD_ID)).toEqual([]);
    expect(await Runs.listByThreadId(THREAD_ID)).toEqual([]);
    expect(await AgentActivityLog.getByThreadId(THREAD_ID)).toEqual([]);

    // No orphaned activity rows either: activity was deleted, not set to NULL.
    const { rows: orphans } = await getDb().query(
      `SELECT id FROM public.agent_activity_log WHERE agent_id = $1 AND run_id IS NULL`,
      [AGENT_ID]
    );
    expect(orphans).toEqual([]);

    // The fold is gone too (clearSummaries was not asked for): replay would otherwise open the
    // next prompt with a summary of the conversation that was just cleared.
    expect(await ThreadSummaries.getLatestCompaction(THREAD_ID, AGENT_ID)).toBeNull();
    expect(await ThreadSummaries.findByIdWithNode(FOLD_ID)).toBeNull();

    // The thread survives; viewers were told to empty the message list.
    expect(await Threads.findById(THREAD_ID)).not.toBeNull();
    expect(broadcastToChannel).toHaveBeenCalledWith(
      THREAD_ID,
      expect.objectContaining({ type: 'socket:thread:cleared' })
    );
  });

  it('leaves other threads runs and activity untouched', async () => {
    expect((await Runs.listByThreadId(OTHER_THREAD_ID)).map((r) => r.id)).toEqual([OTHER_RUN_ID]);
    expect(await AgentActivityLog.getByThreadId(OTHER_THREAD_ID)).toHaveLength(1);
    expect((await ThreadSummaries.getLatestCompaction(OTHER_THREAD_ID, AGENT_ID))?.id).toBe(
      OTHER_FOLD_ID
    );
  });

  it('purges runs and activity before permanently deleting a thread', async () => {
    const res = await request(makeApp()).delete(`/threads/${DELETE_THREAD_ID}`);

    expect(res.status).toBe(200);
    expect(await Threads.findById(DELETE_THREAD_ID)).toBeNull();
    expect(await Runs.listByThreadId(DELETE_THREAD_ID)).toEqual([]);
    const { rows } = await getDb().query(
      `SELECT id FROM public.agent_activity_log WHERE run_id = $1 OR content = $2`,
      [DELETE_RUN_ID, 'delete thread activity']
    );
    expect(rows).toEqual([]);
  });
});
