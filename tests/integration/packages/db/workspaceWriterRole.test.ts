/**
 * The workspace writer role behind `database_execute` and `create_view`, its
 * grants and checks.
 *
 * The role is cluster-wide and shared by every file in this Jest run, so the
 * suite provisions it idempotently with the run-derived password and never
 * drops it. Grants are per database, so everything asserted here happens in
 * this file's own clone of the migrated template. Fixtures are neutral,
 * role-based placeholders.
 */
import { createHash } from 'node:crypto';
import { lstat, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import { PostgresAdapter } from '@snaglet/db/adapters';
import { getDb, getDbClient } from '@snaglet/db/db';
import { PostgresRuntime } from '@snaglet/db/runtime/postgres/runtime';
import {
  provisionWorkspaceReaderRole,
  WORKSPACE_READER_ROLE,
} from '@snaglet/db/runtime/postgres/workspaceReader';
import {
  assertWorkspaceWriterRestricted,
  provisionWorkspaceWriterRole,
  WORKSPACE_WRITER_HBA_ENTRY,
  WORKSPACE_WRITER_ROLE,
  type WorkspaceWriterProvisioningReport,
} from '@snaglet/db/runtime/postgres/workspaceWriter';
import { WorkspaceExecute, WorkspaceExecuteUnavailableError } from '@snaglet/db/tables/table_query';
import { loadTestClusterHandoff } from '../../../support/pgTestCluster';

const handoff = loadTestClusterHandoff();
const database = process.env.SNAGLET_PG_TEST_DATABASE;
if (!database) throw new Error('Missing SNAGLET_PG_TEST_DATABASE');
const writerPassword = createHash('sha256')
  .update(`${WORKSPACE_WRITER_ROLE}:${handoff.runToken}`)
  .digest('base64url');

function connectionUrl(user: string, password: string): string {
  const url = new URL('postgresql://localhost');
  url.username = user;
  url.password = password;
  url.pathname = `/${database}`;
  url.searchParams.set('host', handoff.host);
  url.port = String(handoff.port);
  url.searchParams.set('sslmode', 'disable');
  return url.toString();
}

async function provision(): Promise<WorkspaceWriterProvisioningReport> {
  return provisionWorkspaceWriterRole(await getDbClient(), {
    password: writerPassword,
    database: database as string,
    revokePublic: true,
  });
}

async function scalar<T>(sql: string, params: unknown[] = []): Promise<T> {
  const result = await getDb().query<{ value: T }>(sql, params);
  return result.rows[0]!.value;
}

const tablePrivilege = (table: string, privilege = 'SELECT') =>
  scalar<boolean>('SELECT has_table_privilege($1, $2, $3) AS value', [
    WORKSPACE_WRITER_ROLE,
    table,
    privilege,
  ]);

async function expectReject(promise: Promise<unknown>, match?: RegExp): Promise<void> {
  let threw = false;
  try {
    await promise;
  } catch (error) {
    threw = true;
    if (match) expect(String((error as Error).message)).toMatch(match);
  }
  expect(threw).toBe(true);
}

describe('pg-workspace-writer-password credential file', () => {
  let home: string;

  beforeAll(async () => {
    home = await mkdtemp(path.join(tmpdir(), 'snaglet-workspace-writer-password-'));
  });

  afterAll(async () => {
    await rm(home, { recursive: true, force: true });
  });

  it('is created privately next to the reader credentials and reused unchanged', async () => {
    const runtime = new PostgresRuntime({
      platform: 'linux',
      snagletHome: home,
      env: {},
      ensureBinaries: async () => {
        throw new Error('the credential file needs no PostgreSQL binaries');
      },
      log: () => {},
      warn: () => {},
    });
    expect(runtime.workspaceWriterPasswordPath).toBe(
      path.join(home, 'pg-workspace-writer-password')
    );
    const first = await runtime.ensureWorkspaceWriterPassword();
    expect(first).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(first).not.toBe(await runtime.ensureWorkspaceReaderPassword());
    const info = await lstat(runtime.workspaceWriterPasswordPath);
    expect(info.isFile()).toBe(true);
    if (process.platform !== 'win32') expect(info.mode & 0o777).toBe(0o600);
    expect((await readFile(runtime.workspaceWriterPasswordPath, 'utf8')).trim()).toBe(first);
    expect(await runtime.ensureWorkspaceWriterPassword()).toBe(first);
  });

  it('names the loopback hba entry the Windows transport appends', () => {
    expect(WORKSPACE_WRITER_HBA_ENTRY).toBe(
      'host all snaglet_workspace_writer 127.0.0.1/32 scram-sha-256'
    );
  });
});

describe('snaglet_workspace_writer provisioning (shared managed test cluster)', () => {
  let firstReport: WorkspaceWriterProvisioningReport;
  let secondReport: WorkspaceWriterProvisioningReport;
  let writer: PostgresAdapter;

  beforeAll(async () => {
    // An app-owned custom table that exists before provisioning (backfill path).
    await getDb().query(
      'CREATE TABLE IF NOT EXISTS user_tables.writer_probe_app (id int PRIMARY KEY, label text)'
    );
    // The reader exists first, as at boot, so the writer can grant it SELECT
    // on what the writer creates. Same run-derived password as the reader suite.
    await provisionWorkspaceReaderRole(await getDbClient(), {
      password: createHash('sha256')
        .update(`${WORKSPACE_READER_ROLE}:${handoff.runToken}`)
        .digest('base64url'),
      database: database as string,
      revokePublic: true,
    });
    firstReport = await provision();
    secondReport = await provision();
    writer = new PostgresAdapter(
      { connectionString: connectionUrl(WORKSPACE_WRITER_ROLE, writerPassword) },
      { poolMax: 1 }
    );
  }, 60_000);

  afterAll(async () => {
    await writer.end();
    const db = getDb();
    await db.query('DROP VIEW IF EXISTS user_tables.writer_probe_view');
    await db.query('DROP TABLE IF EXISTS user_tables.writer_probe_owned');
    await db.query('DROP TABLE IF EXISTS user_tables.writer_probe_app');
    await db.query('DROP TABLE IF EXISTS user_tables.writer_probe_late');
    await db.query('DROP VIEW IF EXISTS user_tables.writer_probe_bad');
    await db.query('DROP VIEW IF EXISTS user_tables.writer_probe_shared_view');
    await db.query('DROP TABLE IF EXISTS user_tables.writer_probe_shared');
  });

  it('reports the custom schema granted and is idempotent', () => {
    expect(firstReport).toEqual({ customSchemaGranted: true });
    expect(secondReport).toEqual(firstReport);
  });

  it('exists as a bounded read-write LOGIN role with timeout and search_path defaults', async () => {
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
      memberships: number;
    }>(
      `SELECT rolcanlogin, rolsuper, rolcreatedb, rolcreaterole, rolinherit, rolreplication,
              rolbypassrls, rolconnlimit, rolconfig,
              (SELECT count(*)::int FROM pg_auth_members m WHERE m.member = r.oid) AS memberships
         FROM pg_roles r WHERE rolname = $1`,
      [WORKSPACE_WRITER_ROLE]
    );
    expect(role.rows[0]).toMatchObject({
      rolcanlogin: true,
      rolsuper: false,
      rolcreatedb: false,
      rolcreaterole: false,
      rolinherit: false,
      rolreplication: false,
      rolbypassrls: false,
      rolconnlimit: 4,
      memberships: 0,
    });
    expect(role.rows[0]?.rolconfig).toEqual(
      expect.arrayContaining([
        'statement_timeout=30s',
        'lock_timeout=5s',
        'idle_in_transaction_session_timeout=15s',
        'search_path=user_tables',
      ])
    );
    // Never read-only: this role writes.
    expect(role.rows[0]?.rolconfig ?? []).not.toContain('default_transaction_read_only=on');
  });

  it('may write and create in user_tables but reach nothing in public', async () => {
    expect(
      await scalar("SELECT has_schema_privilege($1, 'user_tables', 'USAGE') AS value", [
        WORKSPACE_WRITER_ROLE,
      ])
    ).toBe(true);
    expect(
      await scalar("SELECT has_schema_privilege($1, 'user_tables', 'CREATE') AS value", [
        WORKSPACE_WRITER_ROLE,
      ])
    ).toBe(true);
    for (const privilege of ['SELECT', 'INSERT', 'UPDATE', 'DELETE']) {
      expect(await tablePrivilege('user_tables.writer_probe_app', privilege)).toBe(true);
    }
    // USAGE on public (name resolution) but never CREATE there.
    expect(
      await scalar("SELECT has_schema_privilege($1, 'public', 'USAGE') AS value", [
        WORKSPACE_WRITER_ROLE,
      ])
    ).toBe(true);
    expect(
      await scalar("SELECT has_schema_privilege($1, 'public', 'CREATE') AS value", [
        WORKSPACE_WRITER_ROLE,
      ])
    ).toBe(false);
    for (const table of ['public.agents', 'public.table_catalog', 'public.messages']) {
      expect(
        await scalar("SELECT has_any_column_privilege($1, $2, 'SELECT') AS value", [
          WORKSPACE_WRITER_ROLE,
          table,
        ])
      ).toBe(false);
    }
    expect(await tablePrivilege('public.user_provider_credentials', 'SELECT')).toBe(false);
  });

  it('logs in as its own session user and may call pgvector and pg_trgm functions', async () => {
    // search_path is user_tables, so public functions are called schema-qualified.
    const result = await writer.query<{ who: string; session: string; sim: boolean; dist: number }>(
      `SELECT current_user AS who, session_user AS session,
              public.similarity('a', 'ab') >= 0 AS sim,
              ('[1,2]'::public.vector OPERATOR(public.<->) '[1,3]'::public.vector) AS dist`
    );
    expect(result.rows[0]).toMatchObject({
      who: WORKSPACE_WRITER_ROLE,
      session: WORKSPACE_WRITER_ROLE,
      sim: true,
      dist: 1,
    });
  });

  it('inserts, updates and deletes rows in an app-owned custom table', async () => {
    await writer.query("INSERT INTO writer_probe_app (id, label) VALUES (1, 'a'), (2, 'b')");
    await writer.query("UPDATE writer_probe_app SET label = 'c' WHERE id = 1");
    const after = await writer.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM writer_probe_app WHERE label = 'c'"
    );
    expect(after.rows[0]?.n).toBe(1);
    await writer.query('DELETE FROM writer_probe_app WHERE id = 2');
    const remaining = await writer.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM writer_probe_app'
    );
    expect(remaining.rows[0]?.n).toBe(1);
  });

  it('creates, alters, drops and views custom tables it owns', async () => {
    await writer.query('CREATE TABLE writer_probe_owned (id int PRIMARY KEY)');
    await writer.query('ALTER TABLE writer_probe_owned ADD COLUMN note text');
    await writer.query('INSERT INTO writer_probe_owned (id, note) VALUES (1, $1)', ['n']);
    await writer.query('CREATE VIEW writer_probe_view AS SELECT id FROM writer_probe_owned');
    const owner = await getDb().query<{ relowner: string; nspname: string }>(
      `SELECT r.rolname AS relowner, n.nspname
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
         JOIN pg_roles r ON r.oid = c.relowner
        WHERE c.relname = 'writer_probe_view'`
    );
    expect(owner.rows[0]).toEqual({ relowner: WORKSPACE_WRITER_ROLE, nspname: 'user_tables' });
    await writer.query('DROP VIEW writer_probe_view');
    await writer.query('DROP TABLE writer_probe_owned');
  });

  it('cannot read or write Snaglet system tables, or a credential-bearing table', async () => {
    await expectReject(writer.query('SELECT id FROM public.agents LIMIT 1'), /permission denied/i);
    await expectReject(writer.query("UPDATE public.agents SET name = 'x'"), /permission denied/i);
    await expectReject(
      writer.query('SELECT 1 FROM public.user_provider_credentials LIMIT 1'),
      /permission denied/i
    );
    await expectReject(
      writer.query('SELECT id FROM public.table_catalog LIMIT 1'),
      /permission denied/i
    );
    await expectReject(
      writer.query(
        'INSERT INTO public.table_catalog (id, name, table_name, origin) VALUES ($1,$2,$3,$4)',
        ['x', 'x', 'x', 'custom']
      ),
      /permission denied/i
    );
  });

  it('cannot read a view over a system table, and create_view rolls one back', async () => {
    // PostgreSQL checks a view's underlying privileges when the view is read
    // (with its owner's rights), not when it is created.
    await expectReject(
      writer.query(
        'CREATE VIEW writer_probe_bad AS SELECT id FROM public.agents; SELECT * FROM writer_probe_bad LIMIT 0'
      ),
      /permission denied/i
    );
    await expectReject(
      WorkspaceExecute.execute(
        'CREATE VIEW writer_probe_bad AS SELECT id FROM public.agents;\nSELECT * FROM writer_probe_bad LIMIT 0',
        { writer }
      ),
      /permission denied/i
    );
    expect(
      await scalar("SELECT to_regclass('user_tables.writer_probe_bad') IS NULL AS value")
    ).toBe(true);
  });

  it('cannot COPY TO PROGRAM (no server-program execution)', async () => {
    await expectReject(
      writer.query("COPY (SELECT 1) TO PROGRAM 'cat'"),
      /must be superuser|pg_execute_server_program|permission denied/i
    );
  });

  it('writes a custom table the app created after provisioning, without re-provisioning', async () => {
    await getDb().query('CREATE TABLE user_tables.writer_probe_late (id int PRIMARY KEY)');
    // No provision() call here: ALTER DEFAULT PRIVILEGES granted it at creation.
    await writer.query('INSERT INTO writer_probe_late (id) VALUES (42)');
    const row = await writer.query<{ id: number }>('SELECT id FROM writer_probe_late');
    expect(row.rows[0]?.id).toBe(42);
  });

  it('leaves what it creates readable by the workspace reader', async () => {
    await writer.query('CREATE TABLE writer_probe_shared (id int PRIMARY KEY)');
    await writer.query(
      'CREATE VIEW writer_probe_shared_view AS SELECT id FROM writer_probe_shared'
    );
    for (const relation of [
      'user_tables.writer_probe_shared',
      'user_tables.writer_probe_shared_view',
    ]) {
      expect(
        await scalar<boolean>('SELECT has_table_privilege($1, $2, $3) AS value', [
          'snaglet_workspace_reader',
          relation,
          'SELECT',
        ])
      ).toBe(true);
    }
    await writer.query('DROP VIEW writer_probe_shared_view');
    await writer.query('DROP TABLE writer_probe_shared');
  });

  it('passes its own sandbox check and refuses a superuser', async () => {
    await expect(assertWorkspaceWriterRestricted(writer)).resolves.toBeUndefined();
    await expectReject(assertWorkspaceWriterRestricted(getDb()), /superuser/);
  });

  describe('WorkspaceExecute on the writer pool', () => {
    it('runs several statements in one transaction and returns the last result', async () => {
      const result = await WorkspaceExecute.execute(
        "INSERT INTO writer_probe_app (id, label) VALUES (10, 'x'), (11, 'y');\n" +
          "UPDATE writer_probe_app SET label = 'z' WHERE id >= 10;\n" +
          'SELECT id FROM writer_probe_app WHERE id >= 10 ORDER BY id',
        { writer }
      );
      expect(result.rows).toEqual([{ id: 10 }, { id: 11 }]);
      expect(result.rowCount).toBe(2);
    });

    it('rolls back every statement when a later one is refused', async () => {
      await expectReject(
        WorkspaceExecute.execute(
          "INSERT INTO writer_probe_app (id, label) VALUES (20, 'gone');\n" +
            "UPDATE public.agents SET name = 'x'",
          { writer }
        ),
        /permission denied/i
      );
      expect(
        await scalar<number>(
          'SELECT count(*)::int AS value FROM user_tables.writer_probe_app WHERE id = 20'
        )
      ).toBe(0);
    });
  });
});

describe('WorkspaceExecute refusal when no writer connection exists', () => {
  it('throws the unavailable error (the external-mode path with no SNAGLET_WORKSPACE_WRITER_URL)', async () => {
    await expect(WorkspaceExecute.execute('SELECT 1', { writer: null })).rejects.toBeInstanceOf(
      WorkspaceExecuteUnavailableError
    );
  });
});
