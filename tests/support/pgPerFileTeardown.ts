/** Close and drop the one PostgreSQL database owned by this integration file. */
import { lstatSync, realpathSync, rmSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { afterAll } from '@jest/globals';
import { closeDatabase } from '@snaglet/db';
import {
  assertSafeDatabaseName,
  loadTestClusterHandoff,
  runClusterCommand,
  type TestClusterHandoff,
} from './pgTestCluster';

const DATABASE_ENV = 'SNAGLET_PG_TEST_DATABASE';
const HOME_ENV = 'SNAGLET_PG_TEST_HOME';

interface TeardownState {
  handoff: TestClusterHandoff;
  database: string;
  testHome: string;
}

function isWithin(parent: string, child: string): boolean {
  const pathFromParent = relative(parent, child);
  return pathFromParent !== '' && !pathFromParent.startsWith('..') && !isAbsolute(pathFromParent);
}

function loadState(): TeardownState {
  const database = process.env[DATABASE_ENV];
  const homeValue = process.env[HOME_ENV];
  if (!database || !homeValue) throw new Error('Incomplete per-file PostgreSQL teardown state');
  assertSafeDatabaseName(database);

  const handoff = loadTestClusterHandoff();
  const runRoot = resolve(handoff.runRoot);
  const testHomesDir = resolve(handoff.testHomesDir);
  const testHome = resolve(homeValue);
  if (
    testHomesDir !== join(runRoot, 'test-homes') ||
    !isWithin(testHomesDir, testHome) ||
    !testHome.startsWith(join(testHomesDir, 'snaglet-pg-test-home-'))
  ) {
    throw new Error('PostgreSQL per-file home escaped its owned parent');
  }
  if (lstatSync(testHome).isSymbolicLink() || realpathSync(testHome) !== testHome) {
    throw new Error('Refusing non-canonical PostgreSQL per-file home');
  }
  return { handoff, database, testHome };
}

// Capture immutable state before tests can mutate process.env.
const state = loadState();

afterAll(async () => {
  let closeError: unknown;
  let dropError: unknown;
  try {
    await closeDatabase();
  } catch (error: unknown) {
    closeError = error;
  }

  try {
    runClusterCommand(state.handoff, state.handoff.binaries.psql, [
      '--host',
      state.handoff.host,
      '--port',
      String(state.handoff.port),
      '--username',
      state.handoff.user,
      '--dbname',
      'postgres',
      '--set',
      'ON_ERROR_STOP=1',
      '--command',
      `DROP DATABASE IF EXISTS "${state.database}" WITH (FORCE);`,
    ]);
  } catch (error: unknown) {
    dropError = error;
  } finally {
    if (!closeError && !dropError) rmSync(state.testHome, { recursive: true, force: true });
    else console.error(`PostgreSQL per-file teardown failed; retained ${state.testHome}`);
    if (process.env[DATABASE_ENV] === state.database) delete process.env[DATABASE_ENV];
    if (process.env[HOME_ENV] === state.testHome) delete process.env[HOME_ENV];
  }

  if (closeError && dropError) {
    throw new AggregateError(
      [closeError, dropError],
      `Failed to close and drop PostgreSQL test database ${state.database}`
    );
  }
  if (closeError) throw closeError;
  if (dropError) throw dropError;
}, 30_000);
