/**
 * Archive, restore and delete for custom tables and fields, through the table
 * routes, the generic archive routes and the agent tools, against real
 * PostgreSQL; plus the archive route re-parenting a node restored out of a
 * still-archived container.
 */
import { afterAll, beforeEach, describe, expect, it, jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';
import { Containers, Docs, getDb, quoteIdentifier } from '@snaglet/db';
import type { Actor } from '@snaglet/shared/types/workspace-events';
import type { TableEntryValues, TableField } from '@snaglet/shared/types';

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
import { createTable, getTableDetail, listTables } from '@server/domains/tables/tableCatalog';
import { createTableField, listTableFields } from '@server/domains/tables/tableFields';
import {
  createTableEntry,
  getTableEntry,
  listTableEntries,
  resolveTableEntries,
} from '@server/domains/tables/tableEntries';
import { listTableHistory, stepTableHistory } from '@server/domains/tables/tableHistory';
import {
  archiveTable,
  archiveTableField,
  deleteTable,
  listArchivedTableFields,
  listArchivedTables,
  restoreTable,
  restoreTableField,
} from '@server/domains/tables/tableLifecycle';
import tablesRouter from '@server/routes/tables';
import archiveRouter from '@server/routes/archive';
import { errorHandler } from '@server/middleware/errorHandler';
import tableSchemaTool from '@server/services/ToolService/handlers/tables/tableSchema';
import tableReadTool from '@server/services/ToolService/handlers/tables/tableRead';
import restoreNodeTool from '@server/services/ToolService/handlers/workspace/restoreNode';

const USER: Actor = { actorKind: 'user', actorId: 'test-user-a', actorName: 'Test User' };
const AGENT: Actor = { actorKind: 'agent', actorId: 'test-agent-a', actorName: 'test-agent-a' };
const TARGET = 'table-1111111111111-arcaaaaa';
const LINKING = 'table-1111111111111-arcbbbbb';
const T1 = '11111111-1111-4111-8111-111111111111';
const T2 = '22222222-2222-4222-8222-222222222222';
const L1 = '33333333-3333-4333-8333-333333333333';
const PREFIX = 'archive-reparent-it';

const as = <T>(actor: Actor, fn: () => Promise<T>): Promise<T> => runWithActor(actor, fn);

function app(): express.Application {
  const result = express();
  result.use(express.json());
  result.use((_req, _res, next) => runWithActor(USER, () => next()));
  result.use('/api/tables', tablesRouter);
  result.use('/api/archive', archiveRouter);
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

function def(id: string, name: string, type: string, extra: Record<string, unknown> = {}) {
  return {
    id: `field-1111111111111-${id}`,
    name,
    description: null,
    type,
    nullable: true,
    defaultValue: null,
    referenceTableId: null,
    ...extra,
  };
}

async function insert(tableId: string, id: string, values: TableEntryValues = {}) {
  const { schemaVersion } = await listTableEntries(tableId);
  return as(USER, () => createTableEntry(tableId, { id, values, schemaVersion }));
}

function fieldNamed(list: readonly TableField[], name: string): TableField {
  const field = list.find((candidate) => candidate.name === name);
  if (!field) throw new Error(`missing field ${name}`);
  return field;
}

async function caught(action: () => Promise<unknown>) {
  try {
    await action();
  } catch (error) {
    return error as { statusCode?: number; message: string; details?: Record<string, unknown> };
  }
  throw new Error('expected a rejection');
}

/** A target table with two entries, and a linking table whose relations point at it. */
async function linkedTables(): Promise<{ one: string; many: string }> {
  await as(USER, () => createTable({ id: TARGET, name: 'target_table' }));
  await as(USER, () => createTableField(TARGET, def('notes', 'notes', 'text')));
  await insert(TARGET, T1, { [`field-title-${TARGET}`]: 'first' });
  await insert(TARGET, T2, { [`field-title-${TARGET}`]: 'second' });
  await as(USER, () => createTable({ id: LINKING, name: 'linking_table' }));
  const one = (
    await as(USER, () =>
      createTableField(LINKING, def('one', 'one', 'relation', { referenceTableId: TARGET }))
    )
  ).field.id;
  const many = (
    await as(USER, () =>
      createTableField(
        LINKING,
        def('many', 'many', 'relation', {
          referenceTableId: TARGET,
          multiple: true,
          nullable: false,
          defaultValue: [],
        })
      )
    )
  ).field.id;
  await insert(LINKING, L1, { [one]: T1, [many]: [T2, T1] });
  return { one, many };
}

describe('archive, restore and delete for custom tables (real DB)', () => {
  beforeEach(async () => {
    await clean();
    emitted.length = 0;
  });
  afterAll(clean);

  it('archives a field (name freed, data kept), restores it under a new name, and undoes', async () => {
    await linkedTables();
    const notes = fieldNamed(await listTableFields(TARGET), 'notes');
    const { schemaVersion } = await listTableEntries(TARGET);
    await as(USER, () =>
      createTableEntry(TARGET, {
        id: '44444444-4444-4444-8444-444444444444',
        values: { [notes.id]: 'kept' },
        schemaVersion,
      })
    );
    const archived = await as(USER, () => archiveTableField(TARGET, notes.id));
    expect(archived).toMatchObject({ changed: true, field: { state: 'archived', name: 'notes' } });
    expect((await listTableFields(TARGET)).map((field) => field.name)).not.toContain('notes');
    expect((await listArchivedTableFields(TARGET)).fields.map((field) => field.id)).toEqual([
      notes.id,
    ]);
    // The name is free: a new field takes it.
    await as(USER, () => createTableField(TARGET, def('notes2', 'notes', 'text')));
    const taken = await caught(() => as(USER, () => restoreTableField(TARGET, notes.id, {})));
    expect(taken.statusCode).toBe(409);
    expect(taken.details).toMatchObject({ reason: 'nameTaken' });
    const restored = await as(USER, () =>
      restoreTableField(TARGET, notes.id, { name: 'old_notes' })
    );
    expect(restored.field).toMatchObject({ id: notes.id, name: 'old_notes' });
    expect(restored.field.state).toBeUndefined();
    expect(
      (await getTableEntry(TARGET, '44444444-4444-4444-8444-444444444444')).entry.values[notes.id]
    ).toBe('kept');
    // Undo the restore: archived again.
    await as(USER, () => stepTableHistory('undo'));
    expect((await listArchivedTableFields(TARGET)).fields.map((field) => field.id)).toEqual([
      notes.id,
    ]);
  });

  it('archives a table: hidden from the catalog and agents, name freed, links unavailable, restorable', async () => {
    const { one } = await linkedTables();
    const result = await as(USER, () => archiveTable(TARGET));
    expect(result).toMatchObject({ changed: true, table: { id: TARGET, state: 'archived' } });
    expect(emitted.map((event) => event.type)).toContain('table.removed');
    expect((await listTables()).map((table) => table.id)).not.toContain(TARGET);
    expect((await listArchivedTables()).tables).toMatchObject([
      { id: TARGET, name: 'target_table', state: 'archived' },
    ]);
    expect((await getTableDetail(TARGET)).table.state).toBe('archived');
    const entries = await caught(() => listTableEntries(TARGET));
    expect(entries.statusCode).toBe(409);
    // The linking table still reads; its stored ids stay, their names are unavailable.
    const linking = await listTableEntries(LINKING);
    expect(linking.entries[0]?.values[one]).toBe(T1);
    expect(linking.relatedEntries[TARGET]).toBeUndefined();
    expect(
      (await resolveTableEntries({ refs: [{ tableId: TARGET, entryId: T1 }] })).entries
    ).toEqual([]);
    // Agents do not see it, except on the quiet archived line.
    const read = await as(AGENT, () => Promise.resolve(tableReadTool({}, {})));
    expect(String(read)).toContain('archived (restore_table): target_table');
    expect(String(read)).not.toMatch(/^target_table \(/m);

    // The name is free; restoring asks for another.
    await as(USER, () => createTable({ id: 'table-1111111111111-arcccccc', name: 'target_table' }));
    const taken = await caught(() => as(USER, () => restoreTable(TARGET, {})));
    expect(taken.details).toMatchObject({ reason: 'nameTaken' });
    const restored = await as(USER, () => restoreTable(TARGET, { name: 'target_back' }));
    expect(restored.table).toEqual(expect.objectContaining({ id: TARGET, name: 'target_back' }));
    expect(restored.table.state).toBeUndefined();
    expect((await listTableEntries(TARGET)).entries.map((entry) => entry.id)).toEqual([T1, T2]);
  });

  it('deletes a linked table only on confirmation, and undo brings table, relation fields and links back', async () => {
    const { one, many } = await linkedTables();
    const before = {
      target: await listTableEntries(TARGET),
      linking: await listTableEntries(LINKING),
    };
    const refused = await caught(() => as(USER, () => deleteTable(TARGET, {})));
    expect(refused.statusCode).toBe(409);
    expect(refused.details).toMatchObject({
      linkedFields: [
        { tableId: LINKING, fieldName: 'many' },
        { tableId: LINKING, fieldName: 'one' },
      ],
    });
    const deleted = await as(USER, () => deleteTable(TARGET, { clearReferences: true }));
    expect(deleted.table.state).toBe('deleted');
    expect(deleted.deletedLinkedFields?.map((field) => field.fieldId).sort()).toEqual(
      [one, many].sort()
    );
    expect((await listTableFields(LINKING)).map((field) => field.id)).not.toContain(one);
    expect((await caught(() => listTableEntries(TARGET))).statusCode).toBe(404);

    await as(USER, () => stepTableHistory('undo'));
    const target = await listTableEntries(TARGET);
    const linking = await listTableEntries(LINKING);
    expect(target.entries.map(({ revision: _r, ...entry }) => entry)).toEqual(
      before.target.entries.map(({ revision: _r, ...entry }) => entry)
    );
    expect(linking.entries.map(({ revision: _r, ...entry }) => entry)).toEqual(
      before.linking.entries.map(({ revision: _r, ...entry }) => entry)
    );
    await as(USER, () => stepTableHistory('redo'));
    expect((await caught(() => listTableEntries(TARGET))).statusCode).toBe(404);
  });

  it('special-cases table ids in the generic archive routes', async () => {
    await linkedTables();
    const server = app();
    const counts = await request(server).get(`/api/archive/counts/${TARGET}`);
    expect(counts.status).toBe(200);
    expect(counts.body.data).toMatchObject({
      node: { id: TARGET, type: 'table', title: 'target_table', archived: false },
      counts: { entries: 2, fields: 2, linked_fields: 2, docs: 0 },
    });
    const activeDelete = await request(server).delete(`/api/archive/${TARGET}`);
    expect(activeDelete.status).toBe(409);

    const archived = await request(server).post(`/api/archive/${TARGET}`);
    expect(archived.status).toBe(200);
    expect(archived.body.data).toMatchObject({
      node: { id: TARGET, type: 'table', archived: true },
      affected: 1,
      alreadyArchived: false,
    });
    const again = await request(server).post(`/api/archive/${TARGET}`);
    expect(again.body.data).toMatchObject({ affected: 0, alreadyArchived: true });
    const listed = await request(server).get('/api/archive');
    expect(listed.body.data.roots).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: TARGET, type: 'table' })])
    );
    // The archive is a step in the caller's history.
    await as(USER, () => stepTableHistory('undo'));
    expect((await listTables()).map((table) => table.id)).toContain(TARGET);
    await as(USER, () => stepTableHistory('redo'));

    const restored = await request(server).post(`/api/archive/${TARGET}/restore`).send({});
    expect(restored.body.data).toMatchObject({
      node: { id: TARGET, type: 'table', archived: false },
      alreadyActive: false,
    });
    await request(server).post(`/api/archive/${TARGET}`);
    const linked = await request(server).delete(`/api/archive/${TARGET}`);
    expect(linked.status).toBe(409);
    expect(linked.body.error.details.linkedFields).toHaveLength(2);
    const purged = await request(server).delete(`/api/archive/${TARGET}?clearReferences=true`);
    expect(purged.status).toBe(200);
    expect(purged.body.data).toMatchObject({ id: TARGET, deleted: 1 });
    const { rows } = await getDb().query<{ n: number }>(
      "SELECT count(*)::int AS n FROM information_schema.tables WHERE table_schema = 'user_tables' AND table_name LIKE '_snaglet_table_1111111111111_arcaaaaa%'"
    );
    expect(rows[0]?.n).toBe(0);
    expect(
      await getDb().query('SELECT id FROM public.table_catalog WHERE id = $1', [TARGET])
    ).toMatchObject({
      rows: [],
    });
    expect((await listTableFields(LINKING)).map((field) => field.name)).toEqual([
      'name',
      'id',
      'created_at',
    ]);
    // Every step that needed it, or the relation fields dropped with it, left
    // the history too, so undo reaches the linking table's own entry.
    const history = await as(USER, () => listTableHistory());
    expect(history.steps.map((step) => [step.kind, step.tableIds])).toEqual([
      ['entry.create', [LINKING]],
      ['table.create', [LINKING]],
    ]);
    const next = await as(USER, () => stepTableHistory('undo'));
    expect(next.step.kind).toBe('entry.create');
  });

  it('lets agents archive fields and delete tables in their own history, which a person can undo', async () => {
    await linkedTables();
    const archived = String(
      await as(AGENT, () =>
        Promise.resolve(
          tableSchemaTool(
            { table: 'target_table', ops: [{ op: 'archive_field', name: 'notes' }] },
            {}
          )
        )
      )
    );
    expect(archived).toContain('altered target_table (1 op):');
    expect(archived).toContain('archived (restore_field): notes');
    const refused = await as(AGENT, () =>
      Promise.resolve(tableSchemaTool({ table: 'target_table', ops: [{ op: 'delete_table' }] }, {}))
    ).catch((error: Error) => error.message);
    expect(refused).toBe(
      'error 409: ops[0] delete_table: 2 relation fields link to target_table: linking_table.many, linking_table.one. Repeat with clear_links:true to delete them with the table.'
    );
    const deleted = String(
      await as(AGENT, () =>
        Promise.resolve(
          tableSchemaTool(
            { table: 'target_table', ops: [{ op: 'delete_table', clear_links: true }] },
            {}
          )
        )
      )
    );
    expect(deleted).toContain('deleted target_table; a person can undo it');
    const stack = await as(USER, () =>
      stepTableHistory('undo', { actor: { kind: 'agent', id: AGENT.actorId } })
    );
    expect(stack.step).toMatchObject({ kind: 'table.delete', actor: { kind: 'agent' } });
    expect((await listTables()).map((table) => table.id)).toContain(TARGET);
    const restored = String(
      await as(AGENT, () =>
        Promise.resolve(
          tableSchemaTool(
            { table: 'target_table', ops: [{ op: 'restore_field', name: 'notes' }] },
            {}
          )
        )
      )
    );
    expect(restored).toMatch(/^notes text\?/m);
  });

  it('re-parents a node restored out of a still-archived container, so a sweep cannot delete it', async () => {
    const server = app();
    const grand = `container-${PREFIX}-grand`;
    const parent = `container-${PREFIX}-parent`;
    const lone = `container-${PREFIX}-lone`;
    await Containers.create({ id: grand, name: 'Test Grand' });
    await Containers.create({ id: parent, name: 'Test Parent', parentId: grand });
    await Containers.create({ id: lone, name: 'Test Lone' });
    const child = (
      await Docs.create({
        id: `doc-${PREFIX}-child`,
        title: 'Test Child',
        content: 'x',
        containerId: parent,
      })
    ).id;
    const orphan = (
      await Docs.create({
        id: `doc-${PREFIX}-orphan`,
        title: 'Test Orphan',
        content: 'x',
        containerId: lone,
      })
    ).id;

    expect((await request(server).post(`/api/archive/${parent}`)).status).toBe(200);
    expect((await request(server).post(`/api/archive/${lone}`)).status).toBe(200);
    const restored = await request(server).post(`/api/archive/${child}/restore`).send({});
    expect(restored.body.data).toMatchObject({
      container_id: grand,
      reparented_from: parent,
      alreadyActive: false,
    });
    const viaTool = await restoreNodeTool({ node_id: orphan }, {});
    expect(viaTool).toMatchObject({ container_id: null, reparented_from: lone });
    expect(viaTool.message).toContain('moved to the root');

    await getDb().query("SELECT * FROM public.archive_ttl_sweep('0 seconds'::interval)");
    const { rows } = await getDb().query<{
      id: string;
      archived: boolean;
      container_id: string | null;
    }>(
      'SELECT id, archived, container_id FROM public.nodes WHERE id = ANY($1::text[]) ORDER BY id',
      [[child, orphan, parent, lone]]
    );
    expect(rows).toEqual([
      { id: child, archived: false, container_id: grand },
      { id: orphan, archived: false, container_id: null },
    ]);
  });
});
