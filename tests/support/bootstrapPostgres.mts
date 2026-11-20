/**
 * Build the migrated PostgreSQL template used by the Jest integration project.
 *
 * This process intentionally leaves its one private postmaster running. Jest's
 * global teardown stops it using the exact binary and data directory recorded
 * in the mode-0600 handoff file.
 */
import { execFile } from 'node:child_process';
import { mkdir, open, realpath } from 'node:fs/promises';
import { basename, isAbsolute, join, relative, resolve } from 'node:path';
import { promisify } from 'node:util';
import {
  ensurePostgresBinaries,
  PostgresRuntime,
  postgresRuntimeEnvironment,
  postgresExecutableName,
  restrictPostgresPath,
  type BinDir,
} from '@snaglet/db/runtime/postgres';
import type { TestClusterHandoff } from './pgTestCluster';

const execFileAsync = promisify(execFile);
const RUN_PREFIX = 'snaglet-pg-jest-';
const TEMPLATE_DATABASE = 'snaglet_template';

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`PostgreSQL Jest bootstrap: ${message}`);
}

function isWithin(parent: string, child: string): boolean {
  const pathFromParent = relative(parent, child);
  return pathFromParent !== '' && !pathFromParent.startsWith('..') && !isAbsolute(pathFromParent);
}

async function assertOwnedBinary(
  runtimeRoot: string,
  binDir: string,
  executable: string,
  filename: string
): Promise<void> {
  const expected = join(binDir, postgresExecutableName(filename));
  assert(resolve(executable) === resolve(expected), `${filename} is not at ${expected}`);
  const [realRuntimeRoot, realExecutable] = await Promise.all([
    realpath(runtimeRoot),
    realpath(executable),
  ]);
  assert(
    isWithin(realRuntimeRoot, realExecutable),
    `${filename} resolves outside managed runtime root ${realRuntimeRoot}`
  );
}

function databaseUrl(host: string, port: number, password: string, database: string): string {
  const url = new URL('postgresql://localhost');
  url.username = 'snaglet';
  url.password = password;
  url.pathname = `/${database}`;
  url.searchParams.set('host', host);
  url.port = String(port);
  url.searchParams.set('sslmode', 'disable');
  return url.toString();
}

async function runDatabaseCommand(
  binaries: BinDir,
  executable: string,
  args: string[],
  host: string,
  port: number,
  password: string
): Promise<string> {
  const result = await execFileAsync(executable, args, {
    env: postgresRuntimeEnvironment(binaries, {
      ...process.env,
      PGHOST: host,
      PGPORT: String(port),
      PGUSER: 'snaglet',
      PGPASSWORD: password,
    }),
    timeout: 120_000,
    windowsHide: true,
    maxBuffer: 10 * 1024 * 1024,
  });
  return result.stdout.trim();
}

