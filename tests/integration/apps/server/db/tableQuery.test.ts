/**
 * TableQuery sandbox against the shared managed test cluster.
 *
 * The per-file database is reached in url mode, so the reader pool comes from
 * `SNAGLET_TABLES_READER_URL`, which this file points at its own database before
 * the first `getDbClient()` opens the app pool. The cluster-wide
 * `snaglet_tables_reader` role is provisioned idempotently with a password derived
 * from the run token, so every file in the run agrees on it and none drops it.
 */
import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import { getDb, getDbClient, getTablesReaderClient } from '@snaglet/db/db';
import {
  provisionTablesReaderRole,
  TABLES_READER_ROLE,
} from '@snaglet/db/runtime/postgres/runtime';
import { TableQuery, TableQueryError } from '@snaglet/db/tables/table_query';
import { loadTestClusterHandoff } from '../../../../support/pgTestCluster';

const handoff = loadTestClusterHandoff();
const database = process.env.SNAGLET_PG_TEST_DATABASE;
if (!database) throw new Error('Missing SNAGLET_PG_TEST_DATABASE');
const readerPassword = createHash('sha256')
  .update(`${TABLES_READER_ROLE}:${handoff.runToken}`)
  .digest('base64url');
{
  const url = new URL('postgresql://localhost');
  url.username = TABLES_READER_ROLE;
  url.password = readerPassword;
  url.pathname = `/${database}`;
  url.searchParams.set('host', handoff.host);
  url.port = String(handoff.port);
  url.searchParams.set('sslmode', 'disable');
  process.env.SNAGLET_TABLES_READER_URL = url.toString();
}

const LONG_NOTE = 'x'.repeat(300);

function pgCode(error: unknown): string | undefined {
  return (error as { code?: string }).code;
}

async function failure(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error: unknown) {
    return error;
  }
  throw new Error('Expected the query to fail');
}

async function readerBackendsActive(): Promise<number> {
  const result = await getDb().query<{ active: number }>(
    "SELECT count(*)::int AS active FROM pg_stat_activity WHERE usename = $1 AND state = 'active'",
    [TABLES_READER_ROLE]
  );
  return result.rows[0]?.active ?? 0;
}

