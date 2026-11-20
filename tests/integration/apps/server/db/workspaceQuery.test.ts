/**
 * database_query against the shared managed test cluster.
 *
 * The per-file database is reached in url mode, so the tool's reader pool
 * comes from `SNAGLET_WORKSPACE_READER_URL`, which this file points at its own
 * database before the first `getDbClient()` opens the app pool. The
 * cluster-wide `snaglet_workspace_reader` role is provisioned idempotently with a
 * password derived from the run token, so every file agrees on it and none
 * drops it.
 */
import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import { getDb, getDbClient, getWorkspaceReaderClient } from '@snaglet/db/db';
import {
  provisionWorkspaceReaderRole,
  WORKSPACE_READER_ROLE,
} from '@snaglet/db/runtime/postgres/workspaceReader';
import { WorkspaceQuery } from '@snaglet/db/tables/table_query';
import databaseQuery from '@server/services/ToolService/tools/database/database-query/tool';
import { loadTestClusterHandoff } from '../../../../support/pgTestCluster';

const handoff = loadTestClusterHandoff();
const database = process.env.SNAGLET_PG_TEST_DATABASE;
if (!database) throw new Error('Missing SNAGLET_PG_TEST_DATABASE');
const readerPassword = createHash('sha256')
  .update(`${WORKSPACE_READER_ROLE}:${handoff.runToken}`)
  .digest('base64url');
{
  const url = new URL('postgresql://localhost');
  url.username = WORKSPACE_READER_ROLE;
  url.password = readerPassword;
  url.pathname = `/${database}`;
  url.searchParams.set('host', handoff.host);
  url.port = String(handoff.port);
  url.searchParams.set('sslmode', 'disable');
  process.env.SNAGLET_WORKSPACE_READER_URL = url.toString();
}

const DOC_ID = 'doc-1111111111111-aaaaaaaaa';
const LONG_CONTENT = 'y'.repeat(300);

async function run(sql: string, extra: Record<string, unknown> = {}): Promise<string> {
  const result = await databaseQuery({ sql, ...extra }, {});
  if (typeof result !== 'string') throw new Error('database_query returns text');
  return result;
}

async function refusal(sql: string, extra: Record<string, unknown> = {}): Promise<string> {
  try {
    await run(sql, extra);
  } catch (error: unknown) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error(`Expected database_query to refuse: ${sql}`);
}

function pgCode(error: unknown): string | undefined {
  return (error as { code?: string }).code;
}

/** Run `sql` on a raw reader connection (no tool pre-check) and return its SQLSTATE. */
async function rawReaderCode(sql: string): Promise<string | undefined> {
  const reader = await getWorkspaceReaderClient();
  if (!reader) throw new Error('workspace reader unavailable');
  return reader.withConnection(async (connection) => {
    try {
      await connection.query(sql);
    } catch (error: unknown) {
      return pgCode(error);
    }
    throw new Error(`Expected the reader to be refused: ${sql}`);
  });
}

async function readerBackendsActive(): Promise<number> {
  const result = await getDb().query<{ active: number }>(
    "SELECT count(*)::int AS active FROM pg_stat_activity WHERE usename = $1 AND state = 'active'",
    [WORKSPACE_READER_ROLE]
  );
  return result.rows[0]?.active ?? 0;
}

async function docCount(): Promise<number> {
  const result = await getDb().query<{ n: number }>('SELECT count(*)::int AS n FROM public.docs');
  return result.rows[0]?.n ?? 0;
}

