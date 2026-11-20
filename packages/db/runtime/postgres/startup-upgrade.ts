import { createHash } from 'node:crypto';
import { mkdir, open, readFile, rename } from 'node:fs/promises';
import * as path from 'node:path';
import { getErrorMessage } from '@snaglet/shared/utils';
import type { BackupAdapter, DbClient } from '../../adapters';
import { applyPendingMigrations } from '../../migrations';
import { restrictPostgresPath, syncPostgresDirectory } from './filesystem';
import {
  CHECKPOINT_STAGING_PREFIX,
  newCheckpointName,
  preMigrationCheckpointDir,
  prunePreMigrationCheckpoints,
} from './pre-migration-checkpoints';
import { stampPostgresDataDir } from './runtime';
import { PGVECTOR_VERSION, POSTGRES_VERSION } from './version';

interface UpgradeOptions {
  snagletHome: string;
  dataDir: string;
  backup: BackupAdapter;
}

async function writeDurableFile(target: string, contents: Buffer | string): Promise<void> {
  const handle = await open(target, 'wx', 0o600);
  try {
    await handle.writeFile(contents);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/** Called before packaged services start accepting work. */
export async function upgradeManagedDatabase(db: DbClient, options: UpgradeOptions): Promise<void> {
  const base = preMigrationCheckpointDir(options.snagletHome);
  let checkpoint: string | undefined;
  try {
    await applyPendingMigrations(db, {
      rejectUnknownMigrations: true,
      beforeApply: async (pending) => {
        await mkdir(base, { recursive: true });
        await restrictPostgresPath(base, true);
        const suffix = newCheckpointName();
        const staging = path.join(base, `${CHECKPOINT_STAGING_PREFIX}${suffix}`);
        await mkdir(staging);
        await restrictPostgresPath(staging, true);
        const artifact = await options.backup.dump({ format: 'custom' });
        if (artifact.subarray(0, 5).toString('ascii') !== 'PGDMP') {
          throw new Error('Pre-migration backup is not a PostgreSQL custom-format archive');
        }
        const sha256 = createHash('sha256').update(artifact).digest('hex');
        const archivePath = path.join(staging, 'database.dump');
        await writeDurableFile(archivePath, artifact);
        const storedSha256 = createHash('sha256')
          .update(await readFile(archivePath))
          .digest('hex');
        if (storedSha256 !== sha256)
          throw new Error('Pre-migration backup checksum verification failed');
        await writeDurableFile(
          path.join(staging, 'manifest.json'),
          JSON.stringify(
            {
              schemaVersion: 1,
              format: 'custom',
              postgresVersion: POSTGRES_VERSION,
              pgvectorVersion: PGVECTOR_VERSION,
              pendingMigrations: pending,
              createdAt: new Date().toISOString(),
              byteLength: artifact.byteLength,
              sha256,
            },
            null,
            2
          ) + '\n'
        );
        const completed = path.join(base, suffix);
        await rename(staging, completed);
        checkpoint = completed;
        await syncPostgresDirectory(base);
        console.log(
          `[db] Verified pre-migration backup: ${path.join(checkpoint, 'database.dump')}`
        );
      },
      // Still under the migration lock, so no other Snaglet process on this home
      // can be writing a checkpoint while old ones are pruned.
      afterApply: async () => {
        await stampPostgresDataDir(options.dataDir);
        // Only now that every migration succeeded are older checkpoints safe
        // to drop; a failed upgrade keeps them all. Runs on every successful
        // boot, so a backlog drains even when this boot had nothing to apply.
        // Never throws.
        await prunePreMigrationCheckpoints(base, { current: checkpoint });
      },
    });
  } catch (error: unknown) {
    throw new Error(
      `Snaglet database upgrade could not complete: ${getErrorMessage(error)}. ` +
        (checkpoint
          ? `Your pre-upgrade backup is preserved at ${path.join(checkpoint, 'database.dump')}. Restore it with Snaglet backup recovery or retry with a compatible Snaglet build.`
          : 'Schema migration did not start without a verified backup. Check available disk space and database compatibility, then restart Snaglet.')
    );
  }
}
