/** Create one database cloned from snaglet_template before each integration file. */
'use strict';

const { execFileSync } = require('node:child_process');
const { randomBytes } = require('node:crypto');
const { lstatSync, mkdtempSync, readFileSync, realpathSync } = require('node:fs');
const { delimiter, isAbsolute, join, relative, resolve } = require('node:path');

const HANDOFF_ENV = 'SNAGLET_PG_TEST_HANDOFF_PATH';
const DATABASE_ENV = 'SNAGLET_PG_TEST_DATABASE';
const HOME_ENV = 'SNAGLET_PG_TEST_HOME';

function isWithin(parent, child) {
  const pathFromParent = relative(parent, child);
  return pathFromParent !== '' && !pathFromParent.startsWith('..') && !isAbsolute(pathFromParent);
}

function assertSafeDatabaseName(database) {
  if (database.length > 63 || !/^test_[a-z0-9_]+$/.test(database)) {
    throw new Error(`Unsafe PostgreSQL test database name ${JSON.stringify(database)}`);
  }
}

function loadHandoff() {
  const handoffPathValue = process.env[HANDOFF_ENV];
  if (!handoffPathValue) throw new Error(`Missing ${HANDOFF_ENV}`);
  const handoffPath = resolve(handoffPathValue);
  const handoff = JSON.parse(readFileSync(handoffPath, 'utf8'));
  const runRoot = resolve(handoff.runRoot);
  const testHomesDir = resolve(handoff.testHomesDir);

  if (handoff.schemaVersion !== 2 || handoff.templateDatabase !== 'snaglet_template') {
    throw new Error('Unexpected PostgreSQL test handoff');
  }
  if (handoffPath !== join(runRoot, 'handoff.json')) {
    throw new Error('PostgreSQL test handoff escaped its run root');
  }
  if (testHomesDir !== join(runRoot, 'test-homes') || !isWithin(runRoot, testHomesDir)) {
    throw new Error('PostgreSQL test-home parent escaped its run root');
  }
  if (lstatSync(runRoot).isSymbolicLink() || realpathSync(runRoot) !== runRoot) {
    throw new Error('Refusing non-canonical PostgreSQL test run root');
  }
  if (
    !Number.isInteger(handoff.port) ||
    handoff.port < 1 ||
    handoff.port > 65535 ||
    (process.platform === 'win32'
      ? handoff.transport !== 'tcp' || handoff.host !== '127.0.0.1'
      : handoff.transport !== 'socket' || handoff.host !== handoff.socketDir)
  ) {
    throw new Error('Invalid PostgreSQL test connection contract');
  }

  for (const [key, filename] of [
    ['createdb', 'createdb'],
    ['psql', 'psql'],
    ['dropdb', 'dropdb'],
  ]) {
    const executable = resolve(handoff.binaries[key]);
    if (
      executable !==
        join(
          resolve(handoff.binaries.binDir),
          filename + (process.platform === 'win32' ? '.exe' : '')
        ) ||
      !isWithin(realpathSync(handoff.binaries.rootDir), realpathSync(executable))
    ) {
      throw new Error(`Refusing ${filename} outside the recorded managed runtime`);
    }
  }
  return handoff;
}

function commandEnvironment(handoff) {
  const env = { ...process.env };
  const pathKey = Object.keys(env).find((key) => key.toUpperCase() === 'PATH');
  const inheritedPath = pathKey ? env[pathKey] : '';
  if (process.platform === 'win32') {
    for (const key of Object.keys(env)) if (key.toUpperCase() === 'PATH') delete env[key];
  }
  return {
    ...env,
    PATH: `${handoff.binaries.binDir}${delimiter}${inheritedPath || ''}`,
    ...(process.platform === 'win32'
      ? {}
      : {
          DYLD_LIBRARY_PATH: `${handoff.binaries.libDir}${delimiter}${process.env.DYLD_LIBRARY_PATH || ''}`,
          LD_LIBRARY_PATH: `${handoff.binaries.libDir}${delimiter}${process.env.LD_LIBRARY_PATH || ''}`,
        }),
    PGHOST: handoff.host,
    PGPORT: String(handoff.port),
    PGUSER: handoff.user,
    PGPASSWORD: handoff.password,
  };
}

function run(handoff, executable, args) {
  execFileSync(executable, args, {
    env: commandEnvironment(handoff),
    stdio: 'pipe',
    timeout: 60_000,
    windowsHide: true,
  });
}

function forceDrop(handoff, database) {
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
    `DROP DATABASE IF EXISTS "${database}" WITH (FORCE);`,
  ]);
}

function databaseUrl(handoff, database) {
  const url = new URL('postgresql://localhost');
  url.username = handoff.user;
  url.password = handoff.password;
  url.pathname = `/${database}`;
  url.searchParams.set('host', handoff.host);
  url.port = String(handoff.port);
  url.searchParams.set('sslmode', 'disable');
  return url.toString();
}

const handoff = loadHandoff();
const worker = String(process.env.JEST_WORKER_ID || '1')
  .toLowerCase()
  .replace(/[^a-z0-9]+/g, '_');
const token = String(handoff.runToken)
  .toLowerCase()
  .replace(/[^a-z0-9]+/g, '_');
const database = `test_${token}_${worker}_${process.pid.toString(36)}_${randomBytes(8).toString(
  'hex'
)}`.slice(0, 63);
assertSafeDatabaseName(database);

const testHome = mkdtempSync(join(handoff.testHomesDir, `snaglet-pg-test-home-${worker}-`));
if (!isWithin(resolve(handoff.testHomesDir), resolve(testHome))) {
  throw new Error('Generated PostgreSQL test home escaped its parent');
}

let databaseCreated = false;
try {
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
    database,
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
    `ALTER DATABASE "${database}" SET hnsw.ef_search = 100;`,
  ]);

  process.env.NODE_ENV = 'test';
  process.env.SNAGLET_HOME = testHome;
  // SNAGLET_DATABASE_URL selects the override path. SNAGLET_DB_MODE is inert next to a
  // URL (packages/db/db.ts rejects a non-managed mode only without one).
  process.env.SNAGLET_DB_MODE = 'external';
  process.env.SNAGLET_DATABASE_URL = databaseUrl(handoff, database);
  process.env[DATABASE_ENV] = database;
  process.env[HOME_ENV] = testHome;
  delete process.env.SNAGLET_DB_CONFIG_PATH;
  delete process.env.SNAGLET_PG_DATA_DIR;
} catch (error) {
  if (databaseCreated) {
    try {
      forceDrop(handoff, database);
    } catch (cleanupError) {
      console.error(`Failed to clean PostgreSQL test database ${database}:`, cleanupError);
    }
  }
  console.error(`PostgreSQL per-file setup failed; retained disposable home at ${testHome}`);
  throw error;
}
