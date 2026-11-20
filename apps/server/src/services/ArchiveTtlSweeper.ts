/**
 * ArchiveTtlSweeper — periodic background job that hard-deletes expired
 * archived nodes via the `archive_ttl_sweep()` SQL function, and prunes the
 * agent_activity_log via `activity_payload_truncate()` + `activity_hard_delete()`.
 *
 * Policy:
 *
 *   - Archive TTL: 30 days (uniform across all node types).
 *   - Expiration action: hard-delete with full cascade.
 *   - Frequency: once per day is fine (TTL is in days).
 *
 * Activity log TTL (added alongside the activity-log refactor):
 *
 *   - 30 days → NULL the heavy payload columns (content, tool_input,
 *     tool_output) but keep the row skeleton so historical bubbles still
 *     render structurally.
 *   - 90 days → hard-delete the row.
 *
 * pg_cron is not available on the local Postgres install, so the schedule
 * lives here. The SQL functions do the heavy lifting; this service is only
 * responsible for "call them every N hours and log the result."
 *
 * The sweeper is idempotent and crash-safe. Archived nodes go through
 * {@link purgeExpiredArchivedNodes} (bounded transactions, each with its
 * thread execution purge); activity retention functions run independently
 * afterward. Missing a tick (or running two back to back after a restart)
 * only leaves some expired rows around longer.
 */

import { getDb, HookRuns, transaction } from '@snaglet/db';
import { sweepAllOrphanRepeats } from '@snaglet/db/tables/table_entries/repeats';
import { getErrorMessage } from '@snaglet/shared/utils';
import { logger } from '@server/config/logger';
import { emitHookRunsChanged } from '@server/realtime/surfaces/hookRuns';
import {
  ArchivePurgeIncompleteError,
  purgeExpiredArchivedNodes,
  type ArchivePurgeResult,
} from '@server/services/ArchivePurge';
import { onWorkerPolicyChange, resolveWorkerPolicy } from '@server/services/workers/workerPolicy';
import { beginSweep, endSweep, registerWorker } from '@server/services/workers/workerStatus';

const LOG_PREFIX = '\x1b[35m[ttl-sweeper]\x1b[0m';
export const RETENTION_WORKER_ID = 'retention';

/** Sweep cadence — every 6 hours. TTL is in days, so 4 sweeps/day is plenty. */
const SWEEP_INTERVAL_MS = 6 * 60 * 60 * 1000;

/** Delay before the first sweep so server startup isn't blocked. */
const INITIAL_DELAY_MS = 60_000;

/** Age at which archived docs, threads and containers are deleted for good. */
const ARCHIVE_NODE_RETENTION = '30 days';

/** Age at which heavy activity-log payloads (content, tool I/O) get NULL'd. */
const ACTIVITY_PAYLOAD_RETENTION = '30 days';

/** Age at which activity-log rows themselves get hard-deleted. */
const ACTIVITY_HARD_DELETE_RETENTION = '90 days';

/** Durable hook history policy. Running rows are never candidates. */
export const HOOK_RUN_RETENTION_POLICY = {
  keepLatestPerHook: 100,
  succeededRetention: '30 days',
  failureRetention: '90 days',
  batchSize: 500,
} as const;

/** Bound one tick even after a long outage; later ticks resume deterministically. */
const HOOK_RUN_MAX_BATCHES_PER_SWEEP = 10;

interface SweepResult {
  deletedContainers: number;
  deletedOther: number;
  activityPayloadsTruncated: number;
  activityRowsDeleted: number;
  hookRunsDeleted: number;
  orphanRepeatsDeleted: number;
}

class ArchiveTtlSweeperService {
  private interval: ReturnType<typeof setInterval> | null = null;
  private startupTimer: ReturnType<typeof setTimeout> | null = null;
  private sweeping = false;
  private desired = false;
  private policyUnsubscribe: (() => void) | null = null;

  start(): void {
    if (this.desired) return;
    this.desired = true;
    registerWorker(RETENTION_WORKER_ID);
    logger.info(
      `${LOG_PREFIX} Starting TTL sweeper (interval: ${SWEEP_INTERVAL_MS / 1000 / 60 / 60}h, first sweep in ${INITIAL_DELAY_MS / 1000}s)`
    );
    this.policyUnsubscribe = onWorkerPolicyChange(() => {
      void this.reconcilePolicy();
    });
    void this.reconcilePolicy();
  }

  private arm(): void {
    if (this.startupTimer || this.interval) return;
    this.startupTimer = setTimeout(() => {
      this.startupTimer = null;
      void this.tick();
      this.interval = setInterval(() => void this.tick(), SWEEP_INTERVAL_MS);
    }, INITIAL_DELAY_MS);
  }

  private disarm(): void {
    if (this.startupTimer) {
      clearTimeout(this.startupTimer);
      this.startupTimer = null;
    }
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
  }

  private async reconcilePolicy(): Promise<void> {
    if (!this.desired) return;
    try {
      const policy = await resolveWorkerPolicy();
      if (policy.stopped) this.disarm();
      else this.arm();
    } catch (error) {
      logger.warn(`${LOG_PREFIX} policy reconcile failed: ${getErrorMessage(error)}`);
    }
  }

  stop(): void {
    const wasRunning = this.desired || this.startupTimer !== null || this.interval !== null;
    this.desired = false;
    this.policyUnsubscribe?.();
    this.policyUnsubscribe = null;
    this.disarm();
    if (wasRunning) logger.info(`${LOG_PREFIX} TTL sweeper stopped`);
  }

