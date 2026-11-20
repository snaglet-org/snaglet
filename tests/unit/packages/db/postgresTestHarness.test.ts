import { afterEach, beforeEach, expect, it } from '@jest/globals';
import { linkSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { postgresExecutableName } from '@snaglet/db/runtime/postgres/binaries';
import {
  clusterCommandEnvironment,
  databaseUrl,
  loadTestClusterHandoff,
  type TestClusterHandoff,
} from '../../../support/pgTestCluster';

let runRoot: string;
let handoff: TestClusterHandoff;
let handoffPath: string;

beforeEach(() => {
  runRoot = realpathSync(mkdtempSync(join(tmpdir(), 'snaglet-pg-jest-harness-unit-')));
  const runtimeHome = join(runRoot, 'runtime-home');
  const dataDir = join(runtimeHome, 'postgres');
  const testHomesDir = join(runRoot, 'test-homes');
  const rootDir = join(runRoot, 'artifact');
  const binDir = join(rootDir, 'bin');
  for (const directory of [dataDir, testHomesDir, binDir])
    mkdirSync(directory, { recursive: true });
  const executable = (name: string): string => {
    const target = join(binDir, postgresExecutableName(name));
    writeFileSync(target, 'non-executable fixture');
    return target;
  };
  const socketDir = join(runRoot, 'socket');
  handoff = {
    schemaVersion: 2,
    runRoot,
    runtimeHome,
    dataDir,
    testHomesDir,
    runToken: 'fixture',
    socketDir,
    host: process.platform === 'win32' ? '127.0.0.1' : socketDir,
    transport: process.platform === 'win32' ? 'tcp' : 'socket',
    port: 45678,
    user: 'snaglet',
    password: 'fixture:with@characters',
    templateDatabase: 'snaglet_template',
    postmasterPid: 12345,
    binaries: {
      rootDir,
      binDir,
      libDir: join(rootDir, 'lib'),
      shareDir: join(rootDir, 'share'),
      postgres: executable('postgres'),
      initdb: executable('initdb'),
      pgCtl: executable('pg_ctl'),
      pgDump: executable('pg_dump'),
      pgRestore: executable('pg_restore'),
      pgConfig: executable('pg_config'),
      psql: executable('psql'),
      createdb: executable('createdb'),
      dropdb: executable('dropdb'),
    },
  };
  handoffPath = join(runRoot, 'handoff.json');
  saveHandoff();
});

afterEach(() => rmSync(runRoot, { recursive: true, force: true }));

function saveHandoff(): void {
  writeFileSync(handoffPath, JSON.stringify(handoff), { mode: 0o600 });
}

it('loads the explicit disposable handoff with platform executable suffixes', () => {
  expect(loadTestClusterHandoff(handoffPath)).toEqual(handoff);
});

it('carries the real host and dynamic port into URL and command environment', () => {
  const url = new URL(databaseUrl(handoff, 'test_fixture'));
  expect(url.searchParams.get('host')).toBe(handoff.host);
  expect(url.port).toBe('45678');
  expect(decodeURIComponent(url.password)).toBe(handoff.password);
  const env = clusterCommandEnvironment(handoff);
  expect(env.PGHOST).toBe(handoff.host);
  expect(env.PGPORT).toBe('45678');
  expect(env.PATH?.startsWith(handoff.binaries.binDir + delimiter)).toBe(true);
  if (process.platform === 'win32') {
    expect(Object.keys(env).filter((key) => key.toUpperCase() === 'PATH')).toEqual(['PATH']);
  }
});

it('refuses a handoff redirected to another data directory', () => {
  handoff.dataDir = join(runRoot, 'different-postgres');
  saveHandoff();
  expect(() => loadTestClusterHandoff(handoffPath)).toThrow('ownership or connection');
});

it('refuses remote hosts, invalid ports and missing process identity', () => {
  handoff.host = 'remote.example.invalid';
  saveHandoff();
  expect(() => loadTestClusterHandoff(handoffPath)).toThrow('ownership or connection');
  handoff.host = process.platform === 'win32' ? '127.0.0.1' : handoff.socketDir;
  handoff.port = 0;
  saveHandoff();
  expect(() => loadTestClusterHandoff(handoffPath)).toThrow('ownership or connection');
  handoff.port = 45678;
  handoff.postmasterPid = 0;
  saveHandoff();
  expect(() => loadTestClusterHandoff(handoffPath)).toThrow('ownership or connection');
});

it('refuses binaries outside the declared runtime and linked credential handoffs', () => {
  handoff.binaries.pgCtl = join(runRoot, postgresExecutableName('pg_ctl'));
  saveHandoff();
  expect(() => loadTestClusterHandoff(handoffPath)).toThrow('outside the recorded managed runtime');
  linkSync(handoffPath, join(runRoot, 'handoff-alias.json'));
  expect(() => loadTestClusterHandoff(handoffPath)).toThrow('linked PostgreSQL test handoff');
});