async function main(): Promise<void> {
  const runRootArgument = process.argv[2];
  const handoffArgument = process.argv[3];
  assert(runRootArgument, 'expected an owned run-root argument');
  assert(handoffArgument, 'expected a handoff-file argument');

  const runRoot = resolve(runRootArgument);
  const handoffPath = resolve(handoffArgument);
  assert(basename(runRoot).startsWith(RUN_PREFIX), `unexpected run-root prefix: ${runRoot}`);
  assert(handoffPath === join(runRoot, 'handoff.json'), 'handoff must be inside the run root');
  assert((await realpath(runRoot)) === runRoot, 'run root must exist and may not be a symlink');
  await restrictPostgresPath(runRoot, true);

  // A Snaglet home identifies a cluster: keeping the data directory exactly where
  // PostgresRuntime derives it from this home means `SNAGLET_HOME=runtimeHome`
  // resolves this cluster, with no separately threaded data directory.
  const runtimeHome = join(runRoot, 'runtime-home');
  const dataDir = join(runtimeHome, 'postgres');
  const testHomesDir = join(runRoot, 'test-homes');
  await mkdir(testHomesDir, { recursive: false, mode: 0o700 });

  const binaries = await ensurePostgresBinaries();
  await Promise.all([
    assertOwnedBinary(binaries.rootDir, binaries.binDir, binaries.pgCtl, 'pg_ctl'),
    assertOwnedBinary(binaries.rootDir, binaries.binDir, binaries.pgConfig, 'pg_config'),
    assertOwnedBinary(binaries.rootDir, binaries.binDir, binaries.psql, 'psql'),
    assertOwnedBinary(binaries.rootDir, binaries.binDir, binaries.createdb, 'createdb'),
    assertOwnedBinary(binaries.rootDir, binaries.binDir, binaries.dropdb, 'dropdb'),
  ]);

  const commandEnv = postgresRuntimeEnvironment(binaries, process.env);
  const pgConfig = await execFileAsync(binaries.pgConfig, ['--bindir'], {
    env: commandEnv,
    timeout: 30_000,
    windowsHide: true,
  });
  assert(
    (await realpath(pgConfig.stdout.trim())) === (await realpath(binaries.binDir)),
    `pg_config --bindir escaped managed runtime root ${binaries.rootDir}`
  );

  const runtime = new PostgresRuntime({
    snagletHome: runtimeHome,
    dataDir,
    env: process.env,
    ensureBinaries: async () => binaries,
  });
  let successful = false;
  let closeDatabase: (() => Promise<void>) | undefined;

  try {
    const status = await runtime.start();
    assert(status.running && status.socketReady, 'temporary postmaster did not become healthy');
    assert(status.pid && status.pid > 0, 'temporary postmaster did not report a pid');

    const connection = await runtime.connectionInfo();
    const port = connection.port ?? 5432;
    await runDatabaseCommand(
      binaries,
      binaries.createdb,
      [
        '--host',
        connection.host,
        '--port',
        String(port),
        '--username',
        connection.user,
        '--maintenance-db',
        'postgres',
        '--template',
        'template0',
        TEMPLATE_DATABASE,
      ],
      connection.host,
      port,
      connection.password
    );

    process.env.NODE_ENV = 'test';
    process.env.SNAGLET_HOME = runtimeHome;
    // SNAGLET_DATABASE_URL selects the override path. SNAGLET_DB_MODE is inert next to a
    // URL (packages/db/db.ts rejects a non-managed mode only without one).
    process.env.SNAGLET_DB_MODE = 'external';
    process.env.SNAGLET_DATABASE_URL = databaseUrl(
      connection.host,
      port,
      connection.password,
      TEMPLATE_DATABASE
    );
    delete process.env.SNAGLET_DB_CONFIG_PATH;
    delete process.env.SNAGLET_PG_DATA_DIR;

    // Import only after the isolated external-DB environment is complete.
    // initializeDatabase() exercises Snaglet's normal fresh-boot migration path.
    const databaseModule = await import('@snaglet/db');
    closeDatabase = databaseModule.closeDatabase;
    await databaseModule.initializeDatabase();
    await databaseModule.Users.getOrCreateLocalUser();
    await closeDatabase();
    closeDatabase = undefined;

    // A clone source must have no live sessions. Disabling connections after
    // the explicit termination also prevents a late accidental template open.
    await runDatabaseCommand(
      binaries,
      binaries.psql,
      [
        '--host',
        connection.host,
        '--port',
        String(port),
        '--username',
        connection.user,
        '--dbname',
        'postgres',
        '--set',
        'ON_ERROR_STOP=1',
        '--command',
        `SELECT pg_terminate_backend(pid)
           FROM pg_stat_activity
          WHERE datname = '${TEMPLATE_DATABASE}' AND pid <> pg_backend_pid();
         ALTER DATABASE ${TEMPLATE_DATABASE} SET hnsw.ef_search = 100;
         ALTER DATABASE ${TEMPLATE_DATABASE} WITH ALLOW_CONNECTIONS false;`,
      ],
      connection.host,
      port,
      connection.password
    );

    const runToken = basename(runRoot).slice(RUN_PREFIX.length);
    assert(/^[a-zA-Z0-9_-]+$/.test(runToken), `unsafe run token ${JSON.stringify(runToken)}`);
    const handoff: TestClusterHandoff = {
      schemaVersion: 2,
      runRoot,
      runToken,
      dataDir,
      runtimeHome,
      testHomesDir,
      socketDir: connection.socketDir,
      host: connection.host,
      transport: connection.transport,
      port,
      user: connection.user,
      password: connection.password,
      templateDatabase: TEMPLATE_DATABASE,
      postmasterPid: status.pid,
      binaries,
    };
    const handoffFile = await open(handoffPath, 'wx', 0o600);
    try {
      await restrictPostgresPath(handoffPath);
      await handoffFile.writeFile(`${JSON.stringify(handoff, null, 2)}\n`);
      await handoffFile.sync();
    } finally {
      await handoffFile.close();
    }
    successful = true;
  } finally {
    if (!successful) {
      if (closeDatabase) {
        try {
          await closeDatabase();
        } catch (error: unknown) {
          console.error('PostgreSQL Jest bootstrap failed to close its Snaglet pool:', error);
        }
      }
      try {
        await runtime.stop('fast');
      } catch (error: unknown) {
        console.error('PostgreSQL Jest bootstrap failed to stop its temporary cluster:', error);
      }
    }
  }
}

await main();
// This helper deliberately hands a live postmaster to Jest. On Windows its
// inherited pipe handles can keep the bootstrap process alive; all template
// pools and the durable private handoff are closed before main resolves.
process.exit(0);
