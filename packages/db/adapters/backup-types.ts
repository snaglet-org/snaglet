/**
 * Backup/restore abstraction surface.
 *
 * `BackupAdapter` is kept separate from `DbClient`: `DbClient` is the
 * hot-path query surface every call site uses, while backup is operational
 * (the backup service, the CLI restore tool, the round-trip test harness).
 *
 * The artifact is an opaque `Buffer`; for PostgreSQL it is a
 * `pg_dump --format=custom` blob, round-trip faithful within one adapter.
 * The 'legacy-embedded' values only classify old manifests as parked and
 * non-restorable; importing that format is a separate workflow.
 */

export type BackupEngine = 'postgres' | 'legacy-embedded';
export type BackupArtifactFormat = 'custom' | 'plain-gzip' | 'legacy-embedded';

export interface BackupDumpOptions {
  format?: BackupArtifactFormat;
}

export interface BackupRestoreOptions {
  format?: BackupArtifactFormat;
}

export interface BackupAdapter {
  /** Engine that produced artifacts from this adapter. */
  readonly engine: BackupEngine;

  /**
   * Produce a dump artifact representing the current database state.
   *
   * The returned buffer can be passed to `restore()` on the same adapter
   * type to reproduce that state. Cross-adapter restore is undefined
   * behavior.
   */
  dump(options?: BackupDumpOptions): Promise<Buffer>;

  /**
   * Apply a dump artifact, replacing the current database state.
   *
   * Behavior on a non-empty target database is adapter-defined; callers
   * should reset/recreate the target first. The implementation is expected
   * to be atomic from the caller's perspective: either the restore
   * succeeds and the new state is visible, or it fails and the implementor
   * raises with the original state intact (best-effort — process kill
   * mid-restore can still corrupt).
   */
  restore(artifact: Buffer, options?: BackupRestoreOptions): Promise<void>;
}
