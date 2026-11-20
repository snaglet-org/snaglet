/**
 * Repeats against real PostgreSQL: set on scheduled days, the write checks,
 * and the stored value's round trip. There is no time-to-do-it window, so
 * `within` is rejected as an unknown param.
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
  getTableEntry,
  getTableEntryRepeats,
  listTableEntries,
  getTableRepeats,
  tableEntryRepeatAction,
  updateTableEntry,
  type RepeatAction,
} from '@server/domains/tables/tableEntries';
import { stepTableHistory } from '@server/domains/tables/tableHistory';
import { tableDateTimeToUtc, tableRepeatToday, userTimeZone } from '@snaglet/shared/utils';
import { listRepeatsForFields } from '@snaglet/db/tables/table_entries/repeats';
import {
  describeAgentTable,
  readAgentEntries,
  writeAgentEntries,
} from '@server/domains/tables/tableAgent';
import {
  renderEntries,
  renderTableDetail,
  renderWrite,
} from '@server/services/ToolService/tools/database/_shared/render';

const USER: Actor = { actorKind: 'user', actorId: 'test-user-repeat-v2', actorName: 'Test User' };
const TABLE = 'table-1111111111111-repeatv2a';
const E1 = '11111111-1111-4111-8111-111111111111';
const E2 = '22222222-2222-4222-8222-222222222222';
const as = <T>(fn: () => Promise<T>): Promise<T> => runWithActor(USER, fn);

const ID = {
  day: 'field-1111111111111-v2day',
  sunday: 'field-1111111111111-v2sun',
  at: 'field-1111111111111-v2at',
  span: 'field-1111111111111-v2span',
  status: 'field-1111111111111-v2status',
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

async function updateField(id: string, patch: Record<string, unknown>): Promise<void> {
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
      ...patch,
    })
  );
}

let todo = '';
let done = '';

async function setup(): Promise<void> {
  await as(() => createTable({ id: TABLE, name: 'repeat_v2_table' }));
  for (const body of [
    def(ID.day, 'day', 'date'),
    def(ID.sunday, 'sunday', 'date'),
    def(ID.at, 'at', 'datetime'),
    def(ID.span, 'span', 'date'),
    def(ID.status, 'status', 'select', { options: [{ label: 'todo' }, { label: 'done' }] }),
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
  await updateField(ID.day, { recurrence });
  await updateField(ID.sunday, { recurrence });
  await updateField(ID.at, { recurrence });
  await updateField(ID.span, { range: true });
  await updateField(ID.span, { recurrence });
  // Wed Oct 14, 2026.
  for (const id of [E1, E2]) {
    const { schemaVersion } = await listTableEntries(TABLE);
    await as(() =>
      createTableEntry(TABLE, {
        id,
        values: {
          [ID.day]: '2026-10-14',
          [ID.sunday]: '2026-10-14',
          [ID.at]: '2026-10-14T22:00:00Z',
          [ID.span]: '2026-10-14/2026-10-15',
        },
        schemaVersion,
      })
    );
  }
}

const undo = () => as(() => stepTableHistory('undo', {}));

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

async function caught(action: () => Promise<unknown>) {
  try {
    await action();
  } catch (error) {
    return error as { statusCode?: number; message: string };
  }
  throw new Error('expected a rejection');
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

const tallies = async (id: string) =>
  (await state(id)).log
    .filter((row) => row.fieldId === ID.day)
    .map((row) => [row.occurrence, row.kind, row.doneOn])
    .sort();

describe('repeats (real DB)', () => {
  beforeEach(async () => {
    await clean();
    await setup();
  });
  afterAll(clean);

  describe('set stores only the schedule keys', () => {
    it('stores a repeat with no time-to-do-it key', async () => {
      const rent = await act(E1, ID.day, 'set', {
        rrule: 'FREQ=MONTHLY',
        date: '2026-11-01',
      });
      expect(rent.repeat).toEqual({
        rrule: 'FREQ=MONTHLY',
        dtstart: '2026-11-01',
        current: '2026-11-01',
        tz: expect.any(String),
      });
      expect(rent.entry.values[ID.day]).toBe('2026-11-01');
      // The stored value carries only the schedule keys — no `within`.
      expect(Object.keys((await state(E1)).repeats[ID.day]!)).toEqual([
        'rrule',
        'dtstart',
        'current',
        'tz',
      ]);
    });

    it('rejects a `within` param like an unknown field', async () => {
      const error = await caught(() =>
        act(E1, ID.day, 'set', { rrule: 'FREQ=WEEKLY;BYDAY=WE', within: 'next' })
      );
      expect(error.statusCode).toBe(400);
      expect(error.message).toMatch(/within is no longer supported/);
      expect((await state(E1)).repeats).toEqual({});
    });

    it('a field with an End date repeats on set days only', async () => {
      const set = await act(E1, ID.span, 'set', { rrule: 'FREQ=WEEKLY;BYDAY=WE' });
      expect(set.repeat).toMatchObject({ current: '2026-10-14' });
      expect(set.repeat).not.toHaveProperty('within');
    });
  });

  describe('agents: the table tool', () => {
    const agentWrite = (input: Parameters<typeof writeAgentEntries>[1]) =>
      as(() => writeAgentEntries('repeat_v2_table', input));

    it('marks repeating fields and says how to write a repeat', async () => {
      const detail = renderTableDetail(await describeAgentTable('repeat_v2_table'));
      expect(detail).toContain('day date? ↻');
      expect(detail).toContain('repeats (↻): write repeat [{id, field, set:');
    });

    it('sets set days alongside a row update, after it', async () => {
      const current = await getTableEntry(TABLE, E2);
      const result = await agentWrite({
        update: [{ id: E2, values: { status: 'todo' }, rev: current.entry.revision }],
        repeat: [{ id: E2, field: 'day', set: { rrule: 'FREQ=WEEKLY;BYDAY=WE' } }],
      });
      expect(result.updated).toHaveLength(1);
      expect(result.repeats?.[0]?.repeat).toBe('Every week on Wednesday · Wed Oct 14');
    });

    it('jumps an interval that is behind to its next time with skip: "now", logging none', async () => {
      // Every minute from the cell's Oct 14, 22:00Z, never marked done.
      await agentWrite({ repeat: [{ id: E1, field: 'at', set: { rrule: 'FREQ=MINUTELY' } }] });
      const started = Date.now();
      const jumped = await agentWrite({ repeat: [{ id: E1, field: 'at', skip: 'now' }] });
      expect(jumped.repeats?.[0]?.repeat).toMatch(/^Every 1 min · /);
      const view = await state(E1);
      const repeat = view.repeats[ID.at]!;
      const at = Date.parse(tableDateTimeToUtc(repeat.current, repeat.tz)!);
      expect(at).toBeGreaterThanOrEqual(started - 1000);
      expect(at).toBeLessThanOrEqual(Date.now() + 60_000);
      expect(view.log.filter((row) => row.fieldId === ID.at)).toEqual([]);
      // A repeat on set days has no jump.
      await agentWrite({ repeat: [{ id: E2, field: 'day', set: { rrule: 'FREQ=WEEKLY' } }] });
      expect(
        (await caught(() => agentWrite({ repeat: [{ id: E2, field: 'day', skip: 'now' }] })))
          .message
      ).toContain('Only a repeat at an interval');
    });

    it('refuses a repeat item that is unclear or not on a date field', async () => {
      for (const [item, message] of [
        [{ id: E1, field: 'day', done: true, skip: true }, 'exactly one'],
        [{ id: E1, field: 'day', skip: 'later' }, 'skip must be true or "now"'],
        [{ id: E1, field: 'status', done: true }, 'date or datetime field'],
        [{ id: 'nope', field: 'day', done: true }, 'entry UUID'],
        [
          { id: E1, field: 'day', set: { rrule: 'FREQ=WEEKLY;BYDAY=WE', within: 'next' } },
          "set.within isn't a repeat set key",
        ],
      ] as const) {
        const error = await caught(() => agentWrite({ repeat: [item as never] }));
        expect(error.message).toContain(message);
      }
    });
  });
});
