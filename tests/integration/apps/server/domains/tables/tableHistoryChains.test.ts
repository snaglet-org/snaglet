/**
 * Undo and redo chains over field and table edits, against real PostgreSQL:
 * several steps on one field (or table) undo one after another and redo
 * again, every state exact. Each step checks that the field is still as that
 * step left it, not the revision it had before the stack's other steps ran,
 * so a change by someone else in between still refuses (409) and writes
 * nothing.
 */
import { afterAll, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { getDb, quoteIdentifier } from '@snaglet/db';
import type { Actor } from '@snaglet/shared/types/workspace-events';
import type { TableEntryValues, TableField, TableFieldRecurrence } from '@snaglet/shared/types';

jest.mock('@server/realtime/surfaces/tables', () => ({
  emitTableCreated: () => undefined,
  emitTableUpdated: () => undefined,
  emitTableFieldsChanged: () => undefined,
  emitTableEntriesChanged: () => undefined,
  emitTableRemoved: () => undefined,
  emitTableRestored: () => undefined,
  emitTableHistoryChanged: () => undefined,
}));

import { runWithActor } from '@server/realtime/actorContext';
import { createTable, listTables, renameTable } from '@server/domains/tables/tableCatalog';
import {
  createTableField,
  listTableFields,
  updateTableField,
} from '@server/domains/tables/tableFields';
import {
  createTableEntry,
  getTableEntry,
  listTableEntries,
  updateTableEntry,
} from '@server/domains/tables/tableEntries';
import { stepTableHistory } from '@server/domains/tables/tableHistory';
import {
  archiveTableField,
  deleteTableField,
  listArchivedTableFields,
  restoreTableField,
  setTableTitleField,
} from '@server/domains/tables/tableLifecycle';

const USER: Actor = { actorKind: 'user', actorId: 'test-user-a', actorName: 'Test User' };
const AGENT: Actor = { actorKind: 'agent', actorId: 'test-agent-a', actorName: 'test-agent-a' };
const TABLE = 'table-1111111111111-chainaaa';
const TITLE = `field-title-${TABLE}`;
const E1 = '11111111-1111-4111-8111-111111111111';
const E2 = '22222222-2222-4222-8222-222222222222';
const ID = {
  day: 'field-1111111111111-day',
  status: 'field-1111111111111-status',
  notes: 'field-1111111111111-notes',
  score: 'field-1111111111111-score',
};

const as = <T>(actor: Actor, fn: () => Promise<T>): Promise<T> => runWithActor(actor, fn);

async function clean(): Promise<void> {
  const { rows } = await getDb().query<{ table_name: string }>(
    "SELECT table_name FROM public.table_catalog WHERE origin = 'custom'"
  );
  for (const row of rows)
    await getDb().query(
      `DROP TABLE IF EXISTS user_tables.${quoteIdentifier(row.table_name)} CASCADE`
    );
  await getDb().query(
    "DELETE FROM public.table_entry_repeats WHERE table_id IN (SELECT id FROM public.table_catalog WHERE origin = 'custom')"
  );
  await getDb().query(
    "DELETE FROM public.table_fields WHERE table_id IN (SELECT id FROM public.table_catalog WHERE origin = 'custom')"
  );
  await getDb().query("DELETE FROM public.table_catalog WHERE origin = 'custom'");
  await getDb().query('DELETE FROM public.table_history');
}

function def(id: string, name: string, type: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    name,
    description: null,
    type,
    nullable: true,
    defaultValue: null,
    referenceTableId: null,
    ...extra,
  };
}

async function field(id: string): Promise<TableField> {
  const found = (await listTableFields(TABLE)).find((candidate) => candidate.id === id);
  if (!found) throw new Error(`missing field ${id}`);
  return found;
}

/** Edit a field as `actor`: its current definition with `changes` applied. */
async function edit(id: string, changes: Record<string, unknown>, actor: Actor = USER) {
  const current = await field(id);
  return as(actor, () =>
    updateTableField(TABLE, id, {
      name: current.name,
      description: current.description,
      type: current.type,
      nullable: current.nullable,
      defaultValue: current.defaultValue,
      referenceTableId: current.referenceTableId,
      ...changes,
      expectedRevision: current.revision,
    })
  );
}

async function insert(id: string, values: TableEntryValues = {}) {
  const { schemaVersion } = await listTableEntries(TABLE);
  return as(USER, () => createTableEntry(TABLE, { id, values, schemaVersion }));
}

