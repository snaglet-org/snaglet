/**
 * The starter tables a fresh install gets, against real PostgreSQL and the
 * real table, calendar and reminder services: the workspace-level `ideas`,
 * `tasks`, `events` and `reminders` tables with their fields (ideas, tasks and
 * events blank, one example reminder with no repeat or notification), the
 * sample project's own task table, what the Calendar shows for the next three
 * weeks, and a second seed keeping what is there.
 */
import { createHash } from 'node:crypto';
import { beforeAll, describe, expect, it, jest } from '@jest/globals';
import { Containers, getDbClient, transaction } from '@snaglet/db';
import { Calendars } from '@snaglet/db/tables/calendars';
import { Reminders } from '@snaglet/db/tables/reminders';
import { TableCatalog } from '@snaglet/db/tables/table_catalog';
import {
  provisionTablesReaderRole,
  TABLES_READER_ROLE,
} from '@snaglet/db/runtime/postgres/runtime';
import type {
  CalendarOccurrence,
  CalendarRowOccurrence,
  TableEntry,
  TableField,
} from '@snaglet/shared/types';
import { tableDateTimeLocalDate, userTimeZone } from '@snaglet/shared/utils';
import { loadTestClusterHandoff } from '../../../../../support/pgTestCluster';

const handoff = loadTestClusterHandoff();
const database = process.env.SNAGLET_PG_TEST_DATABASE;
if (!database) throw new Error('Missing SNAGLET_PG_TEST_DATABASE');
const readerPassword = createHash('sha256')
  .update(`${TABLES_READER_ROLE}:${handoff.runToken}`)
  .digest('base64url');
{
  const url = new URL('postgresql://localhost');
  url.username = TABLES_READER_ROLE;
  url.password = readerPassword;
  url.pathname = `/${database}`;
  url.searchParams.set('host', handoff.host);
  url.port = String(handoff.port);
  url.searchParams.set('sslmode', 'disable');
  process.env.SNAGLET_TABLES_READER_URL = url.toString();
}

const broadcast = jest.fn();
jest.mock('@server/services/WebSocketService', () => ({
  wsService: {
    broadcastToChannel: (...args: unknown[]) => broadcast(...args),
    broadcast: jest.fn(),
    sendToClient: jest.fn(),
  },
}));

import { createCalendar } from '@server/domains/calendar/calendarService';
import { listOccurrences } from '@server/domains/calendar/occurrences';
import { remindersBetween } from '@server/domains/reminders/upcomingReminders';
import { getTableRepeats, listTableEntries } from '@server/domains/tables/tableEntries';
import { listTableFields } from '@server/domains/tables/tableFields';
import {
  seedSampleProjectTable,
  seedStarterTables,
  type StarterTableIds,
} from '@server/services/onboarding/starterTables';

const PROJECT = 'container-1111111111111-onboarding';
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

let ids: StarterTableIds;
let sampleId = '';
let defaultCalendar = '';
let lookalike = '';
let today = '';

function addDays(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY).toISOString().slice(0, 10);
}

async function fieldsOf(tableId: string): Promise<Map<string, TableField>> {
  return new Map((await listTableFields(tableId)).map((field) => [field.name, field]));
}

function field(fields: Map<string, TableField>, name: string): TableField {
  const found = fields.get(name);
  if (!found) throw new Error(`missing field ${name}`);
  return found;
}

function optionsOf(found: TableField): Array<[string, string]> {
  return (found.options ?? []).map((option) => [option.label, option.color]);
}

function optionId(found: TableField, label: string): string {
  const option = found.options?.find((candidate) => candidate.label === label);
  if (!option) throw new Error(`missing option ${label}`);
  return option.id;
}

async function entriesOf(tableId: string): Promise<TableEntry[]> {
  return (await listTableEntries(tableId)).entries;
}

/** Entry values by field name. */
async function rowsOf(tableId: string): Promise<Array<Record<string, unknown>>> {
  const fields = await listTableFields(tableId);
  return (await entriesOf(tableId)).map((entry) =>
    Object.fromEntries(fields.map((one) => [one.name, entry.values[one.id] ?? null]))
  );
}

