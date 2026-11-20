/**
 * Database table service against the real database: custom-table creation
 * (one `user_tables` table named exactly like the table + one catalog row per
 * create, in one transaction),
 * idempotent replay, name / id conflicts, input validation, concurrent
 * duplicate submits, the `table.created` emit (only on real creation), and
 * metadata-only detail reads — including the credentials builtin, whose
 * values must never appear.
 */

import { afterAll, beforeEach, describe, expect, it, jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';
import { getDb } from '@snaglet/db';
import { TableCatalog } from '@snaglet/db/tables/table_catalog';
import type { AppError } from '@snaglet/shared/utils';

const emitTableCreated = jest.fn();
jest.mock('@server/realtime/surfaces/tables', () => ({
  emitTableHistoryChanged: jest.fn(),
  emitTableRemoved: jest.fn(),
  emitTableRestored: jest.fn(),
  emitTableCreated: (...args: unknown[]) => emitTableCreated(...args),
}));

import { createTable, getTableDetail, listTables } from '@server/domains/tables/tableCatalog';
import tablesRouter from '@server/routes/tables';
import { errorHandler } from '@server/middleware/errorHandler';

const ID_A = 'table-1111111111111-aaaaaaaaa';
const ID_B = 'table-1111111111111-bbbbbbbbb';
const ID_C = 'table-1111111111111-ccccccccc';
const ID_D = 'table-1111111111111-ddddddddd';
const ID_E = 'table-1111111111111-eeeeeeeee';
const CREDENTIAL_ID = 'credential-test-table-detail';
const CREDENTIAL_SECRET = 'test-secret-value-never-returned';

async function customPhysicalTables(): Promise<string[]> {
  const { rows } = await getDb().query<{ tablename: string }>(
    `SELECT tablename FROM pg_tables WHERE schemaname = 'user_tables' ORDER BY tablename`
  );
  return rows.map((row) => row.tablename);
}

async function customRowCount(): Promise<number> {
  const { rows } = await getDb().query<{ n: number }>(
    `SELECT count(*)::int AS n FROM public.table_catalog WHERE origin = 'custom'`
  );
  return rows[0]?.n ?? 0;
}

async function statusOf(run: () => Promise<unknown>): Promise<number | undefined> {
  try {
    await run();
  } catch (err) {
    return (err as AppError).statusCode;
  }
  return undefined;
}

describe('table catalog service (real DB)', () => {
  beforeEach(() => {
    emitTableCreated.mockClear();
  });

  afterAll(async () => {
    const custom = await TableCatalog.listTables({ origin: 'custom' });
    for (const row of custom) {
      await getDb().query(`DROP TABLE IF EXISTS user_tables."${row.tableName}"`);
    }
    await getDb().query(`DELETE FROM public.table_catalog WHERE origin = 'custom'`);
    await getDb().query('DELETE FROM public.user_provider_credentials WHERE id = $1', [
      CREDENTIAL_ID,
    ]);
  });

  it('creates exactly one user_tables table and one catalog row, then emits once', async () => {
    const tablesBefore = await customPhysicalTables();
    const result = await createTable({ id: ID_A, name: '  test_table  ' });

    expect(result.created).toBe(true);
    expect(result.table).toEqual({
      id: ID_A,
      name: 'test_table',
      origin: 'custom',
      projectId: null,
      sortOrder: expect.any(Number),
      createdAt: expect.any(String),
    });
    const tablesAfter = await customPhysicalTables();
    expect(tablesAfter).toHaveLength(tablesBefore.length + 1);
    const row = await TableCatalog.findById(ID_A);
    // The table's name is its real physical name.
    expect(row?.tableName).toBe('test_table');
    expect(tablesAfter).toContain('test_table');
    expect(await customRowCount()).toBe(1);
    expect(emitTableCreated).toHaveBeenCalledTimes(1);
    expect(emitTableCreated).toHaveBeenCalledWith(result.table);
  });

  it('replays the same id + name idempotently without a second table or emit', async () => {
    const tablesBefore = await customPhysicalTables();
    const first = await TableCatalog.findById(ID_A);
    const replay = await createTable({ id: ID_A, name: 'test_table' });

    expect(replay.created).toBe(false);
    expect(replay.table).toEqual({
      id: ID_A,
      name: 'test_table',
      origin: 'custom',
      projectId: null,
      sortOrder: first?.sortOrder,
      createdAt: first?.createdAt,
    });
    expect(await customPhysicalTables()).toEqual(tablesBefore);
    expect(emitTableCreated).not.toHaveBeenCalled();
  });

  it('409s the same id with a different name and a name already taken by any table', async () => {
    expect(await statusOf(() => createTable({ id: ID_A, name: 'other_name' }))).toBe(409);
    expect(await statusOf(() => createTable({ id: ID_B, name: 'test_table' }))).toBe(409);
    // Builtin display names are taken case-insensitively (`Docs`, `Agents`).
    expect(await statusOf(() => createTable({ id: ID_B, name: 'docs' }))).toBe(409);
    await expect(createTable({ id: ID_B, name: 'agents' })).rejects.toThrow(
      'A table named "agents" already exists'
    );
    expect(await TableCatalog.findById(ID_B)).toBeNull();
    expect(emitTableCreated).not.toHaveBeenCalled();
  });

  it('400s invalid ids and names without writing tables or catalog rows', async () => {
    const tablesBefore = await customPhysicalTables();
    const catalogBefore = await customRowCount();
    const invalid: Array<{ id: unknown; name: unknown }> = [
      { id: 'table-builtin-docs', name: 'Valid' },
      { id: 'doc-1111111111111-aaaaaaaaa', name: 'Valid' },
      { id: 'table-123-abc', name: 'Valid' },
      { id: 42, name: 'Valid' },
      { id: ID_B, name: '   ' },
      { id: ID_B, name: 'x'.repeat(64) },
      { id: ID_B, name: 'Line\nBreak' },
      { id: ID_B, name: 'Tasks & Ideas' },
      { id: ID_B, name: 'Test-Table' },
      { id: ID_B, name: 'Test.Table' },
      { id: ID_B, name: 'Tasks 😀' },
      { id: ID_B, name: 'Café' },
      { id: ID_B, name: '___' },
      { id: ID_B, name: '2026 Projects' },
      { id: ID_B, name: 'Test Table' },
      { id: ID_B, name: 'Work_Experience' },
      { id: ID_B, name: '_leading' },
      { id: ID_B, name: 'order' },
      { id: ID_B, name: 7 },
    ];
    for (const input of invalid) {
      expect({
        input,
        status: await statusOf(() => createTable(input as { id: string; name: string })),
      }).toEqual({ input, status: 400 });
    }
    expect(await customPhysicalTables()).toEqual(tablesBefore);
    expect(await customRowCount()).toBe(catalogBefore);
    expect(emitTableCreated).not.toHaveBeenCalled();
  });

  it('accepts a 63-character name', async () => {
    const name = 'n'.repeat(63);
    const result = await createTable({ id: ID_E, name });
    expect(result).toMatchObject({ created: true, table: { name } });
  });

  it('resolves concurrent creates of one id to exactly one table', async () => {
    const tablesBefore = await customPhysicalTables();
    const results = await Promise.all([
      createTable({ id: ID_C, name: 'concurrent_table' }),
      createTable({ id: ID_C, name: 'concurrent_table' }),
      createTable({ id: ID_C, name: 'concurrent_table' }),
    ]);

    expect(results.filter((result) => result.created)).toHaveLength(1);
    expect(new Set(results.map((result) => JSON.stringify(result.table))).size).toBe(1);
    expect(await customPhysicalTables()).toHaveLength(tablesBefore.length + 1);
    expect(emitTableCreated).toHaveBeenCalledTimes(1);
  });

  it('rolls back the losing physical table when the id insert races and replays the winner', async () => {
    const tablesBefore = await customPhysicalTables();
    // Simulate losing the race: the pre-check misses the committed row, so the
    // insert hits the primary key after this create's CREATE TABLE ran.
    const idCheck = jest.spyOn(TableCatalog, 'findById').mockResolvedValueOnce(null);
    const nameCheck = jest.spyOn(TableCatalog, 'findByName').mockResolvedValueOnce(null);
    try {
      const result = await createTable({ id: ID_A, name: 'test_table' });
      expect(result.created).toBe(false);
      expect(result.table.id).toBe(ID_A);
    } finally {
      idCheck.mockRestore();
      nameCheck.mockRestore();
    }
    expect(await customPhysicalTables()).toEqual(tablesBefore);
    expect(emitTableCreated).not.toHaveBeenCalled();
  });

  it('treats a same-id row committed between the pre-checks as a replay, not a name clash', async () => {
    const idCheck = jest.spyOn(TableCatalog, 'findById').mockResolvedValueOnce(null);
    try {
      const result = await createTable({ id: ID_A, name: 'test_table' });
      expect(result).toMatchObject({ created: false, table: { id: ID_A } });
    } finally {
      idCheck.mockRestore();
    }
  });

  it('lets exactly one of two concurrent same-name creates win', async () => {
    const settled = await Promise.allSettled([
      createTable({ id: ID_D, name: 'race_name' }),
      createTable({ id: ID_B, name: 'race_name' }),
    ]);
    const fulfilled = settled.filter((entry) => entry.status === 'fulfilled');
    const rejected = settled.filter(
      (entry): entry is PromiseRejectedResult => entry.status === 'rejected'
    );
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0]?.reason as AppError).statusCode).toBe(409);
  });

  it('lists entries without physical names, filtered by origin', async () => {
    const custom = await listTables({ origin: 'custom' });
    expect(custom.map((entry) => entry.id).sort()).toEqual(
      [ID_A, ID_C, ID_E, ...((await TableCatalog.findById(ID_D)) ? [ID_D] : [ID_B])].sort()
    );
    for (const entry of await listTables()) {
      expect(Object.keys(entry).sort()).toEqual([
        'createdAt',
        'id',
        'name',
        'origin',
        'projectId',
        'sortOrder',
      ]);
    }
    expect(
      (await listTables({ origin: 'builtin' })).every((entry) => entry.origin === 'builtin')
    ).toBe(true);
  });

  it('describes a custom table: managed columns, the Name column and a row count, never rows', async () => {
    const detail = await getTableDetail(ID_A);
    expect(Object.keys(detail).sort()).toEqual(['columns', 'rowCount', 'table']);
    expect(detail.table).toMatchObject({ id: ID_A, name: 'test_table', origin: 'custom' });
    expect(detail.columns).toEqual([
      { name: 'id', dataType: 'uuid', nullable: false, managed: true },
      { name: 'created_at', dataType: 'timestamp with time zone', nullable: false, managed: true },
      { name: 'name', dataType: 'text', nullable: false, managed: false },
    ]);
    expect(detail.rowCount).toBe(0);

    const row = await TableCatalog.findById(ID_A);
    await getDb().query(`INSERT INTO user_tables."${row?.tableName}" DEFAULT VALUES`);
    await getDb().query(`INSERT INTO user_tables."${row?.tableName}" DEFAULT VALUES`);
    expect((await getTableDetail(ID_A)).rowCount).toBe(2);
  });

  it('describes a builtin table with unmanaged columns', async () => {
    const detail = await getTableDetail('table-builtin-docs');
    expect(detail.table.origin).toBe('builtin');
    expect(detail.columns.length).toBeGreaterThan(0);
    expect(detail.columns.some((column) => column.managed)).toBe(false);
    expect(detail.columns.map((column) => column.name)).toContain('title');
  });

  it('exposes only column metadata and a count for the credentials builtin', async () => {
    await getDb().query(
      `INSERT INTO public.user_provider_credentials (id, provider_id, auth_type, label, encrypted_secret)
       VALUES ($1, 'anthropic', 'api_key', 'Test Credential', $2)`,
      [CREDENTIAL_ID, CREDENTIAL_SECRET]
    );
    const detail = await getTableDetail('table-builtin-credentials');
    expect(detail.columns.map((column) => column.name)).toContain('encrypted_secret');
    expect(detail.rowCount).toBeGreaterThanOrEqual(1);
    const wire = JSON.stringify(detail);
    expect(wire).not.toContain(CREDENTIAL_SECRET);
    expect(wire).not.toContain('Test Credential');
    expect(wire).not.toContain('user_provider_credentials');
  });

  it('404s an unknown id', async () => {
    expect(await statusOf(() => getTableDetail('table-1111111111111-zzzzzzzzz'))).toBe(404);
  });

  it('names the physical table exactly like the table so SQL can use it directly', async () => {
    await getDb().query('INSERT INTO user_tables.test_table DEFAULT VALUES');
    const { rows } = await getDb().query<{ n: number }>(
      'SELECT count(*)::int AS n FROM user_tables.test_table'
    );
    expect(rows[0]?.n).toBe((await getTableDetail(ID_A)).rowCount);
  });

  it('enforces the naming policy over HTTP and creates a real table for a valid name', async () => {
    const app = express();
    app.use(express.json());
    app.use('/api/tables', tablesRouter);
    app.use(errorHandler);
    const id = 'table-1111111111111-hhhhhhhhh';
    const tablesBefore = await customPhysicalTables();
    const catalogBefore = await customRowCount();
    const invalid = await request(app).post('/api/tables').send({ id, name: 'Tasks & Ideas' });
    expect(invalid.status).toBe(400);
    expect(JSON.stringify(invalid.body)).toContain('Use only lowercase letters');
    expect(await customPhysicalTables()).toEqual(tablesBefore);
    expect(await customRowCount()).toBe(catalogBefore);
    expect(emitTableCreated).not.toHaveBeenCalled();

    const created = await request(app).post('/api/tables').send({ id, name: 'test_table_2026' });
    expect(created.status).toBe(201);
    expect(created.body.data.table.name).toBe('test_table_2026');
    expect(await customPhysicalTables()).toEqual([...tablesBefore, 'test_table_2026'].sort());
  });
});
