/**
 * Renaming custom Database tables against the real database: a rename is a
 * real rename — the physical `user_tables` table and its catalog row change
 * together (same id, data kept, key and index names untouched), built-ins are
 * refused, the shared naming policy and uniqueness (catalog names and stray
 * physical tables) apply, relations into the renamed table keep working, a
 * stale `expectedName` is a 409 carrying the current entry, and
 * `table.updated` is emitted only on a real change.
 */

import { afterAll, beforeEach, describe, expect, it, jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';
import { getDb, TableEntries, TableFields } from '@snaglet/db';
import { TableCatalog } from '@snaglet/db/tables/table_catalog';
import type { AppError } from '@snaglet/shared/utils';

const emitTableCreated = jest.fn();
const emitTableUpdated = jest.fn();
jest.mock('@server/realtime/surfaces/tables', () => ({
  emitTableHistoryChanged: jest.fn(),
  emitTableRemoved: jest.fn(),
  emitTableRestored: jest.fn(),
  emitTableCreated: (...args: unknown[]) => emitTableCreated(...args),
  emitTableUpdated: (...args: unknown[]) => emitTableUpdated(...args),
}));

import { createTable, renameTable } from '@server/domains/tables/tableCatalog';
import tablesRouter from '@server/routes/tables';
import { errorHandler } from '@server/middleware/errorHandler';

const ID_A = 'table-1111111111111-raaaaaaaa';
const ID_B = 'table-1111111111111-rbbbbbbbb';
const ID_C = 'table-1111111111111-rcccccccc';
const ID_D = 'table-1111111111111-rdddddddd';
const STRAY = 'stray_table';

async function caught(run: () => Promise<unknown>): Promise<AppError | undefined> {
  try {
    await run();
  } catch (err) {
    return err as AppError;
  }
  return undefined;
}

async function catalogName(id: string): Promise<string | undefined> {
  return (await TableCatalog.findById(id))?.name;
}

async function physicalTables(): Promise<string[]> {
  const { rows } = await getDb().query<{ tablename: string }>(
    `SELECT tablename FROM pg_tables WHERE schemaname = 'user_tables' ORDER BY tablename`
  );
  return rows.map((row) => row.tablename);
}

describe('renaming custom tables (real DB)', () => {
  beforeEach(() => {
    emitTableUpdated.mockClear();
  });

  afterAll(async () => {
    await getDb().query('DELETE FROM public.table_fields WHERE table_id = ANY($1::text[])', [
      [ID_A, ID_B, ID_C, ID_D],
    ]);
    for (const id of [ID_A, ID_B, ID_C, ID_D]) {
      const row = await TableCatalog.findById(id);
      if (row) await getDb().query(`DROP TABLE IF EXISTS user_tables."${row.tableName}" CASCADE`);
    }
    await getDb().query(`DROP TABLE IF EXISTS user_tables."${STRAY}"`);
    await getDb().query(`DELETE FROM public.table_catalog WHERE id = ANY($1::text[])`, [
      [ID_A, ID_B, ID_C, ID_D],
    ]);
  });

  it('renames the real table with its catalog row: same id, data kept, one emit', async () => {
    await createTable({ id: ID_A, name: 'rename_source' });
    await getDb().query('INSERT INTO user_tables.rename_source DEFAULT VALUES');
    const before = await TableCatalog.findById(ID_A);

    const table = await renameTable(ID_A, {
      name: '  rename_target  ',
      expectedName: 'rename_source',
    });

    expect(table).toEqual({
      id: ID_A,
      name: 'rename_target',
      origin: 'custom',
      projectId: null,
      sortOrder: before?.sortOrder,
      createdAt: before?.createdAt,
    });
    expect((await TableCatalog.findById(ID_A))?.tableName).toBe('rename_target');
    const tables = await physicalTables();
    expect(tables).toContain('rename_target');
    expect(tables).not.toContain('rename_source');
    const { rows } = await getDb().query<{ n: number }>(
      'SELECT count(*)::int AS n FROM user_tables.rename_target'
    );
    expect(rows[0]?.n).toBe(1);
    // Key and index are named after the stable id, so nothing is left stale.
    const { rows: indexes } = await getDb().query<{ indexname: string }>(
      `SELECT indexname FROM pg_indexes WHERE schemaname = 'user_tables' AND tablename = 'rename_target' ORDER BY 1`
    );
    expect(indexes.map((index) => index.indexname)).toEqual([
      'table_1111111111111_raaaaaaaa_pkey',
      'table_1111111111111_raaaaaaaa_position_idx',
    ]);
    expect(emitTableUpdated).toHaveBeenCalledTimes(1);
    expect(emitTableUpdated).toHaveBeenCalledWith(table);
  });

  it('treats the unchanged name as a silent no-op', async () => {
    const same = await renameTable(ID_A, {
      name: 'rename_target',
      expectedName: 'rename_target',
    });
    expect(same.name).toBe('rename_target');
    expect(emitTableUpdated).not.toHaveBeenCalled();
  });

  it('409s a stale expectedName with the current entry and writes nothing', async () => {
    const err = await caught(() =>
      renameTable(ID_A, { name: 'overwrite_attempt', expectedName: 'rename_source' })
    );
    expect(err?.statusCode).toBe(409);
    expect(err?.message).toContain('rename_target');
    expect(err?.details).toEqual({ table: expect.objectContaining({ id: ID_A }) });
    expect(await catalogName(ID_A)).toBe('rename_target');
    expect(await physicalTables()).not.toContain('overwrite_attempt');
    expect(emitTableUpdated).not.toHaveBeenCalled();
  });

  it('409s a name held by another table, a built-in, or a stray physical table', async () => {
    await createTable({ id: ID_B, name: 'second_table' });
    await getDb().query(`CREATE TABLE user_tables."${STRAY}" (id uuid PRIMARY KEY)`);
    for (const name of ['second_table', 'docs', STRAY]) {
      const err = await caught(() => renameTable(ID_A, { name, expectedName: 'rename_target' }));
      expect({ name, status: err?.statusCode }).toEqual({ name, status: 409 });
    }
    expect(await catalogName(ID_A)).toBe('rename_target');
    expect(await physicalTables()).toContain('rename_target');
    expect(emitTableUpdated).not.toHaveBeenCalled();
  });

  it('lets exactly one of two concurrent renames to one name win, the other a 409', async () => {
    await createTable({ id: ID_C, name: 'race_left' });
    await createTable({ id: ID_D, name: 'race_right' });
    const results = await Promise.allSettled([
      renameTable(ID_C, { name: 'race_winner', expectedName: 'race_left' }),
      renameTable(ID_D, { name: 'race_winner', expectedName: 'race_right' }),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const loser = results.find((result) => result.status === 'rejected');
    expect(loser).toMatchObject({ reason: { statusCode: 409 } });
    expect((await physicalTables()).filter((name) => name.startsWith('race_')).sort()).toEqual(
      [
        'race_winner',
        (await catalogName(ID_C)) === 'race_winner' ? 'race_right' : 'race_left',
      ].sort()
    );
  });

  it('keeps relations into a renamed table working', async () => {
    const { field } = await TableFields.createField(ID_B, {
      id: 'field-1111111111111-rrelation',
      name: 'linked',
      description: null,
      type: 'relation',
      nullable: true,
      defaultValue: null,
      referenceTableId: ID_A,
    });
    await renameTable(ID_A, { name: 'rename_linked', expectedName: 'rename_target' });
    const listed = await TableEntries.listEntries(ID_B);
    expect(listed.fields.find((item) => item.id === field.id)?.referenceTableId).toBe(ID_A);
    const { rows } = await getDb().query<{ target: string }>(
      `SELECT confrelid::regclass::text AS target FROM pg_constraint
        WHERE conrelid = 'user_tables.second_table'::regclass AND contype = 'f'`
    );
    expect(rows).toEqual([{ target: 'user_tables.rename_linked' }]);
  });

  it('400s names the shared policy rejects and 404s an unknown id', async () => {
    for (const name of [
      'Tasks & Ideas',
      '2026 plan',
      '   ',
      'x'.repeat(64),
      'Rename Me',
      'order',
    ]) {
      const err = await caught(() => renameTable(ID_A, { name, expectedName: 'rename_linked' }));
      expect({ name, status: err?.statusCode }).toEqual({ name, status: 400 });
    }
    const missing = await caught(() =>
      renameTable('table-1111111111111-rzzzzzzzz', { name: 'anything', expectedName: 'old' })
    );
    expect(missing?.statusCode).toBe(404);
    expect(await catalogName(ID_A)).toBe('rename_linked');
    expect(emitTableUpdated).not.toHaveBeenCalled();
  });

  it('refuses to rename a Snaglet table', async () => {
    const err = await caught(() =>
      renameTable('table-builtin-docs', { name: 'my_docs', expectedName: 'Docs' })
    );
    expect(err?.statusCode).toBe(403);
    expect(await catalogName('table-builtin-docs')).toBe('Docs');
    expect(emitTableUpdated).not.toHaveBeenCalled();
  });

  it('serves PATCH /api/tables/:id with the envelope and validates the body', async () => {
    const app = express();
    app.use(express.json());
    app.use('/api/tables', tablesRouter);
    app.use(errorHandler);

    const ok = await request(app)
      .patch(`/api/tables/${ID_B}`)
      .send({ name: 'second_renamed', expectedName: 'second_table' });
    expect(ok.status).toBe(200);
    expect(ok.body.data.table).toMatchObject({ id: ID_B, name: 'second_renamed' });

    const stale = await request(app)
      .patch(`/api/tables/${ID_B}`)
      .send({ name: 'third_name', expectedName: 'second_table' });
    expect(stale.status).toBe(409);
    expect(JSON.stringify(stale.body)).toContain('second_renamed');

    const malformed = await request(app).patch(`/api/tables/${ID_B}`).send({ name: 'only_name' });
    expect(malformed.status).toBe(400);
    const builtin = await request(app)
      .patch('/api/tables/table-builtin-agents')
      .send({ name: 'people', expectedName: 'Agents' });
    expect(builtin.status).toBe(403);
    expect(await catalogName(ID_B)).toBe('second_renamed');
    expect(await physicalTables()).toContain('second_renamed');
  });
});
