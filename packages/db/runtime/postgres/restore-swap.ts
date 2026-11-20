import { randomBytes } from 'node:crypto';
import { open, readFile, rename, unlink } from 'node:fs/promises';
import * as path from 'node:path';
import { Pool, type PoolConfig } from 'pg';
import { safeJsonParse } from '@snaglet/shared/utils';
import { syncPostgresDirectory } from './filesystem';

export type RestoreSwapState = 'preparing' | 'parked' | 'promoted';

export interface RestoreSwapMarker {
  schemaVersion: 1;
  state: RestoreSwapState;
  liveDatabase: string;
  scratchDatabase: string;
  parkedDatabase: string;
  startedAt: string;
}

export interface RestoreRecoveryOptions {
  connection: PoolConfig;
  markerPath: string;
  log?: (line: string) => void;
}

const DATABASE_NAME = /^[A-Za-z_][A-Za-z0-9_$]*$/;

export function assertDatabaseName(value: string): string {
  if (!DATABASE_NAME.test(value) || Buffer.byteLength(value) > 63) {
    throw new Error(`Unsafe PostgreSQL database identifier: ${JSON.stringify(value)}`);
  }
  return value;
}

export function quoteDatabaseName(value: string): string {
  return `"${assertDatabaseName(value).replace(/"/g, '""')}"`;
}

