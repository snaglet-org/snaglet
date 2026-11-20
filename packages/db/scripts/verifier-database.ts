/**
 * Resolve the database a migration verifier works in.
 *
 * These scripts apply migrations raw, delete seed rows, and simulate drift by
 * dropping columns — they destroy whatever database they run in. So they never
 * inherit `SNAGLET_DATABASE_URL`: a caller that owns a disposable database says so
 * explicitly through `SNAGLET_VERIFIER_DATABASE_URL`, and that database must be
 * empty.
 *
 * With nothing handed over, one rule picks the cluster: the Snaglet home. That is
 * `SNAGLET_HOME` when set, and a throwaway home otherwise (exported, so every
 * resolver in the process agrees) — running the script by hand never
 * provisions into a real Snaglet home by accident. The cluster there is adopted if
 * it is already up and started if it is not, and the verifier still works in
 * a database of its own that it drops on the way out.
 */
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getErrorMessage } from '@snaglet/shared/utils';
import { PostgresAdapter } from '../adapters/postgres';
import { resolveDbHome } from '../runtime/snaglet-home';
import { PostgresRuntime } from '../runtime/postgres/runtime';

export const VERIFIER_DATABASE_URL_ENV = 'SNAGLET_VERIFIER_DATABASE_URL';

export interface VerifierDatabase {
  /** Opens another pool on the same database (some checks race two pools). */
  connect(): PostgresAdapter;
  /** Drops what this call created and stops only what it started. */
  dispose(): Promise<void>;
}

function verifierDatabaseName(label: string): string {
  const suffix = label.toLowerCase().replace(/[^a-z0-9]+/g, '_');
  const database = `snaglet_verify_${suffix}_${randomBytes(6).toString('hex')}`;
  if (database.length > 63 || !/^snaglet_verify_[a-z0-9_]+$/.test(database)) {
    throw new Error(`Unsafe verifier database name ${JSON.stringify(database)}`);
  }
  return database;
}

async function assertEmptyDatabase(db: PostgresAdapter): Promise<void> {
  const { rows } = await db.query<{ tables: number }>(
    `SELECT count(*)::int AS tables FROM pg_tables WHERE schemaname = 'public'`
  );
  if ((rows[0]?.tables ?? 0) > 0) {
    throw new Error(
      `${VERIFIER_DATABASE_URL_ENV} points at a database that already has tables. ` +
        'This verifier rewrites and drops schema, so it only accepts an empty database.'
    );
  }
}

export async function openVerifierDatabase(label: string): Promise<VerifierDatabase> {
  const injected = process.env[VERIFIER_DATABASE_URL_ENV]?.trim();
  if (injected) {
    const probe = new PostgresAdapter({ connectionString: injected });
    try {
      await assertEmptyDatabase(probe);
    } finally {
      await probe.end();
    }
    return {
      connect: () => new PostgresAdapter({ connectionString: injected }),
      dispose: async () => {},
    };
  }

  const ownedHome = process.env.SNAGLET_HOME?.trim()
    ? undefined
    : await mkdtemp(join(tmpdir(), `snaglet-${label}-home-`));
  if (ownedHome) {
    // Only data belongs in the throwaway home. The runtime cache would follow
    // SNAGLET_HOME too, and a per-run cache means compiling PostgreSQL from source
    // every run — so pin it to where a normal install already built it.
    process.env.SNAGLET_PG_RUNTIME_DIR ||= join(resolveDbHome(), 'cache', 'postgres-runtime');
    process.env.SNAGLET_HOME = ownedHome;
  }

  const runtime = new PostgresRuntime();
  const wasRunning = (await runtime.status()).running;
  let admin: PostgresAdapter | undefined;
  let database: string | undefined;

  const cleanup = async (): Promise<void> => {
    try {
      if (admin && database) {
        await admin.query(`DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`);
      }
    } finally {
      await admin?.end();
      // Never remove a data directory under a live postmaster: a failed stop
      // aborts cleanup and leaves the state behind for diagnosis.
      if (!wasRunning) await runtime.stop('fast');
      if (ownedHome) {
        await rm(runtime.socketDir, { recursive: true, force: true });
        await rm(ownedHome, { recursive: true, force: true });
      }
    }
  };

  try {
    await runtime.start();
    const connection = await runtime.connectionInfo();
    const poolConfig = {
      host: connection.host,
      port: connection.port,
      user: connection.user,
      password: connection.password,
    };
    admin = new PostgresAdapter({ ...poolConfig, database: connection.database });
    database = verifierDatabaseName(label);
    await admin.exec(`CREATE DATABASE "${database}" TEMPLATE template0`);
    const target = database;
    return {
      connect: () => new PostgresAdapter({ ...poolConfig, database: target }),
      dispose: cleanup,
    };
  } catch (error: unknown) {
    try {
      await cleanup();
    } catch (cleanupError: unknown) {
      console.error(`[${label}] cleanup after a failed open: ${getErrorMessage(cleanupError)}`);
    }
    throw error;
  }
}
