/**
 * Reminders against real PostgreSQL and the real routes:
 *
 * - /api/reminders/settings CRUD, validation (400) and missing items (404);
 * - /api/reminders/upcoming: timed events, timed and repeating table rows
 *   (done ones skipped), once / repeat / Every automations (paused ones
 *   skipped, Every capped per window), all-day and date-only items excluded,
 *   window bounds, offsets, stable keys;
 * - the scheduler: delivery as fireAt passes, dedupe across ticks and
 *   restarts, the 10-minute catch-up limit, ledger pruning;
 * - `reminders:changed` on settings writes, calendar writes and row writes
 *   of tables that have row reminders.
 */
import { createHash } from 'node:crypto';
import { afterEach, beforeAll, beforeEach, describe, expect, it, jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';
import { getDb, getDbClient, quoteIdentifier } from '@snaglet/db';
import {
  provisionTablesReaderRole,
  TABLES_READER_ROLE,
} from '@snaglet/db/runtime/postgres/runtime';
import type { ReminderDue, TableField } from '@snaglet/shared/types';
import type { Actor } from '@snaglet/shared/types/workspace-events';
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
jest.mock('@server/services/SocketService/dispatch/dispatchToThread', () => ({
  dispatchToThread: async () => ({ ok: true, reason: 'completed', wakeCount: 1, capHit: false }),
}));

import { errorHandler } from '@server/middleware';
import { runWithActor } from '@server/realtime/actorContext';
import { deleteCalendar, previewCalendarDeletion } from '@server/domains/calendar/calendarDeletion';
import remindersRoutes from '@server/domains/reminders/reminders.routes';
import { reminderScheduler } from '@server/domains/reminders/reminderScheduler';
import {
  createEvent,
  deleteEvent,
  listCalendars,
  createCalendar,
  updateEvent,
} from '@server/domains/calendar/calendarService';
import { createTable } from '@server/domains/tables/tableCatalog';
import {
  createTableField,
  listTableFields,
  setTableFieldCalendar,
  updateTableField,
} from '@server/domains/tables/tableFields';
import {
  createTableEntry,
  listTableEntries,
  updateTableEntry,
} from '@server/domains/tables/tableEntries';
import { automationService } from '@server/services/automations/AutomationService';

const USER: Actor = { actorKind: 'user', actorId: 'test-user-rem', actorName: 'Test User' };
const as = <T>(fn: () => Promise<T>): Promise<T> => runWithActor(USER, fn);
const PERSON = { kind: 'person' } as const;

const AGENT = 'test-agent-a';
const THREAD = 'thread-1111111111111-remindaaa';
const TABLE = 'table-1111111111111-remaaaaa';
const OTHER_TABLE = 'table-1111111111111-rembbbbb';
const ID = {
  due: 'field-1111111111111-remdue',
  day: 'field-1111111111111-remday',
  status: 'field-1111111111111-remstat',
};
const E1 = '11111111-1111-4111-8111-111111111111';
const E2 = '22222222-2222-4222-8222-222222222222';
const E3 = '33333333-3333-4333-8333-333333333333';
const MISSING_ENTRY = '99999999-9999-4999-8999-999999999999';

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

function app() {
  const server = express();
  server.use(express.json());
  server.use('/api/reminders', remindersRoutes);
  server.use(errorHandler);
  return server;
}

async function sql<T = Record<string, unknown>>(text: string, params: unknown[] = []) {
  return (await getDb().query<T>(text, params)).rows;
}

/** A whole minute `ms` from now, ISO. */
function fromNow(ms: number): string {
  return new Date(Math.floor((Date.now() + ms) / MIN) * MIN).toISOString();
}

const settingsBody = (extra: Record<string, unknown> = {}) => ({
  enabled: true,
  atStart: true,
  offsets: [],
  sound: 'chime',
  ...extra,
});

const eventQuery = (eventId: string) => `kind=event&eventId=${eventId}`;
const rowQuery = (entryId: string, fieldId = ID.due, tableId = TABLE) =>
  `kind=table_entry&tableId=${tableId}&entryId=${entryId}&fieldId=${fieldId}`;
const automationQuery = (automationId: string) => `kind=automation&automationId=${automationId}`;

async function put(query: string, body: Record<string, unknown>) {
  return request(app()).put(`/api/reminders/settings?${query}`).send(body);
}

async function upcoming(hours?: number): Promise<ReminderDue[]> {
  const res = await request(app()).get(
    `/api/reminders/upcoming${hours === undefined ? '' : `?hours=${hours}`}`
  );
  expect(res.status).toBe(200);
  return res.body.data.reminders;
}

async function timedEvent(id: string, title: string, startAt: string, calendarId?: string) {
  const end = new Date(Date.parse(startAt) + HOUR).toISOString();
  const { event } = await as(() =>
    createEvent({
      id,
      title,
      ...(calendarId ? { calendarId } : {}),
      time: { kind: 'timed', startAt, endAt: end, timeZone: 'UTC' },
    })
  );
  return event;
}

function changedFrames(): number {
  return broadcast.mock.calls.filter(
    ([channel, frame]) =>
      channel === 'workspace' && (frame as { type: string }).type === 'reminders:changed'
  ).length;
}

async function cleanAll(): Promise<void> {
  await sql('DELETE FROM public.reminder_settings');
  await sql('DELETE FROM public.reminder_deliveries');
  await sql('DELETE FROM public.automations');
  await sql(`DELETE FROM public.schedules WHERE action_kind = 'automation'`);
  await sql('UPDATE public.table_fields SET calendar_id = NULL');
  await sql(`DELETE FROM public.nodes WHERE type = 'calendar_event'`);
  await sql('DELETE FROM public.calendars');
  for (const id of [TABLE, OTHER_TABLE]) {
    const rows = await sql<{ table_name: string }>(
      'SELECT table_name FROM public.table_catalog WHERE id = $1',
      [id]
    );
    for (const row of rows)
      await sql(`DROP TABLE IF EXISTS user_tables.${quoteIdentifier(row.table_name)} CASCADE`);
    await sql('DELETE FROM public.table_entry_occurrences WHERE table_id = $1', [id]);
    await sql('DELETE FROM public.table_entry_repeats WHERE table_id = $1', [id]);
    await sql('DELETE FROM public.table_fields WHERE table_id = $1', [id]);
    await sql('DELETE FROM public.table_catalog WHERE id = $1', [id]);
  }
  await sql('DELETE FROM public.table_history WHERE actor_id = $1', [USER.actorId]);
}

async function field(tableId: string, id: string): Promise<TableField> {
  const found = (await listTableFields(tableId)).find((f) => f.id === id);
  if (!found) throw new Error(`no field ${id}`);
  return found;
}

/** The id of field `id` in `tableId` (OTHER_TABLE gets its own ids). */
function fieldIdIn(tableId: string, id: string): string {
  return tableId === TABLE ? id : id.replace('-rem', '-rmb');
}

/** A table with a datetime `due`, a date `day` and a select `status`; due and day on `calendarId`. */
async function setupTable(calendarId: string, tableId = TABLE): Promise<void> {
  await as(() => createTable({ id: tableId, name: `rem_${tableId.slice(-5)}` }));
  const def = (id: string, name: string, type: string, extra: Record<string, unknown> = {}) => ({
    id: fieldIdIn(tableId, id),
    name,
    description: null,
    type,
    nullable: true,
    defaultValue: null,
    referenceTableId: null,
    ...extra,
  });
  for (const body of [
    def(ID.due, 'due', 'datetime'),
    def(ID.day, 'day', 'date'),
    def(ID.status, 'status', 'select', { options: [{ label: 'todo' }, { label: 'done' }] }),
  ])
    await as(() => createTableField(tableId, body));
  for (const id of [ID.due, ID.day]) {
    const fieldId = fieldIdIn(tableId, id);
    const current = await field(tableId, fieldId);
    await as(() =>
      setTableFieldCalendar(tableId, fieldId, { calendarId, expectedRevision: current.revision })
    );
  }
}

async function addEntry(id: string, values: Record<string, unknown>, tableId = TABLE) {
  const { schemaVersion } = await listTableEntries(tableId);
  const { name, ...rest } = values;
  const mapped = name === undefined ? rest : { ...rest, [`field-title-${tableId}`]: name };
  await as(() => createTableEntry(tableId, { id, values: mapped, schemaVersion }));
}

async function defaultCalendarId(): Promise<string> {
  return ((await listCalendars())[0] ?? (await createCalendar({ title: 'Default calendar' }))).id;
}

beforeAll(async () => {
  await provisionTablesReaderRole(await getDbClient(), {
    password: readerPassword,
    database: database!,
    revokePublic: true,
  });
  await sql(
    `INSERT INTO public.agents (id, name) VALUES ($1, 'Test Agent A') ON CONFLICT DO NOTHING`,
    [AGENT]
  );
  await sql(
    `INSERT INTO public.members (id, kind, agent_id) VALUES ($1, 'agent', $2) ON CONFLICT DO NOTHING`,
    [`${AGENT}-member`, AGENT]
  );
  await sql(`INSERT INTO public.nodes (id, type) VALUES ($1, 'thread') ON CONFLICT DO NOTHING`, [
    THREAD,
  ]);
  await sql(
    `INSERT INTO public.threads (id, title) VALUES ($1, 'Reminder thread') ON CONFLICT DO NOTHING`,
    [THREAD]
  );
  const [member] = await sql<{ id: string }>(`SELECT id FROM public.members WHERE agent_id = $1`, [
    AGENT,
  ]);
  await sql(
    `INSERT INTO public.thread_participants (thread_id, member_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
    [THREAD, member!.id]
  );
});

// Each test file runs on its own database clone, so no file-level teardown.
beforeEach(async () => {
  await cleanAll();
  broadcast.mockClear();
});

describe('reminder settings', () => {
  it('reads null, saves (deduping offsets), reads back, deletes; each write emits reminders:changed', async () => {
    await timedEvent('event-rem-crud', 'Dentist', fromNow(2 * HOUR));
    const empty = await request(app()).get(
      `/api/reminders/settings?${eventQuery('event-rem-crud')}`
    );
    expect(empty.status).toBe(200);
    expect(empty.body.data).toEqual({ settings: null });

    broadcast.mockClear();
    const saved = await put(
      eventQuery('event-rem-crud'),
      settingsBody({
        atStart: false,
        sound: 'bell',
        offsets: [
          { amount: 60, unit: 'minutes' },
          { amount: 15, unit: 'minutes' },
          { amount: 1, unit: 'hours' },
          { amount: 15, unit: 'minutes' },
          { amount: 1, unit: 'days' },
        ],
      })
    );
    expect(saved.status).toBe(200);
    expect(saved.body.data.settings).toEqual({
      item: { kind: 'event', eventId: 'event-rem-crud' },
      enabled: true,
      atStart: false,
      offsets: [
        { amount: 60, unit: 'minutes' },
        { amount: 15, unit: 'minutes' },
        { amount: 1, unit: 'days' },
      ],
      sound: 'bell',
      updatedAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/),
    });
    expect(changedFrames()).toBe(1);
    expect(broadcast).toHaveBeenCalledWith('workspace', {
      type: 'reminders:changed',
      payload: {},
    });

    const again = await put(eventQuery('event-rem-crud'), settingsBody({ enabled: false }));
    expect(again.body.data.settings).toMatchObject({ enabled: false, atStart: true, offsets: [] });
    const read = await request(app()).get(
      `/api/reminders/settings?${eventQuery('event-rem-crud')}`
    );
    expect(read.body.data.settings).toEqual(again.body.data.settings);
    expect((await sql('SELECT 1 FROM public.reminder_settings')).length).toBe(1);

    broadcast.mockClear();
    const removed = await request(app()).delete(
      `/api/reminders/settings?${eventQuery('event-rem-crud')}`
    );
    expect(removed.status).toBe(200);
    expect(removed.body.data).toEqual({ settings: null });
    expect(changedFrames()).toBe(1);
    const gone = await request(app()).get(
      `/api/reminders/settings?${eventQuery('event-rem-crud')}`
    );
    expect(gone.body.data.settings).toBeNull();
  });

  it('refuses bad input with 400 and missing items with 404', async () => {
    await timedEvent('event-rem-valid', 'Standup', fromNow(2 * HOUR));
    const q = eventQuery('event-rem-valid');
    const bad: Record<string, unknown>[] = [
      settingsBody({ offsets: [{ amount: 0, unit: 'minutes' }] }),
      settingsBody({ offsets: [{ amount: 1000, unit: 'minutes' }] }),
      settingsBody({ offsets: [{ amount: 1.5, unit: 'hours' }] }),
      settingsBody({ offsets: [{ amount: '5', unit: 'minutes' }] }),
      settingsBody({ offsets: [{ amount: 1, unit: 'weeks' }] }),
      settingsBody({ offsets: 'soon' }),
      settingsBody({
        offsets: Array.from({ length: 11 }, (_, i) => ({ amount: i + 1, unit: 'minutes' })),
      }),
      settingsBody({ sound: 'beep' }),
      settingsBody({ enabled: 'yes' }),
      { atStart: true, offsets: [], sound: 'chime' },
    ];
    for (const body of bad) expect((await put(q, body)).status).toBe(400);
    // Ten distinct offsets are fine.
    const ten = await put(
      q,
      settingsBody({
        offsets: Array.from({ length: 10 }, (_, i) => ({ amount: i + 1, unit: 'minutes' })),
      })
    );
    expect(ten.status).toBe(200);

    for (const query of [
      'kind=nope&eventId=x',
      'kind=event',
      `kind=table_entry&tableId=${TABLE}&entryId=not-a-uuid&fieldId=${ID.due}`,
      `kind=table_entry&tableId=${TABLE}&entryId=${E1}`,
      'kind=automation',
    ])
      expect((await request(app()).get(`/api/reminders/settings?${query}`)).status).toBe(400);

    const calendarId = await defaultCalendarId();
    await setupTable(calendarId);
    await addEntry(E1, { name: 'Call', [ID.due]: fromNow(3 * HOUR) });
    expect((await put(eventQuery('event-missing'), settingsBody())).status).toBe(404);
    expect(
      (await put(automationQuery('automation-1111111111111-missingaa'), settingsBody())).status
    ).toBe(404);
    expect((await put(rowQuery(MISSING_ENTRY), settingsBody())).status).toBe(404);
    expect((await put(rowQuery(E1, 'field-1111111111111-nofield'), settingsBody())).status).toBe(
      404
    );
    expect((await put(rowQuery(E1, ID.status), settingsBody())).status).toBe(400);
    expect((await put(rowQuery(E1), settingsBody())).status).toBe(200);

    // A deleted event is missing too.
    await as(() => deleteEvent('event-rem-valid', '1'));
    expect((await put(q, settingsBody())).status).toBe(404);
  });
});

describe('upcoming reminders', () => {
  it('lists events in the window by fireAt, with offsets, stable keys, and nothing all-day, past or disabled', async () => {
    const soon = fromNow(2 * HOUR);
    const later = fromNow(73 * HOUR);
    await timedEvent('event-rem-soon', 'Dentist', soon);
    await timedEvent('event-rem-later', 'Flight', later);
    await timedEvent('event-rem-off', 'Muted', fromNow(4 * HOUR));
    await as(() =>
      createEvent({
        id: 'event-rem-allday',
        title: 'Holiday',
        time: {
          kind: 'all_day',
          startDate: fromNow(DAY).slice(0, 10),
          endDate: fromNow(2 * DAY).slice(0, 10),
          timeZone: 'UTC',
        },
      })
    );
    const offsets = [
      { amount: 15, unit: 'minutes' },
      { amount: 1, unit: 'days' },
    ];
    expect((await put(eventQuery('event-rem-soon'), settingsBody({ offsets }))).status).toBe(200);
    expect(
      (await put(eventQuery('event-rem-later'), settingsBody({ offsets, sound: 'marimba' }))).status
    ).toBe(200);
    expect((await put(eventQuery('event-rem-off'), settingsBody({ enabled: false }))).status).toBe(
      200
    );
    expect((await put(eventQuery('event-rem-allday'), settingsBody())).status).toBe(200);

    const list = await upcoming();
    const at = (iso: string, ms: number) => new Date(Date.parse(iso) - ms).toISOString();
    // The soon event's 1-day reminder fired yesterday; the later one's start
    // (73 h) and 15-minute reminder (72 h 45 m) are past the 72-hour window.
    expect(list).toEqual([
      {
        key: `event:event-rem-soon@${soon}#15m`,
        item: { kind: 'event', eventId: 'event-rem-soon' },
        title: 'Dentist',
        calendarName: 'Default calendar',
        startsAt: soon,
        fireAt: at(soon, 15 * MIN),
        offset: { amount: 15, unit: 'minutes' },
        sound: 'chime',
      },
      expect.objectContaining({
        key: `event:event-rem-soon@${soon}#start`,
        fireAt: soon,
        offset: null,
      }),
      expect.objectContaining({
        key: `event:event-rem-later@${later}#1d`,
        title: 'Flight',
        fireAt: at(later, DAY),
        sound: 'marimba',
        offset: { amount: 1, unit: 'days' },
      }),
    ]);

    // A wider window picks up the rest; keys are the same on every read.
    const wide = await upcoming(168);
    expect(wide.map((r) => r.key)).toEqual([
      `event:event-rem-soon@${soon}#15m`,
      `event:event-rem-soon@${soon}#start`,
      `event:event-rem-later@${later}#1d`,
      `event:event-rem-later@${later}#15m`,
      `event:event-rem-later@${later}#start`,
    ]);
    // A narrow window holds only the first.
    expect((await upcoming(1.9)).map((r) => r.key)).toEqual([`event:event-rem-soon@${soon}#15m`]);

    // Moving the event moves its reminders (and says so); deleting it drops them.
    broadcast.mockClear();
    const moved = fromNow(5 * HOUR);
    await as(() =>
      updateEvent('event-rem-soon', {
        time: {
          kind: 'timed',
          startAt: moved,
          endAt: new Date(Date.parse(moved) + HOUR).toISOString(),
          timeZone: 'UTC',
        },
        expectedRevision: 1,
      })
    );
    expect(changedFrames()).toBeGreaterThanOrEqual(1);
    expect((await upcoming()).map((r) => r.key)).toEqual([
      `event:event-rem-soon@${moved}#15m`,
      `event:event-rem-soon@${moved}#start`,
      `event:event-rem-later@${later}#1d`,
    ]);
    await as(() => deleteEvent('event-rem-soon', '2'));
    expect((await upcoming()).map((r) => r.key)).toEqual([`event:event-rem-later@${later}#1d`]);
  });

  it('refuses a bad hours value', async () => {
    for (const hours of ['0', '-1', '169', 'soon'])
      expect((await request(app()).get(`/api/reminders/upcoming?hours=${hours}`)).status).toBe(400);
    const res = await request(app()).get('/api/reminders/upcoming');
    expect(Date.parse(res.body.data.until) - Date.now()).toBeGreaterThan(71.9 * HOUR);
  });

  it('lists timed rows and repeating rows as the calendar places them; date-only rows and done occurrences never remind', async () => {
    const calendarId = await defaultCalendarId();
    await setupTable(calendarId);
    const due = fromNow(3 * HOUR);
    await addEntry(E1, { name: 'Call the bank', [ID.due]: due });
    await addEntry(E2, { name: 'Plants', [ID.day]: fromNow(DAY).slice(0, 10) });
    expect(
      (await put(rowQuery(E1), settingsBody({ offsets: [{ amount: 30, unit: 'minutes' }] }))).status
    ).toBe(200);
    expect((await put(rowQuery(E2, ID.day), settingsBody())).status).toBe(200);

    expect(await upcoming()).toEqual([
      {
        key: `table_entry:${TABLE}:${E1}:${ID.due}@${due}#30m`,
        item: { kind: 'table_entry', tableId: TABLE, entryId: E1, fieldId: ID.due },
        title: 'Call the bank',
        calendarName: 'Default calendar',
        startsAt: due,
        fireAt: new Date(Date.parse(due) - 30 * MIN).toISOString(),
        offset: { amount: 30, unit: 'minutes' },
        sound: 'chime',
      },
      expect.objectContaining({ key: `table_entry:${TABLE}:${E1}:${ID.due}@${due}#start` }),
    ]);

    // A daily 09:00 UTC repeat from tomorrow, with tomorrow's occurrence already done.
    const status = await field(TABLE, ID.status);
    const [todo, done] = status.options!;
    const dueField = await field(TABLE, ID.due);
    await as(() =>
      updateTableField(TABLE, ID.due, {
        name: dueField.name,
        description: dueField.description,
        type: dueField.type,
        nullable: dueField.nullable,
        defaultValue: dueField.defaultValue,
        referenceTableId: dueField.referenceTableId,
        expectedRevision: dueField.revision,
        recurrence: {
          statusFieldId: ID.status,
          doneOptionIds: [done!.id],
          resetOptionId: todo!.id,
        },
      })
    );
    const day1 = fromNow(DAY).slice(0, 10);
    const day2 = fromNow(2 * DAY).slice(0, 10);
    const day3 = fromNow(3 * DAY).slice(0, 10);
    await addEntry(E3, { name: 'Standup', [ID.due]: `${day1}T09:00:00.000Z` });
    await sql(
      `INSERT INTO public.table_entry_repeats (table_id, field_id, entry_id, value) VALUES ($1, $2, $3, $4::jsonb)`,
      [
        TABLE,
        ID.due,
        E3,
        JSON.stringify({
          rrule: 'FREQ=DAILY',
          dtstart: `${day1}T09:00:00`,
          current: `${day1}T09:00:00`,
          tz: 'UTC',
        }),
      ]
    );
    await sql(
      `INSERT INTO public.table_entry_occurrences (table_id, field_id, entry_id, occurrence, kind) VALUES ($1, $2, $3, $4, 'done')`,
      [TABLE, ID.due, E3, `${day1}T09:00:00`]
    );
    expect((await put(rowQuery(E3), settingsBody())).status).toBe(200);
    const standups = (await upcoming(168))
      .filter((r) => r.item.kind === 'table_entry' && r.item.entryId === E3)
      .map((r) => r.startsAt);
    // Tomorrow's is done; the rest follow daily at 09:00 (how many fit depends on the hour).
    expect(standups.slice(0, 2)).toEqual([`${day2}T09:00:00.000Z`, `${day3}T09:00:00.000Z`]);
    expect(standups).not.toContain(`${day1}T09:00:00.000Z`);
    expect(standups.every((start) => start.endsWith('T09:00:00.000Z'))).toBe(true);
    await deleteCalendar(calendarId, (await previewCalendarDeletion(calendarId)).token);
    expect(await upcoming(168)).toEqual([]);
    expect(
      (await sql('SELECT field_id FROM public.reminder_settings WHERE field_id=$1', [ID.due]))
        .length
    ).toBeGreaterThan(0);
  });

  it('caps a row repeating every minute at 50 a window, even when its current one is days behind', async () => {
    const calendarId = await defaultCalendarId();
    await setupTable(calendarId);
    const status = await field(TABLE, ID.status);
    const [todo, done] = status.options!;
    const dueField = await field(TABLE, ID.due);
    await as(() =>
      updateTableField(TABLE, ID.due, {
        name: dueField.name,
        description: dueField.description,
        type: dueField.type,
        nullable: dueField.nullable,
        defaultValue: dueField.defaultValue,
        referenceTableId: dueField.referenceTableId,
        expectedRevision: dueField.revision,
        recurrence: {
          statusFieldId: ID.status,
          doneOptionIds: [done!.id],
          resetOptionId: todo!.id,
        },
      })
    );
    // Three days back, on the minute, never marked done.
    const start = new Date(Math.floor((Date.now() - 3 * DAY) / MIN) * MIN).toISOString();
    await addEntry(E3, { name: 'Stretch', [ID.due]: start });
    await sql(
      `INSERT INTO public.table_entry_repeats (table_id, field_id, entry_id, value) VALUES ($1, $2, $3, $4::jsonb)`,
      [
        TABLE,
        ID.due,
        E3,
        JSON.stringify({
          rrule: 'FREQ=MINUTELY',
          dtstart: start.slice(0, 19),
          current: start.slice(0, 19),
          tz: 'UTC',
        }),
      ]
    );
    expect((await put(rowQuery(E3), settingsBody())).status).toBe(200);
    const starts = (await upcoming())
      .filter((r) => r.item.kind === 'table_entry' && r.item.entryId === E3)
      .map((r) => Date.parse(r.startsAt));
    expect(starts).toHaveLength(50);
    expect(starts[0]!).toBeGreaterThan(Date.now() - MIN);
    expect(starts[0]!).toBeLessThanOrEqual(Date.now() + MIN);
    expect(starts.slice(1).every((at, i) => at - starts[i]! === MIN)).toBe(true);
  });

  it.each([
    [1, 60],
    [30, 60],
    [45, 90],
  ])('spaces a row repeating every %i s to one reminder every %i s', async (seconds, spacing) => {
    const calendarId = await defaultCalendarId();
    await setupTable(calendarId);
    const status = await field(TABLE, ID.status);
    const [todo, done] = status.options!;
    const dueField = await field(TABLE, ID.due);
    await as(() =>
      updateTableField(TABLE, ID.due, {
        name: dueField.name,
        description: dueField.description,
        type: dueField.type,
        nullable: dueField.nullable,
        defaultValue: dueField.defaultValue,
        referenceTableId: dueField.referenceTableId,
        expectedRevision: dueField.revision,
        recurrence: {
          statusFieldId: ID.status,
          doneOptionIds: [done!.id],
          resetOptionId: todo!.id,
        },
      })
    );
    // A day back, on the minute, never marked done.
    const start = new Date(Math.floor((Date.now() - DAY) / MIN) * MIN).toISOString();
    await addEntry(E3, { name: 'Ping', [ID.due]: start });
    await sql(
      `INSERT INTO public.table_entry_repeats (table_id, field_id, entry_id, value) VALUES ($1, $2, $3, $4::jsonb)`,
      [
        TABLE,
        ID.due,
        E3,
        JSON.stringify({
          rrule: `FREQ=SECONDLY;INTERVAL=${seconds}`,
          dtstart: start.slice(0, 19),
          current: start.slice(0, 19),
          tz: 'UTC',
        }),
      ]
    );
    expect((await put(rowQuery(E3), settingsBody())).status).toBe(200);
    const starts = (await upcoming(24))
      .filter((r) => r.item.kind === 'table_entry' && r.item.entryId === E3)
      .map((r) => Date.parse(r.startsAt));
    expect(starts).toHaveLength(50);
    // Every one a whole number of spacings from the start: never two closer than a minute.
    expect(starts.slice(1).every((at, i) => at - starts[i]! === spacing * 1000)).toBe(true);
    expect(starts.every((at) => (at - Date.parse(start)) % (spacing * 1000) === 0)).toBe(true);
  });

  it.each([
    [1, 1],
    [30, 1],
    [45, 1],
    [1, 60],
    [30, 2],
    [45, 2],
  ])(
    'keeps at least a minute between %i-second repeats after moving step %i',
    async (seconds, step) => {
      const calendarId = await defaultCalendarId();
      await setupTable(calendarId);
      const status = await field(TABLE, ID.status);
      const [todo, done] = status.options!;
      const dueField = await field(TABLE, ID.due);
      await as(() =>
        updateTableField(TABLE, ID.due, {
          name: dueField.name,
          description: dueField.description,
          type: dueField.type,
          nullable: dueField.nullable,
          defaultValue: dueField.defaultValue,
          referenceTableId: dueField.referenceTableId,
          expectedRevision: dueField.revision,
          recurrence: {
            statusFieldId: ID.status,
            doneOptionIds: [done!.id],
            resetOptionId: todo!.id,
          },
        })
      );
      const start = fromNow(3 * MIN);
      const originalMoved = new Date(Date.parse(start) + seconds * step * 1000);
      const movedTo = new Date(Date.parse(start) + 1000);
      await addEntry(E3, { name: 'Ping', [ID.due]: start });
      await sql(
        `INSERT INTO public.table_entry_repeats (table_id, field_id, entry_id, value) VALUES ($1, $2, $3, $4::jsonb)`,
        [
          TABLE,
          ID.due,
          E3,
          JSON.stringify({
            rrule: `FREQ=SECONDLY;INTERVAL=${seconds};COUNT=100`,
            dtstart: start.slice(0, 19),
            current: start.slice(0, 19),
            tz: 'UTC',
          }),
        ]
      );
      await sql(
        `INSERT INTO public.table_entry_occurrences
        (table_id, field_id, entry_id, occurrence, kind, moved_to) VALUES ($1, $2, $3, $4, 'moved', $5)`,
        [
          TABLE,
          ID.due,
          E3,
          originalMoved.toISOString().slice(0, 19),
          movedTo.toISOString().slice(0, 19),
        ]
      );
      expect(
        (await put(rowQuery(E3), settingsBody({ offsets: [{ amount: 1, unit: 'minutes' }] })))
          .status
      ).toBe(200);
      const reminders = (await upcoming(24)).filter(
        (r) => r.item.kind === 'table_entry' && r.item.entryId === E3
      );
      for (const offset of [null, 1]) {
        const starts = reminders
          .filter((r) => (offset === null ? r.offset === null : r.offset?.amount === offset))
          .map((r) => Date.parse(r.startsAt))
          .sort((a, b) => a - b);
        expect(starts[0]).toBe(Date.parse(start));
        expect(starts).not.toContain(movedTo.getTime());
        expect(starts.slice(1).every((at, i) => at - starts[i]! >= MIN)).toBe(true);
      }
    }
  );

  it('keeps an isolated moved occurrence for a finite 30-second repeat', async () => {
    const calendarId = await defaultCalendarId();
    await setupTable(calendarId);
    const status = await field(TABLE, ID.status);
    const [todo, done] = status.options!;
    const dueField = await field(TABLE, ID.due);
    await as(() =>
      updateTableField(TABLE, ID.due, {
        name: dueField.name,
        description: dueField.description,
        type: dueField.type,
        nullable: dueField.nullable,
        defaultValue: dueField.defaultValue,
        referenceTableId: dueField.referenceTableId,
        expectedRevision: dueField.revision,
        recurrence: {
          statusFieldId: ID.status,
          doneOptionIds: [done!.id],
          resetOptionId: todo!.id,
        },
      })
    );
    const start = fromNow(3 * MIN);
    const movedTo = new Date(Date.parse(start) + 121_000);
    await addEntry(E3, { name: 'Ping', [ID.due]: start });
    await sql(
      `INSERT INTO public.table_entry_repeats (table_id, field_id, entry_id, value) VALUES ($1, $2, $3, $4::jsonb)`,
      [
        TABLE,
        ID.due,
        E3,
        JSON.stringify({
          rrule: 'FREQ=SECONDLY;INTERVAL=30;COUNT=2',
          dtstart: start.slice(0, 19),
          current: start.slice(0, 19),
          tz: 'UTC',
        }),
      ]
    );
    await sql(
      `INSERT INTO public.table_entry_occurrences
      (table_id, field_id, entry_id, occurrence, kind, moved_to) VALUES ($1, $2, $3, $4, 'moved', $5)`,
      [
        TABLE,
        ID.due,
        E3,
        new Date(Date.parse(start) + 30_000).toISOString().slice(0, 19),
        movedTo.toISOString().slice(0, 19),
      ]
    );
    expect(
      (await put(rowQuery(E3), settingsBody({ offsets: [{ amount: 1, unit: 'minutes' }] }))).status
    ).toBe(200);
    const reminders = (await upcoming(24)).filter(
      (r) => r.item.kind === 'table_entry' && r.item.entryId === E3
    );
    expect(reminders.some((r) => r.offset === null && r.startsAt === movedTo.toISOString())).toBe(
      true
    );
    for (const offset of [null, 1]) {
      const starts = reminders
        .filter((r) => (offset === null ? r.offset === null : r.offset?.amount === offset))
        .map((r) => Date.parse(r.startsAt))
        .sort((a, b) => a - b);
      expect(starts.slice(1).every((at, i) => at - starts[i]! >= MIN)).toBe(true);
    }
  });

  it('lists automation runs: once, repeat and a capped Every; paused ones fire nothing', async () => {
    const base = { prompt: 'Look at the build.', threadId: THREAD, agentId: AGENT };
    const onceAt = fromNow(2 * HOUR);
    const once = await automationService.create(
      { ...base, name: 'Check build', when: { at: onceAt.slice(0, 16), tz: 'UTC' } },
      PERSON
    );
    const daily = await automationService.create(
      { ...base, name: 'Morning', when: { repeat: 'FREQ=DAILY', at: '07:00', tz: 'UTC' } },
      PERSON
    );
    const every = await automationService.create(
      { ...base, name: 'Inbox', when: { every: '1m', tz: 'UTC' } },
      PERSON
    );
    const paused = await automationService.create(
      { ...base, name: 'Paused', when: { at: fromNow(3 * HOUR).slice(0, 16), tz: 'UTC' } },
      PERSON
    );
    for (const id of [once.id, daily.id, every.id, paused.id])
      expect((await put(automationQuery(id), settingsBody())).status).toBe(200);
    await automationService.pause(paused.id, PERSON);

    const list = await upcoming();
    const of = (id: string) =>
      list.filter((r) => r.item.kind === 'automation' && r.item.automationId === id);
    expect(of(once.id)).toEqual([
      expect.objectContaining({
        key: `automation:${once.id}@${onceAt}#start`,
        title: 'Check build',
        startsAt: onceAt,
        fireAt: onceAt,
        offset: null,
      }),
    ]);
    expect(of(daily.id).map((r) => r.startsAt.slice(11))).toEqual([
      '07:00:00.000Z',
      '07:00:00.000Z',
      '07:00:00.000Z',
    ]);
    // Every minute for 72 h: capped at 50 runs a window.
    const runs = of(every.id);
    expect(runs).toHaveLength(50);
    expect(Date.parse(runs[1]!.startsAt) - Date.parse(runs[0]!.startsAt)).toBe(MIN);
    expect(of(paused.id)).toEqual([]);
  });
});

