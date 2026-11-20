/**
 * Creating a custom table straight into a project against the real database:
 * `createTable` and `POST /api/tables` take an optional `projectId`, land the
 * new table at the bottom of that project's list in the create's own
 * transaction, and announce it with `table.created` carrying its `projectId`
 * and `sortOrder`; a plain folder, an archived project or an unknown id is
 * refused (400 / 404) with nothing created; a replay of the same id + name
 * is idempotent and ignores `projectId`; and undoing the create deletes the
 * table while redoing it restores the table in its project.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';
import { Containers, getDb } from '@snaglet/db';
import { TableCatalog } from '@snaglet/db/tables/table_catalog';
import type { TableCatalogEntry } from '@snaglet/shared/types';
import type { Actor } from '@snaglet/shared/types/workspace-events';
import type { AppError } from '@snaglet/shared/utils';

const emitTableCreated = jest.fn<(table: TableCatalogEntry) => void>();
jest.mock('@server/realtime/surfaces/tables', () => ({
  emitTableCreated: (table: TableCatalogEntry) => emitTableCreated(table),
  emitTableFieldsChanged: jest.fn(),
  emitTableEntriesChanged: jest.fn(),
  emitTableHistoryChanged: jest.fn(),
  emitTableRemoved: jest.fn(),
  emitTableRestored: jest.fn(),
  emitTableUpdated: jest.fn(),
}));

import { runWithActor } from '@server/realtime/actorContext';
import { createTable, listTables } from '@server/domains/tables/tableCatalog';
import { stepTableHistory } from '@server/domains/tables/tableHistory';
import tablesRouter from '@server/routes/tables';
import { errorHandler } from '@server/middleware/errorHandler';

const USER: Actor = { actorKind: 'user', actorId: 'test-user-a', actorName: 'Test User' };
const PROJECT = 'container-7777777777777-project1';
const OTHER_PROJECT = 'container-7777777777777-project2';
const ARCHIVED_PROJECT = 'container-7777777777777-project3';
const PLAIN = 'container-7777777777777-plain001';
const UNKNOWN_PROJECT = 'container-7777777777777-missing1';
const TABLE_A = 'table-7777777777777-aaaaaaaaa';
const TABLE_B = 'table-7777777777777-bbbbbbbbb';
const TABLE_C = 'table-7777777777777-ccccccccc';
const TABLE_D = 'table-7777777777777-ddddddddd';
const TABLE_E = 'table-7777777777777-eeeeeeeee';
const REFUSED = 'table-7777777777777-zzzzzzzzz';
const TABLES = [TABLE_A, TABLE_B, TABLE_C, TABLE_D, TABLE_E, REFUSED];

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

async function physicalTableExists(name: string): Promise<boolean> {
  const { rows } = await getDb().query<{ found: string | null }>(
    "SELECT to_regclass(format('%I.%I', 'user_tables', $1::text))::text AS found",
    [name]
  );
  return rows[0]?.found != null;
}

/** Our custom tables in one list, in the order the server lists them. */
async function order(projectId: string | 'none'): Promise<string[]> {
  return (await listTables({ origin: 'custom', projectId }))
    .map((table) => table.id)
    .filter((id) => TABLES.includes(id));
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
  await db.query('DELETE FROM public.nodes WHERE id = ANY($1::text[])', [
    [PROJECT, OTHER_PROJECT, ARCHIVED_PROJECT, PLAIN],
  ]);
}

beforeAll(async () => {
  await cleanup();
  await Containers.create({ id: PROJECT, name: 'Create project', category: 'project' });
  await Containers.create({ id: OTHER_PROJECT, name: 'Other project', category: 'project' });
  await Containers.create({ id: ARCHIVED_PROJECT, name: 'Old project', category: 'project' });
  await Containers.create({ id: PLAIN, name: 'Plain folder' });
  await getDb().query(
    'UPDATE public.nodes SET archived = true, archived_at = now() WHERE id = $1',
    [ARCHIVED_PROJECT]
  );
});

