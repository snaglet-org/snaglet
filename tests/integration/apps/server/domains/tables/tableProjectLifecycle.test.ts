/**
 * A project's custom Database tables follow the project's lifecycle, against
 * real PostgreSQL:
 *
 * - archiving a project (or a folder holding one) archives the active tables
 *   homed in it, as one undoable step in the caller's table history;
 * - restoring it restores exactly those tables, not ones archived on their
 *   own before, and one whose name was taken meanwhile stays archived;
 * - deleting it for good (either delete route) drops its tables, refused
 *   (409, nothing changed) while another project's table links to them
 *   unless `clearReferences`;
 * - the TTL sweep drops an expired project's tables, keeping (workspace-wide,
 *   still archived) only ones other tables link to.
 */
import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';
import { Containers, getDb, quoteIdentifier } from '@snaglet/db';
import { TableCatalog } from '@snaglet/db/tables/table_catalog';
import type { Actor } from '@snaglet/shared/types/workspace-events';

const emitted: Array<{ type: string; args: unknown[] }> = [];
const record =
  (type: string) =>
  (...args: unknown[]) =>
    emitted.push({ type, args });
jest.mock('@server/realtime/surfaces/tables', () => ({
  emitTableCreated: (...args: unknown[]) => record('table.created')(...args),
  emitTableUpdated: (...args: unknown[]) => record('table.updated')(...args),
  emitTableFieldsChanged: (...args: unknown[]) => record('table.fields.changed')(...args),
  emitTableEntriesChanged: (...args: unknown[]) => record('table.entries.changed')(...args),
  emitTableRemoved: (...args: unknown[]) => record('table.removed')(...args),
  emitTableRestored: (...args: unknown[]) => record('table.restored')(...args),
  emitTableHistoryChanged: (...args: unknown[]) => record('table.history.changed')(...args),
}));
jest.mock('@server/realtime/surfaces/tree', () => ({
  emitTreeNodeArchived: jest.fn(),
  emitTreeNodeRestored: jest.fn(),
  emitTreeNodeDeleted: jest.fn(),
  emitTreeNodeCreated: jest.fn(),
  emitTreeNodeUpdated: jest.fn(),
  snapshotFromContainer: jest.fn(),
  snapshotFromDoc: jest.fn(),
  snapshotFromThread: jest.fn(),
}));

import { runWithActor } from '@server/realtime/actorContext';
import { createTable } from '@server/domains/tables/tableCatalog';
import { createTableField } from '@server/domains/tables/tableFields';
import { archiveTable, restoreTable } from '@server/domains/tables/tableLifecycle';
import { listTableHistory, stepTableHistory } from '@server/domains/tables/tableHistory';
import { archiveItem, restoreItem } from '@server/services/ArchiveService';
import { archiveTtlSweeper } from '@server/services/ArchiveTtlSweeper';
import archiveRouter from '@server/routes/archive';
import containersRouter from '@server/domains/containers/containers.routes';
import { errorHandler } from '@server/middleware/errorHandler';

const USER: Actor = { actorKind: 'user', actorId: 'test-user-a', actorName: 'Test User' };
const PREFIX = 'tplife';
const PROJECT = `container-1111111111111-${PREFIX}p1`;
const OTHER_PROJECT = `container-1111111111111-${PREFIX}p2`;
const FOLDER = `container-1111111111111-${PREFIX}f1`;
const NESTED_PROJECT = `container-1111111111111-${PREFIX}p3`;
const TABLE_A = 'table-1111111111111-tplaaaaa';
const TABLE_B = 'table-1111111111111-tplbbbbb';
const TABLE_C = 'table-1111111111111-tplccccc';
const OUTSIDE = 'table-1111111111111-tplooooo';
const LOOSE = 'table-1111111111111-tplzzzzz';

const as = <T>(fn: () => Promise<T>): Promise<T> => runWithActor(USER, fn);

function app(): express.Application {
  const result = express();
  result.use(express.json());
  result.use((_req, _res, next) => runWithActor(USER, () => next()));
  result.use('/api/archive', archiveRouter);
  result.use('/api/containers', containersRouter);
  result.use(errorHandler);
  return result;
}