  /**
   * Execute one sweep. Exposed for tests and admin endpoints — call this
   * directly to force an out-of-cycle sweep without waiting for the
   * scheduled tick.
   */
  async tick(): Promise<SweepResult | null> {
    if (this.sweeping) {
      logger.debug(`${LOG_PREFIX} Sweep already in progress — skipping`);
      return null;
    }
    this.sweeping = true;
    beginSweep(RETENTION_WORKER_ID);
    const pool = getDb();
    try {
      const policy = await resolveWorkerPolicy();
      if (!policy.active) {
        endSweep(RETENTION_WORKER_ID, { outcome: 'skipped' });
        return null;
      }

      const result: SweepResult = {
        deletedContainers: 0,
        deletedOther: 0,
        activityPayloadsTruncated: 0,
        activityRowsDeleted: 0,
        hookRunsDeleted: 0,
        orphanRepeatsDeleted: 0,
      };

      const countArchive = (swept: ArchivePurgeResult) => {
        result.deletedContainers = swept.deletedContainers;
        result.deletedOther = swept.deletedOther;
        if (swept.tables.dropped.length || swept.tables.kept.length)
          logger.info(`${LOG_PREFIX} dropped tables of expired projects`, {
            dropped: swept.tables.dropped.map((table) => table.id),
            keptForLinks: swept.tables.kept,
          });
      };
      try {
        countArchive(await purgeExpiredArchivedNodes(ARCHIVE_NODE_RETENTION));
      } catch (err) {
        if (err instanceof ArchivePurgeIncompleteError) countArchive(err.progress);
        logger.error(`${LOG_PREFIX} archive_ttl_sweep failed`, { error: err });
      }

      try {
        const { rows } = await pool.query<{ activity_payload_truncate: number }>(
          'SELECT activity_payload_truncate($1::interval) AS activity_payload_truncate',
          [ACTIVITY_PAYLOAD_RETENTION]
        );
        result.activityPayloadsTruncated = rows[0]?.activity_payload_truncate ?? 0;
      } catch (err) {
        logger.error(`${LOG_PREFIX} activity_payload_truncate failed`, { error: err });
      }

      try {
        const { rows } = await pool.query<{ activity_hard_delete: number }>(
          'SELECT activity_hard_delete($1::interval) AS activity_hard_delete',
          [ACTIVITY_HARD_DELETE_RETENTION]
        );
        result.activityRowsDeleted = rows[0]?.activity_hard_delete ?? 0;
      } catch (err) {
        logger.error(`${LOG_PREFIX} activity_hard_delete failed`, { error: err });
      }

      try {
        const hookRetention = await transaction(async (tx) => {
          let deleted = 0;
          const hookNames = new Set<string>();
          for (let batch = 0; batch < HOOK_RUN_MAX_BATCHES_PER_SWEEP; batch += 1) {
            const pruned = await HookRuns.pruneTerminal(HOOK_RUN_RETENTION_POLICY, tx);
            deleted += pruned.deleted;
            for (const hookName of pruned.hookNames) hookNames.add(hookName);
            if (pruned.deleted < HOOK_RUN_RETENTION_POLICY.batchSize) break;
          }
          return { deleted, hookNames: [...hookNames].sort() };
        });
        result.hookRunsDeleted = hookRetention.deleted;
        emitHookRunsChanged(hookRetention.hookNames, 'retention');
      } catch (err) {
        logger.error(`${LOG_PREFIX} hook-run retention failed`, { error: err });
      }

      try {
        // Repeats / occurrence log rows whose entry is gone. Entry deletes
        // remove them in the same transaction; this catches anything that slipped.
        result.orphanRepeatsDeleted = await transaction((tx) => sweepAllOrphanRepeats(tx));
      } catch (err) {
        logger.error(`${LOG_PREFIX} orphan repeat sweep failed`, { error: err });
      }

      const didAnything =
        result.orphanRepeatsDeleted > 0 ||
        result.deletedContainers > 0 ||
        result.deletedOther > 0 ||
        result.activityPayloadsTruncated > 0 ||
        result.activityRowsDeleted > 0 ||
        result.hookRunsDeleted > 0;

      if (didAnything) {
        logger.info(
          `${LOG_PREFIX} Sweep complete: ${result.deletedContainers} container(s), ${result.deletedOther} other node(s), ${result.activityPayloadsTruncated} activity payload(s) truncated, ${result.activityRowsDeleted} activity row(s) deleted, ${result.hookRunsDeleted} hook run(s) deleted, ${result.orphanRepeatsDeleted} orphan repeat row(s) deleted`
        );
      } else {
        logger.debug(`${LOG_PREFIX} Sweep complete: nothing expired`);
      }

      endSweep(RETENTION_WORKER_ID, {
        outcome: 'ok',
        processed:
          result.deletedContainers +
          result.deletedOther +
          result.activityPayloadsTruncated +
          result.activityRowsDeleted +
          result.hookRunsDeleted +
          result.orphanRepeatsDeleted,
      });
      return result;
    } catch (error) {
      endSweep(RETENTION_WORKER_ID, { outcome: 'error', error: getErrorMessage(error) });
      logger.error(`${LOG_PREFIX} sweep failed`, { error });
      return null;
    } finally {
      this.sweeping = false;
    }
  }
}

export const archiveTtlSweeper = new ArchiveTtlSweeperService();