async function patch(id: string, values: TableEntryValues) {
  const current = await getTableEntry(TABLE, id);
  return as(USER, () =>
    updateTableEntry(TABLE, id, {
      values,
      schemaVersion: current.schemaVersion,
      expectedRevision: current.entry.revision,
    })
  );
}

async function caught(action: () => Promise<unknown>) {
  try {
    await action();
  } catch (error) {
    return error as { statusCode?: number; message: string; details?: Record<string, unknown> };
  }
  throw new Error('expected a rejection');
}

/** Everything a step can change: the table's name, fields, entries and rows' repeats. */
async function snapshot() {
  const name = (await listTables()).find((table) => table.id === TABLE)?.name;
  const fields = (await listTableFields(TABLE)).map(({ revision: _revision, ...rest }) => rest);
  const archived = (await listArchivedTableFields(TABLE)).fields.map(
    ({ revision: _revision, archivedAt: _at, ...rest }) => rest
  );
  const page = await listTableEntries(TABLE, { pageSize: '100' });
  const entries = page.entries.map(({ id, values }) => ({ id, values }));
  const { rows: repeats } = await getDb().query<{ field_id: string; entry_id: string }>(
    `SELECT field_id, entry_id, value FROM public.table_entry_repeats
      WHERE table_id = $1 ORDER BY field_id, entry_id`,
    [TABLE]
  );
  return { name, fields, archived, entries, repeats };
}

async function stackSize(): Promise<number> {
  const { rows } = await getDb().query<{ n: number }>(
    "SELECT count(*)::int AS n FROM public.table_history WHERE actor_kind = 'user' AND actor_id = $1",
    [USER.actorId]
  );
  return rows[0]?.n ?? 0;
}

async function step(direction: 'undo' | 'redo', label: string): Promise<void> {
  try {
    await as(USER, () => stepTableHistory(direction, {}));
  } catch (error) {
    throw new Error(`${direction} of step ${label}: ${(error as Error).message}`);
  }
}

/**
 * Run each named action (one undoable step each), then undo them all,
 * newest first, and redo them all, checking every state exactly.
 */
async function roundTrip(actions: Array<[string, () => Promise<unknown>]>): Promise<void> {
  const states = [await snapshot()];
  const size = await stackSize();
  for (const [, action] of actions) {
    await action();
    states.push(await snapshot());
  }
  expect(await stackSize()).toBe(size + actions.length);
  const labels = actions.map(([label]) => label);
  // `after` names the step in a failing diff.
  for (let index = actions.length; index > 0; index--) {
    const label = labels[index - 1]!;
    await step('undo', label);
    expect({ after: `undo ${label}`, ...(await snapshot()) }).toEqual({
      after: `undo ${label}`,
      ...states[index - 1],
    });
  }
  for (let index = 1; index <= actions.length; index++) {
    const label = labels[index - 1]!;
    await step('redo', label);
    expect({ after: `redo ${label}`, ...(await snapshot()) }).toEqual({
      after: `redo ${label}`,
      ...states[index],
    });
  }
}

let todo = '';
let done = '';

function setting(): TableFieldRecurrence {
  return { statusFieldId: ID.status, doneOptionIds: [done], resetOptionId: todo };
}

async function setup(): Promise<void> {
  await as(USER, () => createTable({ id: TABLE, name: 'chain_table' }));
  for (const body of [
    def(ID.day, 'day', 'date'),
    def(ID.status, 'status', 'select', { options: [{ label: 'todo' }, { label: 'done' }] }),
    def(ID.notes, 'notes', 'text'),
  ])
    await as(USER, () => createTableField(TABLE, body));
  const status = await field(ID.status);
  const byLabel = new Map((status.options ?? []).map((option) => [option.label, option.id]));
  todo = byLabel.get('todo')!;
  done = byLabel.get('done')!;
  await insert(E1, { [TITLE]: 'first', [ID.day]: '2026-10-05', [ID.status]: 'todo' });
  await insert(E2, { [TITLE]: 'second', [ID.notes]: 'kept' });
}

