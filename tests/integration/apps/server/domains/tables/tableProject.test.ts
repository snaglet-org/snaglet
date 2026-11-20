/**
 * Linking custom Database tables to projects against the real database: the
 * domain validates the target (a live project container that exists),
 * refuses built-ins and archived tables, is idempotent, emits
 * `table.updated` only on a real change and never records an undo step;
 * `PATCH /api/tables/:id` takes `{ projectId }` alone or with a rename and
 * `GET /api/tables` filters by project; deleting a project unlinks its
 * tables; and agents link through `table_schema set_project`, see project
 * homes in `table_read`, and get their thread's project's tables first.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';
import { Containers, Threads, getDb } from '@snaglet/db';
import { TableCatalog } from '@snaglet/db/tables/table_catalog';
import type { AppError } from '@snaglet/shared/utils';

const emitTableUpdated = jest.fn();
jest.mock('@server/realtime/surfaces/tables', () => ({
  emitTableCreated: jest.fn(),
  emitTableFieldsChanged: jest.fn(),
  emitTableEntriesChanged: jest.fn(),
  emitTableHistoryChanged: jest.fn(),
  emitTableRemoved: jest.fn(),
  emitTableRestored: jest.fn(),
  emitTableUpdated: (...args: unknown[]) => emitTableUpdated(...args),
}));

import { createTable, listTables, updateTablePlacement } from '@server/domains/tables/tableCatalog';
import { archiveTable, restoreTable } from '@server/domains/tables/tableLifecycle';
import {
  applyAgentSchema,
  listAgentTables,
  threadProject,
} from '@server/domains/tables/tableAgent';
import { renderTableList } from '@server/services/ToolService/tools/database/_shared/render';
import tablesRouter from '@server/routes/tables';
import { errorHandler } from '@server/middleware/errorHandler';

const PROJECT = 'container-3333333333333-project1';
const OTHER_PROJECT = 'container-3333333333333-project2';
const ARCHIVED_PROJECT = 'container-3333333333333-project3';
const DOOMED_PROJECT = 'container-3333333333333-project4';
const PLAIN = 'container-3333333333333-plain001';
const UNKNOWN_PROJECT = 'container-3333333333333-missing1';
const THREAD_IN_PROJECT = 'thread-3333333333333-aaaaaaaaa';
const THREAD_FLAT = 'thread-3333333333333-fffffffff';
const TABLE_A = 'table-3333333333333-aaaaaaaaa';
const TABLE_B = 'table-3333333333333-bbbbbbbbb';
const TABLE_C = 'table-3333333333333-ccccccccc';
const TABLE_D = 'table-3333333333333-ddddddddd';
const MISSING_TABLE = 'table-3333333333333-zzzzzzzzz';
const TABLES = [TABLE_A, TABLE_B, TABLE_C, TABLE_D];

/** A project link is a placement with no slot: the table lands at the bottom. */
function setTableProject(id: string, projectId: string | null) {
  return updateTablePlacement(id, { projectId });
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

async function projectOf(id: string): Promise<string | null | undefined> {
  return (await TableCatalog.findById(id))?.projectId;
}

async function lastHistoryLabel(): Promise<string | undefined> {
  const { rows } = await getDb().query<{ label: string }>(
    'SELECT label FROM public.table_history ORDER BY seq DESC LIMIT 1'
  );
  return rows[0]?.label;
}

function app(): express.Application {
  const server = express();
  server.use(express.json());
  server.use('/api/tables', tablesRouter);
  server.use(errorHandler);
  return server;
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
    [
      THREAD_IN_PROJECT,
      THREAD_FLAT,
      PROJECT,
      OTHER_PROJECT,
      ARCHIVED_PROJECT,
      DOOMED_PROJECT,
      PLAIN,
    ],
  ]);
}

beforeAll(async () => {
  await cleanup();
  await Containers.create({ id: PROJECT, name: 'Launch', category: 'project' });
  await Containers.create({ id: OTHER_PROJECT, name: 'Sales', category: 'project' });
  await Containers.create({ id: ARCHIVED_PROJECT, name: 'Old launch', category: 'project' });
  await Containers.create({ id: DOOMED_PROJECT, name: 'Short lived', category: 'project' });
  await Containers.create({ id: PLAIN, name: 'Plain folder' });
  await getDb().query(
    'UPDATE public.nodes SET archived = true, archived_at = now() WHERE id = $1',
    [ARCHIVED_PROJECT]
  );
  await Threads.create({ id: THREAD_IN_PROJECT, title: 'In project', projectId: PROJECT });
  await Threads.create({ id: THREAD_FLAT, title: 'Flat' });
  await createTable({ id: TABLE_A, name: 'scoped_alpha' });
  await createTable({ id: TABLE_B, name: 'scoped_beta' });
  await createTable({ id: TABLE_C, name: 'scoped_gamma' });
  await createTable({ id: TABLE_D, name: 'scoped_delta' });
  await archiveTable(TABLE_D);
});

