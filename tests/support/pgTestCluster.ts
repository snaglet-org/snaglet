/**
 * Typed access to the one managed PostgreSQL cluster a Jest run owns.
 *
 * `pgGlobalSetup` starts that cluster under its own Snaglet home
 * (`handoff.runtimeHome`) and records how to reach it in a mode-0600 handoff
 * file; `pgPerFileSetup` clones the migrated `snaglet_template` into a database per
 * test file. Everything here talks to that same cluster — nothing in a test
 * may start a second one.
 *
 * Cluster vs database: the Snaglet home selects the CLUSTER (that is how
 * `PostgresRuntime` resolves one in managed mode), and a connection URL still
 * selects the DATABASE inside it, because Snaglet has no database-name knob yet.
 * When one lands, `databaseUrl()` is the single place that has to change.
 */
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { getErrorMessage } from '@snaglet/shared/utils';
import {
  postgresExecutableName,
  postgresRuntimeEnvironment,
  type BinDir,
} from '@snaglet/db/runtime/postgres/binaries';

const HANDOFF_ENV = 'SNAGLET_PG_TEST_HANDOFF_PATH';
const DATABASE_ENV = 'SNAGLET_PG_TEST_DATABASE';

export interface TestClusterHandoff {
  schemaVersion: 2;
  runRoot: string;
  runToken: string;
  /** The Snaglet home that owns this cluster — its data directory lives inside. */
  runtimeHome: string;
  dataDir: string;
  testHomesDir: string;
  socketDir: string;
  host: string;
  transport: 'socket' | 'tcp';
  port: number;
  user: string;
  password: string;
  templateDatabase: string;
  postmasterPid: number;
  binaries: BinDir;
}

function isWithin(parent: string, child: string): boolean {
  const pathFromParent = relative(parent, child);
  return pathFromParent !== '' && !pathFromParent.startsWith('..') && !isAbsolute(pathFromParent);
}

export function assertSafeDatabaseName(database: string): void {
  if (database.length > 63 || !/^test_[a-z0-9_]+$/.test(database)) {
    throw new Error(`Unsafe PostgreSQL test database name ${JSON.stringify(database)}`);
  }
}

/** Read and validate the run's handoff: paths stay inside the owned run root. */
export function loadTestClusterHandoff(
  handoffPathValue = process.env[HANDOFF_ENV]
): TestClusterHandoff {
  if (!handoffPathValue) {
    throw new Error(
      `Missing ${HANDOFF_ENV}. This suite needs the shared PostgreSQL cluster, so it must ` +
        'live under tests/integration (projects integration:server or integration:db).'
    );
  }
  const handoffPath = resolve(handoffPathValue);
  const file = lstatSync(handoffPath);
  if (
    !file.isFile() ||
    file.nlink !== 1 ||
    (process.platform !== 'win32' && (file.mode & 0o777) !== 0o600)
  ) {
    throw new Error('Refusing non-private or linked PostgreSQL test handoff');
  }
  const handoff = JSON.parse(readFileSync(handoffPath, 'utf8')) as TestClusterHandoff;
  const runRoot = resolve(handoff.runRoot);

  if (
    handoff.schemaVersion !== 2 ||
    handoffPath !== join(runRoot, 'handoff.json') ||
    handoff.templateDatabase !== 'snaglet_template'
  ) {
    throw new Error('Unexpected PostgreSQL test handoff');
  }
  if (lstatSync(runRoot).isSymbolicLink() || realpathSync(runRoot) !== runRoot) {
    throw new Error('Refusing non-canonical PostgreSQL test run root');
  }
  if (
    !basename(runRoot).startsWith('snaglet-pg-jest-') ||
    resolve(dirname(runRoot)) !== realpathSync(tmpdir()) ||
    resolve(handoff.runtimeHome) !== join(runRoot, 'runtime-home') ||
    resolve(handoff.dataDir) !== join(runRoot, 'runtime-home', 'postgres') ||
    resolve(handoff.testHomesDir) !== join(runRoot, 'test-homes') ||
    !Number.isInteger(handoff.postmasterPid) ||
    handoff.postmasterPid <= 0 ||
    !Number.isInteger(handoff.port) ||
    handoff.port < 1 ||
    handoff.port > 65535 ||
    handoff.user !== 'snaglet' ||
    !handoff.password ||
    !isAbsolute(handoff.socketDir) ||
    (process.platform === 'win32'
      ? handoff.transport !== 'tcp' || handoff.host !== '127.0.0.1'
      : handoff.transport !== 'socket' || handoff.host !== handoff.socketDir)
  )
    throw new Error('PostgreSQL test ownership or connection contract is invalid');
  for (const directory of [handoff.runtimeHome, handoff.dataDir, handoff.testHomesDir]) {
    if (lstatSync(directory).isSymbolicLink() || realpathSync(directory) !== resolve(directory)) {
      throw new Error('Refusing redirected PostgreSQL test directory');
    }
  }
  for (const key of ['psql', 'createdb', 'dropdb', 'pgCtl', 'pgConfig'] as const) {
    const executable = resolve(handoff.binaries[key]);
    const filename = key === 'pgCtl' ? 'pg_ctl' : key === 'pgConfig' ? 'pg_config' : key;
    if (
      executable !== join(resolve(handoff.binaries.binDir), postgresExecutableName(filename)) ||
      !isWithin(realpathSync(handoff.binaries.rootDir), realpathSync(executable))
    ) {
      throw new Error(`Refusing ${key} outside the recorded managed runtime`);
    }
  }
  return handoff;
}

