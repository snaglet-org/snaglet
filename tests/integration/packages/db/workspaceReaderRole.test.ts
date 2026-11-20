/**
 * The workspace reader role behind `database_query`, its grants and checks.
 *
 * The role is cluster-wide and shared by every file in this Jest run, so the
 * suite provisions it idempotently with the run-derived password and never
 * drops it. Grants are per database, so everything asserted here happens in
 * this file's own clone of the migrated template.
 */
import { createHash, randomBytes } from 'node:crypto';
import { lstat, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import { PostgresAdapter } from '@snaglet/db/adapters';
import { getDb, getDbClient } from '@snaglet/db/db';
import { PostgresRuntime } from '@snaglet/db/runtime/postgres/runtime';
import {
  assertReaderSessionRestricted,
  assertWorkspaceReaderRestricted,
  hiddenWorkspaceObjects,
  provisionWorkspaceReaderRole,
  WORKSPACE_READER_HBA_ENTRY,
  WORKSPACE_READER_POLICY,
  WORKSPACE_READER_ROLE,
  type WorkspaceReaderProvisioningReport,
} from '@snaglet/db/runtime/postgres/workspaceReader';
import { loadTestClusterHandoff } from '../../../support/pgTestCluster';

const handoff = loadTestClusterHandoff();
const database = process.env.SNAGLET_PG_TEST_DATABASE;
if (!database) throw new Error('Missing SNAGLET_PG_TEST_DATABASE');
const readerPassword = createHash('sha256')
  .update(`${WORKSPACE_READER_ROLE}:${handoff.runToken}`)
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

async function provision(): Promise<WorkspaceReaderProvisioningReport> {
  return provisionWorkspaceReaderRole(await getDbClient(), {
    password: readerPassword,
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
    WORKSPACE_READER_ROLE,
    table,
    privilege,
  ]);
const anyColumnPrivilege = (table: string) =>
  scalar<boolean>("SELECT has_any_column_privilege($1, $2, 'SELECT') AS value", [
    WORKSPACE_READER_ROLE,
    table,
  ]);
const columnPrivilege = (table: string, column: string) =>
  scalar<boolean>("SELECT has_column_privilege($1, $2, $3, 'SELECT') AS value", [
    WORKSPACE_READER_ROLE,
    table,
    column,
  ]);

describe('pg-workspace-reader-password credential file', () => {
  let home: string;

  beforeAll(async () => {
    home = await mkdtemp(path.join(tmpdir(), 'snaglet-workspace-reader-password-'));
  });

  afterAll(async () => {
    await rm(home, { recursive: true, force: true });
  });

  it('is created privately next to the tables reader credential and reused unchanged', async () => {
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
    expect(runtime.workspaceReaderPasswordPath).toBe(
      path.join(home, 'pg-workspace-reader-password')
    );
    const first = await runtime.ensureWorkspaceReaderPassword();
    expect(first).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(first).not.toBe(await runtime.ensureReaderPassword());
    const info = await lstat(runtime.workspaceReaderPasswordPath);
    expect(info.isFile()).toBe(true);
    if (process.platform !== 'win32') expect(info.mode & 0o777).toBe(0o600);
    expect((await readFile(runtime.workspaceReaderPasswordPath, 'utf8')).trim()).toBe(first);
    expect(await runtime.ensureWorkspaceReaderPassword()).toBe(first);
  });

  it('names the loopback hba entry the Windows transport appends', () => {
    expect(WORKSPACE_READER_HBA_ENTRY).toBe(
      'host all snaglet_workspace_reader 127.0.0.1/32 scram-sha-256'
    );
  });
});

describe('snaglet_workspace_reader provisioning (shared managed test cluster)', () => {
  let firstReport: WorkspaceReaderProvisioningReport;
  let secondReport: WorkspaceReaderProvisioningReport;
  let reader: PostgresAdapter;

  beforeAll(async () => {
    // Before any fixture exists: this is the freshly migrated schema.
    firstReport = await provision();
    // Idempotent: a second boot of any Snaglet process on the cluster changes nothing.
    secondReport = await provision();
    await getDb().query(
      'CREATE TABLE user_tables.workspace_reader_probe_late (id int PRIMARY KEY)'
    );
    reader = new PostgresAdapter(
      { connectionString: connectionUrl(WORKSPACE_READER_ROLE, readerPassword) },
      { poolMax: 1 }
    );
  }, 60_000);

  afterAll(async () => {
    await reader.end();
    const db = getDb();
    await db.query('DROP TABLE IF EXISTS user_tables.workspace_reader_probe_late');
    await db.query('DROP VIEW IF EXISTS public.workspace_reader_probe_view');
    await db.query('DROP TABLE IF EXISTS public.workspace_reader_probe_table');
    await db.query('ALTER TABLE public.images DROP COLUMN IF EXISTS api_key');
  });

  it('classifies every public relation and column the migrations create', () => {
    expect(firstReport).toEqual({ unclassified: [], withheldColumns: [], missing: [] });
    expect(secondReport).toEqual(firstReport);
  });

  it('exists as a bounded LOGIN role with read-only, timeout and search_path defaults', async () => {
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
      [WORKSPACE_READER_ROLE]
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
        'default_transaction_read_only=on',
        'statement_timeout=5s',
        'lock_timeout=1s',
        'idle_in_transaction_session_timeout=10s',
        'search_path=public, user_tables',
      ])
    );
  });

  it('reads workspace tables and user_tables (including later ones), nothing it may write', async () => {
    for (const table of ['public.docs', 'public.nodes', 'public.messages', 'public.agents']) {
      expect(await tablePrivilege(table)).toBe(true);
    }
    expect(await tablePrivilege('user_tables.workspace_reader_probe_late')).toBe(true);
    for (const privilege of ['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE']) {
      expect(await tablePrivilege('public.docs', privilege)).toBe(false);
      expect(await tablePrivilege('user_tables.workspace_reader_probe_late', privilege)).toBe(
        false
      );
    }
    expect(
      await scalar<boolean>(
        "SELECT has_database_privilege($1, current_database(), 'TEMP') AS value",
        [WORKSPACE_READER_ROLE]
      )
    ).toBe(false);
    expect(
      await scalar<boolean>("SELECT has_schema_privilege($1, 'public', 'CREATE') AS value", [
        WORKSPACE_READER_ROLE,
      ])
    ).toBe(false);
  });

  it('is denied every secret table and column in the policy', async () => {
    const hidden = hiddenWorkspaceObjects();
    expect(hidden.tables).toEqual([
      'mcp_api_keys',
      'provider_fallback_credentials',
      'socket_sessions',
      'user_provider_credentials',
    ]);
    for (const table of hidden.tables) {
      expect(await anyColumnPrivilege(`public.${table}`)).toBe(false);
    }
    for (const qualified of hidden.columns) {
      const [table, column] = qualified.split('.') as [string, string];
      expect(await columnPrivilege(`public.${table}`, column)).toBe(false);
    }
    expect(await columnPrivilege('public.mcp_servers', 'name')).toBe(true);
    expect(await columnPrivilege('public.users', 'email')).toBe(true);
    expect(await tablePrivilege('public.mcp_servers')).toBe(false);
  });

  it('never grants a later public table or any view, and reports both as unclassified', async () => {
    const db = getDb();
    await db.query('CREATE TABLE public.workspace_reader_probe_table (id int PRIMARY KEY)');
    await db.query(
      'CREATE VIEW public.workspace_reader_probe_view AS SELECT key_hash FROM public.mcp_api_keys'
    );
    expect(await tablePrivilege('public.workspace_reader_probe_table')).toBe(false);
    expect(await tablePrivilege('public.workspace_reader_probe_view')).toBe(false);

    const report = await provision();
    expect(report.unclassified).toEqual([
      'workspace_reader_probe_table',
      'workspace_reader_probe_view',
    ]);
    expect(await tablePrivilege('public.workspace_reader_probe_table')).toBe(false);
    expect(await tablePrivilege('public.workspace_reader_probe_view')).toBe(false);
  });

  it('withholds a secret-named column added to a readable table', async () => {
    await getDb().query('ALTER TABLE public.images ADD COLUMN api_key text');
    const report = await provision();
    expect(report.withheldColumns).toEqual(['images.api_key']);
    expect(await columnPrivilege('public.images', 'api_key')).toBe(false);
    expect(await columnPrivilege('public.images', 'url')).toBe(true);
  });

  it('logs in as its own session user and may call pgvector and pg_trgm functions', async () => {
    const result = await reader.query<{ who: string; session: string; sim: boolean; dist: number }>(
      `SELECT current_user AS who, session_user AS session,
              similarity('workspace', 'workspaces') > 0 AS sim,
              ('[1,2]'::vector <-> '[1,3]'::vector) AS dist`
    );
    expect(result.rows[0]).toEqual({
      who: WORKSPACE_READER_ROLE,
      session: WORKSPACE_READER_ROLE,
      sim: true,
      dist: 1,
    });
  });

  it('passes its own sandbox check and refuses a superuser or over-granted reader', async () => {
    await expect(assertWorkspaceReaderRestricted(reader)).resolves.toBeUndefined();
    await expect(assertWorkspaceReaderRestricted(getDb())).rejects.toThrow(/superuser/);

    const db = getDb();
    await db.query(`GRANT SELECT ON public.mcp_api_keys TO ${WORKSPACE_READER_ROLE}`);
    await db.query(`GRANT SELECT (headers) ON public.mcp_servers TO ${WORKSPACE_READER_ROLE}`);
    try {
      await expect(assertWorkspaceReaderRestricted(reader)).rejects.toThrow(
        /mcp_api_keys\.key_hash.*|mcp_servers\.headers/
      );
    } finally {
      await provision();
    }
    await expect(assertWorkspaceReaderRestricted(reader)).resolves.toBeUndefined();
  });

  it('refuses a reader that is a member of a privileged role', async () => {
    const probeRole = `test_reader_probe_${randomBytes(6).toString('hex')}`;
    const probePassword = randomBytes(24).toString('base64url');
    const db = getDb();
    await db.query(`CREATE ROLE ${probeRole} LOGIN NOINHERIT PASSWORD '${probePassword}'`);
    await db.query(`GRANT pg_read_server_files TO ${probeRole}`);
    const probe = new PostgresAdapter(
      { connectionString: connectionUrl(probeRole, probePassword) },
      { poolMax: 1 }
    );
    try {
      await expect(assertReaderSessionRestricted(probe, 'probe reader')).rejects.toThrow(
        /member of pg_read_server_files/
      );
    } finally {
      await probe.end();
      await db.query(`DROP ROLE ${probeRole}`);
    }
  });

  it('covers every relation named in the policy with a known access level', () => {
    for (const [table, policy] of Object.entries(WORKSPACE_READER_POLICY)) {
      expect(['read', 'columns', 'deny']).toContain(policy.access);
      if (policy.access === 'columns') {
        const overlap = policy.visible.filter((column) => policy.hidden.includes(column));
        expect({ table, overlap }).toEqual({ table, overlap: [] });
      }
    }
  });
});