describe('table project links (real DB)', () => {
  // Nested on purpose: a file-level afterAll runs after the shared database
  // teardown has already closed the pool.
  afterAll(cleanup);

  beforeEach(() => {
    emitTableUpdated.mockClear();
  });

  describe('updateTablePlacement with a projectId', () => {
    it('links and unlinks a custom table, emitting once per real change and recording no step', async () => {
      const steps = await historySteps();
      const linked = await setTableProject(TABLE_A, PROJECT);
      expect(linked).toMatchObject({ id: TABLE_A, name: 'scoped_alpha', projectId: PROJECT });
      expect(await projectOf(TABLE_A)).toBe(PROJECT);
      expect(emitTableUpdated).toHaveBeenCalledTimes(1);
      expect(emitTableUpdated).toHaveBeenCalledWith(linked);

      const replay = await setTableProject(TABLE_A, PROJECT);
      expect(replay).toEqual(linked);
      expect(emitTableUpdated).toHaveBeenCalledTimes(1);

      const moved = await setTableProject(TABLE_A, OTHER_PROJECT);
      expect(moved.projectId).toBe(OTHER_PROJECT);
      const unlinked = await setTableProject(TABLE_A, null);
      expect(unlinked.projectId).toBeNull();
      expect(await projectOf(TABLE_A)).toBeNull();
      expect(emitTableUpdated).toHaveBeenCalledTimes(3);
      expect(emitTableUpdated).toHaveBeenLastCalledWith(unlinked);
      expect(await setTableProject(TABLE_A, null)).toEqual(unlinked);
      expect(emitTableUpdated).toHaveBeenCalledTimes(3);
      expect(await historySteps()).toBe(steps);
    });

    it('refuses built-ins, non-projects, archived or unknown projects, and archived or unknown tables', async () => {
      const cases: Array<[table: string, project: string | null, status: number]> = [
        ['table-builtin-docs', PROJECT, 400],
        ['table-builtin-docs', null, 400],
        [TABLE_A, PLAIN, 400],
        [TABLE_A, THREAD_FLAT, 400],
        [TABLE_A, ARCHIVED_PROJECT, 400],
        [TABLE_A, UNKNOWN_PROJECT, 404],
        [TABLE_A, '', 400],
        [MISSING_TABLE, PROJECT, 404],
        [TABLE_D, PROJECT, 409],
      ];
      for (const [table, project, status] of cases) {
        const err = await caught(() => setTableProject(table, project));
        expect({ table, project, status: err?.statusCode }).toEqual({ table, project, status });
      }
      expect(await projectOf(TABLE_A)).toBeNull();
      expect(await projectOf(TABLE_D)).toBeNull();
      expect(await projectOf('table-builtin-docs')).toBeNull();
      expect(emitTableUpdated).not.toHaveBeenCalled();
    });

    it('refuses a table archived between its check and its write, linking nothing', async () => {
      // The pre-read sees an active table; the archive lands before the locked write.
      const read = TableCatalog.findById.bind(TableCatalog);
      const spy = jest
        .spyOn(TableCatalog, 'findById')
        .mockImplementationOnce(async (id, runner) => {
          const row = await read(id, runner);
          await archiveTable(TABLE_B);
          return row;
        });
      try {
        const err = await caught(() => setTableProject(TABLE_B, PROJECT));
        expect(err?.statusCode).toBe(409);
        expect(err?.message).toContain('archived');
      } finally {
        spy.mockRestore();
      }
      expect(await projectOf(TABLE_B)).toBeNull();
      expect((await TableCatalog.findById(TABLE_B))?.state).toBe('archived');
      expect(emitTableUpdated).not.toHaveBeenCalled();
      await restoreTable(TABLE_B, {});
      expect((await TableCatalog.findById(TABLE_B))?.name).toBe('scoped_beta');
    });

    it('lists by project, by none, and by origin together', async () => {
      await setTableProject(TABLE_A, PROJECT);
      await setTableProject(TABLE_B, OTHER_PROJECT);
      const ids = (tables: { id: string }[]) => tables.map((table) => table.id);
      expect(ids(await listTables({ projectId: PROJECT }))).toEqual([TABLE_A]);
      expect(ids(await listTables({ projectId: OTHER_PROJECT }))).toEqual([TABLE_B]);
      const unlinked = ids(await listTables({ projectId: 'none' }));
      expect(unlinked).toContain(TABLE_C);
      expect(unlinked).toContain('table-builtin-docs');
      expect(unlinked).not.toContain(TABLE_A);
      expect(ids(await listTables({ origin: 'custom', projectId: 'none' }))).toEqual([TABLE_C]);
      expect(ids(await listTables({ origin: 'builtin', projectId: PROJECT }))).toEqual([]);
      for (const entry of await listTables({ origin: 'custom' })) {
        expect(entry.projectId).toBe(
          entry.id === TABLE_A ? PROJECT : entry.id === TABLE_B ? OTHER_PROJECT : null
        );
      }
    });
  });

  describe('PATCH and GET /api/tables', () => {
    it('links with { projectId }, unlinks with null, and filters the list', async () => {
      const linked = await request(app())
        .patch(`/api/tables/${TABLE_C}`)
        .send({ projectId: PROJECT });
      expect(linked.status).toBe(200);
      expect(linked.body.data.table).toMatchObject({ id: TABLE_C, projectId: PROJECT });

      const inProject = await request(app()).get(`/api/tables?projectId=${PROJECT}`);
      expect(inProject.status).toBe(200);
      expect(inProject.body.data.tables.map((table: { id: string }) => table.id)).toEqual([
        TABLE_A,
        TABLE_C,
      ]);
      const unlinked = await request(app()).get('/api/tables?origin=custom&projectId=none');
      expect(unlinked.body.data.tables).toEqual([]);

      const cleared = await request(app())
        .patch(`/api/tables/${TABLE_C}`)
        .send({ projectId: null });
      expect(cleared.status).toBe(200);
      expect(cleared.body.data.table.projectId).toBeNull();
      expect(await projectOf(TABLE_C)).toBeNull();
    });

    it('renames and links in one body, rename first', async () => {
      const both = await request(app())
        .patch(`/api/tables/${TABLE_C}`)
        .send({ name: 'scoped_gamma_two', expectedName: 'scoped_gamma', projectId: PROJECT });
      expect(both.status).toBe(200);
      expect(both.body.data.table).toMatchObject({
        id: TABLE_C,
        name: 'scoped_gamma_two',
        projectId: PROJECT,
      });

      // A stale rename is refused before the link is looked at.
      const stale = await request(app())
        .patch(`/api/tables/${TABLE_C}`)
        .send({ name: 'scoped_gamma_three', expectedName: 'scoped_gamma', projectId: null });
      expect(stale.status).toBe(409);
      expect(await projectOf(TABLE_C)).toBe(PROJECT);
      expect((await TableCatalog.findById(TABLE_C))?.name).toBe('scoped_gamma_two');
    });

    it('400s malformed bodies and filters, and refuses built-ins with 400', async () => {
      for (const body of [
        {},
        { projectId: 3 },
        { projectId: '' },
        { projectId: PROJECT, extra: true },
        { projectId: PROJECT, name: 'only_name' },
      ]) {
        const response = await request(app()).patch(`/api/tables/${TABLE_C}`).send(body);
        expect({ body, status: response.status }).toEqual({ body, status: 400 });
      }
      const builtin = await request(app())
        .patch('/api/tables/table-builtin-docs')
        .send({ projectId: PROJECT });
      expect(builtin.status).toBe(400);
      const notProject = await request(app())
        .patch(`/api/tables/${TABLE_C}`)
        .send({ projectId: PLAIN });
      expect(notProject.status).toBe(400);
      expect(JSON.stringify(notProject.body)).toContain('not a project');
      const missing = await request(app())
        .patch(`/api/tables/${TABLE_C}`)
        .send({ projectId: UNKNOWN_PROJECT });
      expect(missing.status).toBe(404);
      for (const query of ['projectId=', 'projectId=a&projectId=b']) {
        const response = await request(app()).get(`/api/tables?${query}`);
        expect({ query, status: response.status }).toEqual({ query, status: 400 });
      }
      expect(await projectOf(TABLE_C)).toBe(PROJECT);
    });

    it('takes none as the list filter only, in any case; a none body is a 400', async () => {
      const ids = (response: request.Response) =>
        response.body.data.tables.map((table: { id: string }) => table.id);
      const lower = await request(app()).get('/api/tables?origin=custom&projectId=none');
      const upper = await request(app()).get('/api/tables?origin=custom&projectId=NONE');
      expect(lower.status).toBe(200);
      expect(upper.status).toBe(200);
      expect(ids(upper)).toEqual(ids(lower));
      expect(ids(lower)).not.toContain(TABLE_C);

      for (const projectId of ['none', 'None']) {
        const response = await request(app()).patch(`/api/tables/${TABLE_C}`).send({ projectId });
        expect({ projectId, status: response.status }).toEqual({ projectId, status: 400 });
        expect(JSON.stringify(response.body)).toContain('or null');
      }
      expect(await projectOf(TABLE_C)).toBe(PROJECT);
    });

    it('refuses a rename plus a bad link before the rename, so the name is unchanged', async () => {
      for (const [projectId, status] of [
        [PLAIN, 400],
        [ARCHIVED_PROJECT, 400],
        [UNKNOWN_PROJECT, 404],
      ] as const) {
        const response = await request(app())
          .patch(`/api/tables/${TABLE_C}`)
          .send({ name: 'scoped_gamma_never', expectedName: 'scoped_gamma_two', projectId });
        expect({ projectId, status: response.status }).toEqual({ projectId, status });
        expect(JSON.stringify(response.body)).not.toContain('scoped_gamma_never');
      }
      const row = await TableCatalog.findById(TABLE_C);
      expect(row).toMatchObject({
        name: 'scoped_gamma_two',
        tableName: 'scoped_gamma_two',
        projectId: PROJECT,
      });
      expect(emitTableUpdated).not.toHaveBeenCalled();
      // The same body with a live target applies both, rename first.
      const both = await request(app())
        .patch(`/api/tables/${TABLE_C}`)
        .send({ name: 'scoped_gamma_two', expectedName: 'scoped_gamma_two', projectId: PROJECT });
      expect(both.status).toBe(200);
      expect(both.body.data.table).toMatchObject({ name: 'scoped_gamma_two', projectId: PROJECT });
    });
  });

  describe('a deleted project', () => {
    it('unlinks its tables, which list and render as workspace-wide', async () => {
      await setTableProject(TABLE_C, DOOMED_PROJECT);
      expect(await projectOf(TABLE_C)).toBe(DOOMED_PROJECT);
      await getDb().query('DELETE FROM public.nodes WHERE id = $1', [DOOMED_PROJECT]);
      expect(await projectOf(TABLE_C)).toBeNull();
      expect((await listTables({ projectId: 'none' })).map((table) => table.id)).toContain(TABLE_C);
      const rendered = renderTableList(await listAgentTables());
      expect(rendered).toContain('scoped_gamma_two (0):');
      expect(rendered).not.toContain('Short lived');
    });
  });

  describe('agents', () => {
    it('link through table_schema set_project, which is not an undo step and emits table.updated', async () => {
      const steps = await historySteps();
      const result = await applyAgentSchema('scoped_gamma_two', {
        ops: [{ op: 'set_project', project_id: PROJECT }],
      });
      expect(result.created).toBe(false);
      expect(result.table.project).toEqual({ id: PROJECT, name: 'Launch' });
      expect(await projectOf(TABLE_C)).toBe(PROJECT);
      expect(emitTableUpdated).toHaveBeenCalledTimes(1);
      expect(emitTableUpdated).toHaveBeenLastCalledWith(
        expect.objectContaining({ id: TABLE_C, projectId: PROJECT })
      );
      expect(await historySteps()).toBe(steps);

      const same = await applyAgentSchema(TABLE_C, {
        ops: [{ op: 'set_project', project_id: PROJECT }],
      });
      expect(same.table.project?.id).toBe(PROJECT);
      expect(emitTableUpdated).toHaveBeenCalledTimes(1);

      const flat = await applyAgentSchema(TABLE_C, {
        ops: [{ op: 'set_project', project_id: null }],
      });
      expect(flat.table.project).toBeUndefined();
      expect(await projectOf(TABLE_C)).toBeNull();
      expect(emitTableUpdated).toHaveBeenCalledTimes(2);
    });

    it('roll the whole call back when the target is refused, naming the op', async () => {
      const steps = await historySteps();
      for (const [project, status] of [
        [PLAIN, 400],
        [ARCHIVED_PROJECT, 400],
        [UNKNOWN_PROJECT, 404],
      ] as const) {
        const err = await caught(() =>
          applyAgentSchema(TABLE_C, {
            ops: [
              { op: 'add_field', field: { name: 'never_added', type: 'text' } },
              { op: 'set_project', project_id: project },
            ],
          })
        );
        expect({ project, status: err?.statusCode }).toEqual({ project, status });
        expect(err?.message).toMatch(/^ops\[1\] set_project: /);
      }
      expect(await projectOf(TABLE_C)).toBeNull();
      const { rows } = await getDb().query<{ n: number }>(
        `SELECT count(*)::int AS n FROM public.table_fields WHERE table_id = $1 AND name = 'never_added'`,
        [TABLE_C]
      );
      expect(rows[0]?.n).toBe(0);
      expect(await historySteps()).toBe(steps);
      expect(emitTableUpdated).not.toHaveBeenCalled();
      await expect(
        applyAgentSchema(TABLE_C, { ops: [{ op: 'set_project' } as never] })
      ).rejects.toMatchObject({ statusCode: 400 });
    });

    it('refuse set_project on a table the same call archived or deleted, saving nothing', async () => {
      const steps = await historySteps();
      for (const [first, status] of [
        [{ op: 'archive_table' }, 409],
        [{ op: 'delete_table' }, 404],
      ] as const) {
        const err = await caught(() =>
          applyAgentSchema(TABLE_C, {
            ops: [first, { op: 'set_project', project_id: PROJECT }],
          })
        );
        expect({ first, status: err?.statusCode }).toEqual({ first, status });
        expect(err?.message).toMatch(/^ops\[1\] set_project: /);
        expect((await TableCatalog.findById(TABLE_C))?.state).toBe('active');
      }
      expect(await projectOf(TABLE_C)).toBeNull();
      expect(await historySteps()).toBe(steps);
      expect(emitTableUpdated).not.toHaveBeenCalled();
    });

    it('label the history step by the journaled ops only, never by set_project', async () => {
      const steps = await historySteps();
      const renamed = await applyAgentSchema(TABLE_C, {
        ops: [
          { op: 'rename_table', name: 'scoped_gamma_three' },
          { op: 'set_project', project_id: PROJECT },
        ],
      });
      expect(renamed.table).toMatchObject({
        name: 'scoped_gamma_three',
        project: { id: PROJECT, name: 'Launch' },
      });
      expect(await historySteps()).toBe(steps + 1);
      expect(await lastHistoryLabel()).toBe('Rename table scoped_gamma_two to scoped_gamma_three');

      const back = await applyAgentSchema(TABLE_C, {
        ops: [
          { op: 'rename_table', name: 'scoped_gamma_two' },
          { op: 'set_project', project_id: null },
        ],
      });
      expect(back.table.name).toBe('scoped_gamma_two');
      expect(back.table.project).toBeUndefined();
      expect(await historySteps()).toBe(steps + 2);
      expect(await lastHistoryLabel()).toBe('Rename table scoped_gamma_three to scoped_gamma_two');
      expect(await projectOf(TABLE_C)).toBeNull();
    });

    it('see project homes, with their thread project first, then workspace-wide, then others', async () => {
      // A: Launch, B: Sales, C: workspace-wide (names order: alpha, beta, gamma_two).
      expect(await threadProject(THREAD_IN_PROJECT)).toEqual({ id: PROJECT, name: 'Launch' });
      expect(await threadProject(THREAD_FLAT)).toBeNull();
      expect(await threadProject(undefined)).toBeNull();

      const unscoped = await listAgentTables();
      expect(unscoped.map((table) => [table.name, table.project?.name])).toEqual([
        ['scoped_alpha', 'Launch'],
        ['scoped_beta', 'Sales'],
        ['scoped_gamma_two', undefined],
      ]);
      const fromLaunch = await listAgentTables(PROJECT);
      expect(fromLaunch.map((table) => table.name)).toEqual([
        'scoped_alpha',
        'scoped_gamma_two',
        'scoped_beta',
      ]);
      const fromSales = await listAgentTables(OTHER_PROJECT);
      expect(fromSales.map((table) => table.name)).toEqual([
        'scoped_beta',
        'scoped_gamma_two',
        'scoped_alpha',
      ]);
      const lines = renderTableList(fromLaunch, [], { id: PROJECT, name: 'Launch' }).split('\n');
      expect(lines[0]).toBe(
        'in project Launch: 1 table first, then workspace-wide, then other projects'
      );
      expect(lines[1]).toMatch(/^scoped_alpha \(0\) @Launch: /);
      expect(lines[2]).toMatch(/^scoped_gamma_two \(0\): /);
      expect(lines[3]).toMatch(/^scoped_beta \(0\) @Sales: /);
    });
  });
});