async function clean(): Promise<void> {
  const { rows } = await getDb().query<{ table_name: string }>(
    "SELECT table_name FROM public.table_catalog WHERE origin = 'custom'"
  );
  for (const row of rows)
    await getDb().query(
      `DROP TABLE IF EXISTS user_tables.${quoteIdentifier(row.table_name)} CASCADE`
    );
  await getDb().query(
    "DELETE FROM public.table_fields WHERE table_id IN (SELECT id FROM public.table_catalog WHERE origin = 'custom')"
  );
  await getDb().query("DELETE FROM public.table_catalog WHERE origin = 'custom'");
  await getDb().query('DELETE FROM public.table_history');
  await getDb().query('DELETE FROM public.nodes WHERE id LIKE $1', [`%${PREFIX}%`]);
}

async function table(id: string, name: string, projectId: string | null): Promise<void> {
  await as(() => createTable({ id, name, projectId }));
}

/** A relation field on `from` pointing at `to`. */
async function link(from: string, to: string, name: string): Promise<void> {
  await as(() =>
    createTableField(from, {
      id: `field-1111111111111-${name.replace(/[^a-z0-9]/g, '').slice(0, 12)}`,
      name,
      description: null,
      type: 'relation',
      nullable: true,
      defaultValue: null,
      referenceTableId: to,
    })
  );
}

async function state(id: string) {
  const row = await TableCatalog.findById(id);
  return row ? { state: row.state, projectId: row.projectId } : null;
}

async function nodeArchivedAt(id: string): Promise<string | null> {
  const { rows } = await getDb().query<{ archived_at: string | null }>(
    'SELECT archived_at::text AS archived_at FROM public.nodes WHERE id = $1',
    [id]
  );
  return rows[0]?.archived_at ?? null;
}

async function backdate(id: string, days: number): Promise<void> {
  // The TTL sweep keys on nodes.archived_at; the cohort stamp on the tables
  // moves with it so a restore before the sweep would still match.
  const { rows } = await getDb().query<{ stamp: string }>(
    'SELECT archived_at::text AS stamp FROM public.nodes WHERE id = $1',
    [id]
  );
  const stamp = rows[0]?.stamp;
  await getDb().query(
    `UPDATE public.table_catalog SET state_changed_at = state_changed_at - make_interval(days => $2)
      WHERE state_changed_at = $1::timestamptz`,
    [stamp, days]
  );
  await getDb().query(
    `UPDATE public.nodes SET archived_at = archived_at - make_interval(days => $2)
      WHERE archived = true AND archived_at = $1::timestamptz`,
    [stamp, days]
  );
}

beforeEach(async () => {
  emitted.length = 0;
  await clean();
  await Containers.create({ id: PROJECT, name: 'Launch', category: 'project' });
  await Containers.create({ id: OTHER_PROJECT, name: 'Sales', category: 'project' });
});

