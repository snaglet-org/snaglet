/**
 * Shared destructive-thread execution purge.
 *
 * Every clear or hard-delete path must use this service. It first reserves all
 * affected threads while they are idle, then deletes activity before runs in a
 * single DB transaction (run_id is ON DELETE SET NULL), holds the reservation
 * through the caller's message/node mutation, removes what a thread delete
 * leaves behind (threadDeleteResidue), and releases the reservation in finally.
 * A delete that would take a home thread is refused before anything is
 * deleted (homeThreadGuard), unless the caller allows it.
 */

import { getDb, transaction, type DbQueryable, type NodeRunner } from '@snaglet/db';
import { ConflictError, getErrorMessage } from '@snaglet/shared/utils';
import { logger } from '@server/config/logger';
import { activeRunTracker } from '@server/services/ActiveRunTracker';
import { assertNoHomeThreads } from '@server/services/homeThreadGuard';
import {
  forgetCachedThreadSummaryModelOverrides,
  pruneDeletedThreadSummaryModelOverrides,
} from '@server/services/settings/threadSummaryOverridePrune';
import {
  announceThreadResidueRemoved,
  collectThreadResidue,
  removeThreadResidue,
  type RemovedThreadResidue,
} from '@server/services/threadDeleteResidue';

interface ThreadExecutionPurgeResult {
  deletedActivity: number;
  deletedRuns: number;
}

export interface ThreadExecutionPurgeOutcome<T> extends ThreadExecutionPurgeResult {
  value: T;
}

export interface ThreadExecutionPurgeContext extends ThreadExecutionPurgeResult {
  /** The purge's transaction (a full client, so table lifecycle helpers fit). */
  tx: DbQueryable;
}

export interface ThreadExecutionPurgeOptions {
  /**
   * Lock the owning node subtree and return its authoritative thread cohort.
   * The result must exactly match the cohort reserved before the transaction;
   * otherwise the transaction aborts before any execution rows are deleted.
   */
  lockAndListThreadIds?: (tx: NodeRunner) => Promise<Iterable<string>>;
  /**
   * The operation keeps the threads (a clear). Their subagent helpers live on,
   * so they are not reserved. A delete takes the helper threads with it and
   * reserves them too: a running helper refuses the delete.
   */
  keepsThreads?: boolean;
  /**
   * The delete may take home threads (the user's DMs with an agent): the agent
   * delete, since a DM is meaningless once one of its parties is gone, and the
   * archive sweep, which only meets a home thread archived before archiving
   * one was refused. Every other delete refuses a home thread before anything
   * is deleted.
   */
  allowsHomeThreads?: boolean;
}

function normalizeThreadIds(threadIds: Iterable<string>): string[] {
  return [...new Set([...threadIds].map((id) => id.trim()).filter(Boolean))].sort((a, b) =>
    a.localeCompare(b)
  );
}

/**
 * Reserve every thread, then every helper thread (helper id -> its parent's
 * id) not already in the list. All or nothing: a conflict releases what was
 * taken.
 */
function reserveAll(
  threadIds: string[],
  helpers: ReadonlyMap<string, string> = new Map()
): string[] {
  const reserved: string[] = [];
  const reserve = (threadId: string, conflict: () => string) => {
    if (!activeRunTracker.reserveThreadPurge(threadId)) {
      for (const held of reserved) activeRunTracker.releaseThreadPurge(held);
      throw new ConflictError(conflict());
    }
    reserved.push(threadId);
  };
  for (const threadId of threadIds) {
    reserve(
      threadId,
      () =>
        `Thread ${threadId} has an active run, handoff, or concurrent purge. Wait for it to finish before clearing or permanently deleting it.`
    );
  }
  for (const [helperId, parentId] of helpers) {
    if (threadIds.includes(helperId)) continue;
    reserve(
      helperId,
      () =>
        `Thread ${parentId} has a subagent that is still running (helper thread ${helperId}). Wait for it to finish, or stop it, before permanently deleting the thread.`
    );
  }
  return reserved;
}

/**
 * The subagent helper threads of `threadIds`, helper id -> parent id. A
 * thread delete deletes them too (the subagents trigger), so they are
 * reserved with their parents.
 */
async function listHelperThreads(threadIds: string[]): Promise<Map<string, string>> {
  if (threadIds.length === 0) return new Map();
  const { rows } = await getDb().query<{ id: string; parentId: string }>(
    `SELECT id, parent_thread_id AS "parentId" FROM public.threads
      WHERE parent_thread_id = ANY($1::text[])
     UNION
     SELECT thread_id, parent_thread_id FROM public.subagents
      WHERE parent_thread_id = ANY($1::text[]) AND thread_id IS NOT NULL
     ORDER BY 1`,
    [threadIds]
  );
  return new Map(rows.map((row) => [row.id, row.parentId]));
}

