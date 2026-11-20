/**
 * Manual table order against the real database: a new custom table lands at
 * the bottom of the workspace-wide list; `updateTablePlacement` and
 * `PATCH /api/tables/:id { sortOrder }` put a table at a slot, shift the live
 * custom tables at or after it, and announce every moved table with
 * `table.updated` (so a client store stays in order without a refetch); a
 * project change without a slot lands at the bottom; built-ins, archived and
 * unknown tables and malformed slots are refused; and placement is never an
 * undo step.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';
import { Containers, getDb } from '@snaglet/db';
import { TableCatalog } from '@snaglet/db/tables/table_catalog';
import type { TableCatalogEntry } from '@snaglet/shared/types';
import type { AppError } from '@snaglet/shared/utils';

const emitTableUpdated = jest.fn<(table: TableCatalogEntry) => void>();
jest.mock('@server/realtime/surfaces/tables', () => ({
  emitTableCreated: jest.fn(),
  emitTableFieldsChanged: jest.fn(),
  emitTableEntriesChanged: jest.fn(),
  emitTableHistoryChanged: jest.fn(),
  emitTableRemoved: jest.fn(),
  emitTableRestored: jest.fn(),
  emitTableUpdated: (table: TableCatalogEntry) => emitTableUpdated(table),
}));

import { createTable, listTables, updateTablePlacement } from '@server/domains/tables/tableCatalog';
import { archiveTable } from '@server/domains/tables/tableLifecycle';
import tablesRouter from '@server/routes/tables';
import { errorHandler } from '@server/middleware/errorHandler';

const PROJECT = 'container-5555555555555-project1';
const TABLE_A = 'table-5555555555555-aaaaaaaaa';
const TABLE_B = 'table-5555555555555-bbbbbbbbb';
const TABLE_C = 'table-5555555555555-ccccccccc';
const TABLE_D = 'table-5555555555555-ddddddddd';
const MISSING_TABLE = 'table-5555555555555-zzzzzzzzz';
const TABLES = [TABLE_A, TABLE_B, TABLE_C, TABLE_D];

function app(): express.Application {
  const server = express();
  server.use(express.json());
  server.use('/api/tables', tablesRouter);
  server.use(errorHandler);
  return server;
}

async function caught(run: () => Promise<unknown>): Promise<AppError | undefined> {
  try {
    await run();
  } catch (err) {
    return err as AppError;
  }
  return undefined;
}

async function historySteps(): Promise<number> {
  const { rows } = await getDb().query<{ n: number }>(
    'SELECT count(*)::int AS n FROM public.table_history'
  );
  return rows[0]?.n ?? -1;
}

/** Our custom tables in one list, in the order the server lists them. */
async function order(projectId: string | 'none'): Promise<string[]> {
  return (await listTables({ origin: 'custom', projectId }))
    .map((table) => table.id)
    .filter((id) => TABLES.includes(id));
}

async function slotOf(id: string): Promise<number | undefined> {
  return (await TableCatalog.findById(id))?.sortOrder;
}

async function cleanup(): Promise<void> {
  const db = getDb();
  for (const id of TABLES) {
    const row = await TableCatalog.findById(id);
    if (row) await db.query(`DROP TABLE IF EXISTS user_tables."${row.tableName}" CASCADE`);
  }
  await db.query('DELETE FROM public.table_fields WHERE table_id = ANY($1::text[])', [TABLES]);
  await db.query('DELETE FROM public.table_history');
  await db.query('DELETE FROM public.table_catalog WHERE id = ANY($1::text[])', [TABLES]);
  await db.query('DELETE FROM public.nodes WHERE id = $1', [PROJECT]);
}

beforeAll(async () => {
  await cleanup();
  await Containers.create({ id: PROJECT, name: 'Placement project', category: 'project' });
  await createTable({ id: TABLE_A, name: 'placed_zeta' });
  await createTable({ id: TABLE_B, name: 'placed_alpha' });
  await createTable({ id: TABLE_C, name: 'placed_mid' });
});