function text(value: unknown): string {
  if (typeof value !== 'string') throw new Error(`expected text, got ${JSON.stringify(value)}`);
  return value;
}

/** A datetime (or a range's start) is a real instant, after now and within `days`. */
function expectSoon(instant: string, days: number): void {
  const at = Date.parse(instant);
  expect(Number.isFinite(at)).toBe(true);
  expect(at).toBeGreaterThan(Date.now());
  expect(at).toBeLessThan(Date.now() + days * DAY);
}

function rowOccurrences(occurrences: CalendarOccurrence[], tableId: string) {
  return occurrences.filter(
    (occurrence): occurrence is CalendarRowOccurrence =>
      occurrence.source === 'row' && occurrence.tableId === tableId
  );
}

beforeAll(async () => {
  await provisionTablesReaderRole(await getDbClient(), {
    password: readerPassword,
    database: database!,
    revokePublic: true,
  });
  // A fresh install's Default calendar, then a calendar titled "Default" that
  // is listed first but is not the default one.
  defaultCalendar = (await transaction((tx) => Calendars.ensureDefault(tx, userTimeZone())))
    .calendar.id;
  lookalike = (await createCalendar({ title: 'Default', timeZone: 'UTC', sortOrder: 0 })).id;
  await Containers.create({ id: PROJECT, name: 'Sample project', category: 'project' });
  today = tableDateTimeLocalDate(new Date().toISOString(), userTimeZone()) ?? '';
  broadcast.mockClear();
  ids = await seedStarterTables();
  sampleId = await seedSampleProjectTable(PROJECT);
});