export function databaseNameFromConfig(config: PoolConfig): string {
  if (config.database) return assertDatabaseName(config.database);
  if (config.connectionString) {
    const parsed = new URL(config.connectionString);
    const database = decodeURIComponent(parsed.pathname.replace(/^\//, ''));
    if (database) return assertDatabaseName(database);
  }
  throw new Error('PostgreSQL backup/restore requires an explicit database name');
}

export function poolConfigForDatabase(config: PoolConfig, database: string): PoolConfig {
  assertDatabaseName(database);
  if (config.connectionString) {
    const parsed = new URL(config.connectionString);
    parsed.pathname = `/${encodeURIComponent(database)}`;
    return { ...config, connectionString: parsed.toString(), database: undefined };
  }
  return { ...config, database };
}

export async function readRestoreSwapMarker(markerPath: string): Promise<RestoreSwapMarker | null> {
  try {
    const parsed = safeJsonParse<RestoreSwapMarker | null>(
      await readFile(markerPath, 'utf8'),
      null
    );
    if (
      parsed?.schemaVersion !== 1 ||
      !['preparing', 'parked', 'promoted'].includes(parsed.state) ||
      !parsed.liveDatabase ||
      !parsed.scratchDatabase ||
      !parsed.parkedDatabase
    ) {
      throw new Error(`PostgreSQL restore marker is malformed: ${markerPath}`);
    }
    assertDatabaseName(parsed.liveDatabase);
    assertDatabaseName(parsed.scratchDatabase);
    assertDatabaseName(parsed.parkedDatabase);
    return parsed;
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

export async function writeRestoreSwapMarker(
  markerPath: string,
  marker: RestoreSwapMarker
): Promise<void> {
  const temporary = `${markerPath}.tmp-${process.pid}-${randomBytes(4).toString('hex')}`;
  try {
    const handle = await open(temporary, 'wx', 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(marker, null, 2)}\n`);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, markerPath);
    await syncPostgresDirectory(path.dirname(markerPath));
  } catch (error: unknown) {
    // eslint-disable-next-line no-restricted-syntax -- intentional: best-effort cleanup of a temp marker that may never have been created; the write error rethrown below is the one that matters
    await unlink(temporary).catch(() => {});
    throw error;
  }
}

export async function clearRestoreSwapMarker(markerPath: string): Promise<void> {
  let removed = false;
  try {
    await unlink(markerPath);
    removed = true;
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  if (removed) {
    await syncPostgresDirectory(path.dirname(markerPath));
  }
}

async function databaseExists(pool: Pool, database: string): Promise<boolean> {
  const result = await pool.query<{ present: boolean }>(
    'SELECT EXISTS (SELECT 1 FROM pg_database WHERE datname = $1) AS present',
    [database]
  );
  return result.rows[0]?.present ?? false;
}

async function terminateDatabaseBackends(pool: Pool, database: string): Promise<void> {
  await pool.query(
    `SELECT pg_terminate_backend(pid)
       FROM pg_stat_activity
      WHERE datname = $1 AND pid <> pg_backend_pid()`,
    [database]
  );
}

async function renameDatabase(pool: Pool, from: string, to: string): Promise<void> {
  await terminateDatabaseBackends(pool, from);
  await pool.query(`ALTER DATABASE ${quoteDatabaseName(from)} RENAME TO ${quoteDatabaseName(to)}`);
}

async function validateRestoredDatabase(config: PoolConfig, database: string): Promise<boolean> {
  const pool = new Pool(poolConfigForDatabase(config, database));
  try {
    const result = await pool.query<{
      nodes: string | null;
      ledger: string | null;
      vector: boolean;
    }>(
      `SELECT
         to_regclass('public.nodes')::text AS nodes,
         to_regclass('public._migrations')::text AS ledger,
         EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'vector') AS vector`
    );
    return Boolean(result.rows[0]?.nodes && result.rows[0]?.ledger && result.rows[0]?.vector);
  } catch {
    return false;
  } finally {
    await pool.end();
  }
}

function abandonedName(liveDatabase: string): string {
  const role = 'restore_abandoned';
  const suffix = `${Date.now().toString(36)}_${randomBytes(2).toString('hex')}`;
  const room = 63 - role.length - suffix.length - 2;
  return assertDatabaseName(`${liveDatabase.slice(0, Math.max(room, 1))}_${role}_${suffix}`);
}

/**
 * Recover a database rename swap interrupted by process death. The original
 * database always wins when promotion was not confirmed; a promoted database
 * wins only after the same schema sanity checks used by the live restore path.
 */
export async function recoverInterruptedPostgresRestore(
  options: RestoreRecoveryOptions
): Promise<void> {
  const liveDatabase = databaseNameFromConfig(options.connection);
  const marker = await readRestoreSwapMarker(options.markerPath);
  const admin = new Pool(poolConfigForDatabase(options.connection, 'postgres'));
  const log = options.log ?? (() => {});
  try {
    const liveExists = await databaseExists(admin, liveDatabase);

    if (!marker) {
      if (liveExists) return;
      const parked = await admin.query<{ datname: string }>(
        `SELECT datname FROM pg_database
          WHERE starts_with(datname, $1)
          ORDER BY datname DESC`,
        [`${liveDatabase}_parked_`]
      );
      const [parkedRow] = parked.rows;
      if (!parkedRow) return;
      if (parked.rows.length > 1) {
        throw new Error(
          `PostgreSQL restore recovery found ${parked.rows.length} parked databases and no ${liveDatabase}; ` +
            'refusing to guess which user database to recover.'
        );
      }
      await renameDatabase(admin, parkedRow.datname, liveDatabase);
      log(`recovered ${liveDatabase} from parked database ${parkedRow.datname}`);
      return;
    }

    if (marker.liveDatabase !== liveDatabase) {
      throw new Error(
        `PostgreSQL restore marker targets ${marker.liveDatabase}, but this connection targets ${liveDatabase}`
      );
    }
    const parkedExists = await databaseExists(admin, marker.parkedDatabase);
    const scratchExists = await databaseExists(admin, marker.scratchDatabase);

    if (!liveExists) {
      if (!parkedExists) {
        throw new Error(
          `Interrupted PostgreSQL restore left ${liveDatabase} missing and parked database ${marker.parkedDatabase} is absent`
        );
      }
      if (scratchExists) {
        await renameDatabase(admin, marker.scratchDatabase, abandonedName(liveDatabase));
      }
      await renameDatabase(admin, marker.parkedDatabase, liveDatabase);
      await clearRestoreSwapMarker(options.markerPath);
      log(`rolled back interrupted restore to ${marker.parkedDatabase}`);
      return;
    }

    if (marker.state === 'promoted' && parkedExists) {
      const promotedIsValid = await validateRestoredDatabase(options.connection, liveDatabase);
      if (promotedIsValid) {
        await terminateDatabaseBackends(admin, marker.parkedDatabase);
        await admin.query(`DROP DATABASE ${quoteDatabaseName(marker.parkedDatabase)}`);
        await clearRestoreSwapMarker(options.markerPath);
        log(`confirmed promoted ${liveDatabase} and removed ${marker.parkedDatabase}`);
        return;
      }
      await renameDatabase(admin, liveDatabase, abandonedName(liveDatabase));
      await renameDatabase(admin, marker.parkedDatabase, liveDatabase);
      await clearRestoreSwapMarker(options.markerPath);
      log(`rejected invalid promoted database and recovered ${marker.parkedDatabase}`);
      return;
    }

    if (marker.state === 'promoted' && !parkedExists) {
      if (!(await validateRestoredDatabase(options.connection, liveDatabase))) {
        throw new Error(
          `Promoted database ${liveDatabase} failed restore sanity checks and its parked original is missing`
        );
      }
      await clearRestoreSwapMarker(options.markerPath);
      log(`confirmed promoted ${liveDatabase}; parked cleanup had already completed`);
      return;
    }

    if (marker.state === 'parked' && parkedExists && !scratchExists) {
      await renameDatabase(admin, liveDatabase, abandonedName(liveDatabase));
      await renameDatabase(admin, marker.parkedDatabase, liveDatabase);
      await clearRestoreSwapMarker(options.markerPath);
      log(`rolled back an unconfirmed promoted database to ${marker.parkedDatabase}`);
      return;
    }

    if (marker.state === 'preparing' && !parkedExists) {
      if (scratchExists)
        await renameDatabase(admin, marker.scratchDatabase, abandonedName(liveDatabase));
      await clearRestoreSwapMarker(options.markerPath);
      log('parked an incomplete restore candidate; live database was unchanged');
      return;
    }

    throw new Error(
      `PostgreSQL restore recovery is ambiguous (state=${marker.state}, live=${liveExists}, parked=${parkedExists}, scratch=${scratchExists}); refusing destructive cleanup.`
    );
  } finally {
    await admin.end();
  }
}
