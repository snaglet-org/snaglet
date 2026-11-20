import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { closeDatabase, getDbClient } from '@snaglet/db';

import {
  databaseUrl,
  loadTestClusterHandoff,
  runClusterCommand as run,
  type TestClusterHandoff as PostgresTestHandoff,
} from '../../../../../support/pgTestCluster';
const CASE_DATABASE_ENV = 'SNAGLET_PG_SEARCH_CASE_DATABASE';
const CASE_HOME_ENV = 'SNAGLET_PG_SEARCH_CASE_HOME';
let activeSearchCaseDatabase: string | null = null;

interface CapturedEnvironment {
  SNAGLET_DB_MODE: string | undefined;
  SNAGLET_DATABASE_URL: string | undefined;
  SNAGLET_DB_CONFIG_PATH: string | undefined;
  SNAGLET_PG_DATA_DIR: string | undefined;
  SNAGLET_HOME: string | undefined;
}

export interface FreshSearchCaseDatabase {
  databaseName: string;
  homePath: string;
  dispose(): Promise<void>;
}

function isWithin(parent: string, child: string): boolean {
  const pathFromParent = relative(parent, child);
  return pathFromParent !== '' && !pathFromParent.startsWith('..') && !isAbsolute(pathFromParent);
}

function assertSafeDatabaseName(databaseName: string): void {
  if (databaseName.length > 63 || !/^test_search_case_[a-z0-9_]+$/.test(databaseName)) {
    throw new Error(`Unsafe search-case database name ${JSON.stringify(databaseName)}`);
  }
}

function captureEnvironment(): CapturedEnvironment {
  return {
    SNAGLET_DB_MODE: process.env.SNAGLET_DB_MODE,
    SNAGLET_DATABASE_URL: process.env.SNAGLET_DATABASE_URL,
    SNAGLET_DB_CONFIG_PATH: process.env.SNAGLET_DB_CONFIG_PATH,
    SNAGLET_PG_DATA_DIR: process.env.SNAGLET_PG_DATA_DIR,
    SNAGLET_HOME: process.env.SNAGLET_HOME,
  };
}

function restoreEnvironment(environment: CapturedEnvironment): void {
  for (const [key, value] of Object.entries(environment)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  delete process.env[CASE_DATABASE_ENV];
  delete process.env[CASE_HOME_ENV];
}

function forceDrop(handoff: PostgresTestHandoff, databaseName: string): void {
  assertSafeDatabaseName(databaseName);
  run(handoff, handoff.binaries.psql, [
    '--host',
    handoff.host,
    '--port',
    String(handoff.port),
    '--username',
    handoff.user,
    '--dbname',
    'postgres',
    '--set',
    'ON_ERROR_STOP=1',
    '--command',
    `DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE);`,
  ]);
}

/**
 * Point Snaglet's source-level DbClient at a new clone of the clean migrated Jest
 * template for one search case. The normal per-file database remains parked
 * for Jest's shared teardown and is never used as the case database.
 */
export async function createFreshSearchCaseDatabase(): Promise<FreshSearchCaseDatabase> {
  if (activeSearchCaseDatabase) {
    throw new Error(
      `Search-case database ${activeSearchCaseDatabase} is still active; ` +
        'dispose it before starting another case in this Jest process'
    );
  }
  const handoff = loadTestClusterHandoff();
  const environment = captureEnvironment();
  const worker = String(process.env.JEST_WORKER_ID ?? '1')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_');
  const databaseName = `test_search_case_${worker}_${process.pid.toString(36)}_${randomBytes(
    8
  ).toString('hex')}`.slice(0, 63);
  assertSafeDatabaseName(databaseName);

  const homePath = mkdtempSync(
    join(handoff.testHomesDir, `snaglet-pg-search-case-home-${worker}-`)
  );
  if (!isWithin(resolve(handoff.testHomesDir), resolve(homePath))) {
    throw new Error('Generated PostgreSQL search-case home escaped its parent');
  }

  let databaseCreated = false;
  let disposed = false;
  try {
    await closeDatabase();
    run(handoff, handoff.binaries.createdb, [
      '--host',
      handoff.host,
      '--port',
      String(handoff.port),
      '--username',
      handoff.user,
      '--maintenance-db',
      'postgres',
      '--template',
      handoff.templateDatabase,
      databaseName,
    ]);
    databaseCreated = true;
    run(handoff, handoff.binaries.psql, [
      '--host',
      handoff.host,
      '--port',
      String(handoff.port),
      '--username',
      handoff.user,
      '--dbname',
      'postgres',
      '--set',
      'ON_ERROR_STOP=1',
      '--command',
      `ALTER DATABASE "${databaseName}" SET hnsw.ef_search = 100;`,
    ]);

    process.env.NODE_ENV = 'test';
    process.env.SNAGLET_HOME = homePath;
    process.env.SNAGLET_DB_MODE = 'external';
    process.env.SNAGLET_DATABASE_URL = databaseUrl(handoff, databaseName);
    process.env[CASE_DATABASE_ENV] = databaseName;
    process.env[CASE_HOME_ENV] = homePath;
    delete process.env.SNAGLET_DB_CONFIG_PATH;
    delete process.env.SNAGLET_PG_DATA_DIR;

    const db = await getDbClient({ allowReopenAfterClose: true });
    const identity = await db.query<{ databaseName: string }>(
      `SELECT current_database() AS "databaseName"`
    );
    if (identity.rows[0]?.databaseName !== databaseName) {
      throw new Error(
        `Source DbClient opened ${String(identity.rows[0]?.databaseName)} instead of ${databaseName}`
      );
    }
    activeSearchCaseDatabase = databaseName;

    return {
      databaseName,
      homePath,
      async dispose(): Promise<void> {
        if (disposed) return;
        disposed = true;
        let closeError: unknown;
        let dropError: unknown;
        try {
          await closeDatabase();
        } catch (error: unknown) {
          closeError = error;
        }
        try {
          forceDrop(handoff, databaseName);
        } catch (error: unknown) {
          dropError = error;
        } finally {
          if (!closeError && !dropError) rmSync(homePath, { recursive: true, force: true });
          else console.error(`Search-case teardown failed; retained ${homePath}`);
          restoreEnvironment(environment);
          if (activeSearchCaseDatabase === databaseName) activeSearchCaseDatabase = null;
        }
        if (closeError && dropError) {
          throw new AggregateError(
            [closeError, dropError],
            `Failed to dispose search-case database ${databaseName}`
          );
        }
        if (closeError) throw closeError;
        if (dropError) throw dropError;
      },
    };
  } catch (error: unknown) {
    try {
      await closeDatabase();
    } catch {
      // Preserve the original setup error; the owned cluster teardown is the
      // final backstop for a pool that could not close.
    }
    if (databaseCreated) {
      try {
        forceDrop(handoff, databaseName);
      } catch {
        // Preserve the original setup error; global teardown owns the cluster.
      }
    }
    console.error(`Search-case setup failed; retained disposable home at ${homePath}`);
    restoreEnvironment(environment);
    if (activeSearchCaseDatabase === databaseName) activeSearchCaseDatabase = null;
    throw error;
  }
}
