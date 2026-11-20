/**
 * Adapter barrel.
 *
 * Public PostgreSQL adapter surface.
 */
export type { DbClient, DbQueryResult } from './types';
export {
  PostgresAdapter,
  createPostgresPoolConfig,
  createPostgresTypeParsers,
  legacyCompatibleTimeZone,
  type PostgresAdapterDependencies,
} from './postgres';

// Backup capability (dump/restore). Kept separate from `DbClient` because backup
// is not a per-query concern and the blob shape is engine-specific.
export type {
  BackupAdapter,
  BackupArtifactFormat,
  BackupDumpOptions,
  BackupEngine,
  BackupRestoreOptions,
} from './backup-types';
export {
  PostgresBackupAdapter,
  type PostgresBackupAdapterOptions,
  type PostgresBackupCommandRunner,
} from './postgres-backup';