describe('table placement (real DB)', () => {
  // Nested on purpose: a file-level afterAll runs after the shared database
  // teardown has already closed the pool.
  afterAll(cleanup);

  beforeEach(() => {
    emitTableUpdated.mockClear();
  });

  it('lands each new table at the bottom of the workspace-wide list', async () => {
    // Creation order, not name order.
    expect(await order('none')).toEqual([TABLE_A, TABLE_B, TABLE_C]);
    const [a, b, c] = await Promise.all(TABLES.slice(0, 3).map(slotOf));
    expect(b).toBe((a ?? 0) + 1);
    expect(c).toBe((b ?? 0) + 1);
  });

  it('puts a table at a slot and announces it and every table it shifted', async () => {
    const steps = await historySteps();
    const top = (await slotOf(TABLE_A)) ?? -1;
    const placed = await updateTablePlacement(TABLE_C, { sortOrder: top });
    expect(placed).toMatchObject({ id: TABLE_C, sortOrder: top, projectId: null });
    expect(await order('none')).toEqual([TABLE_C, TABLE_A, TABLE_B]);

    expect(emitTableUpdated).toHaveBeenCalledTimes(3);
    expect(emitTableUpdated.mock.calls.map(([table]) => [table.id, table.sortOrder])).toEqual([
      [TABLE_C, top],
      [TABLE_A, top + 1],
      [TABLE_B, top + 2],
    ]);
    expect(await historySteps()).toBe(steps);
  });

  it('reorders through PATCH { sortOrder }', async () => {
    const last = ((await slotOf(TABLE_B)) ?? 0) + 1;
    const response = await request(app()).patch(`/api/tables/${TABLE_C}`).send({ sortOrder: last });
    expect(response.status).toBe(200);
    expect(response.body.data.table).toMatchObject({ id: TABLE_C, sortOrder: last });
    expect(await order('none')).toEqual([TABLE_A, TABLE_B, TABLE_C]);
    // Nothing sat at or after the bottom slot: only the table itself moved.
    expect(emitTableUpdated).toHaveBeenCalledTimes(1);
  });

  it('moves into a project at the bottom, or at a slot with the rest shifted', async () => {
    const first = await request(app()).patch(`/api/tables/${TABLE_A}`).send({ projectId: PROJECT });
    expect(first.status).toBe(200);
    expect(first.body.data.table).toMatchObject({ projectId: PROJECT, sortOrder: 0 });
    const second = await updateTablePlacement(TABLE_B, { projectId: PROJECT });
    expect(second.sortOrder).toBe(1);
    expect(await order(PROJECT)).toEqual([TABLE_A, TABLE_B]);
    expect(emitTableUpdated).toHaveBeenCalledTimes(2);

    emitTableUpdated.mockClear();
    const top = await request(app())
      .patch(`/api/tables/${TABLE_C}`)
      .send({ projectId: PROJECT, sortOrder: 0 });
    expect(top.status).toBe(200);
    expect(await order(PROJECT)).toEqual([TABLE_C, TABLE_A, TABLE_B]);
    expect(await order('none')).toEqual([]);
    expect(emitTableUpdated.mock.calls.map(([table]) => table.id)).toEqual([
      TABLE_C,
      TABLE_A,
      TABLE_B,
    ]);
  });

  it('places and renames in one body, placement checked first', async () => {
    const both = await request(app())
      .patch(`/api/tables/${TABLE_B}`)
      .send({ name: 'placed_beta', expectedName: 'placed_alpha', sortOrder: 0 });
    expect(both.status).toBe(200);
    expect(both.body.data.table).toMatchObject({ name: 'placed_beta', sortOrder: 0 });
    expect(await order(PROJECT)).toEqual([TABLE_B, TABLE_C, TABLE_A]);

    const refused = await request(app())
      .patch(`/api/tables/${TABLE_B}`)
      .send({ name: 'placed_never', expectedName: 'placed_beta', sortOrder: -1 });
    expect(refused.status).toBe(400);
    expect((await TableCatalog.findById(TABLE_B))?.name).toBe('placed_beta');
  });

  it('refuses built-ins, archived, unknown and empty placements, and malformed slots', async () => {
    await createTable({ id: TABLE_D, name: 'placed_archived' });
    await archiveTable(TABLE_D);
    emitTableUpdated.mockClear();

    const builtin = await caught(() =>
      updateTablePlacement('table-builtin-docs', { sortOrder: 1 })
    );
    expect(builtin?.statusCode).toBe(400);
    expect(builtin?.message).toContain('built-in order');
    expect((await caught(() => updateTablePlacement(TABLE_D, { sortOrder: 0 })))?.statusCode).toBe(
      409
    );
    expect(
      (await caught(() => updateTablePlacement(MISSING_TABLE, { sortOrder: 0 })))?.statusCode
    ).toBe(404);
    expect((await caught(() => updateTablePlacement(TABLE_A, {})))?.statusCode).toBe(400);

    for (const sortOrder of [-1, 2.5, '1', null]) {
      const response = await request(app()).patch(`/api/tables/${TABLE_A}`).send({ sortOrder });
      expect({ sortOrder, status: response.status }).toEqual({ sortOrder, status: 400 });
    }
    const builtinPatch = await request(app())
      .patch('/api/tables/table-builtin-docs')
      .send({ sortOrder: 0 });
    expect(builtinPatch.status).toBe(400);

    expect(emitTableUpdated).not.toHaveBeenCalled();
    expect((await TableCatalog.findById('table-builtin-docs'))?.sortOrder).toBe(0);
  });
});
