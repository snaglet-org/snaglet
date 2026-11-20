/**
 * Repeating date fields: the field-level `recurrence`
 * setting against real PostgreSQL. The setting names a
 * single select of the same table by id; Snaglet keeps that reference true across
 * edits, archive/delete and restore, and undo/redo round-trips the setting and
 * the rows' repeats that turning it off removes.
 */
import { afterAll, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { getDb, quoteIdentifier } from '@snaglet/db';
import type { Actor } from '@snaglet/shared/types/workspace-events';
import type { TableField, TableFieldRecurrence } from '@snaglet/shared/types';

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
import { createTable } from '@server/domains/tables/tableCatalog';
import {
  createTableField,
  listTableFields,
  updateTableField,
} from '@server/domains/tables/tableFields';
import { createTableEntry, listTableEntries } from '@server/domains/tables/tableEntries';
import { stepTableHistory } from '@server/domains/tables/tableHistory';
import {
  archiveTableField,
  deleteTableField,
  restoreTableField,
} from '@server/domains/tables/tableLifecycle';

const USER: Actor = { actorKind: 'user', actorId: 'test-user-recur', actorName: 'Test User' };
const OTHER_ACTOR: Actor = { actorKind: 'agent', actorId: 'test-agent-recur', actorName: 'agent' };
const TABLE = 'table-1111111111111-recuraaa';
const OTHER = 'table-1111111111111-recurbbb';
const E1 = '11111111-1111-4111-8111-111111111111';
const E2 = '22222222-2222-4222-8222-222222222222';
const as = <T>(fn: () => Promise<T>): Promise<T> => runWithActor(USER, fn);
const undo = () => as(() => stepTableHistory('undo', {}));
const redo = () => as(() => stepTableHistory('redo', {}));

const ID = {
  due: 'field-1111111111111-due',
  day: 'field-1111111111111-day',
  status: 'field-1111111111111-status',
  tags: 'field-1111111111111-tags',
  notes: 'field-1111111111111-notes',
  other: 'field-1111111111111-other',
};

async function clean(): Promise<void> {
  const { rows } = await getDb().query<{ table_name: string }>(
    'SELECT table_name FROM public.table_catalog WHERE id = ANY($1::text[])',
    [[TABLE, OTHER]]
  );
  for (const row of rows)
    await getDb().query(
      `DROP TABLE IF EXISTS user_tables.${quoteIdentifier(row.table_name)} CASCADE`
    );
  await getDb().query('DELETE FROM public.table_entry_repeats WHERE table_id = ANY($1::text[])', [
    [TABLE, OTHER],
  ]);
  await getDb().query('DELETE FROM public.table_fields WHERE table_id = ANY($1::text[])', [
    [TABLE, OTHER],
  ]);
  await getDb().query('DELETE FROM public.table_catalog WHERE id = ANY($1::text[])', [
    [TABLE, OTHER],
  ]);
  await getDb().query('DELETE FROM public.table_history WHERE actor_id = ANY($1::text[])', [
    [USER.actorId, OTHER_ACTOR.actorId],
  ]);
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

async function field(id: string, tableId = TABLE): Promise<TableField> {
  const found = (await listTableFields(tableId)).find((candidate) => candidate.id === id);
  if (!found) throw new Error(`missing field ${id}`);
  return found;
}

/** The field's current definition as an update body, with `patch` applied. */
async function edit(id: string, patch: Record<string, unknown>) {
  const current = await field(id);
  const body = {
    name: current.name,
    description: current.description,
    type: current.type,
    nullable: current.nullable,
    defaultValue: current.defaultValue,
    referenceTableId: current.referenceTableId,
    expectedRevision: current.revision,
    ...patch,
  };
  return as(() => updateTableField(TABLE, id, body));
}

async function caught(action: () => Promise<unknown>) {
  try {
    await action();
  } catch (error) {
    return error as { statusCode?: number; message: string };
  }
  throw new Error('expected a rejection');
}

let todo = '';
let done = '';
let skipped = '';

/** What every date field starts with: repeat-capable, done by the Done button. */
const DEFAULT_SETTING: TableFieldRecurrence = {
  statusFieldId: null,
  doneOptionIds: [],
  resetOptionId: null,
};

function setting(patch: Partial<TableFieldRecurrence> = {}): TableFieldRecurrence {
  return {
    statusFieldId: ID.status,
    doneOptionIds: [done],
    resetOptionId: todo,
    ...patch,
  };
}

async function repeats(fieldId: string): Promise<Array<{ entry_id: string; value: unknown }>> {
  const { rows } = await getDb().query<{ entry_id: string; value: unknown }>(
    'SELECT entry_id, value FROM public.table_entry_repeats WHERE field_id = $1 ORDER BY entry_id',
    [fieldId]
  );
  return rows;
}

async function setup(): Promise<void> {
  await as(() => createTable({ id: TABLE, name: 'recurring_table' }));
  for (const body of [
    def(ID.due, 'due', 'datetime'),
    def(ID.day, 'day', 'date'),
    def(ID.status, 'status', 'select', {
      options: [{ label: 'todo' }, { label: 'done' }, { label: 'skipped' }],
    }),
    def(ID.tags, 'tags', 'select', {
      multiple: true,
      nullable: false,
      defaultValue: [],
      options: [{ label: 'a' }],
    }),
    def(ID.notes, 'notes', 'text'),
  ])
    await as(() => createTableField(TABLE, body));
  const status = await field(ID.status);
  const byLabel = new Map((status.options ?? []).map((option) => [option.label, option.id]));
  todo = byLabel.get('todo')!;
  done = byLabel.get('done')!;
  skipped = byLabel.get('skipped')!;
  for (const id of [E1, E2]) {
    const { schemaVersion } = await listTableEntries(TABLE);
    await as(() =>
      createTableEntry(TABLE, { id, values: { [ID.day]: '2026-10-05' }, schemaVersion })
    );
  }
}

describe('repeating date fields: the field setting (real DB)', () => {
  beforeEach(async () => {
    await clean();
    await setup();
  });
  afterAll(clean);

  it('sets, reads back and clears a repeat setting; other fields carry no recurrence key', async () => {
    const updated = await edit(ID.day, { recurrence: setting() });
    expect(updated.recurrence).toEqual(setting());
    expect((await field(ID.day)).recurrence).toEqual(setting());
    expect('recurrence' in (await field(ID.notes))).toBe(false);
    // Left out, it stays (a client editing only the name keeps it).
    expect((await edit(ID.day, { description: 'when' })).recurrence).toEqual(setting());
    const cleared = await edit(ID.day, { recurrence: null });
    expect('recurrence' in cleared).toBe(false);
    const { rows } = await getDb().query<{ recurrence: unknown }>(
      'SELECT recurrence FROM public.table_fields WHERE id = $1',
      [ID.day]
    );
    expect(rows[0]?.recurrence).toBeNull();
  });

  it('ignores a week start stored in the setting, and never writes one', async () => {
    const stored = async () =>
      (
        await getDb().query<{ recurrence: Record<string, unknown> | null }>(
          'SELECT recurrence FROM public.table_fields WHERE id = $1',
          [ID.day]
        )
      ).rows[0]?.recurrence;
    await getDb().query(
      `UPDATE public.table_fields SET recurrence = jsonb_set(recurrence, '{weekStart}', '"SU"')
        WHERE id = $1`,
      [ID.day]
    );
    expect(await stored()).toMatchObject({ weekStart: 'SU' });
    // Read: the setting has no week start (repeats start weeks on Monday).
    expect((await field(ID.day)).recurrence).toEqual(DEFAULT_SETTING);
    // Write: the next save of the field stores the setting without it.
    expect((await edit(ID.day, { description: 'when' })).recurrence).toEqual(DEFAULT_SETTING);
    expect(await stored()).toEqual(DEFAULT_SETTING);
  });

  it('can be set when the field is created', async () => {
    const created = await as(() =>
      createTableField(
        TABLE,
        def('field-1111111111111-later', 'later', 'date', { recurrence: setting() })
      )
    );
    expect(created.field.recurrence).toEqual(setting());
  });

  it('rejects malformed and dangling settings (400)', async () => {
    const cases: Array<[string, Record<string, unknown>, string]> = [
      ['not a date', { recurrence: setting() }, 'Only date and datetime'],
      ['no done', { recurrence: setting({ doneOptionIds: [] }) }, 'doneOptionIds'],
      ['reset is done', { recurrence: setting({ resetOptionId: done }) }, 'cannot be one'],
      ['a week start', { recurrence: { ...setting(), weekStart: 'MO' } }, 'no weekStart'],
      ['unknown key', { recurrence: { ...setting(), extra: 1 } }, 'no extra'],
    ];
    for (const [label, patch, message] of cases) {
      const target = label === 'not a date' ? ID.notes : ID.day;
      const error = await caught(() => edit(target, patch));
      expect({ label, status: error.statusCode, message: error.message }).toMatchObject({
        label,
        status: 400,
        message: expect.stringContaining(message),
      });
    }
    // References are checked against the table under its lock.
    const references: Array<[TableFieldRecurrence, string]> = [
      [setting({ statusFieldId: ID.notes }), 'single select'],
      [setting({ statusFieldId: ID.tags }), 'single select'],
      [setting({ statusFieldId: 'field-1111111111111-nope' }), 'not a field of this table'],
      [setting({ doneOptionIds: ['opt-not-an-option'] }), 'Choose the done'],
    ];
    for (const [value, message] of references) {
      const error = await caught(() => edit(ID.day, { recurrence: value }));
      expect({ status: error.statusCode, message: error.message }).toEqual({
        status: 400,
        message: expect.stringContaining(message),
      });
    }
    // A status field of another table is not this table's.
    await as(() => createTable({ id: OTHER, name: 'other_table' }));
    await as(() =>
      createTableField(OTHER, def(ID.other, 'state', 'select', { options: [{ label: 'x' }] }))
    );
    const foreign = await caught(() =>
      edit(ID.day, { recurrence: setting({ statusFieldId: ID.other }) })
    );
    expect(foreign.statusCode).toBe(400);
    // Nothing was written: the field keeps the default setting it started with.
    expect((await field(ID.day)).recurrence).toEqual(DEFAULT_SETTING);
  });

  it('keeps the status field consistent with every repeat that names it', async () => {
    await edit(ID.day, { recurrence: setting() });
    const status = await field(ID.status);
    // Renaming the field and its options is fine: the setting holds ids.
    const renamed = await edit(ID.status, {
      name: 'state',
      options: (status.options ?? []).map((option) =>
        option.id === done
          ? { id: option.id, label: 'finished' }
          : { id: option.id, label: option.label }
      ),
    });
    expect(renamed.name).toBe('state');
    expect((await field(ID.day)).recurrence).toEqual(setting());
    // Dropping an option the repeat uses, or changing shape, is refused.
    const dropDone = await caught(() =>
      edit(ID.status, {
        options: (renamed.options ?? [])
          .filter((option) => option.id !== done)
          .map(({ id, label }) => ({ id, label })),
      })
    );
    expect(dropDone).toMatchObject({ statusCode: 409 });
    expect(dropDone.message).toContain('Turn off');
    // An unused option can go.
    await edit(ID.status, {
      options: (renamed.options ?? [])
        .filter((option) => option.id !== skipped)
        .map(({ id, label }) => ({ id, label })),
    });
    expect(
      await caught(() => edit(ID.status, { type: 'text', options: null, defaultValue: null }))
    ).toMatchObject({ statusCode: 409 });
    expect(
      await caught(() => edit(ID.status, { multiple: true, nullable: false, defaultValue: [] }))
    ).toMatchObject({ statusCode: 409 });
    // Archive and delete are refused too, while any repeat names it.
    expect(await caught(() => as(() => archiveTableField(TABLE, ID.status)))).toMatchObject({
      statusCode: 409,
    });
    expect(await caught(() => as(() => deleteTableField(TABLE, ID.status)))).toMatchObject({
      statusCode: 409,
    });
    // Also while the repeating field itself is archived (it can come back).
    await as(() => archiveTableField(TABLE, ID.day));
    expect(await caught(() => as(() => archiveTableField(TABLE, ID.status)))).toMatchObject({
      statusCode: 409,
    });
    await as(() => restoreTableField(TABLE, ID.day, {}));
    await edit(ID.day, { recurrence: null });
    await as(() => archiveTableField(TABLE, ID.status));
    expect((await field(ID.status).catch(() => null)) ?? 'archived').toBe('archived');
  });

  it('a repeating field can change type: its rows’ repeats go, the setting stays; undo and redo follow', async () => {
    await edit(ID.day, { recurrence: setting() });
    const value = {
      rrule: 'FREQ=WEEKLY;BYDAY=MO',
      dtstart: '2026-10-05',
      current: '2026-10-05',
      tz: 'UTC',
    };
    await getDb().query(
      `INSERT INTO public.table_entry_repeats (table_id, field_id, entry_id, value)
       VALUES ($1, $2, $3, $4::jsonb)`,
      [TABLE, ID.day, E1, JSON.stringify(value)]
    );
    const changed = await edit(ID.day, { type: 'datetime' });
    expect(changed.type).toBe('datetime');
    expect(changed.recurrence).toEqual(setting());
    // The rows' repeats were wall dates of the old type.
    expect(await repeats(ID.day)).toEqual([]);
    await undo();
    expect((await field(ID.day)).type).toBe('date');
    expect((await repeats(ID.day)).map((row) => [row.entry_id, row.value])).toEqual([[E1, value]]);
    await redo();
    expect((await field(ID.day)).type).toBe('datetime');
    expect(await repeats(ID.day)).toEqual([]);
    await undo();
    expect((await repeats(ID.day)).length).toBe(1);
  });

  it('a field made a date from another type starts repeat-capable; one made a non-date loses the setting', async () => {
    // A datetime field can repeat too.
    expect((await edit(ID.due, { recurrence: { ...DEFAULT_SETTING } })).recurrence).toEqual({
      ...DEFAULT_SETTING,
    });
    expect((await edit(ID.status, { type: 'text', options: null, defaultValue: null })).type).toBe(
      'text'
    );
    const asDate = await edit(ID.status, { type: 'date', defaultValue: null });
    expect(asDate.recurrence).toMatchObject({ statusFieldId: null, doneOptionIds: [] });
    const asText = await edit(ID.status, { type: 'text', defaultValue: null });
    expect('recurrence' in asText).toBe(false);
  });

  it('turning repeat off removes the rows’ repeats; undo puts them back, redo removes them again', async () => {
    await edit(ID.day, { recurrence: setting() });
    const value = {
      rrule: 'FREQ=WEEKLY;BYDAY=MO',
      dtstart: '2026-10-05',
      current: '2026-10-05',
      tz: 'UTC',
    };
    await getDb().query(
      `INSERT INTO public.table_entry_repeats (table_id, field_id, entry_id, value)
       VALUES ($1, $2, $3, $4::jsonb), ($1, $2, $5, $4::jsonb)`,
      [TABLE, ID.day, E1, JSON.stringify(value), E2]
    );
    await edit(ID.day, { recurrence: null });
    expect(await repeats(ID.day)).toEqual([]);
    const first = await undo().catch((error: unknown) => error);
    if (first instanceof Error) throw new Error(`first undo: ${first.message}`);
    expect((await field(ID.day)).recurrence).toEqual(setting());
    expect((await repeats(ID.day)).map((row) => [row.entry_id, row.value])).toEqual([
      [E1, value],
      [E2, value],
    ]);
    await redo().catch((error: Error) => {
      throw new Error(`first redo: ${error.message}`);
    });
    expect((await field(ID.day)).recurrence).toBeUndefined();
    expect(await repeats(ID.day)).toEqual([]);
    await undo().catch((error: Error) => {
      throw new Error(`second undo: ${error.message}`);
    });
    expect((await repeats(ID.day)).length).toBe(2);
  });

  it('undoing the edit that turned repeat on takes the rows’ repeats; redo puts them back', async () => {
    // Repeat starts on for a date field; turn it off, then on again, and undo that last edit.
    await edit(ID.day, { recurrence: null });
    await edit(ID.day, { recurrence: setting() });
    await getDb().query(
      `INSERT INTO public.table_entry_repeats (table_id, field_id, entry_id, value)
       VALUES ($1, $2, $3, '{"rrule":"FREQ=DAILY"}'::jsonb)`,
      [TABLE, ID.day, E1]
    );
    await undo();
    expect((await field(ID.day)).recurrence).toBeUndefined();
    expect(await repeats(ID.day)).toEqual([]);
    await redo();
    expect((await field(ID.day)).recurrence).toEqual(setting());
    expect((await repeats(ID.day)).map((row) => row.entry_id)).toEqual([E1]);
  });

  it('undo that would put back a setting whose status field no longer fits refuses (409)', async () => {
    await edit(ID.day, { recurrence: setting() });
    await edit(ID.day, { recurrence: null });
    // Someone else then makes the status field a text field.
    const current = await field(ID.status);
    await runWithActor(OTHER_ACTOR, () =>
      updateTableField(TABLE, ID.status, {
        name: current.name,
        description: current.description,
        type: 'text',
        nullable: true,
        defaultValue: null,
        referenceTableId: null,
        options: null,
        expectedRevision: current.revision,
      })
    );
    const error = await caught(() => undo());
    expect(error).toMatchObject({ statusCode: 409 });
    expect((await field(ID.day)).recurrence).toBeUndefined();
  });

  it('a field purge cascades its rows’ repeats', async () => {
    await edit(ID.day, { recurrence: setting() });
    await getDb().query(
      `INSERT INTO public.table_entry_repeats (table_id, field_id, entry_id, value)
       VALUES ($1, $2, $3, '{"rrule":"FREQ=DAILY"}'::jsonb)`,
      [TABLE, ID.day, E1]
    );
    await getDb().query('DELETE FROM public.table_fields WHERE id = $1', [ID.day]);
    expect(await repeats(ID.day)).toEqual([]);
  });
});
