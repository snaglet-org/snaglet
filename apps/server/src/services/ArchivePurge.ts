/**
 * Hard-delete of expired archived nodes and their projects' custom tables,
 * shared by the scheduled TTL sweep and the archive drawer's Sweep.
 *
 * Each dropped table holds about a dozen locks until its transaction ends,
 * and the cluster has a few thousand lock slots for all sessions together.
 * So a sweep runs as a series of sweeps up to earlier cutoffs, oldest first,
 * each one transaction (`archive_ttl_sweep` plus the tables of the projects
 * it deletes) with at most {@link SWEEP_TABLES_PER_TRANSACTION} tables. A
 * project's tables and node go together, and each commit leaves the state a
 * sweep at that earlier time would have. Only projects archived together with
 * more tables than that get their tables dropped first, in transactions of
 * their own. A failure keeps what was committed; running again finishes.
 * Sweeps run one at a time and refuse restores meanwhile (ArchiveSweepGuard).
 */

import { getDb, transaction } from '@snaglet/db';
import type { TableCatalogRow } from '@snaglet/db/tables/table_catalog';
import { ErrorCode, HTTP_STATUS } from '@snaglet/shared/types';
import { AppError, getErrorMessage } from '@snaglet/shared/utils';
import {
  announceProjectTablesDrop,
  dropTablesOfExpiringProjects,
  expiringTableGroups,
  purgeArchivedTable,
  type ExpiringTableGroup,
  type ProjectTablesDrop,
} from '@server/domains/tables/tableLifecycle';
import {
  listArchivedThreadIdsBefore,
  withThreadExecutionPurge,
} from '@server/services/ThreadExecutionPurgeService';
import { runArchiveSweep } from '@server/services/ArchiveSweepGuard';

/** Most custom tables one sweep transaction drops (a few hundred locks). */
const SWEEP_TABLES_PER_TRANSACTION = 25;

export interface ArchivePurgeResult {
  deletedContainers: number;
  deletedOther: number;
  tables: ProjectTablesDrop;
}

/** A sweep that stopped partway; `progress` is what it deleted for good. */
export class ArchivePurgeIncompleteError extends AppError {
  readonly progress: ArchivePurgeResult;

  constructor(progress: ArchivePurgeResult, cause: unknown) {
    const deleted =
      progress.deletedContainers + progress.deletedOther + progress.tables.dropped.length;
    const reason = getErrorMessage(cause).replace(/[.\s]+$/, '');
    const operational = cause instanceof AppError && cause.isOperational;
    super(
      deleted
        ? `Sweep stopped partway: ${reason}. What it deleted stays deleted; sweep again to finish.`
        : `Sweep failed: ${reason}. Nothing was deleted.`,
      operational ? cause.code : ErrorCode.INTERNAL_ERROR,
      operational ? cause.statusCode : HTTP_STATUS.INTERNAL_SERVER_ERROR,
      true,
      {
        deletedContainers: progress.deletedContainers,
        deletedOther: progress.deletedOther,
        deletedTables: progress.tables.dropped.length,
      }
    );
    this.progress = progress;
    this.cause = cause;
    Object.setPrototypeOf(this, ArchivePurgeIncompleteError.prototype);
  }
}

/**
 * Cutoffs (exclusive) for the sweeps before the final one: whole groups, in
 * order, while their tables fit in `maxTables`. A group larger than that gets
 * a sweep of its own.
 */
export function planSweepCutoffs(
  groups: readonly ExpiringTableGroup[],
  maxTables: number
): string[] {
  const cutoffs: string[] = [];
  let tables = 0;
  for (const group of groups) {
    if (tables > 0 && tables + group.tables > maxTables) {
      cutoffs.push(group.due);
      tables = 0;
    }
    tables += group.tables;
  }
  return cutoffs;
}

/** Add one transaction's drop; a kept table can be reported by every transaction of its cutoff. */
function addDrop(result: ArchivePurgeResult, drop: ProjectTablesDrop): void {
  const tables = result.tables;
  tables.dropped.push(...drop.dropped);
  for (const id of drop.kept) if (!tables.kept.includes(id)) tables.kept.push(id);
  tables.linked.push(...drop.linked);
  for (const actor of drop.historyActors)
    if (!tables.historyActors.some((seen) => seen.kind === actor.kind && seen.id === actor.id))
      tables.historyActors.push(actor);
}