describe('TableQuery sandbox (real DB, dedicated reader role)', () => {
  beforeAll(async () => {
    const db = getDb();
    await db.query(
      `CREATE TABLE user_tables.reader_probe (
         id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
         name text,
         note text
       )`
    );
    await db.query(
      `INSERT INTO user_tables.reader_probe (name, note) VALUES ('alpha', $1), ('beta', NULL), ('gamma', 'short')`,
      [LONG_NOTE]
    );
    // Late-bound SQL: the inner statements are planned as the current role at
    // execution time, which is the vector a superuser session could escalate.
    await db.query(
      `CREATE FUNCTION user_tables.late_bound() RETURNS text LANGUAGE plpgsql AS $f$
         DECLARE who text; n bigint;
         BEGIN
           EXECUTE 'select current_user' INTO who;
           EXECUTE 'select count(*) from public.user_provider_credentials' INTO n;
           RETURN who || ':' || n;
         END $f$`
    );
    await provisionTablesReaderRole(await getDbClient(), {
      password: readerPassword,
      database,
      revokePublic: true,
    });
    // Created after provisioning: covered by the schema's default privileges.
    await db.query('CREATE TABLE user_tables.reader_probe_late (id int PRIMARY KEY, label text)');
    await db.query("INSERT INTO user_tables.reader_probe_late VALUES (1, 'late')");
  }, 30_000);

  afterAll(async () => {
    const db = getDb();
    await db.query('DROP FUNCTION IF EXISTS user_tables.late_bound()');
    await db.query('DROP TABLE IF EXISTS user_tables.reader_probe, user_tables.reader_probe_late');
  });

  it('runs as the reader role for both current and session user', async () => {
    const result = await TableQuery.select('select current_user, session_user');
    expect(result).toEqual({
      ok: true,
      columns: ['current_user', 'session_user'],
      rows: [[TABLES_READER_ROLE, TABLES_READER_ROLE]],
      types: [['string', 'string']],
      capped: false,
    });
  });

  it('returns ordered columns, cuts long cells with the exact marker, and caps at limit+1', async () => {
    const capped = await TableQuery.select('select name, note from reader_probe order by name;', {
      limit: 2,
      maxCell: 40,
    });
    expect(capped).toEqual({
      ok: true,
      columns: ['name', 'note'],
      rows: [
        ['alpha', `${'x'.repeat(40)}…[+260 chars]`],
        ['beta', null],
      ],
      types: [
        ['string', 'string'],
        ['string', 'null'],
      ],
      capped: true,
    });

    const whole = await TableQuery.select('select name, note from reader_probe order by name', {
      limit: 3,
      maxCell: 400,
    });
    expect(whole).toMatchObject({ ok: true, capped: false });
    if (!whole.ok) throw new Error('unreachable');
    expect(whole.rows).toEqual([
      ['alpha', LONG_NOTE],
      ['beta', null],
      ['gamma', 'short'],
    ]);

    const empty = await TableQuery.select("select name from reader_probe where name = 'none'");
    expect(empty).toEqual({ ok: true, columns: [], rows: [], types: [], capped: false });
  });

  it('reads tables created after provisioning through default privileges', async () => {
    const result = await TableQuery.select('select id, label from reader_probe_late');
    expect(result).toEqual({
      ok: true,
      columns: ['id', 'label'],
      rows: [['1', 'late']],
      types: [['number', 'string']],
      capped: false,
    });
  });

  it("names each cell's JSON type beside text identical to json_each_text's", async () => {
    const sql =
      "select 'Done'::text as status, 2.50::numeric as phase, true as done, " +
      "null::date as due, date '2026-10-30' as day, array['a','b'] as tags, " +
      `'{"k": [1, 2]}'::jsonb as meta, '' as blank`;
    const result = await TableQuery.select(sql);
    expect(result).toEqual({
      ok: true,
      columns: ['status', 'phase', 'done', 'due', 'day', 'tags', 'meta', 'blank'],
      rows: [['Done', '2.50', 'true', null, '2026-10-30', '["a","b"]', '{"k": [1, 2]}', '']],
      types: [['string', 'number', 'boolean', 'null', 'string', 'array', 'object', 'string']],
      capped: false,
    });
    // The text matches json_each_text's output.
    const db = getDb();
    const { rows: legacy } = await db.query<{ value: string | null }>(
      `select value from json_each_text((select row_to_json(r) from (${sql}) r))`
    );
    expect(result.ok && result.rows[0]).toEqual(legacy.map((row) => row.value));
  });

  it('refuses non-SELECT statements, immutable tables and bad arguments before PostgreSQL', async () => {
    for (const sql of [
      "insert into reader_probe (name) values ('x')",
      'explain select 1',
      'SET SESSION AUTHORIZATION snaglet',
      'with gone as (delete from reader_probe returning 1) select * from gone',
      "select 1; delete from reader_probe where name = 'alpha'",
      '-- only a comment',
    ]) {
      const error = await failure(TableQuery.select(sql));
      expect(error).toBeInstanceOf(TableQueryError);
      expect((error as TableQueryError).code).toBe('not_a_select');
    }
    const immutable = await failure(
      TableQuery.select('select count(*) from public.user_provider_credentials')
    );
    expect((immutable as TableQueryError).code).toBe('immutable_table');
    const badLimit = await failure(TableQuery.select('select 1', { limit: 0 }));
    expect((badLimit as TableQueryError).code).toBe('invalid_argument');
    const badCell = await failure(TableQuery.select('select 1', { maxCell: 10 }));
    expect((badCell as TableQueryError).code).toBe('invalid_argument');
    expect(await readerBackendsActive()).toBe(0);
  });

  it('cannot climb back to the superuser: set_config(role), late-bound SQL, SET SESSION AUTHORIZATION', async () => {
    expect(
      pgCode(await failure(TableQuery.select("select set_config('role','snaglet',true)")))
    ).toBe('42501');
    expect(
      pgCode(
        await failure(
          TableQuery.select(
            "select set_config('role','snaglet',true) as reset, user_tables.late_bound() as late"
          )
        )
      )
    ).toBe('42501');
    expect(pgCode(await failure(TableQuery.select('select user_tables.late_bound()')))).toBe(
      '42501'
    );

    const reader = await getTablesReaderClient();
    expect(reader).not.toBeNull();
    const direct = await reader!.withConnection(async (connection) => ({
      sessionAuthorization: pgCode(
        await failure(connection.query('SET SESSION AUTHORIZATION snaglet'))
      ),
      setRole: pgCode(await failure(connection.query('SET ROLE snaglet'))),
    }));
    expect(direct).toEqual({ sessionAuthorization: '42501', setRole: '42501' });
  });

  it('is denied every read outside user_tables and every server-side file function', async () => {
    expect(pgCode(await failure(TableQuery.select('select count(*) from public.agents')))).toBe(
      '42501'
    );
    expect(pgCode(await failure(TableQuery.select("select pg_read_file('/etc/hosts')")))).toBe(
      '42501'
    );
    const reader = await getTablesReaderClient();
    const credentials = await reader!.withConnection(async (connection) =>
      pgCode(
        await failure(connection.query('select count(*) from public.user_provider_credentials'))
      )
    );
    expect(credentials).toBe('42501');
  });

  it('refuses stacked statements at the server through the extended protocol', async () => {
    expect(pgCode(await failure(TableQuery.select('select 1; select 2')))).toBe('42601');
  });

  it('cannot write: the pre-check refuses INSERT and the server refuses it on a raw connection', async () => {
    const reader = await getTablesReaderClient();
    const code = await reader!.withConnection(async (connection) =>
      pgCode(await failure(connection.query("insert into reader_probe (name) values ('probe')")))
    );
    expect(['25006', '42501']).toContain(code);
    const count = await getDb().query<{ n: number }>(
      'SELECT count(*)::int AS n FROM user_tables.reader_probe'
    );
    expect(count.rows[0]?.n).toBe(3);
  });

  it('cancels a long statement server-side, even when the statement raises its own timeout', async () => {
    const plain = await failure(TableQuery.select('select pg_sleep(20)'));
    expect(pgCode(plain)).toBe('57014');

    const overridden = await failure(
      TableQuery.select("select set_config('statement_timeout','0',true), pg_sleep(20)")
    );
    const code = pgCode(overridden);
    const message = (overridden as Error).message;
    expect(code === '57014' || message === 'Query read timeout').toBe(true);

    // Whichever ceiling fired, no reader backend is left running the sleep.
    const deadline = Date.now() + 3_000;
    let active = await readerBackendsActive();
    while (active > 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      active = await readerBackendsActive();
    }
    expect(active).toBe(0);
  }, 30_000);

  it('releases a session-level advisory lock before the connection returns to the pool', async () => {
    const taken = await TableQuery.select('select pg_advisory_lock(424242) as held');
    expect(taken).toMatchObject({ ok: true, rows: [['']] });
    const locks = await getDb().query<{ n: number }>(
      "SELECT count(*)::int AS n FROM pg_locks WHERE locktype = 'advisory' AND objid = 424242"
    );
    expect(locks.rows[0]?.n).toBe(0);
  });

  it('returns the typed refusal when no reader connection exists', async () => {
    const refused = await TableQuery.select('select 1', {}, { reader: null });
    expect(refused).toEqual({
      ok: false,
      code: 'unavailable',
      message: expect.stringContaining('SQL mode is unavailable'),
    });
  });
});
