/**
 * Type definitions for database snapshots and backup/restore jobs.
 */

/**
 * A database snapshot stored under ~/.snaglet/backups, surfaced in Settings →
 * Data → Backups. `kind` distinguishes manual snapshots from the safety
 * backups taken right before a migration, reset, or restore. 'auto' snapshots
 * come only from older releases' scheduled and shutdown backups.
 */
export interface DbSnapshot {
  id: string;
  label: string;
  createdAt: string;
  sizeBytes: number;
  dbName: string;
  kind: 'manual' | 'pre-reset' | 'pre-restore' | 'pre-migration' | 'auto';
  engine: 'postgres' | 'legacy-embedded';
  format: 'custom' | 'plain-gzip' | 'legacy-embedded';
  fileName: string;
  legacy: boolean;
  restorable: boolean;
}

/**
 * The packaged app's own pre-update checkpoints in ~/.snaglet/backups/pre-migration
 * (written by the database upgrade, not listed as snapshots).
 */
export interface DbPreUpdateCheckpoints {
  count: number;
  totalBytes: number;
}

/** Status of the single in-flight snapshot/restore/reset job. */
export interface DbBackupJobStatus {
  running: boolean;
  jobId: string | null;
  kind: 'snapshot' | 'restore' | 'reset' | null;
  /** Human-readable current phase, e.g. "Creating snapshot…". */
  phase: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  error: string | null;
  /** True after a restore/reset — server caches are stale; recommend restart. */
  requiresRestart: boolean;
  lastSnapshotId: string | null;
}