describe('delivery', () => {
  // The server's one scheduler, driven by hand: tick(at) takes the time and
  // stop() forgets the last tick, as a restart does.
  beforeEach(() => reminderScheduler.stop());
  afterEach(() => reminderScheduler.stop());

  /** The `reminder:due` frames broadcast so far. */
  function dueFrames(): ReminderDue[] {
    return broadcast.mock.calls
      .filter(
        ([channel, frame]) =>
          channel === 'workspace' && (frame as { type: string }).type === 'reminder:due'
      )
      .map(([, frame]) => (frame as { payload: ReminderDue }).payload);
  }

  it('delivers each reminder once as it fires, catches up 10 minutes after a restart, and never older', async () => {
    const start = Date.parse(fromNow(DAY));
    await timedEvent('event-rem-a', 'Review', new Date(start).toISOString());
    await timedEvent('event-rem-b', 'Earlier', new Date(start - 30 * MIN).toISOString());
    await put(
      eventQuery('event-rem-a'),
      settingsBody({ offsets: [{ amount: 15, unit: 'minutes' }] })
    );
    await put(eventQuery('event-rem-b'), settingsBody());
    const tick = async (at: number) =>
      (await reminderScheduler.tick(new Date(at))).map((r) => r.key);

    expect(await tick(start - 31 * MIN)).toEqual([]);
    // b starts 30 minutes before a.
    expect(await tick(start - 30 * MIN + 5_000)).toEqual([
      `event:event-rem-b@${new Date(start - 30 * MIN).toISOString()}#start`,
    ]);
    expect(await tick(start - 30 * MIN + 20_000)).toEqual([]);
    expect(await tick(start - 15 * MIN + 1_000)).toEqual([
      `event:event-rem-a@${new Date(start).toISOString()}#15m`,
    ]);

    // Restart 9 minutes after a's start: its at-start reminder (not yet
    // delivered) still comes; the earlier ones are not repeated.
    reminderScheduler.stop();
    expect(await tick(start + 9 * MIN)).toEqual([
      `event:event-rem-a@${new Date(start).toISOString()}#start`,
    ]);
    const frames = dueFrames();
    expect(frames).toHaveLength(3);
    expect(frames[2]).toEqual({
      key: `event:event-rem-a@${new Date(start).toISOString()}#start`,
      item: { kind: 'event', eventId: 'event-rem-a' },
      title: 'Review',
      calendarName: 'Default calendar',
      startsAt: new Date(start).toISOString(),
      fireAt: new Date(start).toISOString(),
      offset: null,
      sound: 'chime',
    });

    // A restart 11 minutes after a fire time drops it, delivered or not.
    await sql('DELETE FROM public.reminder_deliveries');
    reminderScheduler.stop();
    expect(await tick(start + 11 * MIN)).toEqual([]);
    expect(dueFrames()).toHaveLength(3);
  });

  it('prunes ledger rows older than 30 days', async () => {
    const start = Date.parse(fromNow(2 * DAY));
    await sql(
      `INSERT INTO public.reminder_deliveries (key, delivered_at) VALUES ('event:old@x#start', $1::timestamptz), ('event:new@x#start', $2::timestamptz)`,
      [new Date(start - 31 * DAY).toISOString(), new Date(start - 29 * DAY).toISOString()]
    );
    await reminderScheduler.tick(new Date(start));
    const keys = (
      await sql<{ key: string }>('SELECT key FROM public.reminder_deliveries ORDER BY key')
    ).map((row) => row.key);
    expect(keys).toEqual(['event:new@x#start']);
  });

  it('prunes row settings whose entry is gone', async () => {
    const calendarId = await defaultCalendarId();
    await setupTable(calendarId);
    await addEntry(E1, { name: 'Keep', [ID.due]: fromNow(3 * HOUR) });
    await addEntry(E2, { name: 'Drop', [ID.due]: fromNow(4 * HOUR) });
    await put(rowQuery(E1), settingsBody());
    await put(rowQuery(E2), settingsBody());
    const [{ table_name }] = await sql<{ table_name: string }>(
      'SELECT table_name FROM public.table_catalog WHERE id = $1',
      [TABLE]
    );
    await sql(`DELETE FROM user_tables.${quoteIdentifier(table_name!)} WHERE id = $1`, [E2]);
    // Orphaned settings produce nothing, and the prune removes them.
    expect(
      (await upcoming()).every((r) => r.item.kind === 'table_entry' && r.item.entryId === E1)
    ).toBe(true);
    await reminderScheduler.tick();
    expect(
      (await sql<{ entry_id: string }>('SELECT entry_id::text FROM public.reminder_settings')).map(
        (row) => row.entry_id
      )
    ).toEqual([E1]);
  });
});

