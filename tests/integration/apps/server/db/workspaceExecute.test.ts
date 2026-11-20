/**
 * database_execute and create_view against the shared managed test cluster.
 *
 * The per-file database is reached in url mode, so the tools' writer pool
 * comes from `SNAGLET_WORKSPACE_WRITER_URL`, which this file points at its own
 * database before the first `getDbClient()` opens the app pool. The
 * cluster-wide `snaglet_workspace_writer` role is provisioned idempotently with a
 * password derived from the run token, so every file agrees on it and none
 * drops it. Fixtures are neutral, role-based placeholders.
 */
import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import { getDb, getDbClient } from '@snaglet/db/db';
import {
  provisionWorkspaceWriterRole,
  WORKSPACE_WRITER_ROLE,
} from '@snaglet/db/runtime/postgres/workspaceWriter';
import createView from '@server/services/ToolService/tools/database/create-view/tool';
import databaseExecute from '@server/services/ToolService/tools/database/database-execute/tool';
import { loadTestClusterHandoff } from '../../../../support/pgTestCluster';

const handoff = loadTestClusterHandoff();
const database = process.env.SNAGLET_PG_TEST_DATABASE;
if (!database) throw new Error('Missing SNAGLET_PG_TEST_DATABASE');
const writerPassword = createHash('sha256')
  .update(`${WORKSPACE_WRITER_ROLE}:${handoff.runToken}`)
  .digest('base64url');
{
  const url = new URL('postgresql://localhost');
  url.username = WORKSPACE_WRITER_ROLE;
  url.password = writerPassword;
  url.pathname = `/${database}`;
  url.searchParams.set('host', handoff.host);
  url.port = String(handoff.port);
  url.searchParams.set('sslmode', 'disable');
  process.env.SNAGLET_WORKSPACE_WRITER_URL = url.toString();
}

async function execute(sql: string): Promise<string> {
  const result = await databaseExecute({ sql }, {});
  if (typeof result !== 'string') throw new Error('database_execute returns text');
  return result;
}

async function refusal(run: () => Promise<unknown>, label: string): Promise<string> {
  try {
    await run();
  } catch (error: unknown) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error(`Expected a refusal: ${label}`);
}

async function scalar<T>(sql: string, params: unknown[] = []): Promise<T> {
  const result = await getDb().query<{ value: T }>(sql, params);
  return result.rows[0]!.value;
}

describe('database_execute and create_view as snaglet_workspace_writer', () => {
  beforeAll(async () => {
    await provisionWorkspaceWriterRole(await getDbClient(), {
      password: writerPassword,
      database: database as string,
      revokePublic: true,
    });
    await getDb().query(
      'CREATE TABLE user_tables.execute_probe (id int PRIMARY KEY, label text NOT NULL)'
    );
  }, 60_000);

  afterAll(async () => {
    const db = getDb();
    await db.query('DROP VIEW IF EXISTS user_tables.execute_probe_view');
    await db.query('DROP TABLE IF EXISTS user_tables.execute_probe');
    await db.query('DROP TABLE IF EXISTS user_tables.execute_probe_made');
  });

  it('writes a custom table and reports the affected rows', async () => {
    const inserted = await execute(
      "INSERT INTO execute_probe (id, label) VALUES (1, 'a'), (2, 'b') RETURNING id"
    );
    expect(inserted).toMatch(/\b1\b/);
    expect(inserted).toMatch(/\b2\b/);
    const updated = await execute("UPDATE execute_probe SET label = 'c' WHERE id = 1");
    expect(updated).toMatch(/1 rows affected/);
    expect(
      await scalar<string>('SELECT label AS value FROM user_tables.execute_probe WHERE id = 1')
    ).toBe('c');
  });

  it('runs DDL on custom tables and lands unqualified names in user_tables', async () => {
    await execute('CREATE TABLE execute_probe_made (id int PRIMARY KEY)');
    await execute('ALTER TABLE execute_probe_made ADD COLUMN note text');
    expect(
      await scalar<string>(
        "SELECT (SELECT rolname FROM pg_roles WHERE oid = c.relowner) AS value FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'user_tables' AND c.relname = 'execute_probe_made'"
      )
    ).toBe(WORKSPACE_WRITER_ROLE);
    await execute('DROP TABLE execute_probe_made');
  });

  it('is refused by PostgreSQL on Snaglet system tables, with a message naming the role', async () => {
    const message = await refusal(
      () => execute("UPDATE public.agents SET name = 'x'"),
      'write to agents'
    );
    expect(message).toMatch(/permission denied/);
    expect(message).toMatch(/snaglet_workspace_writer/);
    expect(
      await refusal(() => execute('SELECT id FROM public.table_catalog LIMIT 1'), 'read catalog')
    ).toMatch(/permission denied/);
    expect(
      await refusal(() => execute("INSERT INTO public.memories (id) VALUES ('x')"), 'memories')
    ).toMatch(/permission denied/);
  });

  it('refuses the credential table in the handler and COPY TO PROGRAM in the denylist', async () => {
    expect(
      await refusal(() => execute('SELECT 1 FROM public.user_provider_credentials'), 'credentials')
    ).toMatch(/immutable|credential|not allowed|permission denied/i);
    expect(
      await refusal(() => execute("COPY (SELECT 1) TO PROGRAM 'true'"), 'copy to program')
    ).toMatch(/does not allow/);
  });

  it('rolls the whole call back when one statement fails', async () => {
    await refusal(
      () =>
        execute(
          "INSERT INTO execute_probe (id, label) VALUES (9, 'gone');\n" +
            "UPDATE public.agents SET name = 'x'"
        ),
      'partial write'
    );
    expect(
      await scalar<number>(
        'SELECT count(*)::int AS value FROM user_tables.execute_probe WHERE id = 9'
      )
    ).toBe(0);
  });

  it('creates a writer-owned view over custom tables in user_tables', async () => {
    const result = await createView(
      { view_name: 'execute_probe_view', select_sql: 'SELECT id, label FROM execute_probe' },
      {}
    );
    expect(result).toMatch(/created/);
    const owner = await getDb().query<{ relowner: string; nspname: string }>(
      `SELECT r.rolname AS relowner, n.nspname
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
         JOIN pg_roles r ON r.oid = c.relowner
        WHERE c.relname = 'execute_probe_view'`
    );
    expect(owner.rows[0]).toEqual({ relowner: WORKSPACE_WRITER_ROLE, nspname: 'user_tables' });
    expect(await execute('SELECT count(*)::int AS n FROM execute_probe_view')).toMatch(/\b2\b/);
  });

  it('refuses a view over agents and leaves nothing behind', async () => {
    const message = await refusal(
      () =>
        createView({ view_name: 'execute_probe_agents', select_sql: 'SELECT id FROM agents' }, {}),
      'view over agents'
    );
    expect(message).toMatch(/does not exist|permission denied/);
    expect(
      await scalar<boolean>(
        "SELECT to_regclass('user_tables.execute_probe_agents') IS NULL AS value"
      )
    ).toBe(true);
    const qualified = await refusal(
      () =>
        createView(
          { view_name: 'execute_probe_agents', select_sql: 'SELECT id FROM public.agents' },
          {}
        ),
      'qualified view over agents'
    );
    expect(qualified).toMatch(/permission denied/);
    expect(
      await scalar<boolean>(
        "SELECT to_regclass('user_tables.execute_probe_agents') IS NULL AS value"
      )
    ).toBe(true);
  });
});