describe('creating a table in a project (real DB)', () => {
  // Nested on purpose: a file-level afterAll runs after the shared database
  // teardown has already closed the pool.
  afterAll(cleanup);

  beforeEach(() => {
    emitTableCreated.mockClear();
  });

  it('lands each new table at the bottom of its project and announces its home and slot', async () => {
    const first = await createTable({ id: TABLE_A, name: 'in_project_one', projectId: PROJECT });
    expect(first.created).toBe(true);
    expect(first.table).toMatchObject({ id: TABLE_A, projectId: PROJECT, sortOrder: 0 });

    const second = await createTable({ id: TABLE_B, name: 'in_project_two', projectId: PROJECT });
    expect(second.table).toMatchObject({ id: TABLE_B, projectId: PROJECT, sortOrder: 1 });
    expect(emitTableCreated).toHaveBeenCalledTimes(2);
    expect(emitTableCreated).toHaveBeenLastCalledWith(second.table);

    // A workspace-wide create (null or absent) is untouched by the project's list.
    const flat = await createTable({ id: TABLE_C, name: 'in_workspace', projectId: null });
    expect(flat.table.projectId).toBeNull();
    expect(await order(PROJECT)).toEqual([TABLE_A, TABLE_B]);
    expect(await order('none')).toEqual([TABLE_C]);
    expect((await TableCatalog.findById(TABLE_B))?.projectId).toBe(PROJECT);
  });

  it('creates in a project through POST /api/tables', async () => {
    const response = await request(app())
      .post('/api/tables')
      .send({ id: TABLE_D, name: 'posted_in_project', projectId: OTHER_PROJECT });
    expect(response.status).toBe(201);
    expect(response.body.data.table).toMatchObject({
      id: TABLE_D,
      projectId: OTHER_PROJECT,
      sortOrder: 0,
    });
    expect(emitTableCreated).toHaveBeenCalledWith(response.body.data.table);
    expect(await order(OTHER_PROJECT)).toEqual([TABLE_D]);
  });

  it('refuses a plain folder, an archived project or an unknown id with nothing created', async () => {
    const steps = await historySteps();
    const cases: Array<[project: string, status: number, message: RegExp]> = [
      [PLAIN, 400, /is not a project/],
      [ARCHIVED_PROJECT, 400, /is archived/],
      [UNKNOWN_PROJECT, 404, /not found/],
    ];
    for (const [project, status, message] of cases) {
      const err = await caught(() =>
        createTable({ id: REFUSED, name: 'never_created', projectId: project })
      );
      expect({ project, status: err?.statusCode }).toEqual({ project, status });
      expect(err?.message).toMatch(message);

      const response = await request(app())
        .post('/api/tables')
        .send({ id: REFUSED, name: 'never_created', projectId: project });
      expect({ project, status: response.status }).toEqual({ project, status });
    }
    expect(await TableCatalog.findById(REFUSED)).toBeNull();
    expect(await physicalTableExists('never_created')).toBe(false);
    expect(await historySteps()).toBe(steps);
    expect(emitTableCreated).not.toHaveBeenCalled();
  });

  it('replays the same id and name idempotently, ignoring projectId', async () => {
    const before = await TableCatalog.findById(TABLE_A);
    for (const projectId of [OTHER_PROJECT, null, UNKNOWN_PROJECT, undefined]) {
      const replay = await createTable({ id: TABLE_A, name: 'in_project_one', projectId });
      expect(replay.created).toBe(false);
      expect(replay.table).toMatchObject({ id: TABLE_A, projectId: PROJECT, sortOrder: 0 });
    }
    const posted = await request(app())
      .post('/api/tables')
      .send({ id: TABLE_A, name: 'in_project_one', projectId: OTHER_PROJECT });
    expect(posted.status).toBe(200);
    expect(posted.body.data.table).toMatchObject({ id: TABLE_A, projectId: PROJECT });
    expect(await TableCatalog.findById(TABLE_A)).toEqual(before);
    expect(emitTableCreated).not.toHaveBeenCalled();
  });

  it('undoes the create by deleting the table and redoes it back into its project', async () => {
    const created = await runWithActor(USER, () =>
      createTable({ id: TABLE_E, name: 'undo_in_project', projectId: PROJECT })
    );
    expect(created.table).toMatchObject({ projectId: PROJECT, sortOrder: 2 });

    await runWithActor(USER, () => stepTableHistory('undo', {}));
    expect((await TableCatalog.findById(TABLE_E))?.state).toBe('deleted');
    expect(await order(PROJECT)).toEqual([TABLE_A, TABLE_B]);

    await runWithActor(USER, () => stepTableHistory('redo', {}));
    const restored = await TableCatalog.findById(TABLE_E);
    expect(restored).toMatchObject({
      state: 'active',
      name: 'undo_in_project',
      projectId: PROJECT,
      sortOrder: 2,
    });
    expect(await order(PROJECT)).toEqual([TABLE_A, TABLE_B, TABLE_E]);
  });
});
