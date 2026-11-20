/**
 * Per-actor undo history for custom tables, against real PostgreSQL: every
 * undoable action round-trips exactly (values, ids, positions, relation
 * lists, selects, datetime precision, schema), stacks are per actor, a
 * change made since refuses the undo (409) without writing, and the stack is
 * pruned to 100 steps, purging deleted data that leaves it.
 */
import { afterAll, beforeEach, describe, expect, it, jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';
import { getDb, quoteIdentifier } from '@snaglet/db';
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

import { runWithActor } from '@server/realtime/actorContext';
import { createTable, listTables, renameTable } from '@server/domains/tables/tableCatalog';
import { applyAgentSchema } from '@server/domains/tables/tableAgent';
import {
  createTableField,
  listTableFields,
  reorderTableFields,
  updateTableField,
} from '@server/domains/tables/tableFields';
import {
  createTableEntry,
  deleteTableEntries,
  getTableEntry,
  listTableEntries,
  updateTableEntry,
} from '@server/domains/tables/tableEntries';
import { listTableHistory, stepTableHistory } from '@server/domains/tables/tableHistory';
import {
  deleteTableField,
  listArchivedTableFields,
  setTableTitleField,
} from '@server/domains/tables/tableLifecycle';
import tablesRouter from '@server/routes/tables';
import { errorHandler } from '@server/middleware/errorHandler';

const USER: Actor = { actorKind: 'user', actorId: 'test-user-a', actorName: 'Test User' };
const AGENT: Actor = { actorKind: 'agent', actorId: 'test-agent-a', actorName: 'test-agent-a' };
const TABLE = 'table-1111111111111-histaaaa';
const OTHER = 'table-1111111111111-histbbbb';
const TITLE = `field-title-${TABLE}`;
const E1 = '11111111-1111-4111-8111-111111111111';
const E2 = '22222222-2222-4222-8222-222222222222';
const E3 = '33333333-3333-4333-8333-333333333333';
const B1 = '44444444-4444-4444-8444-444444444444';
const B2 = '55555555-5555-4555-8555-555555555555';

const as = <T>(actor: Actor, fn: () => Promise<T>): Promise<T> => runWithActor(actor, fn);
const stack = (actor: Actor) => ({ kind: actor.actorKind, id: actor.actorId });
const undo = (actor: Actor, body: Record<string, unknown> = {}) =>
  as(actor, () => stepTableHistory('undo', body));
const redo = (actor: Actor, body: Record<string, unknown> = {}) =>
  as(actor, () => stepTableHistory('redo', body));

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

async function schemaVersion(tableId: string): Promise<string> {
  return (await listTableEntries(tableId)).schemaVersion;
}

async function insert(
  actor: Actor,
  tableId: string,
  id: string,
  values: TableEntryValues = {},
  beforeEntryId?: string
) {
  const version = await schemaVersion(tableId);
  return as(actor, () =>
    createTableEntry(tableId, {
      id,
      values,
      schemaVersion: version,
      ...(beforeEntryId ? { beforeEntryId } : {}),
    })
  );
}

async function patch(actor: Actor, tableId: string, id: string, values: TableEntryValues) {
  const current = await getTableEntry(tableId, id);
  return as(actor, () =>
    updateTableEntry(tableId, id, {
      values,
      schemaVersion: current.schemaVersion,
      expectedRevision: current.entry.revision,
    })
  );
}

/** Entries in row order: ids, creation stamps and values, exactly. */
async function rows(tableId: string) {
  const page = await listTableEntries(tableId, { pageSize: '100' });
  return page.entries.map(({ id, createdAt, values }) => ({ id, createdAt, values }));
}

/** Fields in display order without their revisions. */
async function fields(tableId: string) {
  return (await listTableFields(tableId)).map(({ revision: _revision, ...field }) => field);
}

function fieldNamed(list: readonly TableField[], name: string): TableField {
  const field = list.find((candidate) => candidate.name === name);
  if (!field) throw new Error(`missing field ${name}`);
  return field;
}

async function update(
  actor: Actor,
  tableId: string,
  name: string,
  changes: Record<string, unknown>
) {
  const field = fieldNamed(await listTableFields(tableId), name);
  return as(actor, () =>
    updateTableField(tableId, field.id, {
      name: field.name,
      description: field.description,
      type: field.type,
      nullable: field.nullable,
      defaultValue: field.defaultValue,
      referenceTableId: field.referenceTableId,
      multiple: field.multiple,
      ...(field.options ? { options: field.options } : {}),
      ...changes,
      expectedRevision: field.revision,
    })
  );
}

async function historyCount(actor: Actor): Promise<number> {
  const { rows: counted } = await getDb().query<{ n: number }>(
    'SELECT count(*)::int AS n FROM public.table_history WHERE actor_kind = $1 AND actor_id = $2',
    [actor.actorKind, actor.actorId]
  );
  return counted[0]?.n ?? 0;
}

async function caught(action: () => Promise<unknown>) {
  try {
    await action();
  } catch (error) {
    return error as { statusCode?: number; message: string; details?: Record<string, unknown> };
  }
  throw new Error('expected a rejection');
}

/** A table with one field of every editable type and two entries. */
async function richTable(): Promise<void> {
  await as(USER, () => createTable({ id: TABLE, name: 'history_table' }));
  for (const field of [
    def('notes', 'notes', 'text'),
    def('amount', 'amount', 'number'),
    def('due', 'due', 'datetime'),
    def('day', 'day', 'date'),
    def('done', 'done', 'checkbox', { nullable: false, defaultValue: false }),
    def('status', 'status', 'select', { options: [{ label: 'todo' }, { label: 'done' }] }),
    def('tags', 'tags', 'select', {
      multiple: true,
      nullable: false,
      defaultValue: [],
      options: [{ label: 'a' }, { label: 'b' }, { label: 'c' }],
    }),
    def('links', 'links', 'relation', {
      referenceTableId: TABLE,
      multiple: true,
      nullable: false,
      defaultValue: [],
    }),
    def('parent', 'parent', 'relation', { referenceTableId: TABLE }),
  ])
    await as(USER, () => createTableField(TABLE, field));
  await insert(USER, TABLE, E1, { [TITLE]: 'first' });
  await insert(USER, TABLE, E2, { [TITLE]: 'second' });
}

describe('custom table undo history (real DB)', () => {
  beforeEach(async () => {
    await clean();
    emitted.length = 0;
  });
  afterAll(clean);

  it('round-trips cell edits of every type exactly, then redoes them', async () => {
    await richTable();
    const list = await listTableFields(TABLE);
    const id = (name: string) => fieldNamed(list, name).id;
    await patch(USER, TABLE, E1, {
      [id('notes')]: 'kept [Doc](doc-1111111111111-aaaaaaaaa)',
      [id('amount')]: '1.500',
      [id('due')]: '2026-10-01T15:30:00.123456Z',
      [id('day')]: '2026-01-31',
      [id('done')]: true,
      [id('status')]: 'todo',
      [id('tags')]: ['c', 'a'],
      [id('links')]: [E2, E1],
      [id('parent')]: E2,
    });
    const before = await rows(TABLE);
    const beforeEntry = (await getTableEntry(TABLE, E1)).entry;
    await patch(USER, TABLE, E1, {
      [id('notes')]: null,
      [id('amount')]: '2',
      [id('due')]: '2027-01-01T00:00:00Z',
      [id('day')]: null,
      [id('done')]: false,
      [id('status')]: 'done',
      [id('tags')]: ['b'],
      [id('links')]: [E1],
      [id('parent')]: null,
    });
    const after = await rows(TABLE);
    expect(after).not.toEqual(before);

    const history = await as(USER, () => listTableHistory());
    expect(history.undo).toMatchObject({ kind: 'entry.update', state: 'done' });
    emitted.length = 0;
    const undone = await undo(USER, { stepId: history.undo?.id });
    expect(undone.step.state).toBe('undone');
    expect(await rows(TABLE)).toEqual(before);
    // Same schema, same values: the entry's revision is the one before, too.
    expect((await getTableEntry(TABLE, E1)).entry).toEqual(beforeEntry);
    expect(emitted.map((event) => event.type)).toEqual([
      'table.entries.changed',
      'table.history.changed',
    ]);

    await redo(USER);
    expect(await rows(TABLE)).toEqual(after);
  });

  it('round-trips date range cell edits exactly, then redoes them', async () => {
    await as(USER, () => createTable({ id: TABLE, name: 'history_table' }));
    for (const field of [
      def('stay', 'stay', 'date', { range: true }),
      def('slot', 'slot', 'datetime', { range: true }),
    ])
      await as(USER, () => createTableField(TABLE, field));
    await insert(USER, TABLE, E1, { [TITLE]: 'first' });
    await insert(USER, TABLE, E2, { [TITLE]: 'second' });
    const list = await listTableFields(TABLE);
    const id = (name: string) => fieldNamed(list, name).id;
    await patch(USER, TABLE, E1, {
      [id('stay')]: '2026-10-12/2026-10-15',
      [id('slot')]: '2026-10-12T09:00:00.123456Z/2026-10-12T10:30:00Z',
    });
    await patch(USER, TABLE, E2, { [id('slot')]: '2026-10-13T09:00:00Z' });
    const before = await rows(TABLE);
    const beforeEntry = (await getTableEntry(TABLE, E1)).entry;
    await patch(USER, TABLE, E1, { [id('stay')]: '2026-10-20', [id('slot')]: null });
    await patch(USER, TABLE, E2, { [id('slot')]: '2026-10-13T09:00:00Z/2026-10-13T12:00:00Z' });
    const after = await rows(TABLE);
    expect(after).not.toEqual(before);

    await undo(USER);
    await undo(USER);
    expect(await rows(TABLE)).toEqual(before);
    expect((await getTableEntry(TABLE, E1)).entry).toEqual(beforeEntry);
    expect(before.map((row) => [row.values[id('stay')], row.values[id('slot')]])).toEqual([
      ['2026-10-12/2026-10-15', '2026-10-12T09:00:00.123456Z/2026-10-12T10:30:00.000000Z'],
      [null, '2026-10-13T09:00:00.000000Z'],
    ]);
    await redo(USER);
    await redo(USER);
    expect(await rows(TABLE)).toEqual(after);

    // A deleted row comes back with its range cells exactly.
    await as(USER, () => deleteTableEntries(TABLE, { entryIds: [E1, E2] }));
    expect(await rows(TABLE)).toEqual([]);
    await undo(USER);
    expect(await rows(TABLE)).toEqual(after);
  });

  it('undoes turning End date on and off with the values it rewrote, empty cells included', async () => {
    await as(USER, () => createTable({ id: TABLE, name: 'history_table' }));
    await as(USER, () => createTableField(TABLE, def('day', 'day', 'date')));
    await insert(USER, TABLE, E1, { [TITLE]: 'first' });
    await insert(USER, TABLE, E2, { [TITLE]: 'second' });
    const day = fieldNamed(await listTableFields(TABLE), 'day').id;
    await patch(USER, TABLE, E1, { [day]: '2026-10-12' });
    const snapshot = async () => ({ rows: await rows(TABLE), fields: await fields(TABLE) });
    const physical = async () =>
      (
        await getDb().query<{ type: string }>(
          `SELECT format_type(atttypid, atttypmod) AS type FROM pg_attribute
            WHERE attrelid = 'user_tables.history_table'::regclass AND attname = 'day'`
        )
      ).rows[0]?.type;
    const plain = await snapshot();

    // End date on: undo puts the plain date column back, redo the one-day range.
    await update(USER, TABLE, 'day', { range: true });
    const ranged = await snapshot();
    expect(fieldNamed(await listTableFields(TABLE), 'day')).toMatchObject({ range: true });
    expect(ranged.rows.map((row) => row.values[day])).toEqual(['2026-10-12', null]);
    await undo(USER);
    expect(await snapshot()).toEqual(plain);
    expect(await physical()).toBe('date');
    await redo(USER);
    expect(await snapshot()).toEqual(ranged);
    expect(await physical()).toBe('daterange');

    // End date off keeps each start; undo puts the whole span back.
    await patch(USER, TABLE, E1, { [day]: '2026-10-12/2026-10-14' });
    const spanned = await snapshot();
    await update(USER, TABLE, 'day', { range: false });
    const off = await snapshot();
    expect(off.rows.map((row) => row.values[day])).toEqual(['2026-10-12', null]);
    await undo(USER);
    expect(await snapshot()).toEqual(spanned);
    expect(await physical()).toBe('daterange');
    await redo(USER);
    expect(await snapshot()).toEqual(off);
    expect(await physical()).toBe('date');
    // The empty cell stayed SQL NULL through every retype (never an unbounded range).
    const { rows: empty } = await getDb().query<{ empty: boolean }>(
      `SELECT day IS NULL AS empty FROM user_tables.history_table WHERE id = $1`,
      [E2]
    );
    expect(empty).toEqual([{ empty: true }]);
  });

  it('undoes an entry create (placed above another) and redoes it with the same id, stamp and position', async () => {
    await richTable();
    await insert(USER, TABLE, E3, { [TITLE]: 'third' }, E1);
    const placed = await rows(TABLE);
    expect(placed.map((row) => row.id)).toEqual([E3, E1, E2]);
    await undo(USER);
    expect((await rows(TABLE)).map((row) => row.id)).toEqual([E1, E2]);
    await redo(USER);
    expect(await rows(TABLE)).toEqual(placed);
  });

  it('undoes a bulk delete: same ids, positions, values and the links it cleared', async () => {
    await richTable();
    await as(USER, () => createTable({ id: OTHER, name: 'linking_table' }));
    await as(USER, () =>
      createTableField(OTHER, def('one', 'one', 'relation', { referenceTableId: TABLE }))
    );
    await as(USER, () =>
      createTableField(
        OTHER,
        def('many', 'many', 'relation', {
          referenceTableId: TABLE,
          multiple: true,
          nullable: false,
          defaultValue: [],
        })
      )
    );
    const other = await listTableFields(OTHER);
    await insert(USER, OTHER, B1, {
      [fieldNamed(other, 'one').id]: E1,
      [fieldNamed(other, 'many').id]: [E2, E1],
    });
    await insert(USER, OTHER, B2, { [fieldNamed(other, 'many').id]: [E1] });
    const list = await listTableFields(TABLE);
    await patch(USER, TABLE, E2, {
      [fieldNamed(list, 'links').id]: [E1, E2],
      [fieldNamed(list, 'parent').id]: E1,
    });
    const table = await rows(TABLE);
    const linking = await rows(OTHER);

    const refused = await caught(() =>
      as(USER, () => deleteTableEntries(TABLE, { entryIds: [E1] }))
    );
    expect(refused.statusCode).toBe(409);
    const deleted = await as(USER, () =>
      deleteTableEntries(TABLE, { entryIds: [E1], clearReferences: true })
    );
    expect(deleted.deletedIds).toEqual([E1]);
    expect(await rows(OTHER)).not.toEqual(linking);

    await undo(USER);
    expect(await rows(TABLE)).toEqual(table);
    expect(await rows(OTHER)).toEqual(linking);

    await redo(USER);
    expect((await rows(TABLE)).map((row) => row.id)).toEqual([E2]);
    const cleared = await rows(OTHER);
    expect(cleared.find((row) => row.id === B1)?.values).toMatchObject({
      [fieldNamed(other, 'one').id]: null,
      [fieldNamed(other, 'many').id]: [E2],
    });
  });

  it('round-trips field create, type change, option rename, reorder and delete with their data', async () => {
    await richTable();
    const start = await fields(TABLE);
    // Create, then undo and redo it.
    await as(USER, () => createTableField(TABLE, def('score', 'score', 'text')));
    const withScore = await fields(TABLE);
    await undo(USER);
    expect(await fields(TABLE)).toEqual(start);
    await redo(USER);
    expect(await fields(TABLE)).toEqual(withScore);
    const score = fieldNamed(await listTableFields(TABLE), 'score').id;
    await patch(USER, TABLE, E1, { [score]: '2.50' });
    await patch(USER, TABLE, E2, { [score]: '1' });
    const textRows = await rows(TABLE);
    const textFields = await fields(TABLE);

    // text → number converts the values; undo puts the exact text back.
    await update(USER, TABLE, 'score', { type: 'number' });
    expect(fieldNamed(await listTableFields(TABLE), 'score').type).toBe('number');
    const numberRows = await rows(TABLE);
    await undo(USER);
    expect(await fields(TABLE)).toEqual(textFields);
    expect(await rows(TABLE)).toEqual(textRows);
    await redo(USER);
    expect(await rows(TABLE)).toEqual(numberRows);

    // Renaming an option rewrites the rows; undo restores labels and options.
    const status = fieldNamed(await listTableFields(TABLE), 'status');
    await patch(USER, TABLE, E1, { [status.id]: 'todo' });
    const beforeRename = { rows: await rows(TABLE), fields: await fields(TABLE) };
    await update(USER, TABLE, 'status', {
      options: (status.options ?? []).map((option) =>
        option.label === 'todo' ? { ...option, label: 'doing' } : option
      ),
    });
    expect((await getTableEntry(TABLE, E1)).entry.values[status.id]).toBe('doing');
    await undo(USER);
    expect(await rows(TABLE)).toEqual(beforeRename.rows);
    expect(await fields(TABLE)).toEqual(beforeRename.fields);

    // Reorder.
    const order = (await listTableFields(TABLE)).map((field) => field.id);
    await as(USER, () => reorderTableFields(TABLE, { fieldIds: [...order].reverse() }));
    await undo(USER);
    expect((await listTableFields(TABLE)).map((field) => field.id)).toEqual(order);

    // Delete a populated field: gone from schema and entries, name free; undo
    // brings back its values and slot.
    const beforeDelete = { rows: await rows(TABLE), fields: await fields(TABLE) };
    const notes = fieldNamed(await listTableFields(TABLE), 'notes');
    await patch(USER, TABLE, E2, { [notes.id]: 'kept text' });
    const populated = { rows: await rows(TABLE), fields: await fields(TABLE) };
    await as(USER, () => deleteTableField(TABLE, notes.id));
    expect((await listTableFields(TABLE)).some((field) => field.name === 'notes')).toBe(false);
    expect(Object.keys((await getTableEntry(TABLE, E2)).entry.values)).not.toContain(notes.id);
    await undo(USER);
    expect(await rows(TABLE)).toEqual(populated.rows);
    expect(await fields(TABLE)).toEqual(populated.fields);
    await redo(USER);
    await undo(USER);
    await undo(USER);
    expect(await rows(TABLE)).toEqual(beforeDelete.rows);
  });

  it('deletes the Name field, makes another text field the title, and undoes both', async () => {
    await richTable();
    const title = fieldNamed(await listTableFields(TABLE), 'name');
    const notes = fieldNamed(await listTableFields(TABLE), 'notes');
    const before = await fields(TABLE);
    await as(USER, () => deleteTableField(TABLE, title.id));
    expect((await listTableFields(TABLE)).some((field) => field.isTitle)).toBe(false);
    await as(USER, () => setTableTitleField(TABLE, { fieldId: notes.id }));
    expect(fieldNamed(await listTableFields(TABLE), 'notes').isTitle).toBe(true);
    await undo(USER);
    expect(fieldNamed(await listTableFields(TABLE), 'notes').isTitle).toBe(false);
    await undo(USER);
    expect(await fields(TABLE)).toEqual(before);
    expect(fieldNamed(await listTableFields(TABLE), 'name').isTitle).toBe(true);
  });

  it('undoes a table create and a rename, and redoes both', async () => {
    await as(USER, () => createTable({ id: TABLE, name: 'made_table' }));
    await insert(USER, TABLE, E1, { [TITLE]: 'kept' });
    await as(USER, () => renameTable(TABLE, { name: 'renamed_table', expectedName: 'made_table' }));
    await undo(USER);
    expect((await listTables()).find((table) => table.id === TABLE)?.name).toBe('made_table');
    await undo(USER);
    await undo(USER);
    expect((await listTables()).map((table) => table.id)).not.toContain(TABLE);
    // The name is free while the create is undone.
    expect((await caught(() => listTableEntries(TABLE))).statusCode).toBe(404);
    await redo(USER);
    await redo(USER);
    await redo(USER);
    expect((await listTables()).find((table) => table.id === TABLE)?.name).toBe('renamed_table');
    expect((await rows(TABLE)).map((row) => row.values[TITLE])).toEqual(['kept']);
  });

  it('undoes an agent schema batch as one step, chaining ops on the same field', async () => {
    await as(USER, () => createTable({ id: TABLE, name: 'batch_table' }));
    await insert(USER, TABLE, E1, { [TITLE]: 'kept' });
    const before = await fields(TABLE);
    await as(AGENT, () =>
      applyAgentSchema('batch_table', {
        ops: [
          { op: 'add_field', field: { name: 'score', type: 'text' } },
          { op: 'update_field', name: 'score', set: { name: 'points', type: 'number' } },
          { op: 'archive_field', name: 'points' },
          { op: 'rename_table', name: 'batch_renamed' },
        ],
      })
    );
    const after = await fields(TABLE);
    expect(after.map((field) => field.name)).toEqual(before.map((field) => field.name));
    const agentStack = await listTableHistory({ actorKind: 'agent', actorId: AGENT.actorId });
    expect(agentStack.steps).toHaveLength(1);
    expect(agentStack.steps[0]?.label).toBe('Change table batch_renamed (4 changes)');
    await undo(USER, { actor: stack(AGENT) });
    expect(await fields(TABLE)).toEqual(before);
    expect((await listTables()).find((table) => table.id === TABLE)?.name).toBe('batch_table');
    await redo(USER, { actor: stack(AGENT) });
    expect(await fields(TABLE)).toEqual(after);
    expect(
      (await as(USER, () => listArchivedTableFields(TABLE))).fields.map((field) => field.name)
    ).toEqual(['points']);
    await undo(USER, { actor: stack(AGENT) });
    expect(await fields(TABLE)).toEqual(before);
  });

  it('serializes an undo with a concurrent edit of the same entry: one wins, nothing is lost', async () => {
    await richTable();
    const notes = fieldNamed(await listTableFields(TABLE), 'notes').id;
    await patch(USER, TABLE, E1, { [notes]: 'first' });
    const current = await getTableEntry(TABLE, E1);
    const results = await Promise.allSettled([
      undo(USER),
      as(AGENT, () =>
        updateTableEntry(TABLE, E1, {
          values: { [notes]: 'racing' },
          schemaVersion: current.schemaVersion,
          expectedRevision: current.entry.revision,
        })
      ),
    ]);
    const value = (await getTableEntry(TABLE, E1)).entry.values[notes];
    const [undone, edited] = results;
    if (undone?.status === 'fulfilled') {
      // The undo committed first: the stale edit is refused.
      expect(value).toBeNull();
      expect(edited?.status).toBe('rejected');
    } else {
      // The edit committed first: the undo refuses to overwrite it.
      expect(value).toBe('racing');
      expect(edited?.status).toBe('fulfilled');
      expect((undone as PromiseRejectedResult).reason).toMatchObject({ statusCode: 409 });
    }
  });

  it('keeps one stack per actor, and a person can undo an agent step by naming its stack', async () => {
    await richTable();
    const notes = fieldNamed(await listTableFields(TABLE), 'notes').id;
    await patch(USER, TABLE, E1, { [notes]: 'user edit' });
    await patch(AGENT, TABLE, E2, { [notes]: 'agent edit' });

    const agentStack = await as(USER, () =>
      listTableHistory({ actorKind: 'agent', actorId: AGENT.actorId })
    );
    expect(agentStack.steps).toHaveLength(1);
    expect(agentStack.steps[0]?.actor).toMatchObject({ kind: 'agent', id: AGENT.actorId });

    await undo(USER);
    expect((await getTableEntry(TABLE, E1)).entry.values[notes]).toBeNull();
    expect((await getTableEntry(TABLE, E2)).entry.values[notes]).toBe('agent edit');

    await undo(USER, { actor: stack(AGENT) });
    expect((await getTableEntry(TABLE, E2)).entry.values[notes]).toBeNull();
    const all = await listTableHistory({ actor: 'all', tableId: TABLE });
    expect(all.steps.map((step) => step.actor.kind)).toEqual(
      expect.arrayContaining(['user', 'agent'])
    );
  });

  it('refuses (409) an undo that would overwrite a later change, a taken name or a stale step', async () => {
    await richTable();
    const notes = fieldNamed(await listTableFields(TABLE), 'notes');
    await patch(USER, TABLE, E1, { [notes.id]: 'mine' });
    await patch(AGENT, TABLE, E1, { [notes.id]: 'theirs' });
    const conflict = await caught(() => undo(USER));
    expect(conflict.statusCode).toBe(409);
    expect(conflict.details).toMatchObject({
      reason: 'conflict',
      conflicts: [{ kind: 'entry', tableId: TABLE, id: E1 }],
    });
    expect((await getTableEntry(TABLE, E1)).entry.values[notes.id]).toBe('theirs');
    expect((await as(USER, () => listTableHistory())).undo?.state).toBe('done');

    // Stale: the client showed a step that is no longer next.
    const stale = await caught(() => undo(USER, { stepId: 'tstep-not-next' }));
    expect(stale.details).toMatchObject({ reason: 'stale' });

    // The deleted field's name is taken: ask, then restore under a new name.
    await patch(AGENT, TABLE, E1, { [notes.id]: 'mine' });
    await as(USER, () => deleteTableField(TABLE, notes.id));
    await as(AGENT, () => createTableField(TABLE, def('newnotes', 'notes', 'text')));
    const taken = await caught(() => undo(USER));
    expect(taken.statusCode).toBe(409);
    expect(taken.details).toMatchObject({
      reason: 'nameTaken',
      names: [{ kind: 'field', id: notes.id, name: 'notes' }],
    });
    await undo(USER, { names: { [notes.id]: 'old_notes' } });
    const restored = fieldNamed(await listTableFields(TABLE), 'old_notes');
    expect(restored.id).toBe(notes.id);
    expect((await getTableEntry(TABLE, E1)).entry.values[notes.id]).toBe('mine');

    const empty = await caught(() => redo(AGENT));
    expect(empty.details).toMatchObject({ reason: 'empty' });
  });

  it('keeps 100 steps per actor and drops deleted data once its step leaves the history', async () => {
    await as(USER, () => createTable({ id: TABLE, name: 'prune_table' }));
    await as(USER, () => createTableField(TABLE, def('gone', 'gone', 'text')));
    await as(USER, () => createTableField(TABLE, def('counter', 'counter', 'number')));
    const list = await listTableFields(TABLE);
    await insert(USER, TABLE, E1, { [fieldNamed(list, 'gone').id]: 'data' });
    await as(USER, () => deleteTableField(TABLE, fieldNamed(list, 'gone').id));
    const tombstone = (
      await getDb().query<{ column_name: string }>(
        'SELECT column_name FROM public.table_fields WHERE id = $1',
        [fieldNamed(list, 'gone').id]
      )
    ).rows[0]?.column_name;
    expect(tombstone).toMatch(/^_snaglet_/);

    // Another actor's steps never push this actor's out.
    await patch(AGENT, TABLE, E1, { [fieldNamed(list, 'counter').id]: '-1' });
    let current = (await getTableEntry(TABLE, E1)).entry.revision;
    const version = await schemaVersion(TABLE);
    for (let step = 0; step < 100; step++) {
      const result = await as(USER, () =>
        updateTableEntry(TABLE, E1, {
          values: { [fieldNamed(list, 'counter').id]: String(step) },
          schemaVersion: version,
          expectedRevision: current,
        })
      );
      current = result.entry.revision;
    }
    expect(await historyCount(USER)).toBe(100);
    expect(await historyCount(AGENT)).toBe(1);
    const { rows: purged } = await getDb().query<{ n: number }>(
      'SELECT count(*)::int AS n FROM public.table_fields WHERE id = $1',
      [fieldNamed(list, 'gone').id]
    );
    expect(purged[0]?.n).toBe(0);
    const { rows: column } = await getDb().query<{ n: number }>(
      `SELECT count(*)::int AS n FROM information_schema.columns
        WHERE table_schema = 'user_tables' AND table_name = 'prune_table' AND column_name = $1`,
      [tombstone]
    );
    expect(column[0]?.n).toBe(0);
    const history = await as(USER, () => listTableHistory());
    expect(history.steps).toHaveLength(100);
    expect(history.steps.every((step) => step.kind === 'entry.update')).toBe(true);
  });

  it('discards the redo branch on a new step and drops what only it kept', async () => {
    await as(USER, () => createTable({ id: TABLE, name: 'branch_table' }));
    await as(USER, () => createTableField(TABLE, def('draft', 'draft', 'text')));
    const draft = fieldNamed(await listTableFields(TABLE), 'draft').id;
    await undo(USER);
    expect((await as(USER, () => listTableHistory())).redo?.kind).toBe('field.create');
    await insert(USER, TABLE, E1, { [TITLE]: 'new step' });
    const history = await as(USER, () => listTableHistory());
    expect(history.redo).toBeNull();
    const { rows: gone } = await getDb().query<{ n: number }>(
      'SELECT count(*)::int AS n FROM public.table_fields WHERE id = $1',
      [draft]
    );
    expect(gone[0]?.n).toBe(0);
  });

  it('serves the history routes for the caller, with 409 details on a conflict', async () => {
    await richTable();
    const app = express();
    app.use(express.json());
    app.use((_req, _res, next) => runWithActor(USER, () => next()));
    app.use('/api/tables', tablesRouter);
    app.use(errorHandler);
    const notes = fieldNamed(await listTableFields(TABLE), 'notes').id;
    await patch(USER, TABLE, E1, { [notes]: 'via route' });

    const listed = await request(app).get('/api/tables/history?limit=5');
    expect(listed.status).toBe(200);
    expect(listed.body.data.undo).toMatchObject({ kind: 'entry.update' });
    expect(listed.body.data.depth).toBe(100);
    const undone = await request(app)
      .post('/api/tables/history/undo')
      .send({ stepId: listed.body.data.undo.id });
    expect(undone.status).toBe(200);
    expect(undone.body.data.redo.id).toBe(listed.body.data.undo.id);
    const redone = await request(app).post('/api/tables/history/redo').send({});
    expect(redone.status).toBe(200);
    await patch(AGENT, TABLE, E1, { [notes]: 'agent' });
    const conflict = await request(app).post('/api/tables/history/undo').send({});
    expect(conflict.status).toBe(409);
    expect(conflict.body.error.details).toMatchObject({ reason: 'conflict' });
    const bad = await request(app)
      .post('/api/tables/history/undo')
      .send({ actor: { kind: 'x' } });
    expect(bad.status).toBe(400);
  });
});