function cohortsMatch(reserved: string[], authoritative: string[]): boolean {
  return (
    reserved.length === authoritative.length &&
    reserved.every((threadId, index) => threadId === authoritative[index])
  );
}

async function purgeReservedThreads(
  threadIds: string[],
  tx: NodeRunner
): Promise<ThreadExecutionPurgeResult> {
  if (threadIds.length === 0) return { deletedActivity: 0, deletedRuns: 0 };
  // Activity MUST be first: deleting runs first would SET run_id NULL and
  // permanently strand the rows outside any thread-attributable delete.
  const activity = await tx.query<{ id: string }>(
    `DELETE FROM public.agent_activity_log a
        USING public.runs r
        WHERE r.id = a.run_id
          AND r.thread_id = ANY($1::text[])
        RETURNING a.id`,
    [threadIds]
  );
  const runs = await tx.query<{ id: string }>(
    `DELETE FROM public.runs
        WHERE thread_id = ANY($1::text[])
        RETURNING id`,
    [threadIds]
  );
  // A fold is execution state too: replay applies its summary as the first message, so one left
  // behind would put the conversation being purged straight back into the next prompt. (An
  // ordinary digest is never replayed, so those stay unless the caller deletes them.) Removed
  // through the node spine, which cascades the row and its embeddings.
  await tx.query(
    `DELETE FROM public.nodes
        WHERE id IN (
          SELECT id FROM public.thread_summaries
           WHERE thread_id = ANY($1::text[]) AND compaction IS NOT NULL
        )`,
    [threadIds]
  );
  return {
    deletedActivity: activity.rowCount ?? activity.rows.length,
    deletedRuns: runs.rowCount ?? runs.rows.length,
  };
}

/**
 * Reserve idle threads, then run `operation` in one transaction with new
 * sessions blocked — WITHOUT the blanket runs/activity purge.
 *
 * This is the seam for partial destructive edits (history trimming), which
 * delete a *subset* of a thread's execution rows and therefore cannot use
 * `withThreadExecutionPurge`'s all-or-nothing wipe. They still need its two
 * load-bearing guarantees, so both live here rather than being re-implemented:
 * the reservation is taken before any statement runs (an in-flight thread is
 * rejected with zero partial deletion), and it is not released until the
 * transaction has actually committed or rolled back.
 *
 * Callers remain responsible for the activity-before-runs ordering rule inside
 * their own operation — `agent_activity_log.run_id` is ON DELETE SET NULL, so
 * deleting runs first strands activity rows instead of removing them.
 */
export async function withReservedThreadTransaction<T>(
  threadIds: Iterable<string>,
  operation: (tx: NodeRunner) => Promise<T>
): Promise<T> {
  const ids = normalizeThreadIds(threadIds);
  const reserved = reserveAll(ids);
  try {
    return await transaction(async (tx) => operation(tx));
  } finally {
    for (const threadId of reserved) activeRunTracker.releaseThreadPurge(threadId);
  }
}

/**
 * Reserve, transactionally purge, then run the owning clear/delete mutation
 * while new sessions remain blocked. A reservation conflict occurs before any
 * DELETE statement, so active/reserved threads cannot be partially purged.
 */
