/**
 * Integration tests for /api/db (real DB).
 *
 * The only route is GET /api/db/stats: Settings → Data → Backups shows the
 * database size and table count from it. There is no raw table browser and no
 * admin write (create table, add or drop a column, insert or delete rows):
 * those paths reach the JSON 404 and change nothing.
 */
import { afterAll, beforeAll, describe, expect, it, jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';
import { getDb, quoteIdentifier, TableCatalog } from '@snaglet/db';
import type { DbStatsResponse } from '@snaglet/shared/types';

jest.mock('@server/realtime/surfaces/tables', () => ({
  emitTableHistoryChanged: jest.fn(),
  emitTableRemoved: jest.fn(),
  emitTableRestored: jest.fn(),
  emitTableCreated: jest.fn(),
  emitTableUpdated: jest.fn(),
  emitTableFieldsChanged: jest.fn(),
  emitTableEntriesChanged: jest.fn(),
}));
import { createTable } from '@server/domains/tables/tableCatalog';
import dbRouter from '@server/routes/db';
import { errorHandler, notFoundHandler } from '@server/middleware';

const TABLE_ID = 'table-1111111111111-dbroutestats';
/** A public table name the removed create-table route must not create. */
const PROBE_TABLE = 'db_route_removed_probe';

let customRef: string;

/** Mounted like apps/server/src/index.ts: the /api catch-all answers misses. */
function app(): express.Application {
  const result = express();
  result.use(express.json());
  result.use('/api/db', dbRouter);
  result.use('/api', notFoundHandler);
  result.use(errorHandler);
  return result;
}

async function clean(): Promise<void> {
  const table = await TableCatalog.findById(TABLE_ID);
  if (table)
    await getDb().query(
      `DROP TABLE IF EXISTS user_tables.${quoteIdentifier(table.tableName)} CASCADE`
    );
  await getDb().query('DELETE FROM public.table_fields WHERE table_id=$1', [TABLE_ID]);
  await getDb().query('DELETE FROM public.table_catalog WHERE id=$1', [TABLE_ID]);
  await getDb().query(`DROP TABLE IF EXISTS public.${quoteIdentifier(PROBE_TABLE)}`);
}

async function publicTableExists(name: string): Promise<boolean> {
  const { rows } = await getDb().query<{ exists: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name = $1
     ) AS exists`,
    [name]
  );
  return rows[0]?.exists === true;
}

async function customTableShape(): Promise<{ columns: string[]; rows: number }> {
  const [schema, name] = customRef.split('.') as [string, string];
  const { rows: columns } = await getDb().query<{ column_name: string }>(
    `SELECT column_name FROM information_schema.columns
      WHERE table_schema = $1 AND table_name = $2
      ORDER BY ordinal_position`,
    [schema, name]
  );
  const { rows: count } = await getDb().query<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM ${quoteIdentifier(schema)}.${quoteIdentifier(name)}`
  );
  return {
    columns: columns.map((column) => column.column_name),
    rows: Number(count[0]?.count ?? 0),
  };
}

describe('/api/db (real DB)', () => {
  beforeAll(async () => {
    await clean();
    await createTable({ id: TABLE_ID, name: 'db_route_stats' });
    const table = await TableCatalog.findById(TABLE_ID);
    if (!table) throw new Error('Missing test table');
    customRef = `user_tables.${table.tableName}`;
  });
  afterAll(clean);

  it('reports the database size and every table size, custom tables by qualified name', async () => {
    const res = await request(app()).get('/api/db/stats');
    expect(res.status).toBe(200);
    const body = res.body as DbStatsResponse;
    expect(body.database_size).toMatch(/^\d+(\.\d+)? (bytes|kB|MB|GB|TB)$/);
    const sizes = {
      total_size: expect.any(String),
      table_size: expect.any(String),
      indexes_size: expect.any(String),
    };
    expect(body.tables).toContainEqual({ table_name: customRef, ...sizes });
    expect(body.tables).toContainEqual({ table_name: 'table_catalog', ...sizes });
  });

  it.each([
    ['GET', '/api/db/tables'],
    ['GET', '/api/db/schema'],
    ['POST', '/api/db/tables'],
    ['GET', '/api/db/tables/agents'],
    ['POST', '/api/db/tables/agents/columns'],
    ['DELETE', '/api/db/tables/agents/columns/name'],
    ['POST', '/api/db/tables/agents/rows'],
    ['DELETE', '/api/db/tables/agents/rows'],
  ] as const)('%s %s is gone', async (method, path) => {
    const agent = request(app());
    const res = await (method === 'GET'
      ? agent.get(path)
      : method === 'POST'
        ? agent.post(path).send({})
        : agent.delete(path).send({}));
    expect(res.status).toBe(404);
    // The catch-all is mounted at /api, so it names the path below that.
    expect(res.body).toEqual({
      success: false,
      error: { code: 'NOT_FOUND', message: `Route ${method} ${path.slice(4)} not found` },
    });
  });

  it('creates, alters, inserts and deletes nothing through the removed write paths', async () => {
    const before = await customTableShape();
    const path = `/api/db/tables/${encodeURIComponent(customRef)}`;
    const writes = [
      request(app())
        .post('/api/db/tables')
        .send({ name: PROBE_TABLE, columns: [{ name: 'note', type: 'text' }] }),
      request(app()).post(`${path}/columns`).send({ name: 'extra', type: 'text' }),
      request(app()).delete(`${path}/columns/name`),
      request(app()).post(`${path}/rows`).send({ name: 'Inserted' }),
      request(app())
        .delete(`${path}/rows`)
        .send({ column: 'id', values: ['11111111-1111-4111-8111-111111111111'] }),
    ];
    for (const res of await Promise.all(writes)) expect(res.status).toBe(404);

    expect(await publicTableExists(PROBE_TABLE)).toBe(false);
    expect(await customTableShape()).toEqual(before);
  });
});
