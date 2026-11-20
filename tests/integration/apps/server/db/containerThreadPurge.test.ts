/**
 * Real-PostgreSQL coverage for container hard-delete cohorts. A container can
 * own nested containers, and a project container among them owns threads by
 * `project_id`, so deleting the root must reserve every thread scoped to a
 * project in the subtree and atomically purge execution replay data with the
 * node cascade. No conflict or owner failure may leave a half-deleted cohort.
 */

import { afterAll, beforeAll, describe, expect, it, jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';

const emitTreeNodeDeleted = jest.fn();
jest.mock('@server/realtime/surfaces/tree', () => ({
  emitTreeNodeCreated: jest.fn(),
  emitTreeNodeDeleted: (...args: unknown[]) => emitTreeNodeDeleted(...args),
  emitTreeNodeUpdated: jest.fn(),
  snapshotFromContainer: jest.fn(),
}));

import { Containers, getDb, Messages, Threads, transaction, Users } from '@snaglet/db';
import { Agents } from '@snaglet/db/tables/agents';
import { AgentActivityLog } from '@snaglet/db/tables/agent_activity_log';
import { Runs } from '@snaglet/db/tables/runs';
import containersRouter from '@server/domains/containers/containers.routes';
import { errorHandler } from '@server/middleware';
import { activeRunTracker } from '@server/services/ActiveRunTracker';
import {
  listThreadIdsInNodeSubtree,
  lockThreadIdsInNodeSubtree,
  withThreadExecutionPurge,
} from '@server/services/ThreadExecutionPurgeService';

const PREFIX = 'container-thread-purge-it';
const AGENT_ID = `agent-${PREFIX}`;

const SUCCESS_ROOT_ID = `container-${PREFIX}-success-root`;
const SUCCESS_CHILD_ID = `container-${PREFIX}-success-child`;
const SUCCESS_THREAD_ID = `thread-${PREFIX}-success`;
const SUCCESS_RUN_ID = `run-${PREFIX}-success`;

const CONFLICT_ROOT_ID = `container-${PREFIX}-conflict-root`;
const CONFLICT_CHILD_ID = `container-${PREFIX}-conflict-child`;
const CONFLICT_THREAD_ID = `thread-${PREFIX}-conflict`;
const CONFLICT_RUN_ID = `run-${PREFIX}-conflict`;

const ROLLBACK_ROOT_ID = `container-${PREFIX}-rollback-root`;
const ROLLBACK_CHILD_ID = `container-${PREFIX}-rollback-child`;
const ROLLBACK_THREAD_ID = `thread-${PREFIX}-rollback`;
const ROLLBACK_RUN_ID = `run-${PREFIX}-rollback`;

const MISMATCH_ROOT_ID = `container-${PREFIX}-mismatch-root`;
const MISMATCH_CHILD_ID = `container-${PREFIX}-mismatch-child`;
const MISMATCH_THREAD_ID = `thread-${PREFIX}-mismatch`;
const MISMATCH_RUN_ID = `run-${PREFIX}-mismatch`;
const MISMATCH_INCOMING_THREAD_ID = `thread-${PREFIX}-mismatch-incoming`;
const MISMATCH_INCOMING_RUN_ID = `run-${PREFIX}-mismatch-incoming`;

const LOCK_ROOT_ID = `container-${PREFIX}-lock-root`;
const LOCK_CHILD_ID = `container-${PREFIX}-lock-child`;
const LOCK_THREAD_ID = `thread-${PREFIX}-lock`;
const LOCK_RUN_ID = `run-${PREFIX}-lock`;
const LOCK_INCOMING_THREAD_ID = `thread-${PREFIX}-lock-incoming`;
const LOCK_INCOMING_RUN_ID = `run-${PREFIX}-lock-incoming`;

const ROOT_IDS = [
  SUCCESS_ROOT_ID,
  CONFLICT_ROOT_ID,
  ROLLBACK_ROOT_ID,
  MISMATCH_ROOT_ID,
  LOCK_ROOT_ID,
];
const THREAD_IDS = [
  SUCCESS_THREAD_ID,
  CONFLICT_THREAD_ID,
  ROLLBACK_THREAD_ID,
  MISMATCH_THREAD_ID,
  MISMATCH_INCOMING_THREAD_ID,
  LOCK_THREAD_ID,
  LOCK_INCOMING_THREAD_ID,
];
const RUN_IDS = [
  SUCCESS_RUN_ID,
  CONFLICT_RUN_ID,
  ROLLBACK_RUN_ID,
  MISMATCH_RUN_ID,
  MISMATCH_INCOMING_RUN_ID,
  LOCK_RUN_ID,
  LOCK_INCOMING_RUN_ID,
];

function makeApp() {
  return express().use(express.json()).use('/api/containers', containersRouter).use(errorHandler);
}

async function cleanup(): Promise<void> {
  const pool = getDb();
  await pool.query(
    `DELETE FROM public.agent_activity_log WHERE run_id = ANY($1) OR agent_id = $2`,
    [RUN_IDS, AGENT_ID]
  );
  await pool.query(`DELETE FROM public.runs WHERE id = ANY($1)`, [RUN_IDS]);
  await pool.query(`DELETE FROM public.nodes WHERE id = ANY($1)`, [ROOT_IDS]);
  await pool.query(`DELETE FROM public.nodes WHERE id = ANY($1)`, [THREAD_IDS]);
  await pool.query(`DELETE FROM public.nodes WHERE id LIKE $1`, [`message-thread-${PREFIX}-%`]);
  await pool.query(`DELETE FROM public.agents WHERE id = $1`, [AGENT_ID]);
}

async function seedCohort(input: {
  rootId: string;
  childId: string;
  threadId: string;
  runId: string;
  activityContent: string;
}): Promise<void> {
  // The child is a project nested in a plain root; the thread is scoped to it.
  await Containers.create({ id: input.rootId, name: input.rootId });
  await Containers.create({
    id: input.childId,
    name: input.childId,
    parentId: input.rootId,
    category: 'project',
  });
  await Threads.create({
    id: input.threadId,
    title: input.threadId,
    projectId: input.childId,
  });
  const user = await Users.getOrCreateLocalUser();
  await Messages.create({
    id: `message-${input.threadId}`,
    threadId: input.threadId,
    role: 'user',
    content: `message for ${input.threadId}`,
    agentId: null,
    userId: user.id,
  });
  await Runs.create({
    id: input.runId,
    threadId: input.threadId,
    agentId: AGENT_ID,
    providerId: 'anthropic',
    model: 'claude-haiku-4-5-20251001',
    status: 'completed',
  });
  await AgentActivityLog.logActivity({
    agentId: AGENT_ID,
    runId: input.runId,
    actionType: 'thinking',
    triggerType: 'manual',
    content: input.activityContent,
  });
}

async function seedStandaloneThread(input: {
  threadId: string;
  runId: string;
  activityContent: string;
}): Promise<void> {
  await Threads.create({ id: input.threadId, title: input.threadId });
  const user = await Users.getOrCreateLocalUser();
  await Messages.create({
    id: `message-${input.threadId}`,
    threadId: input.threadId,
    role: 'user',
    content: `message for ${input.threadId}`,
    agentId: null,
    userId: user.id,
  });
  await Runs.create({
    id: input.runId,
    threadId: input.threadId,
    agentId: AGENT_ID,
    providerId: 'anthropic',
    model: 'claude-haiku-4-5-20251001',
    status: 'completed',
  });
  await AgentActivityLog.logActivity({
    agentId: AGENT_ID,
    runId: input.runId,
    actionType: 'thinking',
    triggerType: 'manual',
    content: input.activityContent,
  });
}

async function expectCohortPresent(input: {
  rootId: string;
  childId: string;
  threadId: string;
  runId: string;
}): Promise<void> {
  await expect(Containers.findById(input.rootId)).resolves.not.toBeNull();
  await expect(Containers.findById(input.childId)).resolves.not.toBeNull();
  await expect(Threads.findById(input.threadId)).resolves.not.toBeNull();
  await expect(Messages.listByThreadId(input.threadId)).resolves.toHaveLength(1);
  await expect(Runs.listByThreadId(input.threadId)).resolves.toHaveLength(1);
  await expect(AgentActivityLog.getByThreadId(input.threadId)).resolves.toHaveLength(1);
}

async function expectThreadExecutionPresent(threadId: string): Promise<void> {
  await expect(Threads.findById(threadId)).resolves.not.toBeNull();
  await expect(Messages.listByThreadId(threadId)).resolves.toHaveLength(1);
  await expect(Runs.listByThreadId(threadId)).resolves.toHaveLength(1);
  await expect(AgentActivityLog.getByThreadId(threadId)).resolves.toHaveLength(1);
}

describe('container hard-delete thread execution purge', () => {
  beforeAll(async () => {
    await cleanup();
    await Agents.create({ id: AGENT_ID, name: `${PREFIX} agent` });
    await seedCohort({
      rootId: SUCCESS_ROOT_ID,
      childId: SUCCESS_CHILD_ID,
      threadId: SUCCESS_THREAD_ID,
      runId: SUCCESS_RUN_ID,
      activityContent: `${PREFIX} success activity`,
    });
    await seedCohort({
      rootId: CONFLICT_ROOT_ID,
      childId: CONFLICT_CHILD_ID,
      threadId: CONFLICT_THREAD_ID,
      runId: CONFLICT_RUN_ID,
      activityContent: `${PREFIX} conflict activity`,
    });
    await seedCohort({
      rootId: ROLLBACK_ROOT_ID,
      childId: ROLLBACK_CHILD_ID,
      threadId: ROLLBACK_THREAD_ID,
      runId: ROLLBACK_RUN_ID,
      activityContent: `${PREFIX} rollback activity`,
    });
    await seedCohort({
      rootId: MISMATCH_ROOT_ID,
      childId: MISMATCH_CHILD_ID,
      threadId: MISMATCH_THREAD_ID,
      runId: MISMATCH_RUN_ID,
      activityContent: `${PREFIX} mismatch activity`,
    });
    await seedStandaloneThread({
      threadId: MISMATCH_INCOMING_THREAD_ID,
      runId: MISMATCH_INCOMING_RUN_ID,
      activityContent: `${PREFIX} mismatch incoming activity`,
    });
    await seedCohort({
      rootId: LOCK_ROOT_ID,
      childId: LOCK_CHILD_ID,
      threadId: LOCK_THREAD_ID,
      runId: LOCK_RUN_ID,
      activityContent: `${PREFIX} lock activity`,
    });
    await seedStandaloneThread({
      threadId: LOCK_INCOMING_THREAD_ID,
      runId: LOCK_INCOMING_RUN_ID,
      activityContent: `${PREFIX} lock incoming activity`,
    });
  });

  afterAll(cleanup);

  it('returns conflict and preserves the entire subtree when a descendant thread is active', async () => {
    const sessionId = `session-${PREFIX}-conflict`;
    expect(activeRunTracker.startSession(sessionId, CONFLICT_THREAD_ID)).toBe(true);
    try {
      const response = await request(makeApp()).delete(`/api/containers/${CONFLICT_ROOT_ID}`);

      expect(response.status).toBe(409);
      await expectCohortPresent({
        rootId: CONFLICT_ROOT_ID,
        childId: CONFLICT_CHILD_ID,
        threadId: CONFLICT_THREAD_ID,
        runId: CONFLICT_RUN_ID,
      });
      expect(emitTreeNodeDeleted).not.toHaveBeenCalledWith(CONFLICT_ROOT_ID, 'container');
    } finally {
      activeRunTracker.finishSession(sessionId);
    }
  });

  it('returns conflict and preserves the entire subtree when a descendant is already reserved', async () => {
    expect(activeRunTracker.reserveThreadPurge(CONFLICT_THREAD_ID)).toBe(true);
    try {
      const response = await request(makeApp()).delete(`/api/containers/${CONFLICT_ROOT_ID}`);

      expect(response.status).toBe(409);
      await expectCohortPresent({
        rootId: CONFLICT_ROOT_ID,
        childId: CONFLICT_CHILD_ID,
        threadId: CONFLICT_THREAD_ID,
        runId: CONFLICT_RUN_ID,
      });
      expect(emitTreeNodeDeleted).not.toHaveBeenCalledWith(CONFLICT_ROOT_ID, 'container');
    } finally {
      activeRunTracker.releaseThreadPurge(CONFLICT_THREAD_ID);
    }
  });

  it('rolls back the subtree, messages, runs, and activity when the owner callback throws', async () => {
    const threadIds = await listThreadIdsInNodeSubtree(ROLLBACK_ROOT_ID);
    expect(threadIds).toEqual([ROLLBACK_THREAD_ID]);

    await expect(
      withThreadExecutionPurge(
        threadIds,
        async ({ tx }) => {
          expect(await Containers.delete(ROLLBACK_ROOT_ID, tx)).toBe(true);
          throw new Error('deliberate container owner failure');
        },
        {
          lockAndListThreadIds: (tx) => lockThreadIdsInNodeSubtree(ROLLBACK_ROOT_ID, tx),
        }
      )
    ).rejects.toThrow('deliberate container owner failure');

    await expectCohortPresent({
      rootId: ROLLBACK_ROOT_ID,
      childId: ROLLBACK_CHILD_ID,
      threadId: ROLLBACK_THREAD_ID,
      runId: ROLLBACK_RUN_ID,
    });
  });

  it('aborts without mutation when a thread moves into the subtree after preflight', async () => {
    const preflightThreadIds = await listThreadIdsInNodeSubtree(MISMATCH_ROOT_ID);
    expect(preflightThreadIds).toEqual([MISMATCH_THREAD_ID]);

    // Deterministic race interleaving: the project scope commits after the
    // optimistic preflight but before transaction-time subtree locking and
    // revalidation.
    await getDb().query(`UPDATE public.nodes SET project_id = $1 WHERE id = $2`, [
      MISMATCH_CHILD_ID,
      MISMATCH_INCOMING_THREAD_ID,
    ]);
    const ownerDelete = jest.fn();

    await expect(
      withThreadExecutionPurge(preflightThreadIds, ownerDelete, {
        lockAndListThreadIds: (tx) => lockThreadIdsInNodeSubtree(MISMATCH_ROOT_ID, tx),
      })
    ).rejects.toMatchObject({ statusCode: 409 });

    expect(ownerDelete).not.toHaveBeenCalled();
    await expectCohortPresent({
      rootId: MISMATCH_ROOT_ID,
      childId: MISMATCH_CHILD_ID,
      threadId: MISMATCH_THREAD_ID,
      runId: MISMATCH_RUN_ID,
    });
    await expectThreadExecutionPresent(MISMATCH_INCOMING_THREAD_ID);
    const { rows: movedNodes } = await getDb().query<{ project_id: string | null }>(
      `SELECT project_id FROM public.nodes WHERE id = $1`,
      [MISMATCH_INCOMING_THREAD_ID]
    );
    expect(movedNodes[0]?.project_id).toBe(MISMATCH_CHILD_ID);
  });

  it('holds FK parent locks until commit so a racing move cannot enter the deleted cohort', async () => {
    const preflightThreadIds = await listThreadIdsInNodeSubtree(LOCK_ROOT_ID);
    expect(preflightThreadIds).toEqual([LOCK_THREAD_ID]);

    let signalOwnerStarted!: () => void;
    let releaseOwner!: () => void;
    const ownerStarted = new Promise<void>((resolve) => {
      signalOwnerStarted = resolve;
    });
    const holdOwner = new Promise<void>((resolve) => {
      releaseOwner = resolve;
    });
    const deletion = withThreadExecutionPurge(
      preflightThreadIds,
      async ({ tx }) => {
        signalOwnerStarted();
        await holdOwner;
        return Containers.delete(LOCK_ROOT_ID, tx);
      },
      {
        lockAndListThreadIds: (tx) => lockThreadIdsInNodeSubtree(LOCK_ROOT_ID, tx),
      }
    );

    await ownerStarted;
    try {
      await expect(
        transaction(async (tx) => {
          await tx.query(`SET LOCAL lock_timeout = '250ms'`);
          await tx.query(`UPDATE public.nodes SET project_id = $1 WHERE id = $2`, [
            LOCK_CHILD_ID,
            LOCK_INCOMING_THREAD_ID,
          ]);
        })
      ).rejects.toMatchObject({ code: '55P03' });
    } finally {
      releaseOwner();
    }

    await expect(deletion).resolves.toMatchObject({ value: true });
    await expect(Containers.findById(LOCK_ROOT_ID)).resolves.toBeNull();
    await expect(Threads.findById(LOCK_THREAD_ID)).resolves.toBeNull();
    await expectThreadExecutionPresent(LOCK_INCOMING_THREAD_ID);
    const { rows: outsideNodes } = await getDb().query<{ project_id: string | null }>(
      `SELECT project_id FROM public.nodes WHERE id = $1`,
      [LOCK_INCOMING_THREAD_ID]
    );
    expect(outsideNodes[0]?.project_id).toBeNull();
  });

  it('purges execution data and cascades the entire subtree before emitting success', async () => {
    emitTreeNodeDeleted.mockClear();
    const response = await request(makeApp()).delete(`/api/containers/${SUCCESS_ROOT_ID}`);

    expect(response.status).toBe(200);
    await expect(Containers.findById(SUCCESS_ROOT_ID)).resolves.toBeNull();
    await expect(Containers.findById(SUCCESS_CHILD_ID)).resolves.toBeNull();
    await expect(Threads.findById(SUCCESS_THREAD_ID)).resolves.toBeNull();
    await expect(Messages.listByThreadId(SUCCESS_THREAD_ID)).resolves.toEqual([]);
    await expect(Runs.listByThreadId(SUCCESS_THREAD_ID)).resolves.toEqual([]);
    const { rows: activity } = await getDb().query(
      `SELECT id FROM public.agent_activity_log WHERE run_id = $1 OR content = $2`,
      [SUCCESS_RUN_ID, `${PREFIX} success activity`]
    );
    expect(activity).toEqual([]);
    expect(emitTreeNodeDeleted).toHaveBeenCalledWith(SUCCESS_ROOT_ID, 'container');
  });
});