describe('archiving a project', () => {
  it('archives its active tables in the same cohort, as one undoable step', async () => {
    await table(TABLE_A, 'launch_tasks', PROJECT);
    await table(TABLE_B, 'launch_people', PROJECT);
    await table(OUTSIDE, 'sales_leads', OTHER_PROJECT);
    await table(LOOSE, 'loose_notes', null);

    const outcome = await as(() => archiveItem(PROJECT, { actor: USER }));

    expect(outcome.tableIds?.sort()).toEqual([TABLE_A, TABLE_B].sort());
    expect(await state(TABLE_A)).toEqual({ state: 'archived', projectId: PROJECT });
    expect(await state(TABLE_B)).toEqual({ state: 'archived', projectId: PROJECT });
    expect(await state(OUTSIDE)).toEqual({ state: 'active', projectId: OTHER_PROJECT });
    expect(await state(LOOSE)).toEqual({ state: 'active', projectId: null });

    // Same cohort stamp as the project.
    const stamp = await nodeArchivedAt(PROJECT);
    const { rows } = await getDb().query<{ id: string }>(
      'SELECT id FROM public.table_catalog WHERE state_changed_at = $1::timestamptz ORDER BY id',
      [stamp]
    );
    expect(rows.map((row) => row.id)).toEqual([TABLE_A, TABLE_B].sort());

    // One history step, attributed like a direct archive.
    const history = await as(() => listTableHistory({}));
    const top = history.steps[0];
    expect(top?.kind).toBe('table.archive');
    expect(top?.label).toBe('Archive 2 tables with Launch');
    expect(top?.actor).toMatchObject({ kind: 'user', id: USER.actorId });
    expect(top?.tableIds.sort()).toEqual([TABLE_A, TABLE_B].sort());

    const removed = emitted.filter((event) => event.type === 'table.removed');
    expect(removed.map((event) => event.args[0]).sort()).toEqual([TABLE_A, TABLE_B].sort());
  });

  it('archives the tables of a project inside an archived folder', async () => {
    await Containers.create({ id: FOLDER, name: 'Clients' });
    await Containers.create({
      id: NESTED_PROJECT,
      name: 'Acme',
      category: 'project',
      parentId: FOLDER,
    });
    await table(TABLE_C, 'acme_tasks', NESTED_PROJECT);

    const outcome = await as(() => archiveItem(FOLDER, { actor: USER }));

    expect(outcome.tableIds).toEqual([TABLE_C]);
    expect(await state(TABLE_C)).toEqual({ state: 'archived', projectId: NESTED_PROJECT });

    await as(() => restoreItem(FOLDER, undefined, { actor: USER }));
    expect(await state(TABLE_C)).toEqual({ state: 'active', projectId: NESTED_PROJECT });
  });

  it('lists the tables with their project in the archive and nests them under it', async () => {
    await table(TABLE_A, 'launch_tasks', PROJECT);
    await as(() => archiveItem(PROJECT, { actor: USER }));

    const res = await request(app()).get('/api/archive');
    expect(res.status).toBe(200);
    const all = [...res.body.data.roots, ...res.body.data.children] as Array<{
      id: string;
      container_id: string | null;
      project_id: string | null;
    }>;
    const row = all.find((candidate) => candidate.id === TABLE_A);
    expect(row).toMatchObject({ container_id: PROJECT, project_id: PROJECT });
    expect(res.body.data.children.some((child: { id: string }) => child.id === TABLE_A)).toBe(true);
  });
});

describe('restoring a project', () => {
  it('restores the tables archived with it, not ones archived on their own before', async () => {
    await table(TABLE_A, 'launch_tasks', PROJECT);
    await table(TABLE_B, 'launch_old', PROJECT);
    await as(() => archiveTable(TABLE_B));
    await as(() => archiveItem(PROJECT, { actor: USER }));
    expect(await state(TABLE_B)).toEqual({ state: 'archived', projectId: PROJECT });

    const outcome = await as(() => restoreItem(PROJECT, undefined, { actor: USER }));

    expect(outcome.tableIds).toEqual([TABLE_A]);
    expect(await state(TABLE_A)).toEqual({ state: 'active', projectId: PROJECT });
    expect(await state(TABLE_B)).toEqual({ state: 'archived', projectId: PROJECT });
    const history = await as(() => listTableHistory({}));
    expect(history.steps[0]).toMatchObject({
      kind: 'table.restore',
      label: 'Restore 1 table with Launch',
    });
    expect(emitted.some((event) => event.type === 'table.restored')).toBe(true);
  });

  it('leaves a table whose name was taken meanwhile archived and reports it', async () => {
    await table(TABLE_A, 'launch_tasks', PROJECT);
    await as(() => archiveItem(PROJECT, { actor: USER }));
    await table(LOOSE, 'launch_tasks', null);

    const outcome = await as(() => restoreItem(PROJECT, undefined, { actor: USER }));

    expect(outcome.skippedTableIds).toEqual([TABLE_A]);
    expect(await state(TABLE_A)).toEqual({ state: 'archived', projectId: PROJECT });
    // The project itself is back.
    const { rows } = await getDb().query<{ archived: boolean }>(
      'SELECT archived FROM public.nodes WHERE id = $1',
      [PROJECT]
    );
    expect(rows[0]?.archived).toBe(false);
    // It can still be restored under a new name.
    await as(() => restoreTable(TABLE_A, { name: 'launch_tasks_2' }));
    expect(await state(TABLE_A)).toEqual({ state: 'active', projectId: PROJECT });
  });

  it('undoing the archive step brings the tables back like a direct archive', async () => {
    await table(TABLE_A, 'launch_tasks', PROJECT);
    await as(() => archiveItem(PROJECT, { actor: USER }));

    await as(() => stepTableHistory('undo', {}));
    expect(await state(TABLE_A)).toEqual({ state: 'active', projectId: PROJECT });
  });
});