describe('database_query sandbox (real DB, snaglet_workspace_reader)', () => {
  beforeAll(async () => {
    const db = getDb();
    await db.query("INSERT INTO public.nodes (id, type) VALUES ($1, 'doc')", [DOC_ID]);
    await db.query('INSERT INTO public.docs (id, title, content) VALUES ($1, $2, $3)', [
      DOC_ID,
      'Test Doc',
      LONG_CONTENT,
    ]);
    await db.query(
      `INSERT INTO public.users (id, email, name, auth_provider_id)
       VALUES ('user-test-a', 'user@example.com', 'Test User', 'test-provider-subject')`
    );
    await db.query(
      "INSERT INTO public.mcp_api_keys (member_id, name, key_hash) VALUES ('ghost', 'test key', 'test-key-hash')"
    );
    await db.query(
      `INSERT INTO public.user_provider_credentials (id, provider_id, auth_type, label, encrypted_secret)
       SELECT 'credential-test-a', id, 'api_key', 'Test Credential', 'test-ciphertext'
         FROM public.providers ORDER BY id LIMIT 1`
    );
    await db.query(
      'CREATE TABLE user_tables.workspace_query_probe (id int PRIMARY KEY, label text)'
    );
    await db.query("INSERT INTO user_tables.workspace_query_probe VALUES (1, 'custom row')");
    await provisionWorkspaceReaderRole(await getDbClient(), {
      password: readerPassword,
      database: database as string,
      revokePublic: true,
    });
  }, 60_000);

  afterAll(async () => {
    const db = getDb();
    await db.query('DROP TABLE IF EXISTS user_tables.workspace_query_probe');
    await db.query("DELETE FROM public.user_provider_credentials WHERE id = 'credential-test-a'");
    await db.query("DELETE FROM public.mcp_api_keys WHERE name = 'test key'");
    await db.query("DELETE FROM public.users WHERE id = 'user-test-a'");
    await db.query('DELETE FROM public.nodes WHERE id = $1', [DOC_ID]);
  });

  describe('(a) workspace reads', () => {
    it('runs as the reader for both current and session user', async () => {
      const output = await run('select current_user as who, session_user as session');
      expect(output).toBe(
        `who | session\n----+--------\n${WORKSPACE_READER_ROLE} | ${WORKSPACE_READER_ROLE}`
      );
    });

    it('reads docs joined to nodes, agents, and the visible columns of restricted tables', async () => {
      const docs = await run(
        `SELECT d.id, d.title, n.type FROM docs d JOIN nodes n ON n.id = d.id WHERE d.id = '${DOC_ID}'`
      );
      expect(docs).toContain(`${DOC_ID} | Test Doc | doc`);
      expect(await run("SELECT name, role FROM agents WHERE id = 'ghost'")).toContain(
        'ghost | System'
      );
      expect(await run("SELECT email, name FROM users WHERE id = 'user-test-a'")).toContain(
        'user@example.com | Test User'
      );
      expect(
        await run('SELECT count(*) >= 0 AS ok FROM mcp_servers WHERE enabled IS NOT NULL')
      ).toBe('ok\n--\ntrue');
      await expect(run('SELECT id, name, transport FROM mcp_servers LIMIT 1')).resolves.toEqual(
        expect.any(String)
      );
    });

    it('reads custom Database tables through the user_tables search path', async () => {
      expect(await run('SELECT id, label FROM workspace_query_probe')).toBe(
        'id | label\n---+------\n1 | custom row'
      );
      expect(await run('SELECT label FROM user_tables.workspace_query_probe')).toContain(
        'custom row'
      );
    });

    it('caps rows at limit+1 and cuts long cells in SQL', async () => {
      const capped = await run('SELECT n FROM generate_series(1, 150) AS n ORDER BY n');
      expect(capped.split('\n')).toHaveLength(2 + 100 + 2);
      expect(capped).toContain('(showing the first 100 rows; more matched');
      const limited = await run('SELECT n FROM generate_series(1, 10) AS n', { limit: 3 });
      expect(limited).toBe(
        'n\n-\n1\n2\n3\n\n(showing the first 3 rows; more matched — add WHERE/LIMIT or raise limit (max 500))'
      );
      const cut = await run(`SELECT content FROM docs WHERE id = '${DOC_ID}'`, {
        max_column_width: 10,
      });
      expect(cut).toContain(`${'y'.repeat(10)}…[+290 chars]`);
      const whole = await run(`SELECT content FROM docs WHERE id = '${DOC_ID}'`, {
        max_column_width: -1,
      });
      expect(whole).toContain(LONG_CONTENT);
      expect(await run("SELECT id FROM docs WHERE id = 'doc-missing'")).toBe('No rows returned.');
    });
  });

  describe('(b) secrets are denied', () => {
    it.each([
      ['SELECT * FROM mcp_api_keys'],
      ['SELECT key_hash FROM mcp_api_keys'],
      ['SELECT * FROM socket_sessions'],
      ['SELECT * FROM mcp_servers'],
      ['SELECT headers FROM mcp_servers'],
      ['SELECT env FROM mcp_servers'],
      ['SELECT name FROM mcp_servers WHERE url IS NOT NULL'],
      ['SELECT auth_provider_id FROM users'],
      ['SELECT * FROM users'],
    ])('%s', async (sql) => {
      const message = await refusal(sql);
      expect(message).toMatch(/permission denied/);
      expect(message).toContain('snaglet_workspace_reader');
    });

    it('refuses credential tables before PostgreSQL, and the role refuses them too', async () => {
      expect(await refusal('SELECT count(*) FROM user_provider_credentials')).toMatch(
        /Access denied: query references immutable table/
      );
      expect(
        await rawReaderCode('SELECT encrypted_secret FROM public.user_provider_credentials')
      ).toBe('42501');
      expect(await rawReaderCode('SELECT count(*) FROM public.provider_fallback_credentials')).toBe(
        '42501'
      );
      expect(await rawReaderCode('SELECT key_hash FROM public.mcp_api_keys')).toBe('42501');
    });

    it('leaks no hidden values through catalog statistics', async () => {
      await getDb().query('ANALYZE public.mcp_api_keys, public.users');
      expect(
        await run(
          "SELECT attname FROM pg_stats WHERE tablename IN ('mcp_api_keys', 'users') AND attname IN ('key_hash', 'auth_provider_id')"
        )
      ).toBe('No rows returned.');
    });
  });

  describe('(c) writes are denied', () => {
    it.each([
      [`INSERT INTO docs (id, title) VALUES ('${DOC_ID}', 'x')`],
      [`UPDATE docs SET title = 'x' WHERE id = '${DOC_ID}'`],
      [`DELETE FROM docs WHERE id = '${DOC_ID}'`],
      [`WITH gone AS (DELETE FROM docs WHERE id = '${DOC_ID}' RETURNING id) SELECT * FROM gone`],
      [`SELECT 1; DELETE FROM docs WHERE id = '${DOC_ID}'`],
      ['CREATE TABLE public.workspace_query_write (id int)'],
      ['TRUNCATE docs'],
    ])('%s', async (sql) => {
      expect(await refusal(sql)).toMatch(/database_query is read-only/);
    });

    it('is refused by PostgreSQL on a raw reader connection too', async () => {
      const before = await docCount();
      expect(['25006', '42501']).toContain(
        await rawReaderCode(`UPDATE public.docs SET title = 'x' WHERE id = '${DOC_ID}'`)
      );
      expect(['25006', '42501']).toContain(
        await rawReaderCode("INSERT INTO user_tables.workspace_query_probe VALUES (2, 'x')")
      );
      expect(['25006', '42501']).toContain(
        await rawReaderCode('CREATE TEMP TABLE workspace_query_temp (id int)')
      );
      expect(await docCount()).toBe(before);
    });
  });

  describe('(d) server-side file, program and escalation paths are denied', () => {
    it.each([
      ["SELECT pg_read_file('/etc/hosts')"],
      ["SELECT pg_read_binary_file('PG_VERSION')"],
      ["SELECT pg_ls_dir('.')"],
      ["SELECT pg_stat_file('PG_VERSION')"],
      ["SELECT lo_import('/etc/hosts')"],
      ["SELECT set_config('role', 'snaglet', true)"],
    ])('%s', async (sql) => {
      expect(await refusal(sql)).toMatch(/permission denied/);
    });

    it('refuses COPY … TO PROGRAM, SET ROLE and SET SESSION AUTHORIZATION', async () => {
      expect(await refusal("COPY (SELECT 1) TO PROGRAM 'true'")).toMatch(/read-only/);
      expect(await rawReaderCode("COPY (SELECT 1) TO PROGRAM 'true'")).toBe('42501');
      expect(await rawReaderCode('SET ROLE snaglet')).toBe('42501');
      expect(await rawReaderCode('SET SESSION AUTHORIZATION snaglet')).toBe('42501');
    });

    it('has no dblink to reach another session', async () => {
      expect(await refusal("SELECT dblink_connect('host=localhost')")).toMatch(
        /function dblink_connect\(unknown\) does not exist/
      );
    });
  });

  describe('(e) timeouts', () => {
    it('cancels a long statement server-side, even when it raises its own timeout', async () => {
      expect(await refusal('SELECT pg_sleep(20)')).toMatch(
        /statement timeout.*canceled after 5 seconds/
      );
      const overridden = await refusal(
        "SELECT set_config('statement_timeout', '0', true), pg_sleep(20)"
      );
      expect(overridden).toMatch(/statement timeout|canceled after 7 seconds/);

      const deadline = Date.now() + 3_000;
      let active = await readerBackendsActive();
      while (active > 0 && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 50));
        active = await readerBackendsActive();
      }
      expect(active).toBe(0);
    }, 40_000);
  });

  it('returns the typed refusal when no reader connection exists', async () => {
    expect(await WorkspaceQuery.select('select 1', {}, { reader: null })).toEqual({
      ok: false,
      code: 'unavailable',
      message: expect.stringContaining('SNAGLET_WORKSPACE_READER_URL'),
    });
  });
});