/** Delete everything archived before `before` (a timestamptz), in bounded transactions. */
async function sweepBefore(
  before: string,
  maxTables: number,
  result: ArchivePurgeResult
): Promise<void> {
  for (;;) {
    const groups = await expiringTableGroups(before);
    const pending = groups.reduce((sum, group) => sum + group.tables, 0);
    if (pending <= maxTables) break;
    const chunk = await transaction((tx) =>
      dropTablesOfExpiringProjects(before, tx, { limit: maxTables })
    );
    addDrop(result, chunk);
    announceProjectTablesDrop(chunk);
    if (!chunk.dropped.length && !chunk.droppedFields) break;
  }
  const threadIds = await listArchivedThreadIdsBefore(before);
  // Archiving a home thread is refused, so the sweep only meets one archived
  // before that rule; expiring it is what archiving it promised.
  const swept = await withThreadExecutionPurge(
    threadIds,
    async ({ tx }) => {
      const tables = await dropTablesOfExpiringProjects(before, tx);
      // A time-only interval: `now() - before` has a days part, which is
      // applied in calendar days of the session time zone and misses `before`
      // by an hour across a DST change.
      const { rows } = await tx.query<{ deleted_containers: number; deleted_other: number }>(
        `SELECT deleted_containers, deleted_other
         FROM public.archive_ttl_sweep(extract(epoch FROM now() - $1::timestamptz) * interval '1 second')`,
        [before]
      );
      return { tables, nodes: rows[0] };
    },
    { allowsHomeThreads: true }
  );
  result.deletedContainers += swept.value.nodes?.deleted_containers ?? 0;
  result.deletedOther += swept.value.nodes?.deleted_other ?? 0;
  addDrop(result, swept.value.tables);
  announceProjectTablesDrop(swept.value.tables);
}

/**
 * A table kept because a table of a later cutoff linked to it is free once
 * that one is dropped: drop it now, as one transaction would have. Tables
 * still linked from elsewhere stay kept. If the run stops before this, such a
 * table stays archived without a project; Sweep's archived-tables pass (in
 * the sweep-all route) drops it once nothing links to it.
 */
async function dropUnlinkedKeptTables(result: ArchivePurgeResult): Promise<void> {
  const kept = result.tables.kept;
  for (let progress = true; progress && kept.length; ) {
    progress = false;
    for (const id of [...kept]) {
      let table: TableCatalogRow | null = null;
      try {
        table = (await purgeArchivedTable(id, { clearReferences: false })).table;
      } catch (error) {
        if (error instanceof AppError && error.statusCode === HTTP_STATUS.CONFLICT) continue;
        if (!(error instanceof AppError) || error.statusCode !== HTTP_STATUS.NOT_FOUND) throw error;
      }
      kept.splice(kept.indexOf(id), 1);
      if (table) result.tables.dropped.push(table);
      progress = true;
    }
  }
}

/**
 * Hard-delete every archived node archived more than `retention` (an
 * interval) ago, with the custom tables of the projects that go. Throws
 * {@link ArchivePurgeIncompleteError} when a transaction fails.
 */
export async function purgeExpiredArchivedNodes(
  retention: string,
  opts: { maxTablesPerTransaction?: number } = {}
): Promise<ArchivePurgeResult> {
  return runArchiveSweep(() => purge(retention, opts));
}

async function purge(
  retention: string,
  opts: { maxTablesPerTransaction?: number }
): Promise<ArchivePurgeResult> {
  const maxTables = opts.maxTablesPerTransaction ?? SWEEP_TABLES_PER_TRANSACTION;
  const result: ArchivePurgeResult = {
    deletedContainers: 0,
    deletedOther: 0,
    tables: { dropped: [], kept: [], linked: [], historyActors: [] },
  };
  try {
    const { rows } = await getDb().query<{ before: string }>(
      'SELECT (now() - $1::interval)::text AS before',
      [retention]
    );
    const final = rows[0]?.before;
    if (!final) throw new Error('Could not resolve the archive sweep cutoff');
    const cutoffs = planSweepCutoffs(await expiringTableGroups(final), maxTables);
    for (const before of [...cutoffs, final]) await sweepBefore(before, maxTables, result);
    await dropUnlinkedKeptTables(result);
  } catch (error) {
    throw new ArchivePurgeIncompleteError(result, error);
  }
  return result;
}
