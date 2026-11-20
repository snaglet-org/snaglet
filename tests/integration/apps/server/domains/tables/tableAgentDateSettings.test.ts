/**
 * Agents turn a date field's repeats on and off and show it on a calendar
 * through `table` op schema, against real PostgreSQL: the
 * settings round-trip and read back, other types are refused, and turning
 * repeats off while rows repeat needs `clear_repeats` (the editor warns
 * first), with undo putting the rows' repeats back. A calendar binding is
 * announced once, after commit: `"default"` with no calendar makes
 * the Default calendar and one binding event, and a batch that fails after
 * binding announces and keeps nothing.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { getDb, quoteIdentifier } from '@snaglet/db';
import { Calendars } from '@snaglet/db/tables/calendars';
import { TableCatalog } from '@snaglet/db/tables/table_catalog';
import { DEFAULT_CALENDAR_TITLE } from '@snaglet/shared/types';
import type { Actor } from '@snaglet/shared/types/workspace-events';

jest.mock('@server/realtime/surfaces/tables', () => ({
  emitTableCreated: () => undefined,
  emitTableUpdated: () => undefined,
  emitTableFieldsChanged: () => undefined,
  emitTableEntriesChanged: () => undefined,
  emitTableRemoved: () => undefined,
  emitTableRestored: () => undefined,
  emitTableHistoryChanged: () => undefined,
}));
const emitCalendarChanged = jest.fn();
jest.mock('@server/realtime/surfaces/calendar', () => ({
  emitCalendarChanged: (...args: unknown[]) => emitCalendarChanged(...args),
}));

import { runWithActor } from '@server/realtime/actorContext';
import { createCalendar } from '@server/domains/calendar/calendarService';
import { stepTableHistory } from '@server/domains/tables/tableHistory';
import {
  applyAgentSchema,
  describeAgentTable,
  writeAgentEntries,
  type AgentSchemaInput,
  type AgentTableSummary,
} from '@server/domains/tables/tableAgent';
import { renderTableDetail } from '@server/services/ToolService/tools/database/_shared/render';

const USER: Actor = {
  actorKind: 'user',
  actorId: 'test-user-date-settings',
  actorName: 'Test User',
};
const TABLE = 'agent_chores';
const ROW = '11111111-1111-4111-8111-111111111111';
const as = <T>(fn: () => Promise<T>): Promise<T> => runWithActor(USER, fn);
const schema = (input: AgentSchemaInput) => as(() => applyAgentSchema(TABLE, input));
const undo = () => as(() => stepTableHistory('undo', {}));

let home = '';
let work = '';

function fieldNamed(summary: AgentTableSummary, name: string) {
  const field = summary.fields.find((candidate) => candidate.name === name);
  if (!field) throw new Error(`missing field ${name}`);
  return field;
}

async function repeatRows(): Promise<number> {
  const { rows } = await getDb().query<{ n: number }>(
    `SELECT count(*)::int AS n FROM public.table_entry_repeats r
       JOIN public.table_catalog c ON c.id = r.table_id WHERE c.name = $1`,
    [TABLE]
  );
  return rows[0]?.n ?? -1;
}

async function historySteps(): Promise<number> {
  const { rows } = await getDb().query<{ n: number }>(
    'SELECT count(*)::int AS n FROM public.table_history WHERE actor_id = $1',
    [USER.actorId]
  );
  return rows[0]?.n ?? -1;
}

async function dropTable(): Promise<void> {
  const table = await TableCatalog.findByName(TABLE);
  if (!table) return;
  await getDb().query(
    `DROP TABLE IF EXISTS user_tables.${quoteIdentifier(table.tableName)} CASCADE`
  );
  for (const name of ['table_entry_occurrences', 'table_entry_repeats', 'table_fields'])
    await getDb().query(`DELETE FROM public.${name} WHERE table_id = $1`, [table.id]);
  await getDb().query('DELETE FROM public.table_catalog WHERE id = $1', [table.id]);
}

async function clean(): Promise<void> {
  await dropTable();
  await getDb().query('DELETE FROM public.table_history WHERE actor_id = $1', [USER.actorId]);
}

describe('table schema: repeats and calendar on date fields', () => {
  beforeAll(async () => {
    home = (await as(() => createCalendar({ title: 'Home', timeZone: 'UTC' }))).id;
    work = (await as(() => createCalendar({ title: 'Work', timeZone: 'UTC' }))).id;
  });

  beforeEach(async () => {
    await clean();
    emitCalendarChanged.mockClear();
    await schema({ fields: [{ name: 'note', type: 'text' }] });
  });

  afterAll(async () => {
    await clean();
    await getDb().query('DELETE FROM public.calendars WHERE id = ANY($1::text[])', [[home, work]]);
  });

  it('adds a repeating field on a calendar (title in any case) and reads both back', async () => {
    const { table } = await schema({
      ops: [
        {
          op: 'add_field',
          field: { name: 'due', type: 'date', repeats: true, calendar: 'home' },
        },
        { op: 'add_field', field: { name: 'checked', type: 'datetime', calendar: work } },
      ],
    });
    expect(fieldNamed(table, 'due')).toMatchObject({
      recurrence: { statusFieldId: null, doneOptionIds: [], resetOptionId: null },
      calendarId: home,
      calendarName: 'Home',
    });
    expect(fieldNamed(table, 'checked')).toMatchObject({ calendarId: work });
    // Every date field can repeat: a datetime field made without repeats has the default setting.
    expect(fieldNamed(table, 'checked').recurrence).toEqual({
      statusFieldId: null,
      doneOptionIds: [],
      resetOptionId: null,
    });
    const detail = renderTableDetail(await describeAgentTable(TABLE)).split('\n');
    expect(detail).toContain('due date? ↻ calendar "Home"');
    expect(detail).toContain('checked datetime? ↻ calendar "Work"');
    expect(emitCalendarChanged.mock.calls).toEqual([
      [{ kind: 'binding', calendarId: home }],
      [{ kind: 'binding', calendarId: work }],
    ]);
  });

  it('moves the field to another calendar and takes it off', async () => {
    const setting = { statusFieldId: null, doneOptionIds: [], resetOptionId: null };
    await schema({ ops: [{ op: 'add_field', field: { name: 'due', type: 'date' } }] });
    const on = await schema({
      ops: [{ op: 'update_field', name: 'due', set: { repeats: true, calendar: 'Home' } }],
    });
    expect(fieldNamed(on.table, 'due')).toMatchObject({ recurrence: setting, calendarId: home });
    emitCalendarChanged.mockClear();
    const moved = await schema({
      ops: [{ op: 'update_field', name: 'due', set: { calendar: work } }],
    });
    expect(fieldNamed(moved.table, 'due')).toMatchObject({ recurrence: setting, calendarId: work });
    expect(emitCalendarChanged.mock.calls).toEqual([
      [{ kind: 'binding', calendarId: home }],
      [{ kind: 'binding', calendarId: work }],
    ]);
    const off = await schema({
      ops: [{ op: 'update_field', name: 'due', set: { calendar: null } }],
    });
    expect(fieldNamed(off.table, 'due')).not.toHaveProperty('calendarId');
    expect(fieldNamed(off.table, 'due').recurrence).toEqual(setting);
  });

  it('refuses repeats or a calendar on other field types, changing nothing', async () => {
    await expect(
      schema({ ops: [{ op: 'add_field', field: { name: 'size', type: 'number', repeats: true } }] })
    ).rejects.toMatchObject({
      statusCode: 400,
      message:
        'ops[0] add_field: Only date and datetime fields can repeat or show on a calendar; size is number.',
    });
    await expect(
      schema({
        ops: [
          { op: 'add_field', field: { name: 'due', type: 'date' } },
          { op: 'update_field', name: 'note', set: { calendar: 'Home' } },
        ],
      })
    ).rejects.toMatchObject({
      statusCode: 400,
      message:
        'ops[1] update_field: Only date and datetime fields can repeat or show on a calendar; note is text.',
    });
    // Retyping a date field to text cannot keep a calendar either.
    await schema({ ops: [{ op: 'add_field', field: { name: 'due', type: 'date' } }] });
    await expect(
      schema({
        ops: [{ op: 'update_field', name: 'due', set: { type: 'text', calendar: 'Home' } }],
      })
    ).rejects.toMatchObject({ statusCode: 400, message: expect.stringMatching(/due is text\.$/) });
    const table = await describeAgentTable(TABLE);
    expect(table.fields.map((field) => field.name)).not.toContain('size');
    expect(fieldNamed(table, 'due').recurrence).toEqual({
      statusFieldId: null,
      doneOptionIds: [],
      resetOptionId: null,
    });
  });

  it('refuses a calendar that does not exist', async () => {
    await schema({ ops: [{ op: 'add_field', field: { name: 'due', type: 'date' } }] });
    await expect(
      schema({ ops: [{ op: 'update_field', name: 'due', set: { calendar: 'Holidays' } }] })
    ).rejects.toMatchObject({
      statusCode: 404,
      message: expect.stringMatching(/^No calendar "Holidays"\. Calendars: .*"Home"/),
    });
  });

  it('turns repeats off on repeating rows only with clear_repeats; undo brings them back', async () => {
    await schema({
      ops: [{ op: 'add_field', field: { name: 'due', type: 'date', repeats: true } }],
    });
    await as(() =>
      writeAgentEntries(TABLE, {
        insert: [{ id: ROW, values: { name: 'Water plants', due: '2026-10-12' } }],
        repeat: [{ id: ROW, field: 'due', set: { rrule: 'FREQ=WEEKLY' } }],
      })
    );
    expect(await repeatRows()).toBe(1);

    await expect(
      schema({ ops: [{ op: 'update_field', name: 'due', set: { repeats: false } }] })
    ).rejects.toMatchObject({
      statusCode: 409,
      message:
        'ops[0] update_field: due repeats on 1 row; turning repeats off removes its repeat (a person can undo it). Repeat with clear_repeats: true.',
    });
    // A repeating field can change type: its rows' repeats go with the old type.
    const retyped = await schema({
      ops: [{ op: 'update_field', name: 'due', set: { type: 'datetime' } }],
    });
    expect(fieldNamed(retyped.table, 'due')).toMatchObject({ type: 'datetime' });
    expect(await repeatRows()).toBe(0);
    await undo();
    expect(fieldNamed(await describeAgentTable(TABLE), 'due')).toMatchObject({ type: 'date' });
    expect(await repeatRows()).toBe(1);

    const off = await schema({
      ops: [{ op: 'update_field', name: 'due', set: { repeats: false }, clear_repeats: true }],
    });
    expect(fieldNamed(off.table, 'due').recurrence ?? null).toBeNull();
    expect(await repeatRows()).toBe(0);

    await undo();
    expect(fieldNamed(await describeAgentTable(TABLE), 'due').recurrence).toMatchObject({});
    expect(await repeatRows()).toBe(1);
  });

  it('a batch that binds calendars and then fails sends no calendar:changed and binds nothing', async () => {
    await schema({ ops: [{ op: 'add_field', field: { name: 'due', type: 'date' } }] });
    emitCalendarChanged.mockClear();
    const steps = await historySteps();
    await expect(
      schema({
        ops: [
          { op: 'update_field', name: 'due', set: { calendar: 'Home' } },
          { op: 'add_field', field: { name: 'slot', type: 'datetime', calendar: work } },
          { op: 'add_field', field: { name: 'size', type: 'number', repeats: true } },
        ],
      })
    ).rejects.toMatchObject({
      statusCode: 400,
      message: expect.stringMatching(/^ops\[2\] add_field: /),
    });
    expect(emitCalendarChanged).not.toHaveBeenCalled();
    const table = await describeAgentTable(TABLE);
    expect(fieldNamed(table, 'due')).not.toHaveProperty('calendarId');
    const names = table.fields.map((field) => field.name);
    expect(names).not.toContain('slot');
    expect(names).not.toContain('size');
    expect(await historySteps()).toBe(steps);
    const { rows } = await getDb().query<{ n: number }>(
      'SELECT count(*)::int AS n FROM public.table_fields WHERE calendar_id = ANY($1::text[])',
      [[home, work]]
    );
    expect(rows[0]?.n).toBe(0);
  });

  it('turns repeats off without clear_repeats while no row repeats', async () => {
    await schema({
      ops: [{ op: 'add_field', field: { name: 'due', type: 'date', repeats: true } }],
    });
    const off = await schema({
      ops: [{ op: 'update_field', name: 'due', set: { repeats: false, type: 'text' } }],
    });
    expect(fieldNamed(off.table, 'due')).toMatchObject({ type: 'text' });
    expect(fieldNamed(off.table, 'due').recurrence ?? null).toBeNull();
  });
});

describe('table schema: calendar "default" with no calendar', () => {
  async function dropCalendars(): Promise<void> {
    await getDb().query('DELETE FROM public.calendars');
  }

  beforeEach(async () => {
    await clean();
    await dropCalendars();
    emitCalendarChanged.mockClear();
    await schema({ fields: [{ name: 'note', type: 'text' }] });
  });

  afterAll(async () => {
    await clean();
    await dropCalendars();
  });

  it('creates the Default calendar and sends one binding event with its id', async () => {
    expect(await Calendars.list()).toEqual([]);
    const { table } = await schema({
      ops: [{ op: 'add_field', field: { name: 'due', type: 'date', calendar: 'default' } }],
    });
    const [created, ...others] = await Calendars.list();
    expect(others).toEqual([]);
    if (!created) throw new Error('no calendar was created');
    expect(created).toMatchObject({
      title: DEFAULT_CALENDAR_TITLE,
      isDefault: true,
    });
    expect(fieldNamed(table, 'due')).toMatchObject({
      calendarId: created.id,
      calendarName: DEFAULT_CALENDAR_TITLE,
    });
    expect(emitCalendarChanged.mock.calls).toEqual([[{ kind: 'binding', calendarId: created.id }]]);
  });
});
