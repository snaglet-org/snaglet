/**
 * The tables reader role and its credential file.
 *
 * The role is cluster-wide and shared by every file in this Jest run, so the
 * suite provisions it idempotently with the run-derived password and never
 * drops it. Grants are checked on this file's own database.
 */
import { createHash } from 'node:crypto';
import { lstat, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import { PostgresAdapter } from '@snaglet/db/adapters';
import { getDb, getDbClient } from '@snaglet/db/db';
import {
  PostgresRuntime,
  provisionTablesReaderRole,
  TABLES_READER_HBA_ENTRY,
  TABLES_READER_ROLE,
} from '@snaglet/db/runtime/postgres/runtime';
import { loadTestClusterHandoff } from '../../../support/pgTestCluster';

const handoff = loadTestClusterHandoff();
const database = process.env.SNAGLET_PG_TEST_DATABASE;
if (!database) throw new Error('Missing SNAGLET_PG_TEST_DATABASE');
const readerPassword = createHash('sha256')
  .update(`${TABLES_READER_ROLE}:${handoff.runToken}`)
  .digest('base64url');

function readerUrl(): string {
  const url = new URL('postgresql://localhost');
  url.username = TABLES_READER_ROLE;
  url.password = readerPassword;
  url.pathname = `/${database}`;
  url.searchParams.set('host', handoff.host);
  url.port = String(handoff.port);
  url.searchParams.set('sslmode', 'disable');
  return url.toString();
}

async function scalar<T>(sql: string, params: unknown[] = []): Promise<T> {
  const result = await getDb().query<{ value: T }>(sql, params);
  return result.rows[0]!.value;
}

describe('pg-reader-password credential file', () => {
  let home: string;
  let runtime: PostgresRuntime;

  beforeAll(async () => {
    home = await mkdtemp(path.join(tmpdir(), 'snaglet-reader-password-'));
    runtime = new PostgresRuntime({
      platform: 'linux',
      snagletHome: home,
      env: {},
      ensureBinaries: async () => {
        throw new Error('the credential file needs no PostgreSQL binaries');
      },
      log: () => {},
      warn: () => {},
    });
  });

  afterAll(async () => {
    await rm(home, { recursive: true, force: true });
  });

  it('is created privately, reused unchanged, and regenerated only when empty', async () => {
    expect(runtime.readerPasswordPath).toBe(path.join(home, 'pg-reader-password'));
    const first = await runtime.ensureReaderPassword();
    expect(first).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const info = await lstat(runtime.readerPasswordPath);
    expect(info.isFile()).toBe(true);
    expect(info.nlink).toBe(1);
    if (process.platform !== 'win32') expect(info.mode & 0o777).toBe(0o600);
    expect((await readFile(runtime.readerPasswordPath, 'utf8')).trim()).toBe(first);

    expect(await runtime.ensureReaderPassword()).toBe(first);

    await writeFile(runtime.readerPasswordPath, '', { mode: 0o600 });
    const regenerated = await runtime.ensureReaderPassword();
    expect(regenerated).not.toBe(first);
    expect(regenerated).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const parked = (await readdir(home)).filter((name) =>
      name.startsWith('pg-reader-password.empty-')
    );
    expect(parked).toHaveLength(1);
  });

  it('names the loopback hba entry the Windows transport appends', () => {
    expect(TABLES_READER_HBA_ENTRY).toBe(
      'host all snaglet_tables_reader 127.0.0.1/32 scram-sha-256'
    );
  });
});

describe('snaglet_tables_reader provisioning (shared managed test cluster)', () => {
  beforeAll(async () => {
    const db = getDb();
    await db.query('CREATE TABLE user_tables.reader_role_probe (id int PRIMARY KEY)');
    await db.query(
      'CREATE FUNCTION public.reader_role_probe_fn() RETURNS int LANGUAGE sql AS $$ SELECT 1 $$'
    );
    const client = await getDbClient();
    const options = { password: readerPassword, database, revokePublic: true };
    await provisionTablesReaderRole(client, options);
    // Idempotent: a second boot of any Snaglet process on the cluster changes nothing.
    await provisionTablesReaderRole(client, options);
    await db.query('CREATE TABLE user_tables.reader_role_probe_late (id int PRIMARY KEY)');
    await db.query(
      'CREATE FUNCTION public.reader_role_probe_fn_late() RETURNS int LANGUAGE sql AS $$ SELECT 2 $$'
    );
  }, 30_000);

  afterAll(async () => {
    const db = getDb();
    await db.query(
      'DROP TABLE IF EXISTS user_tables.reader_role_probe, user_tables.reader_role_probe_late'
    );
    await db.query(
      'DROP FUNCTION IF EXISTS public.reader_role_probe_fn(), public.reader_role_probe_fn_late()'
    );
  });

  it('exists as a bounded LOGIN role with the required defaults', async () => {
    const role = await getDb().query<{
      rolcanlogin: boolean;
      rolsuper: boolean;
      rolcreatedb: boolean;
      rolcreaterole: boolean;
      rolinherit: boolean;
      rolreplication: boolean;
      rolbypassrls: boolean;
      rolconnlimit: number;
      rolconfig: string[] | null;
    }>(
      'SELECT rolcanlogin, rolsuper, rolcreatedb, rolcreaterole, rolinherit, rolreplication, rolbypassrls, rolconnlimit, rolconfig FROM pg_roles WHERE rolname = $1',
      [TABLES_READER_ROLE]
    );
    expect(role.rows[0]).toMatchObject({
      rolcanlogin: true,
      rolsuper: false,
      rolcreatedb: false,
      rolcreaterole: false,
      rolinherit: false,
      rolreplication: false,
      rolbypassrls: false,
      rolconnlimit: 2,
    });
    expect(role.rows[0]?.rolconfig).toEqual(
      expect.arrayContaining([
        'default_transaction_read_only=on',
        'statement_timeout=5s',
        'lock_timeout=1s',
        'idle_in_transaction_session_timeout=10s',
        'search_path=user_tables',
      ])
    );
  });

  it('may connect and read user_tables, including tables created after provisioning, and nothing else', async () => {
    const privilege = (sql: string) => scalar<boolean>(sql, [TABLES_READER_ROLE]);
    expect(
      await privilege("SELECT has_database_privilege($1, current_database(), 'CONNECT') AS value")
    ).toBe(true);
    expect(
      await privilege("SELECT has_database_privilege($1, current_database(), 'TEMP') AS value")
    ).toBe(false);
    expect(
      await privilege("SELECT has_database_privilege($1, current_database(), 'CREATE') AS value")
    ).toBe(false);
    expect(
      await privilege("SELECT has_schema_privilege($1, 'user_tables', 'USAGE') AS value")
    ).toBe(true);
    expect(
      await privilege("SELECT has_schema_privilege($1, 'user_tables', 'CREATE') AS value")
    ).toBe(false);
    expect(
      await privilege(
        "SELECT has_table_privilege($1, 'user_tables.reader_role_probe', 'SELECT') AS value"
      )
    ).toBe(true);
    expect(
      await privilege(
        "SELECT has_table_privilege($1, 'user_tables.reader_role_probe_late', 'SELECT') AS value"
      )
    ).toBe(true);
    expect(
      await privilege(
        "SELECT has_table_privilege($1, 'user_tables.reader_role_probe', 'INSERT') AS value"
      )
    ).toBe(false);
    expect(
      await privilege("SELECT has_table_privilege($1, 'public.agents', 'SELECT') AS value")
    ).toBe(false);
    expect(
      await privilege(
        "SELECT has_table_privilege($1, 'public.user_provider_credentials', 'SELECT') AS value"
      )
    ).toBe(false);
  });

  it('applies the managed-mode revokes: no PUBLIC EXECUTE in public, no TEMP', async () => {
    const privilege = (sql: string) => scalar<boolean>(sql, [TABLES_READER_ROLE]);
    expect(
      await privilege(
        "SELECT has_function_privilege($1, 'public.reader_role_probe_fn()', 'EXECUTE') AS value"
      )
    ).toBe(false);
    expect(
      await privilege(
        "SELECT has_function_privilege($1, 'public.reader_role_probe_fn_late()', 'EXECUTE') AS value"
      )
    ).toBe(false);
    expect(
      await scalar<boolean>(
        "SELECT has_database_privilege('public', current_database(), 'TEMP') AS value"
      )
    ).toBe(false);
  });

  it('logs in with the provisioned password as its own session user', async () => {
    const reader = new PostgresAdapter({ connectionString: readerUrl() }, { poolMax: 1 });
    try {
      const who = await reader.query<{ current_user: string; session_user: string; ro: string }>(
        "SELECT current_user, session_user, current_setting('transaction_read_only') AS ro"
      );
      expect(who.rows[0]).toEqual({
        current_user: TABLES_READER_ROLE,
        session_user: TABLES_READER_ROLE,
        ro: 'on',
      });
    } finally {
      await reader.end();
    }
  });
});