export async function withThreadExecutionPurge<T>(
  threadIds: Iterable<string>,
  operation: (context: ThreadExecutionPurgeContext) => Promise<T>,
  options?: ThreadExecutionPurgeOptions
): Promise<ThreadExecutionPurgeOutcome<T>> {
  const ids = normalizeThreadIds(threadIds);
  const helpers = options?.keepsThreads ? new Map<string, string>() : await listHelperThreads(ids);
  const reserved = reserveAll(ids, helpers);
  try {
    let prunedOverrides = false;
    let removed: RemovedThreadResidue | null = null;
    // Await inside the try so the finally block cannot release reservations
    // until commit/rollback has actually completed.
    const outcome = await transaction(async (tx) => {
      if (options?.lockAndListThreadIds) {
        const authoritativeIds = normalizeThreadIds(await options.lockAndListThreadIds(tx));
        if (!cohortsMatch(ids, authoritativeIds)) {
          throw new ConflictError(
            'The thread cohort changed while preparing the delete. No data was deleted; retry the operation.'
          );
        }
      }
      // Before any statement deletes: a refused delete changes nothing.
      if (!options?.keepsThreads && !options?.allowsHomeThreads) {
        await assertNoHomeThreads(ids, tx);
      }
      // Read before the purge below deletes the runs it lists.
      const residue = await collectThreadResidue(ids, tx);
      if (!options?.keepsThreads) {
        const held = new Set(reserved);
        const unreserved = residue.helperThreads.find((helper) => !held.has(helper.id));
        if (unreserved) {
          throw new ConflictError(
            `A subagent started in thread ${unreserved.threadId} while preparing the delete. No data was deleted; retry the operation.`
          );
        }
      }
      const purge = await purgeReservedThreads(ids, tx);
      const value = await operation({ tx, ...purge });
      removed = await removeThreadResidue(residue, tx);
      // After the operation, so a clear (thread kept) keeps its per-thread
      // summary model and a delete drops it in the same commit.
      prunedOverrides = await pruneDeletedThreadSummaryModelOverrides(ids, tx);
      return { ...purge, value };
    });
    if (prunedOverrides) forgetCachedThreadSummaryModelOverrides();
    if (removed) {
      await announceThreadResidueRemoved(removed).catch((err: unknown) =>
        logger.warn(`[threads] post-delete announcements failed: ${getErrorMessage(err)}`)
      );
    }
    return outcome;
  } finally {
    for (const threadId of reserved) activeRunTracker.releaseThreadPurge(threadId);
  }
}

/**
 * Lock a node subtree top-down and return the threads its delete will take:
 * thread descendants (none today — threads are not in the folder tree, kept
 * defensively) and every thread scoped by `project_id` to a project container
 * in the subtree, the root included.
 *
 * This deliberately uses one statement per tree level rather than a single
 * recursive-CTE snapshot. Once a parent node is locked FOR UPDATE, PostgreSQL
 * cannot complete an INSERT, a container_id move or a project_id change
 * beneath it: both FKs need a conflicting KEY SHARE lock on that parent. The
 * next level query therefore sees every committed child and project thread,
 * locks them in stable id order, and closes the same race for the following
 * level. Moving an existing descendant out before its row is locked is safe
 * because the exact reserved-versus-authoritative cohort comparison aborts
 * the delete.
 */
export async function lockThreadIdsInNodeSubtree(
  rootId: string,
  tx: NodeRunner
): Promise<string[]> {
  const root = await tx.query<{ id: string; type: string }>(
    `SELECT id, type
       FROM public.nodes
      WHERE id = $1
      FOR UPDATE`,
    [rootId]
  );
  if (root.rows.length === 0) return [];

  const visited = new Set<string>();
  const threadIds: string[] = [];
  let frontier = root.rows;

  while (frontier.length > 0) {
    const parentIds: string[] = [];
    for (const node of frontier) {
      if (visited.has(node.id)) continue;
      visited.add(node.id);
      parentIds.push(node.id);
      if (node.type === 'thread') threadIds.push(node.id);
    }
    if (parentIds.length === 0) break;

    const children = await tx.query<{ id: string; type: string }>(
      `SELECT id, type
         FROM public.nodes
        WHERE container_id = ANY($1::text[]) OR project_id = ANY($1::text[])
        ORDER BY id ASC
        FOR UPDATE`,
      [parentIds]
    );
    frontier = children.rows;
  }

  return threadIds.sort((a, b) => a.localeCompare(b));
}

/**
 * Threads a root node delete will cascade through: thread descendants plus
 * every thread whose `project_id` is a container in the subtree (the root
 * included, when it is a project). Both FKs cascade on delete.
 */
export async function listThreadIdsInNodeSubtree(rootId: string): Promise<string[]> {
  const { rows } = await getDb().query<{ id: string }>(
    `WITH RECURSIVE subtree AS (
       SELECT id, type FROM public.nodes WHERE id = $1
       UNION ALL
       SELECT child.id, child.type
         FROM public.nodes child
         JOIN subtree parent ON child.container_id = parent.id
     )
     SELECT id FROM subtree WHERE type = 'thread'
     UNION
     SELECT n.id
       FROM public.nodes n
      WHERE n.type = 'thread'
        AND n.project_id IN (SELECT id FROM subtree WHERE type = 'container')
     ORDER BY id ASC`,
    [rootId]
  );
  return rows.map((row) => row.id);
}

/** Archived threads that an archive sweep up to `before` (a timestamptz) will hard-delete. */
export async function listArchivedThreadIdsBefore(before: string): Promise<string[]> {
  const { rows } = await getDb().query<{ id: string }>(
    `SELECT id
       FROM public.nodes
      WHERE type = 'thread'
        AND archived = true
        AND archived_at < $1::timestamptz
      ORDER BY id ASC`,
    [before]
  );
  return rows.map((row) => row.id);
}