export function clusterCommandEnvironment(handoff: TestClusterHandoff): NodeJS.ProcessEnv {
  return postgresRuntimeEnvironment(handoff.binaries, {
    ...process.env,
    PGHOST: handoff.host,
    PGPORT: String(handoff.port),
    PGUSER: handoff.user,
    PGPASSWORD: handoff.password,
  });
}

export function runClusterCommand(
  handoff: TestClusterHandoff,
  executable: string,
  args: string[]
): void {
  try {
    execFileSync(executable, args, {
      env: clusterCommandEnvironment(handoff),
      stdio: 'pipe',
      timeout: 60_000,
      windowsHide: true,
    });
  } catch (error: unknown) {
    // execFileSync's message stops at the command line, so a piped PostgreSQL
    // error would otherwise be invisible exactly when teardown breaks.
    const stderr = String((error as { stderr?: unknown }).stderr ?? '').trim();
    if (!stderr) throw error;
    throw new Error(`${getErrorMessage(error)}\n${stderr}`);
  }
}

function maintenanceSql(handoff: TestClusterHandoff, command: string): string[] {
  return [
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
    command,
  ];
}

export function databaseUrl(handoff: TestClusterHandoff, database: string): string {
  const url = new URL('postgresql://localhost');
  url.username = handoff.user;
  url.password = handoff.password;
  url.pathname = `/${database}`;
  url.searchParams.set('host', handoff.host);
  url.port = String(handoff.port);
  url.searchParams.set('sslmode', 'disable');
  return url.toString();
}

/** The migrated, seeded database `pgPerFileSetup` cloned for this test file. */
export function suiteDatabaseUrl(): string {
  const url = process.env.SNAGLET_DATABASE_URL?.trim();
  const database = process.env[DATABASE_ENV];
  if (!url || !database) {
    throw new Error(
      'No per-file PostgreSQL database. This suite must run in a project wired to ' +
        'tests/support/pgPerFileSetup.cjs (integration:server or integration:db).'
    );
  }
  assertSafeDatabaseName(database);
  return url;
}

export interface EmptyTestDatabase {
  database: string;
  url: string;
  /** Drops it, forcing off any session the suite left open. */
  drop(): void;
}

/**
 * A database with nothing in it, cloned from `template0` in the shared cluster.
 *
 * Deliberately not the per-file `snaglet_template` clone: that one is already
 * migrated AND seeded, so a suite that applies the migration chain itself
 * (and asserts on what the chain produces) must not start from it. The caller
 * calls `drop()` in `afterAll`.
 */
export function createEmptyTestDatabase(label: string): EmptyTestDatabase {
  const handoff = loadTestClusterHandoff();
  const token = String(handoff.runToken)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_');
  const suffix = label.toLowerCase().replace(/[^a-z0-9]+/g, '_');
  const database = `test_${token}_${suffix}_${randomBytes(6).toString('hex')}`.slice(0, 63);
  assertSafeDatabaseName(database);

  runClusterCommand(handoff, handoff.binaries.createdb, [
    '--host',
    handoff.host,
    '--port',
    String(handoff.port),
    '--username',
    handoff.user,
    '--maintenance-db',
    'postgres',
    '--template',
    'template0',
    database,
  ]);
  return {
    database,
    url: databaseUrl(handoff, database),
    drop() {
      runClusterCommand(
        handoff,
        handoff.binaries.psql,
        maintenanceSql(handoff, `DROP DATABASE IF EXISTS "${database}" WITH (FORCE);`)
      );
    },
  };
}
