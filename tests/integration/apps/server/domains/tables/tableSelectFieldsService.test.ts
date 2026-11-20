/**
 * Select fields over the REST routes the grid uses: create with options,
 * rename/remove by option id over PATCH, keep options when a PATCH leaves
 * them out, and the per-option usage counts a removal prompt shows.
 */
import { afterAll, beforeEach, describe, expect, it, jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';
import { getDb } from '@snaglet/db';
import { TableCatalog } from '@snaglet/db/tables/table_catalog';
import type { TableField } from '@snaglet/shared/types';

const emitTableFieldsChanged = jest.fn();
jest.mock('@server/realtime/surfaces/tables', () => ({
  emitTableHistoryChanged: jest.fn(),
  emitTableRemoved: jest.fn(),
  emitTableRestored: jest.fn(),
  emitTableCreated: jest.fn(),
  emitTableUpdated: jest.fn(),
  emitTableFieldsChanged: (...args: unknown[]) => emitTableFieldsChanged(...args),
  emitTableEntriesChanged: jest.fn(),
}));
import { createTable } from '@server/domains/tables/tableCatalog';
import tablesRouter from '@server/routes/tables';
import { errorHandler } from '@server/middleware/errorHandler';

const TABLE_ID = 'table-1111111111111-aaaaaaaaa';
const FIELD_ID = 'field-1111111111111-aaaaaaaaa';
const ROW_A = '11111111-1111-4111-8111-111111111111';
const ROW_B = '22222222-2222-4222-8222-222222222222';

function app(): express.Application {
  const value = express();
  value.use(express.json());
  value.use('/api/tables', tablesRouter);
  value.use(errorHandler);
  return value;
}

async function cleanup(): Promise<void> {
  for (const table of await TableCatalog.listTables({ origin: 'custom' }))
    await getDb().query(`DROP TABLE IF EXISTS user_tables."${table.tableName}" CASCADE`);
  await getDb().query('DELETE FROM public.table_fields');
  await getDb().query("DELETE FROM public.table_catalog WHERE origin = 'custom'");
}

async function statuses(): Promise<unknown[]> {
  const { rows } = await getDb().query<{ status: unknown }>(
    'SELECT status FROM user_tables.test_table ORDER BY id'
  );
  return rows.map((row) => row.status);
}

const create = {
  id: FIELD_ID,
  name: 'status',
  description: null,
  type: 'select',
  nullable: true,
  defaultValue: null,
  referenceTableId: null,
  options: [{ label: ' todo ' }, { label: 'doing', color: 'orange' }, { label: 'done' }],
};

describe('select fields API (real DB)', () => {
  beforeEach(async () => {
    await cleanup();
    await createTable({ id: TABLE_ID, name: 'test_table' });
    emitTableFieldsChanged.mockClear();
  });
  afterAll(cleanup);

  it('creates, renames and removes options over the field routes, and counts their use', async () => {
    const created = await request(app()).post(`/api/tables/${TABLE_ID}/fields`).send(create);
    expect(created.status).toBe(201);
    const field = created.body.data.field as TableField;
    expect(field).toMatchObject({ type: 'select', multiple: false, revision: 1 });
    expect(field.options?.map((option) => [option.label, option.color])).toEqual([
      ['todo', 'blue'],
      ['doing', 'orange'],
      ['done', 'green'],
    ]);
    await getDb().query(
      "INSERT INTO user_tables.test_table (id, status) VALUES ($1, 'todo'), ($2, 'done')",
      [ROW_A, ROW_B]
    );

    const usage = await request(app()).get(
      `/api/tables/${TABLE_ID}/fields/${FIELD_ID}/options/usage`
    );
    expect(usage.status).toBe(200);
    expect(usage.body.data).toEqual({
      usage: { [field.options![0]!.id]: 1, [field.options![1]!.id]: 0, [field.options![2]!.id]: 1 },
    });

    const [todo, doing] = field.options!;
    const edited = await request(app())
      .patch(`/api/tables/${TABLE_ID}/fields/${FIELD_ID}`)
      .send({
        ...create,
        options: [{ ...todo, label: 'backlog' }, doing, { label: 'blocked' }],
        expectedRevision: 1,
      });
    expect(edited.status).toBe(200);
    expect(edited.body.data.field.options).toEqual([
      { ...todo, label: 'backlog' },
      doing,
      { id: expect.stringMatching(/^opt-/), label: 'blocked', color: 'green' },
    ]);
    expect(await statuses()).toEqual(['backlog', null]);
    expect(emitTableFieldsChanged).toHaveBeenCalledTimes(2);

    // Leaving options out keeps them.
    const { options: _options, ...withoutOptions } = create;
    const described = await request(app())
      .patch(`/api/tables/${TABLE_ID}/fields/${FIELD_ID}`)
      .send({ ...withoutOptions, description: 'Where the work is.', expectedRevision: 2 });
    expect(described.status).toBe(200);
    expect(described.body.data.field.options).toEqual(edited.body.data.field.options);
  });

  it('answers malformed options with 400 and unknown or non-select fields on usage', async () => {
    const bad = await request(app())
      .post(`/api/tables/${TABLE_ID}/fields`)
      .send({ ...create, options: [{ label: 'a' }, { label: 'A' }] });
    expect(bad.status).toBe(400);
    expect(bad.body.error).toMatchObject({ message: 'The option "A" is listed twice.' });

    const missing = await request(app()).get(
      `/api/tables/${TABLE_ID}/fields/field-1111111111111-zzzzzzzzz/options/usage`
    );
    expect(missing.status).toBe(404);
    const title = await request(app()).get(
      `/api/tables/${TABLE_ID}/fields/field-title-${TABLE_ID}/options/usage`
    );
    expect(title.status).toBe(400);
  });
});