describe('starter tables', () => {
  it('creates the four tables at the workspace level and announces them', async () => {
    for (const [name, id] of Object.entries(ids)) {
      expect(await TableCatalog.findById(id)).toMatchObject({
        name,
        origin: 'custom',
        state: 'active',
        projectId: null,
      });
    }
    const created = broadcast.mock.calls
      .map(([, message]) => message as { type?: string; payload?: { table?: { name: string } } })
      .filter((message) => message.type === 'table.created')
      .map((message) => message.payload?.table?.name);
    expect(created).toEqual(['ideas', 'tasks', 'events', 'reminders', 'sample_project_tasks']);
  });

  it('gives ideas its fields and options, and no rows', async () => {
    const fields = await fieldsOf(ids.ideas);
    expect([...fields.keys()]).toEqual([
      'name',
      'id',
      'created_at',
      'idea',
      'category',
      'status',
      'priority',
      'date_added',
      'notes',
      'related_docs',
    ]);
    expect(field(fields, 'name').isTitle).toBe(true);
    expect(field(fields, 'idea').type).toBe('text');
    expect(optionsOf(field(fields, 'category'))).toEqual([
      ['Product', 'blue'],
      ['Content', 'pink'],
      ['Process', 'orange'],
      ['Research', 'purple'],
      ['Personal', 'green'],
      ['Other', 'gray'],
    ]);
    expect(optionsOf(field(fields, 'status'))).toEqual([
      ['New', 'blue'],
      ['Exploring', 'purple'],
      ['In progress', 'yellow'],
      ['On hold', 'orange'],
      ['Completed', 'green'],
      ['Archived', 'gray'],
    ]);
    expect(field(fields, 'status').defaultValue).toBe('New');
    expect(optionsOf(field(fields, 'priority'))).toEqual([
      ['Low', 'blue'],
      ['Medium', 'yellow'],
      ['High', 'red'],
    ]);
    expect(field(fields, 'date_added')).toMatchObject({ type: 'date', range: false });
    expect(field(fields, 'date_added').calendarId).toBeUndefined();
    expect(field(fields, 'notes').type).toBe('text');
    expect(field(fields, 'related_docs')).toMatchObject({
      type: 'relation',
      referenceKind: 'doc',
      referenceTableId: null,
      multiple: true,
    });
    expect(await entriesOf(ids.ideas)).toEqual([]);
  });

  it('gives tasks a due date on the Default calendar that Done completes, and no rows', async () => {
    const fields = await fieldsOf(ids.tasks);
    expect([...fields.keys()]).toEqual([
      'name',
      'id',
      'created_at',
      'due',
      'status',
      'priority',
      'notes',
    ]);
    const status = field(fields, 'status');
    expect(optionsOf(status)).toEqual([
      ['To do', 'blue'],
      ['In progress', 'yellow'],
      ['Done', 'green'],
    ]);
    expect(status.defaultValue).toBe('To do');
    expect(field(fields, 'due')).toMatchObject({
      type: 'date',
      range: false,
      calendarId: defaultCalendar,
      recurrence: {
        statusFieldId: status.id,
        doneOptionIds: [optionId(status, 'Done')],
        resetOptionId: optionId(status, 'To do'),
      },
    });
    expect(optionsOf(field(fields, 'priority')).map(([label]) => label)).toEqual([
      'Low',
      'Medium',
      'High',
    ]);
    expect(field(fields, 'notes').type).toBe('text');
    expect(field(fields, 'name').description).toContain('general to-do list');
    expect(await entriesOf(ids.tasks)).toEqual([]);
  });

  it('gives events a timed start and end on the Default calendar, and no rows', async () => {
    const fields = await fieldsOf(ids.events);
    expect([...fields.keys()]).toEqual([
      'name',
      'id',
      'created_at',
      'time',
      'location',
      'attendees',
      'notes',
    ]);
    expect(field(fields, 'time')).toMatchObject({
      type: 'datetime',
      range: true,
      calendarId: defaultCalendar,
    });
    for (const name of ['location', 'attendees', 'notes'])
      expect(field(fields, name).type).toBe('text');
    expect(await entriesOf(ids.events)).toEqual([]);
  });

  it('gives reminders a timed date on the Default calendar and a done checkbox, with one example', async () => {
    const fields = await fieldsOf(ids.reminders);
    expect([...fields.keys()]).toEqual(['name', 'id', 'created_at', 'time', 'done', 'notes']);
    expect(field(fields, 'time')).toMatchObject({
      type: 'datetime',
      range: false,
      calendarId: defaultCalendar,
    });
    expect(field(fields, 'done')).toMatchObject({ type: 'checkbox', defaultValue: false });
    const rows = await rowsOf(ids.reminders);
    expect(rows).toHaveLength(1);
    const [row] = rows;
    expect(row).toMatchObject({
      name: 'Water the plants',
      done: false,
      notes: 'Example row: delete it when you are ready.',
    });
    // The day after tomorrow at 18:00, in the user's time zone.
    const time = text(row!.time);
    expectSoon(time, 3);
    expect(tableDateTimeLocalDate(time, userTimeZone())).toBe(addDays(today, 2));
    expect(
      new Intl.DateTimeFormat('en-US', {
        timeZone: userTimeZone(),
        hour: '2-digit',
        minute: '2-digit',
        hourCycle: 'h23',
      }).format(new Date(time))
    ).toBe('18:00');
  });

  it('sets no repeat and no notification on the example reminder', async () => {
    const time = field(await fieldsOf(ids.reminders), 'time');
    expect((await getTableRepeats(ids.reminders)).rows).toEqual([]);
    const [entry] = await entriesOf(ids.reminders);
    expect(
      await Reminders.get({
        kind: 'table_entry',
        tableId: ids.reminders,
        entryId: entry!.id,
        fieldId: time.id,
      })
    ).toBeNull();
    const now = Date.now();
    expect(await remindersBetween({ from: new Date(now), to: new Date(now + 4 * DAY) })).toEqual(
      []
    );
  });

  it('puts the sample project task table in the project with four dated examples', async () => {
    expect(await TableCatalog.findById(sampleId)).toMatchObject({
      name: 'sample_project_tasks',
      origin: 'custom',
      state: 'active',
      projectId: PROJECT,
    });
    const fields = await fieldsOf(sampleId);
    expect([...fields.keys()]).toEqual([
      'name',
      'id',
      'created_at',
      'task',
      'status',
      'priority',
      'due_date',
      'notes',
    ]);
    const status = field(fields, 'status');
    expect(optionsOf(status)).toEqual([
      ['To do', 'blue'],
      ['In progress', 'green'],
      ['Done', 'yellow'],
      ['Blocked', 'orange'],
    ]);
    expect(optionsOf(field(fields, 'priority'))).toEqual([
      ['Low', 'blue'],
      ['Medium', 'green'],
      ['High', 'yellow'],
    ]);
    expect(field(fields, 'due_date')).toMatchObject({
      type: 'date',
      range: false,
      calendarId: defaultCalendar,
      recurrence: {
        statusFieldId: status.id,
        doneOptionIds: [optionId(status, 'Done')],
        resetOptionId: optionId(status, 'To do'),
      },
    });
    expect(field(fields, 'name').description).toContain("sample project's own task list");
    const rows = await rowsOf(sampleId);
    expect(rows).toHaveLength(4);
    for (const row of rows) {
      const due = text(row.due_date);
      expect(due).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(due > today).toBe(true);
      expect(due < addDays(today, 22)).toBe(true);
      expect(['To do', 'In progress']).toContain(row.status);
      expect(['Low', 'Medium', 'High']).toContain(row.priority);
      expect(text(row.task)).not.toBe('');
      expect(row.notes).toBe('Example row: edit or delete it.');
    }
  });

  it('shows the reminder and sample project rows on the Default calendar for the next three weeks', async () => {
    const window = await listOccurrences({
      from: today,
      to: addDays(today, 22),
      tz: userTimeZone(),
    });
    const events = rowOccurrences(window.occurrences, ids.events);
    const reminders = rowOccurrences(window.occurrences, ids.reminders);
    const sample = rowOccurrences(window.occurrences, sampleId);
    expect(events).toEqual([]);
    expect(new Set(reminders.map((one) => one.entryId))).toEqual(
      new Set((await entriesOf(ids.reminders)).map((entry) => entry.id))
    );
    expect(new Set(sample.map((one) => one.entryId))).toEqual(
      new Set((await entriesOf(sampleId)).map((entry) => entry.id))
    );
    // The example reminder shows once, as a timed item.
    expect(reminders).toHaveLength(1);
    expect(reminders.every((one) => one.time.kind === 'timed' && !one.repeat)).toBe(true);
    expect(sample.every((one) => one.time.kind === 'all_day')).toBe(true);
    for (const one of [...events, ...reminders, ...sample]) {
      expect(one.calendarId).toBe(defaultCalendar);
      expect(one.calendarId).not.toBe(lookalike);
    }
    expect(rowOccurrences(window.occurrences, ids.tasks)).toEqual([]);
    expect(window.unavailable).toEqual([]);
  });

  it('writes no personal data into example rows', async () => {
    for (const tableId of [...Object.values(ids), sampleId]) {
      for (const row of await rowsOf(tableId)) {
        for (const value of Object.values(row)) {
          if (typeof value !== 'string') continue;
          expect(value).not.toMatch(/\/Users\/|\/home\/|[A-Za-z]:\\/);
          expect(value).not.toMatch(/[\w.+-]+@[\w-]+\.[\w.-]+/);
          expect(value).not.toMatch(/Venus/i);
        }
      }
    }
  });

  it('keeps tables that already exist when it runs again', async () => {
    const counts = async () =>
      Promise.all(
        [...Object.values(ids), sampleId].map(async (id) => (await entriesOf(id)).length)
      );
    const before = await counts();
    broadcast.mockClear();
    expect(await seedStarterTables()).toEqual(ids);
    expect(await seedSampleProjectTable(PROJECT)).toBe(sampleId);
    expect(await counts()).toEqual(before);
    const created = broadcast.mock.calls.filter(
      ([, message]) => (message as { type?: string }).type === 'table.created'
    );
    expect(created).toEqual([]);
  });
});