describe('undo and redo chains of field and table steps (real DB)', () => {
  beforeEach(async () => {
    await clean();
    await setup();
  });
  afterAll(clean);

  it('undoes two description edits of one field one after the other, then redoes both', async () => {
    await roundTrip([
      ['description 1', () => edit(ID.notes, { description: 'first' })],
      ['description 2', () => edit(ID.notes, { description: 'second' })],
    ]);
    expect((await field(ID.notes)).description).toBe('second');
  });

  it('chains every kind of edit to one field: rename, End date, repeat, retype with data', async () => {
    // Date fields start repeat-capable; start this chain with the field's repeat off,
    // so "repeat on" below is the step that takes and gives back the rows' repeats.
    await edit(ID.day, { recurrence: null });
    await roundTrip([
      ['description', () => edit(ID.day, { description: 'when' })],
      ['rename', () => edit(ID.day, { name: 'starts' })],
      ['End date on', () => edit(ID.day, { range: true })],
      ['range cell', () => patch(E1, { [ID.day]: '2026-10-05/2026-10-07' })],
      ['End date off', () => edit(ID.day, { range: false })],
      [
        'repeat on',
        async () => {
          await edit(ID.day, { recurrence: setting() });
          // A row's repeat (written outside history), held by the steps that turn repeat off.
          await getDb().query(
            `INSERT INTO public.table_entry_repeats (table_id, field_id, entry_id, value)
             VALUES ($1, $2, $3, '{"rrule":"FREQ=DAILY"}'::jsonb)`,
            [TABLE, ID.day, E1]
          );
        },
      ],
      ['repeat off', () => edit(ID.day, { recurrence: null })],
      ['date to text', () => edit(ID.day, { type: 'text' })],
      ['description again', () => edit(ID.day, { description: null })],
      [
        'option rename',
        async () => {
          const status = await field(ID.status);
          return edit(ID.status, {
            options: (status.options ?? []).map((option) =>
              option.label === 'todo' ? { ...option, label: 'doing' } : option
            ),
          });
        },
      ],
      [
        'option added',
        async () => {
          const status = await field(ID.status);
          return edit(ID.status, { options: [...(status.options ?? []), { label: 'later' }] });
        },
      ],
      ['text to date', () => edit(ID.day, { type: 'date' })],
    ]);
    expect(await field(ID.day)).toMatchObject({ name: 'starts', type: 'date', range: false });
    expect((await getTableEntry(TABLE, E1)).entry.values[ID.status]).toBe('doing');
  });

  it('chains a field create, edits, archive, restore and delete', async () => {
    await roundTrip([
      ['create', () => as(USER, () => createTableField(TABLE, def(ID.score, 'score', 'text')))],
      ['cell', () => patch(E1, { [ID.score]: 'ten' })],
      ['description', () => edit(ID.score, { description: 'points' })],
      ['archive', () => as(USER, () => archiveTableField(TABLE, ID.score))],
      ['restore', () => as(USER, () => restoreTableField(TABLE, ID.score, {}))],
      ['rename', () => edit(ID.score, { name: 'points' })],
      ['delete', () => as(USER, () => deleteTableField(TABLE, ID.score))],
    ]);
  });

  it('chains table renames with Name field edits and Name field changes', async () => {
    await roundTrip([
      [
        'rename table 1',
        () =>
          as(USER, () => renameTable(TABLE, { name: 'chain_two', expectedName: 'chain_table' })),
      ],
      ['Name description', () => edit(TITLE, { description: 'what it is' })],
      ['Name rename', () => edit(TITLE, { name: 'title' })],
      ['notes is the Name', () => as(USER, () => setTableTitleField(TABLE, { fieldId: ID.notes }))],
      [
        'rename table 2',
        () =>
          as(USER, () => renameTable(TABLE, { name: 'chain_three', expectedName: 'chain_two' })),
      ],
      ['notes description', () => edit(ID.notes, { description: 'the name now' })],
      ['title is the Name', () => as(USER, () => setTableTitleField(TABLE, { fieldId: TITLE }))],
      ['Name description 2', () => edit(TITLE, { description: null })],
    ]);
  });

  it('still refuses (409) a chained undo when someone else changed the field in between', async () => {
    await edit(ID.notes, { description: 'mine 1' });
    await edit(ID.notes, { description: 'mine 2' });
    await step('undo', 'mine 2');
    await edit(ID.notes, { description: 'theirs' }, AGENT);
    const refused = await caught(() => as(USER, () => stepTableHistory('undo', {})));
    expect(refused.statusCode).toBe(409);
    expect(refused.message).toBe('The field notes changed since.');
    expect(refused.details).toMatchObject({
      reason: 'conflict',
      conflicts: [{ kind: 'field', tableId: TABLE, id: ID.notes }],
    });
    expect((await field(ID.notes)).description).toBe('theirs');
  });

  it('still refuses (409) a chained redo when someone else changed the field in between', async () => {
    await edit(ID.notes, { description: 'mine 1' });
    await edit(ID.notes, { description: 'mine 2' });
    await step('undo', 'mine 2');
    await step('undo', 'mine 1');
    await step('redo', 'mine 1');
    await edit(ID.notes, { name: 'their_notes' }, AGENT);
    const refused = await caught(() => as(USER, () => stepTableHistory('redo', {})));
    expect(refused.statusCode).toBe(409);
    expect(refused.details).toMatchObject({ reason: 'conflict' });
    expect(await field(ID.notes)).toMatchObject({ name: 'their_notes', description: 'mine 1' });
  });

  it('still refuses (409) undoing a create or redoing an archive of a field edited by someone else', async () => {
    await as(USER, () => createTableField(TABLE, def(ID.score, 'score', 'text')));
    await edit(ID.score, { description: 'mine' });
    await step('undo', 'description');
    await edit(ID.score, { name: 'their_score' }, AGENT);
    const create = await caught(() => as(USER, () => stepTableHistory('undo', {})));
    expect(create.statusCode).toBe(409);
    expect(create.message).toBe('The field their_score changed since.');
    expect((await field(ID.score)).name).toBe('their_score');

    await edit(ID.notes, { description: 'mine' });
    await as(USER, () => archiveTableField(TABLE, ID.notes));
    await step('undo', 'archive');
    await edit(ID.notes, { description: 'theirs' }, AGENT);
    const archive = await caught(() => as(USER, () => stepTableHistory('redo', {})));
    expect(archive.statusCode).toBe(409);
    expect((await field(ID.notes)).description).toBe('theirs');
  });

  it('undoes a field create step stored without its definition, by its revision', async () => {
    await as(USER, () => createTableField(TABLE, def(ID.score, 'score', 'text')));
    const newest = `actor_id = $1 AND seq = (SELECT max(seq) FROM public.table_history WHERE actor_id = $1)`;
    await getDb().query(
      `UPDATE public.table_history
          SET ops = (SELECT jsonb_agg(op - 'definition') FROM jsonb_array_elements(ops) AS op)
        WHERE ${newest}`,
      [USER.actorId]
    );
    await step('undo', 'create');
    expect((await listTableFields(TABLE)).map((one) => one.id)).not.toContain(ID.score);
    await step('redo', 'create');
    // Applying it once records the definition, so it chains from then on.
    const { rows } = await getDb().query<{ ops: Array<Record<string, unknown>> }>(
      `SELECT ops FROM public.table_history WHERE ${newest}`,
      [USER.actorId]
    );
    expect(rows[0]?.ops[0]?.definition).toMatchObject({ name: 'score', type: 'text' });
    await edit(ID.score, { description: 'points' });
    await step('undo', 'description');
    await step('undo', 'create');
    expect((await listTableFields(TABLE)).map((one) => one.id)).not.toContain(ID.score);
  });

  it('undoes a field edit past a calendar binding made since, and refuses a retype the binding forbids', async () => {
    await edit(ID.day, { description: 'when' });
    await edit(ID.day, { calendarId: 'default' });
    const bound = (await field(ID.day)).calendarId;
    expect(bound).toEqual(expect.any(String));
    // The binding is not part of the step, so undo leaves it as it is.
    await step('undo', 'description');
    expect(await field(ID.day)).toMatchObject({ description: null, calendarId: bound });
    await step('redo', 'description');

    await as(USER, () => createTableField(TABLE, def(ID.score, 'score', 'text')));
    await edit(ID.score, { type: 'date' });
    await edit(ID.score, { calendarId: bound });
    const refused = await caught(() => as(USER, () => stepTableHistory('undo', {})));
    expect(refused.statusCode).toBe(409);
    expect(refused.message).toBe(
      'The field score is on a calendar now, so it cannot change to text. Take it off the calendar first.'
    );
    expect(refused.details).toMatchObject({
      reason: 'conflict',
      conflicts: [{ kind: 'field', tableId: TABLE, id: ID.score }],
    });
    expect(await field(ID.score)).toMatchObject({ type: 'date', calendarId: bound });
  });
});