describe('reminders:changed from row writes', () => {
  it('fires for writes to a table with row reminders, not for other tables', async () => {
    const calendarId = await defaultCalendarId();
    await setupTable(calendarId);
    await setupTable(calendarId, OTHER_TABLE);
    await addEntry(E1, { name: 'Call', [ID.due]: fromNow(3 * HOUR) });
    await addEntry(E2, { name: 'Other' }, OTHER_TABLE);
    expect((await put(rowQuery(E1), settingsBody())).status).toBe(200);

    const write = async (tableId: string, entryId: string, values: Record<string, unknown>) => {
      const { entries, schemaVersion } = await listTableEntries(tableId);
      const entry = entries.find((e) => e.id === entryId)!;
      await as(() =>
        updateTableEntry(tableId, entryId, {
          values,
          expectedRevision: entry.revision,
          schemaVersion,
        })
      );
    };
    broadcast.mockClear();
    await write(OTHER_TABLE, E2, { [fieldIdIn(OTHER_TABLE, ID.due)]: fromNow(5 * HOUR) });
    expect(changedFrames()).toBe(0);
    const moved = fromNow(6 * HOUR);
    await write(TABLE, E1, { [ID.due]: moved });
    expect(changedFrames()).toBe(1);
    expect((await upcoming()).map((r) => r.startsAt)).toEqual([moved]);
  });
});
