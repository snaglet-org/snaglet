/**
 * queryAgentTables over a real reader connection. Like the TableQuery suite,
 * this file points `SNAGLET_TABLES_READER_URL` at its own database before the app
 * pool opens, and provisions the cluster-wide reader role idempotently.
 */
import { createHash } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it, jest } from '@jest/globals';
import { getDb, getDbClient } from '@snaglet/db/db';
import { quoteIdentifier } from '@snaglet/db/sql-utils';
import {
  provisionTablesReaderRole,
  TABLES_READER_ROLE,
} from '@snaglet/db/runtime/postgres/runtime';
import { TableCatalog } from '@snaglet/db/tables/table_catalog';
import {
  applyAgentSchema,
  queryAgentTables,
  writeAgentEntries,
} from '@server/domains/tables/tableAgent';
import { loadTestClusterHandoff } from '../../../../../support/pgTestCluster';

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

async function cleanup(): Promise<void> {
  for (const table of await TableCatalog.listTables({ origin: 'custom' }))
    await getDb().query(
      `DROP TABLE IF EXISTS user_tables.${quoteIdentifier(table.tableName)} CASCADE`
    );
  await getDb().query(
    "DELETE FROM public.table_fields WHERE table_id IN (SELECT id FROM public.table_catalog WHERE origin = 'custom')"
  );
  await getDb().query("DELETE FROM public.table_catalog WHERE origin = 'custom'");
}

describe('queryAgentTables (real DB, reader role)', () => {
  beforeAll(async () => {
    await cleanup();
    await provisionTablesReaderRole(await getDbClient(), {
      password: readerPassword,
      database,
      revokePublic: true,
    });
    await applyAgentSchema('agent_rows', { fields: [{ name: 'notes', type: 'text' }] });
    await writeAgentEntries('agent_rows', {
      insert: [
        { values: { name: 'alpha', notes: 'x'.repeat(100) } },
        { values: { name: 'beta' } },
        { values: { name: 'gamma' } },
      ],
    });
  }, 30_000);
  afterAll(cleanup);
  afterEach(() => jest.restoreAllMocks());

  it('returns columns, rows with cut cells, and whether the limit capped them', async () => {
    const result = await queryAgentTables('select name, notes from agent_rows order by name', {
      limit: 2,
      maxCell: 40,
    });
    expect(result).toEqual({
      columns: ['name', 'notes'],
      rows: [
        ['alpha', `${'x'.repeat(40)}…[+60 chars]`],
        ['beta', null],
      ],
      types: [
        ['string', 'string'],
        ['string', 'null'],
      ],
      capped: true,
    });
  });

  it('maps PostgreSQL refusals to a 400 carrying only the message', async () => {
    const syntax = await queryAgentTables('select from where', { limit: 5, maxCell: 100 }).catch(
      (error: unknown) => error
    );
    expect(syntax).toMatchObject({
      statusCode: 400,
      message: expect.stringContaining('syntax error'),
      details: { sqlState: '42601' },
    });
    expect((syntax as Error).message).not.toContain('\n    at ');
    await expect(
      queryAgentTables('select * from public.table_catalog', { limit: 5, maxCell: 100 })
    ).rejects.toMatchObject({
      statusCode: 400,
      message: expect.stringContaining('permission denied'),
      details: { sqlState: '42501' },
    });
  });

  it('reads datetimes back in the user zone with its offset, as agents wrote them', async () => {
    const resolved = Intl.DateTimeFormat.prototype.resolvedOptions;
    jest.spyOn(Intl.DateTimeFormat.prototype, 'resolvedOptions').mockImplementation(function (
      this: Intl.DateTimeFormat
    ) {
      return { ...resolved.call(this), timeZone: 'Pacific/Auckland' };
    });
    await applyAgentSchema('agent_rows', {
      ops: [{ op: 'add_field', field: { name: 'due_at', type: 'datetime' } }],
    });
    await writeAgentEntries('agent_rows', {
      insert: [
        { values: { name: 'local', due_at: '2026-10-01T15:30' } },
        { values: { name: 'utc', due_at: '2026-10-01T22:30:00Z' } },
      ],
    });
    const result = await queryAgentTables(
      "select name, due_at, due_at::date as day from agent_rows where name in ('local', 'utc') order by name",
      { limit: 5, maxCell: 100 }
    );
    expect(result.rows).toEqual([
      ['local', '2026-10-01T15:30:00+13:00', '2026-10-01'],
      // 22:30Z is already the next morning in Auckland.
      ['utc', '2026-10-02T11:30:00+13:00', '2026-10-02'],
    ]);
  });

  it('filters selects by label and multi-selects with ANY', async () => {
    await applyAgentSchema('agent_tasks', {
      fields: [
        { name: 'status', type: 'select', options: ['todo', 'done'] },
        { name: 'tags', type: 'select', multiple: true, options: ['urgent', 'later'] },
      ],
    });
    await writeAgentEntries('agent_tasks', {
      insert: [
        { values: { name: 'first', status: 'todo', tags: ['urgent', 'later'] } },
        { values: { name: 'second', status: 'done' } },
        { values: { name: 'third', tags: ['later'] } },
      ],
    });
    const result = await queryAgentTables(
      "select name, tags from agent_tasks where status = 'done' or 'urgent' = any(tags) order by name",
      { limit: 5, maxCell: 100 }
    );
    expect(result.rows).toEqual([
      ['first', '["urgent","later"]'],
      ['second', '[]'],
    ]);
  });

  it('maps a statement timeout to a short hint', async () => {
    await expect(
      queryAgentTables('select pg_sleep(6)', { limit: 1, maxCell: 100 })
    ).rejects.toMatchObject({ statusCode: 400, message: 'query took longer than 5s; narrow it' });
  }, 20_000);
});
