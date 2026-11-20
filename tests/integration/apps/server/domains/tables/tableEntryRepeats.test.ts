/**
 * Per-row repeats against real PostgreSQL:
 * the calendar read API, set / clear, complete, skip, move one, shift all,
 * undo of each, revision conflicts, DST wall time and entry-delete cleanup.
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
import {
  createTableEntry,
  deleteTableEntries,
  getTableEntry,
  getTableEntryRepeats,
  listTableEntries,
  tableEntryRepeatAction,
  updateTableEntry,
  type RepeatAction,
} from '@server/domains/tables/tableEntries';
import { historyContext, stepTableHistory } from '@server/domains/tables/tableHistory';
import { TableEntries } from '@snaglet/db/tables/table_entries';
import {
  listOccurrenceLog,
  listRepeatsForFields,
  logOccurrence,
  sweepAllOrphanRepeats,
  writeRepeat,
} from '@snaglet/db/tables/table_entries/repeats';

const USER: Actor = { actorKind: 'user', actorId: 'test-user-repeat', actorName: 'Test User' };
const TABLE = 'table-1111111111111-repeataa';
const E1 = '11111111-1111-4111-8111-111111111111';
const E2 = '22222222-2222-4222-8222-222222222222';
const as = <T>(fn: () => Promise<T>): Promise<T> => runWithActor(USER, fn);

const ID = {
  due: 'field-1111111111111-rdue',
  day: 'field-1111111111111-rday',
  status: 'field-1111111111111-rstatus',
  notes: 'field-1111111111111-rnotes',
};

async function clean(): Promise<void> {
  const { rows } = await getDb().query<{ table_name: string }>(
    'SELECT table_name FROM public.table_catalog WHERE id = $1',
    [TABLE]
  );
  for (const row of rows)
    await getDb().query(
      `DROP TABLE IF EXISTS user_tables.${quoteIdentifier(row.table_name)} CASCADE`
    );
  for (const table of ['table_entry_occurrences', 'table_entry_repeats', 'table_fields'])
    await getDb().query(`DELETE FROM public.${table} WHERE table_id = $1`, [TABLE]);
  await getDb().query('DELETE FROM public.table_catalog WHERE id = $1', [TABLE]);
  await getDb().query('DELETE FROM public.table_history WHERE actor_id = $1', [USER.actorId]);
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

async function enableRepeat(id: string, recurrence: TableFieldRecurrence): Promise<void> {
  const current = await field(id);
  await as(() =>
    updateTableField(TABLE, id, {
      name: current.name,
      description: current.description,
      type: current.type,
      nullable: current.nullable,
      defaultValue: current.defaultValue,
      referenceTableId: current.referenceTableId,
      expectedRevision: current.revision,
      recurrence,
    })
  );
}

let todo = '';
let done = '';

async function setup(): Promise<void> {
  await as(() => createTable({ id: TABLE, name: 'repeat_rows_table' }));
  for (const body of [
    def(ID.due, 'due', 'datetime'),
    def(ID.day, 'day', 'date'),
    def(ID.status, 'status', 'select', { options: [{ label: 'todo' }, { label: 'done' }] }),
    def(ID.notes, 'notes', 'text'),
  ])
    await as(() => createTableField(TABLE, body));
  const status = await field(ID.status);
  const byLabel = new Map((status.options ?? []).map((option) => [option.label, option.id]));
  todo = byLabel.get('todo')!;
  done = byLabel.get('done')!;
  const recurrence: TableFieldRecurrence = {
    statusFieldId: ID.status,
    doneOptionIds: [done],
    resetOptionId: todo,
  };
  await enableRepeat(ID.day, recurrence);
  await enableRepeat(ID.due, recurrence);
  for (const id of [E1, E2]) {
    const { schemaVersion } = await listTableEntries(TABLE);
    await as(() =>
      createTableEntry(TABLE, { id, values: { [ID.day]: '2026-10-05' }, schemaVersion })
    );
  }
}

const weekly = (current: string, dtstart = current) => ({
  rrule: 'FREQ=WEEKLY;BYDAY=MO',
  dtstart,
  current,
  tz: 'America/New_York',
});

describe('per-row repeats (real DB)', () => {
  beforeEach(async () => {
    await clean();
    await setup();
  });
  afterAll(clean);

  describe('calendar read API', () => {
    it('listRepeatsForFields returns repeats by field then entry, skipping invalid values', async () => {
      const db = getDb();
      await writeRepeat(db, TABLE, ID.day, E1, weekly('2026-10-12', '2026-10-05'));
      await writeRepeat(db, TABLE, ID.day, E2, weekly('2026-10-05'));
      await writeRepeat(db, TABLE, ID.due, E1, weekly('2026-10-05T09:00:00'));
      await db.query(
        `UPDATE public.table_entry_repeats SET value = '{"rrule":"nope"}' WHERE field_id = $1 AND entry_id = $2`,
        [ID.day, E2]
      );
      const result = await listRepeatsForFields(db, [ID.day, ID.due, ID.day]);
      expect([...result.keys()].sort()).toEqual([ID.day, ID.due].sort());
      expect([...result.get(ID.day)!.entries()]).toEqual([
        [E1, weekly('2026-10-12', '2026-10-05')],
      ]);
      expect(result.get(ID.due)!.get(E1)).toEqual(weekly('2026-10-05T09:00:00'));
      expect((await listRepeatsForFields(db, [])).size).toBe(0);
      expect((await listRepeatsForFields(db, [ID.notes])).size).toBe(0);
    });

    it('listOccurrenceLog returns logged occurrences in [from, to), moved ones by either end', async () => {
      const db = getDb();
      const base = { tableId: TABLE, entryId: E1 };
      const doneRow = await logOccurrence(db, {
        ...base,
        fieldId: ID.day,
        occurrence: '2026-10-05',
        kind: 'done',
        actor: { kind: 'user', id: USER.actorId },
      });
      await logOccurrence(db, {
        ...base,
        fieldId: ID.day,
        occurrence: '2026-10-19',
        kind: 'skipped',
      });
      // Planned outside the window, moved into it.
      const moved = await logOccurrence(db, {
        ...base,
        fieldId: ID.day,
        occurrence: '2026-09-28',
        kind: 'moved',
        movedTo: '2026-10-06',
      });
      await logOccurrence(db, {
        ...base,
        fieldId: ID.due,
        occurrence: '2026-10-12T09:00:00',
        kind: 'done',
      });
      const rows = await listOccurrenceLog(db, [ID.day], '2026-10-01', '2026-10-19');
      expect(rows.map((row) => [row.occurrence, row.kind, row.movedTo])).toEqual([
        ['2026-09-28', 'moved', '2026-10-06'],
        ['2026-10-05', 'done', null],
      ]);
      expect(rows[1]).toMatchObject({
        id: doneRow.id,
        tableId: TABLE,
        fieldId: ID.day,
        entryId: E1,
        actorKind: 'user',
        actorId: USER.actorId,
      });
      expect(rows[1]!.id).toMatch(/^tocc-/);
      expect(rows[1]!.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T.*Z$/);
      expect(moved.movedTo).toBe('2026-10-06');
      // A date bound covers datetime occurrences on that day.
      const timed = await listOccurrenceLog(db, [ID.due], '2026-10-12', '2026-10-13');
      expect(timed.map((row) => row.occurrence)).toEqual(['2026-10-12T09:00:00']);
      expect(await listOccurrenceLog(db, [], '2026-01-01', '2027-01-01')).toEqual([]);
    });
  });

  describe('repeat actions', () => {
    it('set: validates, starts the series at the date and writes the cell; undo removes it', async () => {
      const set = await act(E1, ID.day, 'set', {
        rrule: 'FREQ=WEEKLY;BYDAY=MO',
        date: '2026-10-12',
      });
      expect(set.repeat).toMatchObject({
        dtstart: '2026-10-12',
        current: '2026-10-12',
      });
      expect(set.entry.values[ID.day]).toBe('2026-10-12');
      expect((await state(E1)).repeats[ID.day]?.rrule).toBe('FREQ=WEEKLY;BYDAY=MO');
      // Change only the rule: anchor and position stay.
      const changed = await act(E1, ID.day, 'set', { rrule: 'FREQ=DAILY' });
      expect(changed.repeat).toMatchObject({ rrule: 'FREQ=DAILY', current: '2026-10-12' });
      await undo();
      expect((await state(E1)).repeats[ID.day]?.rrule).toBe('FREQ=WEEKLY;BYDAY=MO');
      await undo();
      expect((await state(E1)).repeats[ID.day]).toBeUndefined();
      expect((await entry(E1)).values[ID.day]).toBe('2026-10-05');
      await redo();
      expect((await state(E1)).repeats[ID.day]?.current).toBe('2026-10-12');
      expect((await entry(E1)).values[ID.day]).toBe('2026-10-12');
    });

    it('set refuses a bad rule, within, and a field without repeat', async () => {
      expect(
        (await caught(() => act(E1, ID.day, 'set', { rrule: 'FREQ=HOURLY' }))).statusCode
      ).toBe(400);
      expect(
        (await caught(() => act(E1, ID.day, 'set', { rrule: 'FREQ=DAILY', within: 'day' })))
          .statusCode
      ).toBe(400);
      expect(
        (await caught(() => act(E1, ID.notes, 'set', { rrule: 'FREQ=DAILY' }))).statusCode
      ).toBe(404);
      const off = await caught(() => act(E1, ID.status, 'set', { rrule: 'FREQ=DAILY' }));
      expect(off.statusCode).toBe(404);
      expect((await state(E1)).repeats).toEqual({});
    });

    it('complete logs done and advances; undo restores repeat, cell and log', async () => {
      await act(E1, ID.day, 'set', { rrule: 'FREQ=WEEKLY;BYDAY=MO' });
      const done = await act(E1, ID.day, 'complete');
      expect(done.logged.map((row) => [row.occurrence, row.kind])).toEqual([
        ['2026-10-05', 'done'],
      ]);
      expect(done.repeat?.current).toBe('2026-10-12');
      expect(done.entry.values[ID.day]).toBe('2026-10-12');
      await undo();
      expect((await state(E1)).repeats[ID.day]?.current).toBe('2026-10-05');
      expect((await state(E1)).log).toEqual([]);
      expect((await entry(E1)).values[ID.day]).toBe('2026-10-05');
      await redo();
      expect((await state(E1)).log.map((row) => row.kind)).toEqual(['done']);
      expect((await entry(E1)).values[ID.day]).toBe('2026-10-12');
    });

    it('complete at the end of a series logs it and refuses a second time', async () => {
      await act(E1, ID.day, 'set', { rrule: 'FREQ=DAILY;COUNT=1' });
      const last = await act(E1, ID.day, 'complete');
      expect(last.repeat?.current).toBe('2026-10-05');
      expect(last.entry.values[ID.day]).toBe('2026-10-05');
      expect((await caught(() => act(E1, ID.day, 'complete'))).statusCode).toBe(409);
    });

    it('skip logs skipped and advances; skip to upcoming logs every past one; undo of each', async () => {
      await act(E1, ID.day, 'set', { rrule: 'FREQ=DAILY' });
      const skip = await act(E1, ID.day, 'skip');
      expect(skip.logged.map((row) => row.kind)).toEqual(['skipped']);
      expect(skip.entry.values[ID.day]).toBe('2026-10-06');
      const many = await act(E1, ID.day, 'skip', { toUpcoming: true, now: '2026-10-09' });
      expect(many.logged.map((row) => row.occurrence)).toEqual([
        '2026-10-06',
        '2026-10-07',
        '2026-10-08',
      ]);
      expect(many.entry.values[ID.day]).toBe('2026-10-09');
      await undo();
      expect((await entry(E1)).values[ID.day]).toBe('2026-10-06');
      expect((await state(E1)).log.length).toBe(1);
      await undo();
      expect((await entry(E1)).values[ID.day]).toBe('2026-10-05');
      expect((await state(E1)).log).toEqual([]);
    });

    it('move one: logs moved, shows it in the cell, leaves the series; undo reverts', async () => {
      await act(E1, ID.day, 'set', { rrule: 'FREQ=WEEKLY;BYDAY=MO' });
      const moved = await act(E1, ID.day, 'move', { to: '2026-10-07' });
      expect(moved.logged).toMatchObject([
        { occurrence: '2026-10-05', kind: 'moved', movedTo: '2026-10-07' },
      ]);
      expect(moved.repeat?.current).toBe('2026-10-05');
      expect(moved.entry.values[ID.day]).toBe('2026-10-07');
      // Moving it again replaces the move.
      const again = await act(E1, ID.day, 'move', { to: '2026-10-08' });
      expect(again.removed).toEqual([moved.logged[0]!.id]);
      expect((await state(E1)).log.map((row) => row.movedTo)).toEqual(['2026-10-08']);
      // Completing a moved occurrence advances from the planned slot.
      const done = await act(E1, ID.day, 'complete');
      expect(done.entry.values[ID.day]).toBe('2026-10-12');
      // An upcoming one (not current) moves without touching the cell.
      const later = await act(E1, ID.day, 'move', { occurrence: '2026-10-19', to: '2026-10-20' });
      expect(later.entry.values[ID.day]).toBe('2026-10-12');
      expect(
        (
          await caught(() =>
            act(E1, ID.day, 'move', { occurrence: '2026-10-21', to: '2026-10-22' })
          )
        ).statusCode
      ).toBe(400);
      await undo();
      await undo();
      await undo();
      expect((await state(E1)).log.map((row) => row.movedTo)).toEqual(['2026-10-07']);
      expect((await entry(E1)).values[ID.day]).toBe('2026-10-07');
      await undo();
      expect((await state(E1)).log).toEqual([]);
      expect((await entry(E1)).values[ID.day]).toBe('2026-10-05');
    });

    it('shift all upcoming: moves dtstart, current and the weekday; undo reverts', async () => {
      await act(E1, ID.day, 'set', { rrule: 'FREQ=WEEKLY;BYDAY=MO' });
      await act(E1, ID.day, 'move', { occurrence: '2026-10-12', to: '2026-10-13' });
      const shifted = await act(E1, ID.day, 'shift', { to: '2026-10-07' });
      expect(shifted.repeat).toMatchObject({
        rrule: 'FREQ=WEEKLY;BYDAY=WE',
        dtstart: '2026-10-07',
        current: '2026-10-07',
      });
      expect(shifted.entry.values[ID.day]).toBe('2026-10-07');
      expect((await state(E1)).log).toEqual([]);
      await act(E1, ID.day, 'complete');
      expect((await entry(E1)).values[ID.day]).toBe('2026-10-14');
      await undo();
      await undo();
      expect((await state(E1)).repeats[ID.day]).toMatchObject({
        rrule: 'FREQ=WEEKLY;BYDAY=MO',
        current: '2026-10-05',
      });
      expect((await state(E1)).log.map((row) => row.movedTo)).toEqual(['2026-10-13']);
      expect((await entry(E1)).values[ID.day]).toBe('2026-10-05');
      // A rule pinned to fixed days can't shift by days.
      await act(E1, ID.day, 'set', { rrule: 'FREQ=MONTHLY;BYMONTHDAY=5' });
      expect((await caught(() => act(E1, ID.day, 'shift', { to: '2026-10-06' }))).statusCode).toBe(
        400
      );
    });

    it('datetime repeats keep wall time across DST (America/New_York)', async () => {
      const db = getDb();
      // Set directly so the zone is fixed regardless of the machine zone.
      await writeRepeat(db, TABLE, ID.due, E1, {
        rrule: 'FREQ=WEEKLY;BYDAY=SA',
        dtstart: '2026-10-31T09:00:00',
        current: '2026-10-31T09:00:00',
        tz: 'America/New_York',
      });
      const done = await act(E1, ID.due, 'complete');
      expect(done.repeat?.current).toBe('2026-11-07T09:00:00');
      // 09:00 EST = 14:00Z (EDT the week before would be 13:00Z).
      expect(done.entry.values[ID.due]).toBe('2026-11-07T14:00:00.000000Z');
      const moved = await act(E1, ID.due, 'move', { to: '2026-11-07T10:30:00' });
      expect(moved.entry.values[ID.due]).toBe('2026-11-07T15:30:00.000000Z');
      const shifted = await act(E1, ID.due, 'shift', {
        occurrence: '2026-11-14T09:00:00',
        to: '2026-11-14T08:00:00',
      });
      expect(shifted.repeat).toMatchObject({
        dtstart: '2026-10-31T08:00:00',
        current: '2026-11-07T08:00:00',
        rrule: 'FREQ=WEEKLY;BYDAY=SA',
      });
      await undo();
      await undo();
      expect((await entry(E1)).values[ID.due]).toBe('2026-11-07T14:00:00.000000Z');
    });

    it('a stale revision is a 409 and changes nothing', async () => {
      await act(E1, ID.day, 'set', { rrule: 'FREQ=DAILY' });
      const old = await entry(E1);
      const { schemaVersion } = await listTableEntries(TABLE);
      await act(E1, ID.day, 'complete');
      const error = await caught(() =>
        as(() =>
          tableEntryRepeatAction(TABLE, E1, ID.day, 'complete', {
            expectedRevision: old.revision,
            schemaVersion,
          })
        )
      );
      expect(error.statusCode).toBe(409);
      expect((await state(E1)).log.length).toBe(1);
      const guard = await caught(() => act(E1, ID.day, 'skip', { expectedCurrent: '2026-10-05' }));
      expect(guard.statusCode).toBe(409);
      // Undo refuses once the repeat changed underneath it.
      await writeRepeat(getDb(), TABLE, ID.day, E1, {
        rrule: 'FREQ=DAILY',
        dtstart: '2026-10-05',
        current: '2026-10-20',
        tz: 'UTC',
      });
      expect((await caught(() => undo())).statusCode).toBe(409);
    });

    it('undo one logged occurrence: done steps the row back; it is its own undoable step', async () => {
      await act(E1, ID.day, 'set', { rrule: 'FREQ=WEEKLY;BYDAY=MO' });
      const done = await act(E1, ID.day, 'complete');
      const id = done.logged[0]!.id;
      const reverted = await act(E1, ID.day, 'undoOccurrence', { occurrenceId: id });
      expect(reverted.repeat?.current).toBe('2026-10-05');
      expect(reverted.entry.values[ID.day]).toBe('2026-10-05');
      expect((await state(E1)).log).toEqual([]);
      await undo();
      expect((await state(E1)).log.map((row) => row.id)).toEqual([id]);
      expect((await entry(E1)).values[ID.day]).toBe('2026-10-12');
      expect(
        (await caught(() => act(E2, ID.day, 'undoOccurrence', { occurrenceId: id }))).statusCode
      ).toBe(400);
    });

    it('entry delete removes the repeat and log; undo puts them back; redo removes again', async () => {
      await act(E1, ID.day, 'set', { rrule: 'FREQ=DAILY' });
      await act(E1, ID.day, 'complete');
      await as(() => deleteTableEntries(TABLE, { entryIds: [E1] }));
      expect(await rowCount(E1)).toEqual({ repeats: 0, log: 0 });
      await undo();
      expect(await rowCount(E1)).toEqual({ repeats: 1, log: 1 });
      expect((await state(E1)).repeats[ID.day]?.current).toBe('2026-10-06');
      await redo();
      expect(await rowCount(E1)).toEqual({ repeats: 0, log: 0 });
    });

    it('undoing an entry create removes repeats set on it since only via their own steps', async () => {
      await act(E2, ID.day, 'set', { rrule: 'FREQ=DAILY' });
      await undo(); // the set
      await undo(); // E2's create
      expect(await rowCount(E2)).toEqual({ repeats: 0, log: 0 });
    });
  });

  describe('status done advances the row', () => {
    // Select cells store option labels; the recurrence setting names option ids.
    const DONE = 'done';
    const TODO = 'todo';
    const setStatus = async (entryId: string, value: string | null) => {
      const current = await getTableEntry(TABLE, entryId);
      return as(() =>
        updateTableEntry(TABLE, entryId, {
          values: { [ID.status]: value },
          expectedRevision: current.entry.revision,
          schemaVersion: current.schemaVersion,
        })
      );
    };

    it('a field can repeat without a status field: Done advances, a status change does nothing', async () => {
      await enableRepeat(ID.day, {
        statusFieldId: null,
        doneOptionIds: [],
        resetOptionId: null,
      });
      await act(E1, ID.day, 'set', { rrule: 'FREQ=WEEKLY;BYDAY=MO' });
      const result = await setStatus(E1, DONE);
      // No status field in the setting: the status is just a value.
      expect(result.entry.values[ID.day]).toBe('2026-10-05');
      expect(result.entry.values[ID.status]).toBe(DONE);
      const done = await act(E1, ID.day, 'complete');
      expect(done.entry.values[ID.day]).toBe('2026-10-12');
      // Complete leaves the status alone without a status field.
      expect(done.entry.values[ID.status]).toBe(DONE);
      expect(done.logged.map((row) => [row.occurrence, row.kind])).toEqual([
        ['2026-10-05', 'done'],
      ]);
    });

    it('setting the status to done logs done, advances the date and resets the status; undo restores all', async () => {
      await act(E1, ID.day, 'set', { rrule: 'FREQ=WEEKLY;BYDAY=MO' });
      const result = await setStatus(E1, DONE);
      expect(result.entry.values[ID.day]).toBe('2026-10-12');
      expect(result.entry.values[ID.status]).toBe(TODO);
      const after = await state(E1);
      expect(after.repeats[ID.day]?.current).toBe('2026-10-12');
      expect(after.log.map((row) => [row.occurrence, row.kind])).toEqual([['2026-10-05', 'done']]);

      await undo();
      const undone = await entry(E1);
      expect(undone.values[ID.day]).toBe('2026-10-05');
      expect(undone.values[ID.status] ?? null).toBeNull();
      expect((await state(E1)).repeats[ID.day]?.current).toBe('2026-10-05');
      expect((await state(E1)).log).toEqual([]);

      await redo();
      expect((await entry(E1)).values[ID.day]).toBe('2026-10-12');
      expect((await entry(E1)).values[ID.status]).toBe(TODO);
      expect((await state(E1)).log.map((row) => row.kind)).toEqual(['done']);
    });

    it('a status write that does not reach a done option, or a row without a repeat, changes nothing else', async () => {
      await act(E1, ID.day, 'set', { rrule: 'FREQ=WEEKLY;BYDAY=MO' });
      await setStatus(E1, TODO);
      expect((await entry(E1)).values[ID.day]).toBe('2026-10-05');
      expect((await state(E1)).log).toEqual([]);
      // E2 has no repeat: done just sticks.
      const plain = await setStatus(E2, DONE);
      expect(plain.entry.values[ID.status]).toBe(DONE);
      expect(plain.entry.values[ID.day]).toBe('2026-10-05');
    });

    it('an ending series logs its last occurrence and the status stays done', async () => {
      await act(E1, ID.day, 'set', { rrule: 'FREQ=DAILY;COUNT=1' });
      const last = await setStatus(E1, DONE);
      expect(last.entry.values[ID.day]).toBe('2026-10-05');
      expect(last.entry.values[ID.status]).toBe(DONE);
      expect((await state(E1)).log.map((row) => [row.occurrence, row.kind])).toEqual([
        ['2026-10-05', 'done'],
      ]);
      // Re-marking an ended series does nothing more.
      await setStatus(E1, TODO);
      const again = await setStatus(E1, DONE);
      expect(again.entry.values[ID.status]).toBe(DONE);
      expect((await state(E1)).log).toHaveLength(1);
    });

    it('two repeating fields sharing one status both advance in one undo step', async () => {
      await act(E1, ID.day, 'set', { rrule: 'FREQ=WEEKLY;BYDAY=MO' });
      await act(E1, ID.due, 'set', { rrule: 'FREQ=DAILY', date: '2026-10-05T09:00:00' });
      const before = await entry(E1);
      const result = await setStatus(E1, DONE);
      expect(result.entry.values[ID.day]).toBe('2026-10-12');
      expect(result.entry.values[ID.status]).toBe(TODO);
      const repeats = (await state(E1)).repeats;
      expect(repeats[ID.day]?.current).toBe('2026-10-12');
      expect(repeats[ID.due]?.current).toBe('2026-10-06T09:00:00');
      expect((await state(E1)).log.map((row) => row.fieldId).sort()).toEqual(
        [ID.day, ID.due].sort()
      );
      await undo();
      const undone = await entry(E1);
      expect(undone.values[ID.day]).toBe(before.values[ID.day]);
      expect(undone.values[ID.due]).toBe(before.values[ID.due]);
      expect((await state(E1)).log).toEqual([]);
      expect((await state(E1)).repeats[ID.due]?.current).toBe('2026-10-05T09:00:00');
    });

    it('agent batch updates advance the same way', async () => {
      await act(E1, ID.day, 'set', { rrule: 'FREQ=WEEKLY;BYDAY=MO' });
      const result = await as(() =>
        TableEntries.writeBatch(
          TABLE,
          { inserts: [], updates: [{ id: E1, values: { status: DONE } }] },
          historyContext()
        )
      );
      expect(result.updated).toHaveLength(1);
      expect((await entry(E1)).values[ID.day]).toBe('2026-10-12');
      expect((await entry(E1)).values[ID.status]).toBe(TODO);
    });

    it('explicit Complete resets a status that holds a done option', async () => {
      await act(E1, ID.day, 'set', { rrule: 'FREQ=WEEKLY;BYDAY=MO' });
      // Done set while the patch also writes the date: the writer's choice, no advance.
      const current = await getTableEntry(TABLE, E1);
      await as(() =>
        updateTableEntry(TABLE, E1, {
          values: { [ID.status]: DONE, [ID.day]: '2026-10-05' },
          expectedRevision: current.entry.revision,
          schemaVersion: current.schemaVersion,
        })
      );
      expect((await entry(E1)).values[ID.status]).toBe(DONE);
      const completed = await act(E1, ID.day, 'complete');
      expect(completed.entry.values[ID.day]).toBe('2026-10-12');
      expect(completed.entry.values[ID.status]).toBe(TODO);
      await undo();
      expect((await entry(E1)).values[ID.status]).toBe(DONE);
      expect((await entry(E1)).values[ID.day]).toBe('2026-10-05');
    });

    it('the orphan sweep removes repeats and log rows whose entry is gone', async () => {
      const db = getDb();
      const ghost = '33333333-3333-4333-8333-333333333333';
      await writeRepeat(db, TABLE, ID.day, ghost, weekly('2026-10-05'));
      await logOccurrence(db, {
        tableId: TABLE,
        fieldId: ID.day,
        entryId: ghost,
        occurrence: '2026-09-28',
        kind: 'done',
      });
      await writeRepeat(db, TABLE, ID.day, E1, weekly('2026-10-05'));
      expect(await sweepAllOrphanRepeats(db)).toBe(2);
      expect((await listRepeatsForFields(db, [ID.day])).get(ID.day)?.has(E1)).toBe(true);
      expect(await sweepAllOrphanRepeats(db)).toBe(0);
    });
  });

  describe('interval repeats (every d:h:m:s from the date)', () => {
    const interval = (rrule: string, current = '2026-10-31T09:00:00') => ({
      rrule,
      dtstart: '2026-10-31T09:00:00',
      current,
      tz: 'America/New_York',
    });

    it('set validates the interval: a second at least, a date with a time, no within', async () => {
      const set = await act(E1, ID.due, 'set', {
        rrule: 'FREQ=SECONDLY;INTERVAL=5400',
        date: '2026-10-05T09:00:00',
      });
      expect(set.repeat).toMatchObject({
        rrule: 'FREQ=MINUTELY;INTERVAL=90',
        dtstart: '2026-10-05T09:00:00',
        current: '2026-10-05T09:00:00',
      });
      expect(set.repeat).not.toHaveProperty('quota');
      const refused = async (fieldId: string, body: Record<string, unknown>) =>
        caught(() => act(E1, fieldId, 'set', { date: '2026-10-05T09:00:00', ...body }));
      const zero = await refused(ID.due, { rrule: 'FREQ=SECONDLY;INTERVAL=0' });
      expect(zero.statusCode).toBe(400);
      expect(zero.message).toContain('INTERVAL must be a positive whole number.');
      const dateOnly = await caught(() => act(E1, ID.day, 'set', { rrule: 'FREQ=MINUTELY' }));
      expect(dateOnly.statusCode).toBe(400);
      expect(dateOnly.message).toContain('needs a date with a time');
      for (const body of [
        { rrule: 'FREQ=HOURLY', within: 'next' },
        { rrule: 'FREQ=HOURLY;BYDAY=MO' },
        { rrule: 'FREQ=MINUTELY;INTERVAL=0' },
      ])
        expect((await refused(ID.due, body)).statusCode).toBe(400);
      expect((await state(E1)).repeats[ID.due]?.rrule).toBe('FREQ=MINUTELY;INTERVAL=90');
      // One second is the floor.
      const second = await act(E1, ID.due, 'set', {
        rrule: 'FREQ=SECONDLY',
        date: '2026-10-05T09:00:00',
      });
      expect(second.repeat).toMatchObject({ rrule: 'FREQ=SECONDLY' });
    });

    it('complete and a done status advance by exactly one interval, in absolute time across DST', async () => {
      await writeRepeat(getDb(), TABLE, ID.due, E1, interval('FREQ=HOURLY;INTERVAL=24'));
      const done = await act(E1, ID.due, 'complete');
      expect(done.logged.map((row) => [row.occurrence, row.kind])).toEqual([
        ['2026-10-31T09:00:00', 'done'],
      ]);
      // 24 h after 09:00 EDT (13:00Z) is 08:00 EST on Nov 1 (13:00Z), not 09:00.
      expect(done.repeat?.current).toBe('2026-11-01T08:00:00');
      expect(done.entry.values[ID.due]).toBe('2026-11-01T13:00:00.000000Z');
      const current = await getTableEntry(TABLE, E1);
      const byStatus = await as(() =>
        updateTableEntry(TABLE, E1, {
          values: { [ID.status]: 'done' },
          expectedRevision: current.entry.revision,
          schemaVersion: current.schemaVersion,
        })
      );
      expect(byStatus.entry.values[ID.due]).toBe('2026-11-02T13:00:00.000000Z');
      expect(byStatus.entry.values[ID.status]).toBe('todo');
      expect((await state(E1)).repeats[ID.due]?.current).toBe('2026-11-02T08:00:00');
      await undo();
      expect((await state(E1)).repeats[ID.due]?.current).toBe('2026-11-01T08:00:00');
    });

    it('moves and skips an occurrence thousands of steps on, without walking to it', async () => {
      await writeRepeat(getDb(), TABLE, ID.due, E1, interval('FREQ=MINUTELY'));
      // Ten days on: 14,400 one-minute steps.
      const later = await act(E1, ID.due, 'move', {
        occurrence: '2026-11-10T09:00:00',
        to: '2026-11-10T09:00:30',
      });
      expect(later.logged).toMatchObject([
        { occurrence: '2026-11-10T09:00:00', kind: 'moved', movedTo: '2026-11-10T09:00:30' },
      ]);
      // Off the minute is not one of its occurrences.
      expect(
        (
          await caught(() =>
            act(E1, ID.due, 'move', {
              occurrence: '2026-11-10T09:00:30',
              to: '2026-11-10T09:05:00',
            })
          )
        ).statusCode
      ).toBe(400);
      const skipped = await act(E1, ID.due, 'skip', {
        toUpcoming: true,
        now: '2026-10-31T09:02:30',
      });
      expect(skipped.logged.map((row) => row.occurrence)).toEqual([
        '2026-10-31T09:00:00',
        '2026-10-31T09:01:00',
        '2026-10-31T09:02:00',
      ]);
      expect(skipped.repeat?.current).toBe('2026-10-31T09:03:00');
    });

    it('jumps a 1-minute row a week behind to now in one step, logging none; one undo puts it back', async () => {
      await writeRepeat(getDb(), TABLE, ID.due, E1, interval('FREQ=MINUTELY'));
      // A week on, across the Nov 1 fall-back: over 10,000 missed minutes.
      const now = '2026-11-07T09:00:30';
      const capped = await caught(() => act(E1, ID.due, 'skip', { toUpcoming: true, now }));
      expect(capped.statusCode).toBe(400);
      expect(capped.message).toContain('edit the date or use Jump to now instead');
      const steps = async () =>
        (
          await getDb().query<{ label: string; ops: Array<{ op: string }> }>(
            'SELECT label, ops FROM public.table_history WHERE actor_id = $1 ORDER BY seq',
            [USER.actorId]
          )
        ).rows;
      const before = (await steps()).length;
      const jumped = await act(E1, ID.due, 'skip', { jump: true, now });
      // 09:00 EDT on Oct 31 is 13:00Z; whole minutes on, 09:01 EST is 14:01Z.
      expect(jumped.repeat?.current).toBe('2026-11-07T09:01:00');
      expect(jumped.entry.values[ID.due]).toBe('2026-11-07T14:01:00.000000Z');
      expect(jumped.logged).toEqual([]);
      expect(jumped.changed).toBe(true);
      expect(await rowCount(E1)).toEqual({ repeats: 1, log: 0 });
      // One step, the cell's write in it.
      const after = await steps();
      expect(after).toHaveLength(before + 1);
      expect(after[before]!.label).toBe('Jump to now on due in repeat_rows_table');
      expect(after[before]!.ops.map((op) => op.op).sort()).toEqual(['entries', 'repeat']);
      await undo();
      expect((await state(E1)).repeats[ID.due]?.current).toBe('2026-10-31T09:00:00');
      expect((await entry(E1)).values[ID.due]).toBeNull();
      expect(await rowCount(E1)).toEqual({ repeats: 1, log: 0 });
      await redo();
      expect((await state(E1)).repeats[ID.due]?.current).toBe('2026-11-07T09:01:00');
    });

    it('a jump lands where Skip to upcoming does; it refuses a row not behind, ended or day-based', async () => {
      // Within the cap Skip to upcoming still logs each missed one.
      for (const id of [E1, E2])
        await writeRepeat(getDb(), TABLE, ID.due, id, interval('FREQ=MINUTELY;INTERVAL=30'));
      const now = '2026-10-31T10:10:00';
      const skipped = await act(E1, ID.due, 'skip', { toUpcoming: true, now });
      expect(skipped.logged.map((row) => row.occurrence)).toEqual([
        '2026-10-31T09:00:00',
        '2026-10-31T09:30:00',
        '2026-10-31T10:00:00',
      ]);
      const jumped = await act(E2, ID.due, 'skip', { jump: true, now });
      expect(jumped.repeat?.current).toBe('2026-10-31T10:30:00');
      expect(jumped.repeat?.current).toBe(skipped.repeat?.current);
      expect(jumped.logged).toEqual([]);
      const refused = async (fieldId: string, body: Record<string, unknown>) =>
        caught(() => act(E2, fieldId, 'skip', body));
      // Not behind any more.
      const ahead = await refused(ID.due, { jump: true, now });
      expect(ahead.statusCode).toBe(409);
      expect(ahead.message).toContain('not in the past');
      // Three times from 09:00 ended at 11:00.
      await writeRepeat(getDb(), TABLE, ID.due, E2, interval('FREQ=HOURLY;COUNT=3'));
      const ended = await refused(ID.due, { jump: true, now: '2026-11-01T09:00:00' });
      expect(ended.statusCode).toBe(409);
      expect(ended.message).toContain('series ends before now');
      // Day-based repeats walk their occurrences.
      await writeRepeat(getDb(), TABLE, ID.day, E2, weekly('2026-10-05'));
      const dayBased = await refused(ID.day, { jump: true, now: '2026-10-20' });
      expect(dayBased.statusCode).toBe(400);
      expect(dayBased.message).toContain('Only a repeat at an interval');
      expect((await refused(ID.due, { jump: 'yes' })).statusCode).toBe(400);
      expect(await rowCount(E2)).toEqual({ repeats: 2, log: 0 });
    });

    it('refuses jump together with toUpcoming (400), at the route and in the model; nothing changes', async () => {
      await writeRepeat(getDb(), TABLE, ID.due, E1, interval('FREQ=MINUTELY;INTERVAL=30'));
      const now = '2026-10-31T10:10:00';
      const both = await caught(() =>
        act(E1, ID.due, 'skip', { jump: true, toUpcoming: true, now })
      );
      expect(both.statusCode).toBe(400);
      expect(both.message).toContain('jump or toUpcoming, not both');
      const current = await getTableEntry(TABLE, E1);
      const direct = await caught(() =>
        as(() =>
          TableEntries.repeatAction(
            TABLE,
            E1,
            ID.due,
            {
              action: 'skip',
              jump: true,
              toUpcoming: true,
              now,
              expectedRevision: current.entry.revision,
              schemaVersion: current.schemaVersion,
            },
            historyContext()
          )
        )
      );
      expect(direct.statusCode).toBe(400);
      expect((await state(E1)).repeats[ID.due]?.current).toBe('2026-10-31T09:00:00');
      expect(await rowCount(E1)).toEqual({ repeats: 1, log: 0 });
      // Each alone still works; toUpcoming: false says nothing against a jump.
      const jumped = await act(E1, ID.due, 'skip', { jump: true, toUpcoming: false, now });
      expect(jumped.repeat?.current).toBe('2026-10-31T10:30:00');
    });

    describe('no `now` sent: the clock as an instant', () => {
      const LA = 'America/Los_Angeles';
      // 15 min from 00:30 PDT on Nov 1: 01:00–01:45 PDT are left out, 01:00 PST is next.
      const quarter = (current: string) => ({
        rrule: 'FREQ=MINUTELY;INTERVAL=15',
        dtstart: '2026-11-01T00:30:00',
        current,
        tz: LA,
      });
      const FIRST = '2026-11-01T08:30:00Z'; // 01:30 PDT, the first pass
      const SECOND = '2026-11-01T09:30:00Z'; // 01:30 PST, the second
      const behind = async () => {
        for (const id of [E1, E2])
          await writeRepeat(getDb(), TABLE, ID.due, id, quarter('2026-11-01T00:45:00'));
      };
      const occurrences = (result: { logged: Array<{ occurrence: string }> }) =>
        result.logged.map((row) => row.occurrence);

      it('Skip to upcoming in the fall-back hour skips only what is past', async () => {
        await behind();
        const first = await actAt(FIRST, E1, ID.due, 'skip', { toUpcoming: true });
        expect(occurrences(first)).toEqual(['2026-11-01T00:45:00']);
        expect(first.repeat?.current).toBe('2026-11-01T01:00:00');
        expect(first.entry.values[ID.due]).toBe('2026-11-01T09:00:00.000000Z');
        const second = await actAt(SECOND, E2, ID.due, 'skip', { toUpcoming: true });
        expect(occurrences(second)).toEqual([
          '2026-11-01T00:45:00',
          '2026-11-01T01:00:00',
          '2026-11-01T01:15:00',
        ]);
        expect(second.repeat?.current).toBe('2026-11-01T01:30:00');
        // On 01:00 PST during the first pass, nothing is past yet.
        const ahead = await caught(() => actAt(FIRST, E1, ID.due, 'skip', { toUpcoming: true }));
        expect(ahead.statusCode).toBe(409);
      });

      it('Jump to now likewise; a wall `now` sent is still read as wall time, whatever the clock', async () => {
        await behind();
        const first = await actAt(FIRST, E1, ID.due, 'skip', { jump: true });
        expect(first.repeat?.current).toBe('2026-11-01T01:00:00');
        expect(first.logged).toEqual([]);
        const second = await actAt(SECOND, E2, ID.due, 'skip', { jump: true });
        expect(second.repeat?.current).toBe('2026-11-01T01:30:00');
        expect(
          (await caught(() => actAt(FIRST, E1, ID.due, 'skip', { jump: true }))).statusCode
        ).toBe(409);
        await behind();
        const now = '2026-11-01T01:30:00';
        const jumped = await actAt(FIRST, E1, ID.due, 'skip', { jump: true, now });
        expect(jumped.repeat?.current).toBe('2026-11-01T01:30:00');
        const skipped = await actAt(FIRST, E2, ID.due, 'skip', { toUpcoming: true, now });
        expect(occurrences(skipped)).toEqual([
          '2026-11-01T00:45:00',
          '2026-11-01T01:00:00',
          '2026-11-01T01:15:00',
        ]);
        expect(skipped.repeat?.current).toBe('2026-11-01T01:30:00');
      });

      it('a day-based repeat reads the clock as its wall time', async () => {
        // Every day at 01:30: on Nov 1 that names the second pass, yet at
        // 01:45 PDT (the first pass) it reads past, as with the wall time.
        const daily = {
          rrule: 'FREQ=DAILY',
          dtstart: '2026-10-30T01:30:00',
          current: '2026-10-30T01:30:00',
          tz: LA,
        };
        for (const id of [E1, E2]) await writeRepeat(getDb(), TABLE, ID.due, id, daily);
        const byClock = await actAt('2026-11-01T08:45:00Z', E1, ID.due, 'skip', {
          toUpcoming: true,
        });
        const byWall = await actAt('2000-01-01T00:00:00Z', E2, ID.due, 'skip', {
          toUpcoming: true,
          now: '2026-11-01T01:45:00',
        });
        const missed = ['2026-10-30T01:30:00', '2026-10-31T01:30:00', '2026-11-01T01:30:00'];
        expect(occurrences(byClock)).toEqual(missed);
        expect(occurrences(byWall)).toEqual(missed);
        expect(byClock.repeat?.current).toBe('2026-11-02T01:30:00');
        expect(byWall.repeat?.current).toBe('2026-11-02T01:30:00');
        // A date field: 08:00 in New York on Tue Oct 20 is that day.
        await writeRepeat(getDb(), TABLE, ID.day, E1, weekly('2026-10-05'));
        const days = await actAt('2026-10-20T12:00:00Z', E1, ID.day, 'skip', { toUpcoming: true });
        expect(occurrences(days)).toEqual(['2026-10-05', '2026-10-12', '2026-10-19']);
        expect(days.repeat?.current).toBe('2026-10-26');
      });
    });
  });

  describe('repeats on range fields', () => {
    const DONE = 'done';
    const TODO = 'todo';
    async function rangeOn(id: string): Promise<void> {
      const current = await field(id);
      await as(() =>
        updateTableField(TABLE, id, {
          name: current.name,
          description: current.description,
          type: current.type,
          nullable: current.nullable,
          defaultValue: current.defaultValue,
          referenceTableId: current.referenceTableId,
          expectedRevision: current.revision,
          range: true,
        })
      );
    }
    async function write(entryId: string, values: Record<string, unknown>) {
      const current = await getTableEntry(TABLE, entryId);
      return as(() =>
        updateTableEntry(TABLE, entryId, {
          values,
          expectedRevision: current.entry.revision,
          schemaVersion: current.schemaVersion,
        })
      );
    }

    it('a date range keeps its length through complete, move one and shift; a single day stays single', async () => {
      await rangeOn(ID.day);
      expect(await field(ID.day)).toMatchObject({ range: true, recurrence: expect.any(Object) });
      await write(E1, { [ID.day]: '2026-10-05/2026-10-07' });
      const set = await act(E1, ID.day, 'set', { rrule: 'FREQ=WEEKLY;BYDAY=MO' });
      // The series is on the start; the cell is unchanged.
      expect(set.repeat).toMatchObject({ dtstart: '2026-10-05', current: '2026-10-05' });
      expect(set.entry.values[ID.day]).toBe('2026-10-05/2026-10-07');

      const completed = await act(E1, ID.day, 'complete');
      expect(completed.repeat?.current).toBe('2026-10-12');
      expect(completed.entry.values[ID.day]).toBe('2026-10-12/2026-10-14');
      const moved = await act(E1, ID.day, 'move', { to: '2026-10-13' });
      expect(moved.entry.values[ID.day]).toBe('2026-10-13/2026-10-15');
      await undo();
      expect((await entry(E1)).values[ID.day]).toBe('2026-10-12/2026-10-14');
      const shifted = await act(E1, ID.day, 'shift', { to: '2026-10-14' });
      expect(shifted.repeat).toMatchObject({
        current: '2026-10-14',
        rrule: 'FREQ=WEEKLY;BYDAY=WE',
      });
      expect(shifted.entry.values[ID.day]).toBe('2026-10-14/2026-10-16');
      const skipped = await act(E1, ID.day, 'skip');
      expect(skipped.entry.values[ID.day]).toBe('2026-10-21/2026-10-23');
      // Undo skip, shift and complete: back on the first occurrence, same length.
      await undo();
      await undo();
      await undo();
      expect((await entry(E1)).values[ID.day]).toBe('2026-10-05/2026-10-07');

      // E2 holds a single day: it advances as a single day.
      await act(E2, ID.day, 'set', { rrule: 'FREQ=WEEKLY;BYDAY=MO' });
      expect((await act(E2, ID.day, 'complete')).entry.values[ID.day]).toBe('2026-10-12');
    });

    it('a datetime range keeps its wall-clock length across DST (America/New_York)', async () => {
      await rangeOn(ID.due);
      // Fri 09:00 EDT to Mon 17:00 EST: the clocks go back on Sun Nov 1.
      await write(E1, { [ID.due]: '2026-10-30T13:00:00Z/2026-11-02T22:00:00Z' });
      await writeRepeat(getDb(), TABLE, ID.due, E1, {
        rrule: 'FREQ=WEEKLY;BYDAY=FR',
        dtstart: '2026-10-30T09:00:00',
        current: '2026-10-30T09:00:00',
        tz: 'America/New_York',
      });
      const done = await act(E1, ID.due, 'complete');
      expect(done.repeat?.current).toBe('2026-11-06T09:00:00');
      // Still 09:00 Fri – 17:00 Mon (EST now), not 3 days 9 hours of real time.
      expect(done.entry.values[ID.due]).toBe(
        '2026-11-06T14:00:00.000000Z/2026-11-09T22:00:00.000000Z'
      );
      const moved = await act(E1, ID.due, 'move', { to: '2026-11-06T10:30:00' });
      expect(moved.entry.values[ID.due]).toBe(
        '2026-11-06T15:30:00.000000Z/2026-11-09T23:30:00.000000Z'
      );
      // A single instant stays single.
      await write(E2, { [ID.due]: '2026-10-30T13:00:00Z' });
      await writeRepeat(getDb(), TABLE, ID.due, E2, {
        rrule: 'FREQ=WEEKLY;BYDAY=FR',
        dtstart: '2026-10-30T09:00:00',
        current: '2026-10-30T09:00:00',
        tz: 'America/New_York',
      });
      expect((await act(E2, ID.due, 'complete')).entry.values[ID.due]).toBe(
        '2026-11-06T14:00:00.000000Z'
      );
    });

    it('a resize is not a move: alone it logs nothing; with a done status it advances at the new length', async () => {
      await rangeOn(ID.day);
      await write(E1, { [ID.day]: '2026-10-05/2026-10-06' });
      await act(E1, ID.day, 'set', { rrule: 'FREQ=WEEKLY;BYDAY=MO' });
      const resized = await write(E1, { [ID.day]: '2026-10-05/2026-10-08' });
      expect(resized.entry.values[ID.day]).toBe('2026-10-05/2026-10-08');
      expect((await state(E1)).log).toEqual([]);
      expect((await state(E1)).repeats[ID.day]?.current).toBe('2026-10-05');

      // Resize and done in one write: it advances, and the new length carries on.
      const advanced = await write(E1, { [ID.day]: '2026-10-05/2026-10-07', [ID.status]: DONE });
      expect(advanced.entry.values[ID.day]).toBe('2026-10-12/2026-10-14');
      expect(advanced.entry.values[ID.status]).toBe(TODO);
      expect((await state(E1)).log.map((row) => [row.occurrence, row.kind])).toEqual([
        ['2026-10-05', 'done'],
      ]);
      await undo();
      expect((await entry(E1)).values[ID.day]).toBe('2026-10-05/2026-10-08');
      expect((await state(E1)).log).toEqual([]);

      // Rewriting the same range with done is the writer's choice, as for a
      // plain date: no advance.
      const same = await write(E1, { [ID.day]: '2026-10-05/2026-10-08', [ID.status]: DONE });
      expect(same.entry.values[ID.day]).toBe('2026-10-05/2026-10-08');
      expect((await state(E1)).log).toEqual([]);
      await undo();

      // Moving the start with done is the writer's choice too.
      const movedStart = await write(E1, { [ID.day]: '2026-10-06/2026-10-08', [ID.status]: DONE });
      expect(movedStart.entry.values[ID.day]).toBe('2026-10-06/2026-10-08');
      expect(movedStart.entry.values[ID.status]).toBe(DONE);
      expect((await state(E1)).log).toEqual([]);
    });
  });
});

const undo = () => as(() => stepTableHistory('undo', {}));
const redo = () => as(() => stepTableHistory('redo', {}));

async function entry(id: string) {
  return (await getTableEntry(TABLE, id)).entry;
}

async function state(id: string) {
  return getTableEntryRepeats(TABLE, id);
}

async function act(
  entryId: string,
  fieldId: string,
  action: RepeatAction,
  body: Record<string, unknown> = {}
) {
  const current = await getTableEntry(TABLE, entryId);
  return as(() =>
    tableEntryRepeatAction(TABLE, entryId, fieldId, action, {
      expectedRevision: current.entry.revision,
      schemaVersion: current.schemaVersion,
      ...body,
    })
  );
}

/** {@link act} with the server's clock fixed at `at` (an ISO instant) for a skip without `now`. */
async function actAt(
  at: string,
  entryId: string,
  fieldId: string,
  action: RepeatAction,
  body: Record<string, unknown> = {}
) {
  const current = await getTableEntry(TABLE, entryId);
  return as(() =>
    tableEntryRepeatAction(
      TABLE,
      entryId,
      fieldId,
      action,
      {
        expectedRevision: current.entry.revision,
        schemaVersion: current.schemaVersion,
        ...body,
      },
      { clock: () => new Date(at) }
    )
  );
}

async function caught(action: () => Promise<unknown>) {
  try {
    await action();
  } catch (error) {
    return error as { statusCode?: number; message: string };
  }
  throw new Error('expected a rejection');
}

async function rowCount(entryId: string) {
  const db = getDb();
  const repeats = await db.query<{ n: string }>(
    'SELECT count(*)::text AS n FROM public.table_entry_repeats WHERE entry_id = $1',
    [entryId]
  );
  const log = await db.query<{ n: string }>(
    'SELECT count(*)::text AS n FROM public.table_entry_occurrences WHERE entry_id = $1',
    [entryId]
  );
  return { repeats: Number(repeats.rows[0]!.n), log: Number(log.rows[0]!.n) };
}