describe('deleting a project for good', () => {
  it('drops its tables, with relation fields between them (archive route)', async () => {
    await table(TABLE_A, 'launch_tasks', PROJECT);
    await table(TABLE_B, 'launch_people', PROJECT);
    await link(TABLE_A, TABLE_B, 'owner');
    await table(OUTSIDE, 'sales_leads', OTHER_PROJECT);
    await as(() => archiveItem(PROJECT, { actor: USER }));

    const res = await request(app()).delete(`/api/archive/${PROJECT}`);

    expect(res.status).toBe(200);
    expect(await state(TABLE_A)).toBeNull();
    expect(await state(TABLE_B)).toBeNull();
    expect(await state(OUTSIDE)).toEqual({ state: 'active', projectId: OTHER_PROJECT });
    const { rows } = await getDb().query<{ n: number }>(
      `SELECT count(*)::int AS n FROM public.table_catalog WHERE origin = 'custom' AND project_id IS NULL`
    );
    expect(rows[0]?.n).toBe(0);
  });

  it('refuses while another project links to its tables, then clears on confirmation', async () => {
    await table(TABLE_A, 'launch_tasks', PROJECT);
    await table(OUTSIDE, 'sales_leads', OTHER_PROJECT);
    await link(OUTSIDE, TABLE_A, 'launch_task');

    const refused = await request(app()).delete(`/api/containers/${PROJECT}`);

    expect(refused.status).toBe(409);
    expect(refused.body.error?.details?.linkedFields ?? refused.body.details?.linkedFields).toEqual(
      [expect.objectContaining({ tableId: OUTSIDE, fieldName: 'launch_task' })]
    );
    // Nothing changed: the project and its table are still there.
    expect(await state(TABLE_A)).toEqual({ state: 'active', projectId: PROJECT });
    const { rows: still } = await getDb().query('SELECT 1 FROM public.nodes WHERE id = $1', [
      PROJECT,
    ]);
    expect(still).toHaveLength(1);

    const cleared = await request(app()).delete(`/api/containers/${PROJECT}?clearReferences=true`);
    expect(cleared.status).toBe(200);
    expect(await state(TABLE_A)).toBeNull();
    expect(await state(OUTSIDE)).toEqual({ state: 'active', projectId: OTHER_PROJECT });
    const { rows: fields } = await getDb().query(
      `SELECT 1 FROM public.table_fields WHERE table_id = $1 AND name = 'launch_task'`,
      [OUTSIDE]
    );
    expect(fields).toHaveLength(0);
  });

  it('leaves a table restored on its own out of an archived project workspace-wide', async () => {
    await table(TABLE_A, 'launch_tasks', PROJECT);
    await table(TABLE_B, 'launch_people', PROJECT);
    await as(() => archiveItem(PROJECT, { actor: USER }));
    await as(() => restoreTable(TABLE_B, {}));

    const res = await request(app()).delete(`/api/archive/${PROJECT}`);

    expect(res.status).toBe(200);
    expect(await state(TABLE_A)).toBeNull();
    expect(await state(TABLE_B)).toEqual({ state: 'active', projectId: null });
  });
});

describe('the archive TTL sweep', () => {
  it("drops an expired project's tables, keeping ones other tables link to", async () => {
    await table(TABLE_A, 'launch_tasks', PROJECT);
    await table(TABLE_B, 'launch_people', PROJECT);
    await table(OUTSIDE, 'sales_leads', OTHER_PROJECT);
    await link(OUTSIDE, TABLE_B, 'contact');
    await as(() => archiveItem(PROJECT, { actor: USER }));
    await backdate(PROJECT, 31);

    const result = await archiveTtlSweeper.tick();

    expect(result?.deletedContainers).toBeGreaterThanOrEqual(1);
    expect(await state(TABLE_A)).toBeNull();
    // Kept for its link: archived, now workspace-wide, for an explicit delete.
    expect(await state(TABLE_B)).toEqual({ state: 'archived', projectId: null });
    expect(await state(OUTSIDE)).toEqual({ state: 'active', projectId: OTHER_PROJECT });
  });

  it('leaves a project that has not expired alone', async () => {
    await table(TABLE_A, 'launch_tasks', PROJECT);
    await as(() => archiveItem(PROJECT, { actor: USER }));

    await archiveTtlSweeper.tick();

    expect(await state(TABLE_A)).toEqual({ state: 'archived', projectId: PROJECT });
  });
});
