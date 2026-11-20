/**
 * The calendar server against real PostgreSQL: calendars CRUD with the
 * Default calendar (announced only once its transaction commits), single
 * events (archive-delete + restore), field binding through the table field
 * service and the calendar's own binding write (any date field, Snaglet's
 * `created_at` too), and the occurrences window read through the restricted
 * tables reader (DST and near-midnight cases, repeating rows, read-only
 * managed rows).
 */
import { createHash } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';
import { getDb, getDbClient, quoteIdentifier } from '@snaglet/db';
import { Calendars } from '@snaglet/db/tables/calendars';
import { CalendarEvents } from '@snaglet/db/tables/calendar_events';
import {
  provisionTablesReaderRole,
  TABLES_READER_ROLE,
} from '@snaglet/db/runtime/postgres/runtime';
import type { Actor } from '@snaglet/shared/types/workspace-events';
import { CALENDAR_ROW_OCCURRENCES_MAX, type TableField } from '@snaglet/shared/types';
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
  tableEntryRepeatAction,
  updateTableEntry,
} from '@server/domains/tables/tableEntries';
import tablesRouter from '@server/routes/tables';
import { errorHandler } from '@server/middleware/errorHandler';
import { archiveTableField } from '@server/domains/tables/tableLifecycle';
import {
  createCalendar,
  createEvent,
  deleteEvent,
  getEvent,
  listCalendars,
  reorderCalendars,
  restoreEvent,
  updateCalendar,
  updateEvent,
} from '@server/domains/calendar/calendarService';
import { listOccurrences } from '@server/domains/calendar/occurrences';

const USER: Actor = { actorKind: 'user', actorId: 'test-user-cal', actorName: 'Test User' };
const as = <T>(fn: () => Promise<T>): Promise<T> => runWithActor(USER, fn);
const TABLE = 'table-1111111111111-calaaaaa';
const ID = {
  due: 'field-1111111111111-caldue',
  end: 'field-1111111111111-calend',
  day: 'field-1111111111111-calday',
  status: 'field-1111111111111-calstat',
  notes: 'field-1111111111111-calnote',
};
/** Every custom table's managed columns (registerInitialFields). */
const CREATED = `field-managed-${TABLE}-created_at`;
const MANAGED_ID = `field-managed-${TABLE}-id`;
const E1 = '11111111-1111-4111-8111-111111111111';
const E2 = '22222222-2222-4222-8222-222222222222';
const E3 = '33333333-3333-4333-8333-333333333333';

async function caught(action: () => Promise<unknown>) {
  try {
    await action();
  } catch (error) {
    return error as { statusCode?: number; message: string };
  }
  throw new Error('expected a rejection');
}

async function cleanCalendars(): Promise<void> {
  const db = getDb();
  await db.query('UPDATE public.table_fields SET calendar_id = NULL');
  await db.query("DELETE FROM public.nodes WHERE type = 'calendar_event'");
  await db.query('DELETE FROM public.calendars');
}

async function cleanTable(): Promise<void> {
  const db = getDb();
  const { rows } = await db.query<{ table_name: string }>(
    'SELECT table_name FROM public.table_catalog WHERE id = $1',
    [TABLE]
  );
  for (const row of rows)
    await db.query(`DROP TABLE IF EXISTS user_tables.${quoteIdentifier(row.table_name)} CASCADE`);
  await db.query('DELETE FROM public.table_entry_occurrences WHERE table_id = $1', [TABLE]);
  await db.query('DELETE FROM public.table_entry_repeats WHERE table_id = $1', [TABLE]);
  await db.query('DELETE FROM public.table_fields WHERE table_id = $1', [TABLE]);
  await db.query('DELETE FROM public.table_catalog WHERE id = $1', [TABLE]);
  await db.query('DELETE FROM public.table_history WHERE actor_id = $1', [USER.actorId]);
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
  const found = (await listTableFields(TABLE)).find((f) => f.id === id);
  if (!found) throw new Error(`no field ${id}`);
  return found;
}

async function editField(id: string, patch: Record<string, unknown>): Promise<TableField> {
  const current = await field(id);
  return as(() =>
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

/** The calendar's binding write, at the field's current revision. */
async function showOn(id: string, calendarId: string | null): Promise<TableField> {
  const current = await field(id);
  return as(() =>
    setTableFieldCalendar(TABLE, id, { calendarId, expectedRevision: current.revision })
  );
}

async function historyCount(): Promise<number> {
  const { rows } = await getDb().query<{ n: number }>(
    'SELECT count(*)::int AS n FROM public.table_history WHERE actor_id = $1',
    [USER.actorId]
  );
  return rows[0]?.n ?? 0;
}

async function setupTable(): Promise<void> {
  await as(() => createTable({ id: TABLE, name: 'cal_table' }));
  for (const body of [
    def(ID.due, 'due', 'datetime'),
    def(ID.end, 'ends', 'datetime'),
    def(ID.day, 'day', 'date'),
    def(ID.status, 'status', 'select', { options: [{ label: 'todo' }, { label: 'done' }] }),
    def(ID.notes, 'notes', 'text'),
  ])
    await as(() => createTableField(TABLE, body));
}

async function addEntry(id: string, values: Record<string, unknown>): Promise<void> {
  const { schemaVersion } = await listTableEntries(TABLE);
  // `name` is the table's Name field (id field-title-<table>).
  const { name, ...rest } = values;
  const mapped = name === undefined ? rest : { ...rest, [`field-title-${TABLE}`]: name };
  await as(() => createTableEntry(TABLE, { id, values: mapped, schemaVersion }));
}

beforeAll(async () => {
  await provisionTablesReaderRole(await getDbClient(), {
    password: readerPassword,
    database: database!,
    revokePublic: true,
  });
});

describe('calendars', () => {
  beforeEach(async () => {
    await cleanCalendars();
    emitCalendarChanged.mockClear();
  });

  it('keeps concurrent first reads empty without broadcasts', async () => {
    expect(await Promise.all([listCalendars(), listCalendars(), listCalendars()])).toEqual([
      [],
      [],
      [],
    ]);
    expect((await getDb().query('SELECT id FROM public.calendars')).rows).toEqual([]);
    expect(emitCalendarChanged).not.toHaveBeenCalled();
  });

  it('announces a new Default calendar only after its transaction commits; a rollback announces nothing', async () => {
    // A rolled-back first list (or event create) leaves no calendar and says nothing.
    const list = jest.spyOn(Calendars, 'list').mockRejectedValueOnce(new Error('list failed'));
    const insert = jest
      .spyOn(CalendarEvents, 'insert')
      .mockRejectedValueOnce(new Error('insert failed'));
    try {
      await expect(listCalendars()).rejects.toThrow('list failed');
      await expect(
        as(() =>
          createEvent({
            id: 'event-test-rollback',
            title: 'Standup',
            time: {
              kind: 'timed',
              startAt: '2026-03-09T13:00:00Z',
              endAt: '2026-03-09T14:00:00Z',
              timeZone: 'UTC',
            },
          })
        )
      ).rejects.toThrow('insert failed');
    } finally {
      list.mockRestore();
      insert.mockRestore();
    }
    expect((await getDb().query('SELECT id FROM public.calendars')).rows).toEqual([]);
    expect(emitCalendarChanged).not.toHaveBeenCalled();

    // A committed one is announced once, when another connection can already read it.
    const visible: Array<Promise<number>> = [];
    emitCalendarChanged.mockImplementation((...args: unknown[]) => {
      const change = args[0] as { kind: string; calendarId?: string };
      if (change.kind !== 'calendar') return;
      visible.push(
        getDb()
          .query<{ n: number }>('SELECT count(*)::int AS n FROM public.calendars WHERE id = $1', [
            change.calendarId,
          ])
          .then(({ rows }) => rows[0]!.n)
      );
    });
    try {
      await createEvent({
        title: 'Explicit',
        time: { kind: 'all_day', startDate: '2030-01-01', endDate: '2030-01-02', timeZone: 'UTC' },
      });
      const [made] = await listCalendars();
      expect(
        emitCalendarChanged.mock.calls.filter(
          (call) => (call[0] as { kind: string }).kind === 'calendar'
        )
      ).toEqual([[{ kind: 'calendar', calendarId: made!.id }]]);
      expect(await Promise.all(visible)).toEqual([1]);
    } finally {
      emitCalendarChanged.mockReset();
    }
  });

  it('makes the first named calendar default without creating an extra calendar', async () => {
    const work = await as(() => createCalendar({ title: 'Work' }));
    expect(work.isDefault).toBe(true);
    expect((await listCalendars()).map((c) => c.title)).toEqual(['Work']);
  });

  it('appends with sort_order = max + 1, renames, recolors and checks revisions', async () => {
    const a = await as(() => createCalendar({ title: 'A' }));
    const b = await as(() =>
      createCalendar({ title: ' B ', color: 'green', timeZone: 'Europe/Paris' })
    );
    expect([a.sortOrder, b.sortOrder]).toEqual([0, 1]);
    expect(b).toMatchObject({ title: 'B', color: 'green', timeZone: 'Europe/Paris', revision: 1 });

    const renamed = await updateCalendar(b.id, { title: 'Bee', color: 'red', expectedRevision: 1 });
    expect(renamed).toMatchObject({ title: 'Bee', color: 'red', revision: 2 });
    expect(
      (await caught(() => updateCalendar(b.id, { title: 'x', expectedRevision: 1 }))).statusCode
    ).toBe(409);
    expect(
      (await caught(() => updateCalendar(b.id, { color: 'plaid', expectedRevision: 2 }))).statusCode
    ).toBe(400);
    expect(
      (await caught(() => updateCalendar(b.id, { timeZone: 'Mars/Base', expectedRevision: 2 })))
        .statusCode
    ).toBe(400);
    expect((await caught(() => createCalendar({ title: '   ' }))).statusCode).toBe(400);
  });

  it('reorders only from the full list of active ids', async () => {
    const a = await as(() => createCalendar({ title: 'A' }));
    const b = await as(() => createCalendar({ title: 'B' }));
    const c = await as(() => createCalendar({ title: 'C' }));
    const ordered = await reorderCalendars({ calendarIds: [c.id, a.id, b.id] });
    expect(ordered.map((x) => [x.title, x.sortOrder])).toEqual([
      ['C', 0],
      ['A', 1],
      ['B', 2],
    ]);
    for (const bad of [[c.id, a.id], [c.id, a.id, b.id, b.id], [c.id, a.id, 'calendar-nope'], 'x'])
      expect((await caught(() => reorderCalendars({ calendarIds: bad }))).statusCode).toBe(400);
  });
});

describe('events', () => {
  beforeEach(async () => {
    await cleanCalendars();
    emitCalendarChanged.mockClear();
  });

  const timed = {
    kind: 'timed',
    startAt: '2026-03-09T13:00:00Z',
    endAt: '2026-03-09T14:00:00Z',
    timeZone: 'America/New_York',
  };

  it('creates on the Default calendar when none is given, idempotently by id', async () => {
    const first = await as(() =>
      createEvent({ id: 'event-test-1', title: 'Standup', time: timed })
    );
    expect(first.created).toBe(true);
    expect(first.event).toMatchObject({ id: 'event-test-1', title: 'Standup', revision: 1 });
    expect(first.event.time).toEqual({
      ...timed,
      startAt: '2026-03-09T13:00:00.000Z',
      endAt: '2026-03-09T14:00:00.000Z',
    });
    const [cal] = await listCalendars();
    expect(first.event.calendarId).toBe(cal!.id);
    const replay = await as(() =>
      createEvent({ id: 'event-test-1', title: 'Standup', time: timed })
    );
    expect(replay.created).toBe(false);
    const { rows } = await getDb().query('SELECT type FROM public.nodes WHERE id = $1', [
      'event-test-1',
    ]);
    expect(rows).toEqual([{ type: 'calendar_event' }]);
    expect(emitCalendarChanged).toHaveBeenCalledWith({
      kind: 'event',
      calendarId: cal!.id,
      eventId: 'event-test-1',
    });
  });

  it('repeats an event on its own rule: stored, normalized, expanded in the window, series-wide', async () => {
    const { event } = await createEvent({
      title: 'Test weekly',
      time: timed,
      repeat: { rrule: 'FREQ=WEEKLY;COUNT=3' },
    });
    expect(event.repeat).toEqual({ rrule: 'FREQ=WEEKLY;COUNT=3' });
    const from = timed.startAt.slice(0, 10);
    const res = await listOccurrences({ from, to: '2026-04-30', tz: timed.timeZone });
    const mine = res.occurrences.filter((o) => o.source === 'event' && o.eventId === event.id);
    expect(mine).toHaveLength(3);
    expect(mine.every((o) => !o.canMove && !o.canResize)).toBe(true);
    expect(mine[0]!.key).toBe(`event:${event.id}`);
    expect(new Set(mine.map((o) => o.key)).size).toBe(3);
    // Stopping the repeat leaves the one event.
    const single = await updateEvent(event.id, { repeat: null, expectedRevision: event.revision });
    expect(single.repeat).toBeNull();
    const after = await listOccurrences({ from, to: '2026-04-30', tz: timed.timeZone });
    expect(
      after.occurrences.filter((o) => o.source === 'event' && o.eventId === event.id)
    ).toHaveLength(1);
    // A sub-daily rule would flood the grid.
    expect(
      (
        await caught(() =>
          createEvent({ title: 'x', time: timed, repeat: { rrule: 'FREQ=HOURLY' } })
        )
      ).statusCode
    ).toBe(400);
  });

  it('rejects recurrence, bad times', async () => {
    expect(
      (
        await caught(() =>
          createEvent({ title: 'x', time: timed, recurrence: ['RRULE:FREQ=DAILY'] })
        )
      ).statusCode
    ).toBe(400);
    expect(
      (await caught(() => createEvent({ title: 'x', time: { ...timed, endAt: timed.startAt } })))
        .statusCode
    ).toBe(400);
    expect(
      (
        await caught(() =>
          createEvent({ title: 'x', time: { ...timed, startAt: '2026-03-09T13:00:00' } })
        )
      ).statusCode
    ).toBe(400);
    expect(
      (
        await caught(() =>
          createEvent({
            title: 'x',
            time: {
              kind: 'all_day',
              startDate: '2026-03-09',
              endDate: '2026-03-09',
              timeZone: 'UTC',
            },
          })
        )
      ).statusCode
    ).toBe(400);
  });

  it('updates with revision checks; delete archives the node and restore brings it back', async () => {
    const { event } = await as(() =>
      createEvent({
        id: 'event-test-2',
        title: 'Lunch',
        time: { kind: 'all_day', startDate: '2026-03-10', endDate: '2026-03-11', timeZone: 'UTC' },
      })
    );
    const moved = await as(() =>
      updateEvent(event.id, { title: 'Long lunch', time: timed, expectedRevision: 1 })
    );
    expect(moved).toMatchObject({ title: 'Long lunch', revision: 2, time: { kind: 'timed' } });
    expect(
      (await caught(() => updateEvent(event.id, { title: 'y', expectedRevision: 1 }))).statusCode
    ).toBe(409);
    expect(
      (await caught(() => updateEvent(event.id, { rrule: 'FREQ=DAILY', expectedRevision: 2 })))
        .statusCode
    ).toBe(400);

    expect((await caught(() => deleteEvent(event.id, '1'))).statusCode).toBe(409);
    expect(await deleteEvent(event.id, '2')).toEqual({ id: event.id });
    const { rows } = await getDb().query<{ archived: boolean }>(
      'SELECT archived FROM public.nodes WHERE id = $1',
      [event.id]
    );
    expect(rows[0]!.archived).toBe(true);
    expect((await caught(() => getEvent(event.id))).statusCode).toBe(404);

    const back = await restoreEvent(event.id);
    expect(back).toMatchObject({ id: event.id, title: 'Long lunch', revision: 2 });
    expect(await getEvent(event.id)).toMatchObject({ title: 'Long lunch' });
    expect(emitCalendarChanged).toHaveBeenLastCalledWith({
      kind: 'event',
      calendarId: event.calendarId,
      eventId: event.id,
    });
  });
});

describe('field binding', () => {
  beforeEach(async () => {
    await cleanTable();
    await cleanCalendars();
    await setupTable();
    emitCalendarChanged.mockClear();
  });

  it("binds with 'default' (creating it) and lists bound fields", async () => {
    const bound = await editField(ID.due, { calendarId: 'default' });
    const [cal] = await listCalendars();
    expect(bound).toMatchObject({ calendarId: cal!.id });
    expect(cal!.boundFields).toEqual([
      {
        tableId: TABLE,
        tableName: 'cal_table',
        projectId: null,
        fieldId: ID.due,
        fieldName: 'due',
        fieldType: 'datetime',
        repeats: true,
        unscheduledCount: 0,
      },
    ]);
    expect(emitCalendarChanged).toHaveBeenCalledWith({ kind: 'binding', calendarId: cal!.id });
    // Unbound fields carry no keys.
    expect(await field(ID.notes)).not.toHaveProperty('calendarId');
  });

  it('refuses bad bindings with readable 400s', async () => {
    const cal = await as(() => createCalendar({ title: 'C' }));
    expect((await caught(() => editField(ID.notes, { calendarId: cal.id }))).message).toMatch(
      /date and datetime/
    );
    expect(
      (await caught(() => editField(ID.due, { calendarId: 'calendar-missing' }))).statusCode
    ).toBe(400);
  });

  it('keeps the binding through End date and Include time; retyping away clears it', async () => {
    const cal = await as(() => createCalendar({ title: 'C' }));
    await editField(ID.due, { calendarId: cal.id });
    // An end field key in the request is ignored: a range holds its own end.
    const ranged = await editField(ID.due, { range: true, calendarEndFieldId: ID.end });
    expect(ranged).toMatchObject({ range: true, calendarId: cal.id });
    expect(ranged).not.toHaveProperty('calendarEndFieldId');
    // The other datetime field is free to retype (nothing names it as an end).
    expect(await editField(ID.end, { type: 'text' })).toMatchObject({ type: 'text' });

    const asDate = await editField(ID.due, { type: 'date' });
    expect(asDate).toMatchObject({ type: 'date', range: true, calendarId: cal.id });
    expect(await editField(ID.due, { range: false })).toMatchObject({
      range: false,
      calendarId: cal.id,
    });
    const asText = await editField(ID.due, { type: 'text' });
    expect(asText).not.toHaveProperty('calendarId');
    // Unbinding with null.
    await editField(ID.day, { calendarId: cal.id });
    expect(await editField(ID.day, { calendarId: null })).not.toHaveProperty('calendarId');
  });
});

describe('binding from the calendar (PUT …/fields/:fieldId/calendar)', () => {
  beforeEach(async () => {
    await cleanTable();
    await cleanCalendars();
    await setupTable();
    emitCalendarChanged.mockClear();
  });

  it("shows Snaglet's created_at on a calendar ('default' resolves) and takes it off", async () => {
    const before = await field(CREATED);
    expect(before).toMatchObject({ managed: true, type: 'datetime', columnName: 'created_at' });
    const steps = await historyCount();
    const bound = await showOn(CREATED, 'default');
    const [cal] = await listCalendars();
    expect(cal).toMatchObject({ isDefault: true });
    expect(bound).toMatchObject({
      calendarId: cal!.id,
      managed: true,
      revision: before.revision + 1,
    });
    expect(cal!.boundFields).toEqual([
      {
        tableId: TABLE,
        tableName: 'cal_table',
        projectId: null,
        fieldId: CREATED,
        fieldName: 'created_at',
        fieldType: 'datetime',
        repeats: false,
        unscheduledCount: 0,
      },
    ]);
    expect(emitCalendarChanged).toHaveBeenCalledWith({ kind: 'binding', calendarId: cal!.id });
    // Not a table history step: the calendar's undo stack reverses it.
    expect(await historyCount()).toBe(steps);

    emitCalendarChanged.mockClear();
    const off = await showOn(CREATED, null);
    expect(off).not.toHaveProperty('calendarId');
    expect(emitCalendarChanged).toHaveBeenCalledWith({ kind: 'binding', calendarId: cal!.id });
    // Already off: nothing changes, no revision bump, no event.
    emitCalendarChanged.mockClear();
    expect((await showOn(CREATED, null)).revision).toBe(off.revision);
    expect(emitCalendarChanged).not.toHaveBeenCalled();
  });

  it('binds, moves and unbinds an unmanaged date field; the field PATCH still binds', async () => {
    const a = await as(() => createCalendar({ title: 'A' }));
    const b = await as(() => createCalendar({ title: 'B' }));
    expect(await showOn(ID.day, a.id)).toMatchObject({ calendarId: a.id, managed: false });
    emitCalendarChanged.mockClear();
    expect(await showOn(ID.day, b.id)).toMatchObject({ calendarId: b.id });
    expect(emitCalendarChanged).toHaveBeenCalledWith({ kind: 'binding', calendarId: a.id });
    expect(emitCalendarChanged).toHaveBeenCalledWith({ kind: 'binding', calendarId: b.id });
    expect(await showOn(ID.day, null)).not.toHaveProperty('calendarId');
    expect(await editField(ID.day, { calendarId: a.id })).toMatchObject({ calendarId: a.id });
  });

  it('refuses non-date fields, missing calendars, bad bodies and stale revisions', async () => {
    const cal = await as(() => createCalendar({ title: 'C' }));
    expect(await caught(() => showOn(ID.notes, cal.id))).toMatchObject({
      statusCode: 400,
      message: expect.stringMatching(/date and datetime/),
    });
    // The managed uuid `id` column is not a date.
    expect((await caught(() => showOn(MANAGED_ID, cal.id))).statusCode).toBe(400);
    expect((await caught(() => showOn(CREATED, 'calendar-missing'))).statusCode).toBe(400);
    const created = await field(CREATED);
    for (const body of [
      { calendarId: 5, expectedRevision: created.revision },
      { calendarId: '  ', expectedRevision: created.revision },
      { expectedRevision: created.revision },
      { calendarId: cal.id },
      { calendarId: cal.id, expectedRevision: 0 },
    ])
      expect((await caught(() => setTableFieldCalendar(TABLE, CREATED, body))).statusCode).toBe(
        400
      );
    expect(
      (
        await caught(() =>
          setTableFieldCalendar(TABLE, CREATED, {
            calendarId: cal.id,
            expectedRevision: created.revision + 1,
          })
        )
      ).statusCode
    ).toBe(409);
    expect((await field(CREATED)).calendarId).toBeUndefined();
  });

  it('is wired at PUT /api/tables/:id/fields/:fieldId/calendar (404 for an unknown field)', async () => {
    const app = express();
    app.use(express.json());
    app.use('/api/tables', tablesRouter);
    app.use(errorHandler);
    const cal = await as(() => createCalendar({ title: 'C' }));
    const created = await field(CREATED);
    const ok = await request(app)
      .put(`/api/tables/${TABLE}/fields/${CREATED}/calendar`)
      .send({ calendarId: cal.id, expectedRevision: created.revision });
    expect(ok.status).toBe(200);
    expect(ok.body.data.field).toMatchObject({ id: CREATED, calendarId: cal.id });
    const missing = await request(app)
      .put(`/api/tables/${TABLE}/fields/field-1111111111111-calmissing/calendar`)
      .send({ calendarId: cal.id, expectedRevision: 1 });
    expect(missing.status).toBe(404);
  });
});

describe('occurrences', () => {
  afterAll(async () => {
    await cleanTable();
    await cleanCalendars();
  });

  let cal: Awaited<ReturnType<typeof createCalendar>>;

  beforeEach(async () => {
    await cleanTable();
    await cleanCalendars();
    await setupTable();
    cal = await as(() => createCalendar({ title: 'Cal', timeZone: 'America/New_York' }));
  });

  it('places a timed row across the US DST change and defaults to a 30-minute block', async () => {
    await editField(ID.due, { calendarId: cal.id });
    // 09:00 New York on each side of 2026-03-08 (EST -5 → EDT -4).
    await addEntry(E1, { name: 'before', [ID.due]: '2026-03-07T14:00:00Z' });
    await addEntry(E2, { name: 'after', [ID.due]: '2026-03-09T13:00:00Z' });
    const res = await listOccurrences({
      from: '2026-03-07',
      to: '2026-03-10',
      tz: 'America/New_York',
    });
    const rows = res.occurrences.filter((o) => o.source === 'row');
    expect(rows.map((o) => [o.title, o.time])).toEqual([
      [
        'before',
        { kind: 'timed', start: '2026-03-07T14:00:00.000Z', end: '2026-03-07T14:30:00.000Z' },
      ],
      [
        'after',
        { kind: 'timed', start: '2026-03-09T13:00:00.000Z', end: '2026-03-09T13:30:00.000Z' },
      ],
    ]);
    const entries = await listTableEntries(TABLE);
    const first = rows[0]!;
    if (first.source !== 'row') throw new Error('row expected');
    expect(first).toMatchObject({
      canMove: true,
      canResize: false,
      status: 'upcoming',
      schemaVersion: entries.schemaVersion,
    });
    expect(first.entryRevision).toBe(entries.entries.find((e) => e.id === E1)!.revision);
  });

  it('keeps an all-day row on its date near UTC midnight, in any viewer zone', async () => {
    await editField(ID.day, { calendarId: cal.id });
    await addEntry(E1, { name: 'deadline', [ID.day]: '2026-03-10' });
    for (const tz of ['Pacific/Kiritimati', 'Pacific/Pago_Pago', 'UTC']) {
      const res = await listOccurrences({ from: '2026-03-10', to: '2026-03-11', tz });
      expect(res.occurrences.map((o) => o.time)).toEqual([
        { kind: 'all_day', startDate: '2026-03-10', endDate: '2026-03-11' },
      ]);
    }
    const before = await listOccurrences({
      from: '2026-03-09',
      to: '2026-03-10',
      tz: 'Pacific/Kiritimati',
    });
    expect(before.occurrences).toEqual([]);
  });

  it('shows a date range as an all-day span through its last day, in any viewer zone', async () => {
    await editField(ID.day, { calendarId: cal.id, range: true });
    await addEntry(E1, { name: 'trip', [ID.day]: '2026-03-10/2026-03-12' });
    await addEntry(E2, { name: 'one day', [ID.day]: '2026-03-11' });
    await addEntry(E3, { name: 'no date' });
    const res = await listOccurrences({ from: '2026-03-09', to: '2026-03-14', tz: 'UTC' });
    expect(
      res.occurrences.map((o) => [
        o.title,
        o.time,
        o.canResize,
        o.source === 'row' && o.range,
        o.source === 'row' && o.hasEnd,
      ])
    ).toEqual([
      [
        'trip',
        { kind: 'all_day', startDate: '2026-03-10', endDate: '2026-03-13' },
        true,
        true,
        true,
      ],
      [
        'one day',
        { kind: 'all_day', startDate: '2026-03-11', endDate: '2026-03-12' },
        true,
        true,
        false,
      ],
    ]);
    // Overlap, not start: a window holding only the last day still finds the
    // trip; calendar dates never shift with the viewer's zone.
    for (const tz of ['Pacific/Kiritimati', 'Pacific/Pago_Pago', 'UTC']) {
      const last = await listOccurrences({ from: '2026-03-12', to: '2026-03-13', tz });
      expect(last.occurrences.map((o) => [o.title, o.time])).toEqual([
        ['trip', { kind: 'all_day', startDate: '2026-03-10', endDate: '2026-03-13' }],
      ]);
    }
    const after = await listOccurrences({ from: '2026-03-13', to: '2026-03-14', tz: 'UTC' });
    expect(after.occurrences).toEqual([]);
    expect(res.unavailable).toEqual([]);
  });

  it('shows a datetime range timed to its end, and a single instant as a 30-minute block', async () => {
    await editField(ID.due, { calendarId: cal.id, range: true });
    await addEntry(E1, { name: 'long', [ID.due]: '2026-03-10T13:00:00Z/2026-03-10T15:00:00Z' });
    await addEntry(E2, {
      name: 'overnight',
      [ID.due]: '2026-03-10T22:00:00Z/2026-03-11T02:00:00Z',
    });
    // 23:50 New York on the 10th (EDT, -4): its block runs into the 11th.
    await addEntry(E3, { name: 'point', [ID.due]: '2026-03-11T03:50:00Z' });
    const res = await listOccurrences({
      from: '2026-03-10',
      to: '2026-03-11',
      tz: 'America/New_York',
    });
    expect(
      res.occurrences.map((o) => [o.title, o.time, o.canResize, o.source === 'row' && o.hasEnd])
    ).toEqual([
      [
        'long',
        { kind: 'timed', start: '2026-03-10T13:00:00.000Z', end: '2026-03-10T15:00:00.000Z' },
        true,
        true,
      ],
      [
        'overnight',
        { kind: 'timed', start: '2026-03-10T22:00:00.000Z', end: '2026-03-11T02:00:00.000Z' },
        true,
        true,
      ],
      [
        'point',
        { kind: 'timed', start: '2026-03-11T03:50:00.000Z', end: '2026-03-11T04:20:00.000Z' },
        true,
        false,
      ],
    ]);
    // The next New York day starts at 04:00Z: the overnight range ended
    // before it, but the point's 30-minute block reaches into it (the window
    // test widens a single instant exactly like a plain datetime).
    const next = await listOccurrences({
      from: '2026-03-11',
      to: '2026-03-12',
      tz: 'America/New_York',
    });
    expect(next.occurrences.map((o) => o.title)).toEqual(['point']);
    const utc = await listOccurrences({ from: '2026-03-11', to: '2026-03-12', tz: 'UTC' });
    expect(utc.occurrences.map((o) => o.title)).toEqual(['overnight', 'point']);
  });

  it('includes events, filters calendars, and lists archived fields as unavailable', async () => {
    await editField(ID.day, { calendarId: cal.id });
    await addEntry(E1, { name: 'row', [ID.day]: '2026-03-10' });
    await as(() =>
      createEvent({
        id: 'event-occ-1',
        calendarId: cal.id,
        title: 'Event',
        time: {
          kind: 'timed',
          startAt: '2026-03-10T15:00:00Z',
          endAt: '2026-03-10T16:00:00Z',
          timeZone: 'UTC',
        },
      })
    );
    const res = await listOccurrences({ from: '2026-03-10', to: '2026-03-11', tz: 'UTC' });
    expect(res.occurrences.map((o) => o.key)).toEqual([
      `row:${ID.day}:${E1}:value`,
      'event:event-occ-1',
    ]);
    expect(
      (
        await listOccurrences({
          from: '2026-03-10',
          to: '2026-03-11',
          tz: 'UTC',
          calendarIds: 'calendar-none',
        })
      ).occurrences
    ).toEqual([]);

    await as(() => archiveTableField(TABLE, ID.day));
    const after = await listOccurrences({ from: '2026-03-10', to: '2026-03-11', tz: 'UTC' });
    expect(after.occurrences.map((o) => o.key)).toEqual(['event:event-occ-1']);
    expect(after.unavailable).toEqual([
      { tableId: TABLE, fieldId: ID.day, reason: 'field_archived' },
    ]);
  });

  it("gives each event occurrence the event's own saved zone, whatever the viewer's", async () => {
    await as(() =>
      createEvent({
        id: 'event-occ-tz-1',
        calendarId: cal.id,
        title: 'Timed',
        time: {
          kind: 'timed',
          startAt: '2026-03-10T15:00:00Z',
          endAt: '2026-03-10T16:00:00Z',
          timeZone: 'Asia/Tokyo',
        },
      })
    );
    await as(() =>
      createEvent({
        id: 'event-occ-tz-2',
        calendarId: cal.id,
        title: 'All day',
        time: {
          kind: 'all_day',
          startDate: '2026-03-10',
          endDate: '2026-03-11',
          timeZone: 'Europe/Berlin',
        },
      })
    );
    const res = await listOccurrences({ from: '2026-03-10', to: '2026-03-11', tz: 'UTC' });
    const zones = Object.fromEntries(
      res.occurrences.flatMap((o) => (o.source === 'event' ? [[o.eventId, o.timeZone]] : []))
    );
    expect(zones).toEqual({ 'event-occ-tz-1': 'Asia/Tokyo', 'event-occ-tz-2': 'Europe/Berlin' });
  });

  it("shows Snaglet's created_at read-only: no move or resize, and the server refuses date writes", async () => {
    await showOn(CREATED, cal.id);
    await addEntry(E1, { name: 'made' });
    const entry = (await listTableEntries(TABLE)).entries.find((e) => e.id === E1)!;
    const start = new Date(entry.createdAt).toISOString();
    const day = start.slice(0, 10);
    const res = await listOccurrences({
      from: day,
      to: new Date(Date.parse(`${day}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10),
      tz: 'UTC',
    });
    const rows = res.occurrences.filter((o) => o.source === 'row');
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    if (row.source !== 'row') throw new Error('row expected');
    expect(row).toMatchObject({
      key: `row:${CREATED}:${E1}:value`,
      title: 'made',
      fieldId: CREATED,
      canMove: false,
      canResize: false,
      time: { kind: 'timed', start },
    });
    expect(row.repeat).toBeUndefined();
    const revisionPair = { expectedRevision: row.entryRevision, schemaVersion: row.schemaVersion };
    // A move / resize / Move to… is an entry update of the bound field.
    expect(
      await caught(() =>
        as(() =>
          updateTableEntry(TABLE, E1, {
            values: { [CREATED]: '2026-01-05T09:00:00Z' },
            ...revisionPair,
          })
        )
      )
    ).toMatchObject({ statusCode: 400, message: expect.stringMatching(/managed by Snaglet/) });
    // Repeat…, Done / Skip and the repeat moves need a repeating field.
    for (const [action, body] of [
      ['set', { rrule: 'FREQ=WEEKLY' }],
      ['complete', {}],
      ['skip', {}],
      ['move', { to: '2026-01-05T09:00:00Z' }],
      ['shift', { to: '2026-01-05T09:00:00Z' }],
    ] as const)
      expect(
        await caught(() =>
          as(() => tableEntryRepeatAction(TABLE, E1, CREATED, action, { ...body, ...revisionPair }))
        )
      ).toMatchObject({ statusCode: 400, message: expect.stringMatching(/doesn't repeat/) });
    const after = (await listTableEntries(TABLE)).entries.find((e) => e.id === E1)!;
    expect(after.createdAt).toBe(entry.createdAt);
  });

  it('refuses windows over 62 days and bad zones', async () => {
    expect(
      (await caught(() => listOccurrences({ from: '2026-01-01', to: '2026-03-05' }))).statusCode
    ).toBe(400);
    expect(
      (await caught(() => listOccurrences({ from: '2026-01-02', to: '2026-01-01' }))).statusCode
    ).toBe(400);
    expect(
      (
        await caught(() =>
          listOccurrences({ from: '2026-01-01', to: '2026-01-02', tz: 'Not/AZone' })
        )
      ).statusCode
    ).toBe(400);
  });

  it('repeats a range at its current length (wall-clock across DST), logged history too', async () => {
    const status = await field(ID.status);
    const [todo, done] = status.options!;
    const recurrence = {
      statusFieldId: ID.status,
      doneOptionIds: [done!.id],
      resetOptionId: todo!.id,
    };
    await editField(ID.due, { calendarId: cal.id, range: true, recurrence });
    await editField(ID.day, { calendarId: cal.id, range: true, recurrence });
    // Fri 09:00 EST to Mon 17:00 EDT (the clocks go forward on Sun Mar 8).
    await addEntry(E1, { name: 'weekend', [ID.due]: '2026-03-06T14:00:00Z/2026-03-09T21:00:00Z' });
    // Mon to Wed, weekly.
    await addEntry(E2, { name: 'shift', [ID.day]: '2026-03-02/2026-03-04' });
    const repeat = (fieldId: string, entryId: string, value: Record<string, unknown>) =>
      getDb().query(
        `INSERT INTO public.table_entry_repeats (table_id, field_id, entry_id, value) VALUES ($1, $2, $3, $4::jsonb)`,
        [TABLE, fieldId, entryId, JSON.stringify({ tz: 'America/New_York', ...value })]
      );
    await repeat(ID.due, E1, {
      rrule: 'FREQ=WEEKLY;BYDAY=FR',
      dtstart: '2026-02-27T09:00:00',
      current: '2026-03-06T09:00:00',
    });
    await repeat(ID.day, E2, {
      rrule: 'FREQ=WEEKLY;BYDAY=MO',
      dtstart: '2026-03-02',
      current: '2026-03-02',
    });
    await getDb().query(
      `INSERT INTO public.table_entry_occurrences (table_id, field_id, entry_id, occurrence, kind) VALUES ($1, $2, $3, '2026-02-27T09:00:00', 'done')`,
      [TABLE, ID.due, E1]
    );
    const res = await listOccurrences({
      from: '2026-02-27',
      to: '2026-03-17',
      tz: 'America/New_York',
    });
    const got = (title: string) =>
      res.occurrences
        .filter((o) => o.title === title)
        .map((o) => [
          o.status,
          o.time,
          o.canResize,
          o.source === 'row' && o.hasEnd,
          o.source === 'row' && o.repeat?.isCurrent,
        ]);
    expect(got('weekend')).toEqual([
      // The logged one takes the current length: Fri 09:00 – Mon 17:00 EST.
      [
        'done',
        { kind: 'timed', start: '2026-02-27T14:00:00.000Z', end: '2026-03-02T22:00:00.000Z' },
        false,
        true,
        false,
      ],
      [
        'upcoming',
        { kind: 'timed', start: '2026-03-06T14:00:00.000Z', end: '2026-03-09T21:00:00.000Z' },
        true,
        true,
        true,
      ],
      // Still Fri 09:00 – Mon 17:00, now EDT: the length is wall-clock time.
      [
        'upcoming',
        { kind: 'timed', start: '2026-03-13T13:00:00.000Z', end: '2026-03-16T21:00:00.000Z' },
        false,
        true,
        false,
      ],
    ]);
    expect(got('shift').map(([status, time]) => [status, time])).toEqual([
      ['upcoming', { kind: 'all_day', startDate: '2026-03-02', endDate: '2026-03-05' }],
      ['upcoming', { kind: 'all_day', startDate: '2026-03-09', endDate: '2026-03-12' }],
      ['upcoming', { kind: 'all_day', startDate: '2026-03-16', endDate: '2026-03-19' }],
    ]);
    // A window holding only the done one's last day still finds it, although
    // it started days before (the log read is padded by the range's length).
    const monday = await listOccurrences({
      from: '2026-03-02',
      to: '2026-03-03',
      tz: 'America/New_York',
    });
    expect(
      monday.occurrences.filter((o) => o.title === 'weekend').map((o) => [o.status, o.time])
    ).toEqual([
      [
        'done',
        { kind: 'timed', start: '2026-02-27T14:00:00.000Z', end: '2026-03-02T22:00:00.000Z' },
      ],
    ]);
  });

  it('expands a repeating datetime row in wall time across DST, with logged history', async () => {
    const status = await field(ID.status);
    const [todo, done] = status.options!;
    await editField(ID.due, {
      calendarId: cal.id,
      recurrence: {
        statusFieldId: ID.status,
        doneOptionIds: [done!.id],
        resetOptionId: todo!.id,
      },
    });
    // Daily 09:00 New York from 2026-03-06; current is 03-07 (03-06 was done).
    await addEntry(E3, { name: 'standup', [ID.due]: '2026-03-07T14:00:00Z' });
    await getDb().query(
      `INSERT INTO public.table_entry_repeats (table_id, field_id, entry_id, value) VALUES ($1, $2, $3, $4::jsonb)`,
      [
        TABLE,
        ID.due,
        E3,
        JSON.stringify({
          rrule: 'FREQ=DAILY',
          dtstart: '2026-03-06T09:00:00',
          current: '2026-03-07T09:00:00',
          tz: 'America/New_York',
        }),
      ]
    );
    await getDb().query(
      `INSERT INTO public.table_entry_occurrences (table_id, field_id, entry_id, occurrence, kind) VALUES ($1, $2, $3, '2026-03-06T09:00:00', 'done')`,
      [TABLE, ID.due, E3]
    );
    await getDb().query(
      `INSERT INTO public.table_entry_occurrences (table_id, field_id, entry_id, occurrence, kind, moved_to)
       VALUES ($1, $2, $3, '2026-03-09T09:00:00', 'moved', '2026-03-09T11:00:00')`,
      [TABLE, ID.due, E3]
    );
    const res = await listOccurrences({
      from: '2026-03-06',
      to: '2026-03-11',
      tz: 'America/New_York',
    });
    const got = res.occurrences.map((o) => [
      o.status,
      o.time.kind === 'timed' ? o.time.start : null,
      o.source === 'row' ? o.repeat?.isCurrent : null,
    ]);
    expect(got).toEqual([
      ['done', '2026-03-06T14:00:00.000Z', false],
      ['upcoming', '2026-03-07T14:00:00.000Z', true],
      ['upcoming', '2026-03-08T13:00:00.000Z', false],
      ['moved', '2026-03-09T15:00:00.000Z', false],
      ['upcoming', '2026-03-10T13:00:00.000Z', false],
    ]);
    const moved = res.occurrences[3]!;
    if (moved.source !== 'row') throw new Error('row expected');
    expect(moved.repeat).toMatchObject({
      occurrence: '2026-03-09T09:00:00',
      originalStart: '2026-03-09T13:00:00.000Z',
      canShiftAll: true,
    });
    expect(moved.repeat!.summary).toBe('Every day');

    // A done occurrence that had been moved shows where it was moved to, with
    // its planned start; a window holding only the new day still finds it.
    await getDb().query(
      `INSERT INTO public.table_entry_occurrences (table_id, field_id, entry_id, occurrence, kind, moved_to, created_at)
       VALUES ($1, $2, $3, '2026-03-06T09:00:00', 'moved', '2026-03-10T10:00:00', now() - interval '1 hour')`,
      [TABLE, ID.due, E3]
    );
    const narrow = await listOccurrences({
      from: '2026-03-10',
      to: '2026-03-11',
      tz: 'America/New_York',
    });
    const doneMoved = narrow.occurrences.find(
      (o) => o.source === 'row' && o.repeat?.occurrence === '2026-03-06T09:00:00'
    );
    if (!doneMoved || doneMoved.source !== 'row') throw new Error('moved done row expected');
    expect(doneMoved.status).toBe('done');
    expect(doneMoved.time).toMatchObject({ kind: 'timed', start: '2026-03-10T14:00:00.000Z' });
    expect(doneMoved.repeat!.originalStart).toBe('2026-03-06T14:00:00.000Z');
    const wide = await listOccurrences({
      from: '2026-03-06',
      to: '2026-03-07',
      tz: 'America/New_York',
    });
    expect(
      wide.occurrences.some(
        (o) => o.source === 'row' && o.repeat?.occurrence === '2026-03-06T09:00:00'
      )
    ).toBe(false);
    const cals = await listCalendars();
    expect(cals.find((c) => c.id === cal.id)!.boundFields[0]!.repeats).toBe(true);
  });

  it('bounds an interval row per window, from a current one far behind, and says so', async () => {
    const status = await field(ID.status);
    const [todo, done] = status.options!;
    await editField(ID.due, {
      calendarId: cal.id,
      recurrence: {
        statusFieldId: ID.status,
        doneOptionIds: [done!.id],
        resetOptionId: todo!.id,
      },
    });
    // Every minute from Mar 1, never marked done: current is nine days back.
    await addEntry(E3, { name: 'stretch', [ID.due]: '2026-03-01T14:00:00Z' });
    const write = (rrule: string) =>
      getDb().query(
        `INSERT INTO public.table_entry_repeats (table_id, field_id, entry_id, value) VALUES ($1, $2, $3, $4::jsonb)
         ON CONFLICT (field_id, entry_id) DO UPDATE SET value = EXCLUDED.value`,
        [
          TABLE,
          ID.due,
          E3,
          JSON.stringify({
            rrule,
            dtstart: '2026-03-01T09:00:00',
            current: '2026-03-01T09:00:00',
            tz: 'America/New_York',
          }),
        ]
      );
    await write('FREQ=MINUTELY');
    const res = await listOccurrences({
      from: '2026-03-10',
      to: '2026-03-11',
      tz: 'America/New_York',
    });
    const rows = rowsOf(res);
    expect(rows.length).toBeGreaterThan(400);
    expect(rows.length).toBeLessThanOrEqual(CALENDAR_ROW_OCCURRENCES_MAX);
    // Midnight EDT is 04:00Z; the one at 03:31Z still reaches in (30-minute block).
    expect(rows[0]!.time).toMatchObject({ kind: 'timed', start: '2026-03-10T03:31:00.000Z' });
    expect(rows[1]!.time).toMatchObject({ start: '2026-03-10T03:32:00.000Z' });
    expect(rows.every((o) => o.status === 'upcoming' && !o.repeat!.isCurrent)).toBe(true);
    expect(rows[0]!.repeat!.summary).toBe('Every 1 min');
    expect(res.truncated).toEqual([
      { tableId: TABLE, fieldId: ID.due, entryId: E3, title: 'stretch', shown: rows.length },
    ]);

    // Every 2 h fits: twelve in the day, nothing cut short.
    await write('FREQ=HOURLY;INTERVAL=2');
    const fits = await listOccurrences({
      from: '2026-03-10',
      to: '2026-03-11',
      tz: 'America/New_York',
    });
    // From 09:00 EST (14:00Z) on Mar 1: even UTC hours, the same after DST.
    expect(rowsOf(fits).map((o) => (o.time.kind === 'timed' ? o.time.start : null))).toEqual([
      '2026-03-10T04:00:00.000Z',
      '2026-03-10T06:00:00.000Z',
      '2026-03-10T08:00:00.000Z',
      '2026-03-10T10:00:00.000Z',
      '2026-03-10T12:00:00.000Z',
      '2026-03-10T14:00:00.000Z',
      '2026-03-10T16:00:00.000Z',
      '2026-03-10T18:00:00.000Z',
      '2026-03-10T20:00:00.000Z',
      '2026-03-10T22:00:00.000Z',
      '2026-03-11T00:00:00.000Z',
      '2026-03-11T02:00:00.000Z',
    ]);
    expect(fits.truncated).toBeUndefined();
  });

  it('hides a row repeating more often than once a minute from every view, and says so', async () => {
    const status = await field(ID.status);
    const [todo, done] = status.options!;
    await editField(ID.due, {
      calendarId: cal.id,
      recurrence: {
        statusFieldId: ID.status,
        doneOptionIds: [done!.id],
        resetOptionId: todo!.id,
      },
    });
    await addEntry(E3, { name: 'ping', [ID.due]: '2026-03-01T14:00:00Z' });
    const write = (rrule: string) =>
      getDb().query(
        `INSERT INTO public.table_entry_repeats (table_id, field_id, entry_id, value) VALUES ($1, $2, $3, $4::jsonb)
         ON CONFLICT (field_id, entry_id) DO UPDATE SET value = EXCLUDED.value`,
        [
          TABLE,
          ID.due,
          E3,
          JSON.stringify({
            rrule,
            dtstart: '2026-03-01T09:00:00',
            current: '2026-03-01T09:00:00',
            tz: 'America/New_York',
          }),
        ]
      );
    const hidden = {
      tableId: TABLE,
      fieldId: ID.due,
      entryId: E3,
      title: 'ping',
      shown: 0,
      hidden: true,
    };
    for (const rrule of ['FREQ=SECONDLY', 'FREQ=SECONDLY;INTERVAL=30']) {
      await write(rrule);
      // A month of it (2.6 million times at one second) is never expanded.
      const began = Date.now();
      const month = await listOccurrences({
        from: '2026-03-01',
        to: '2026-04-01',
        tz: 'America/New_York',
      });
      expect(Date.now() - began).toBeLessThan(2000);
      expect(rowsOf(month)).toEqual([]);
      expect(month.truncated).toEqual([hidden]);
    }
    // Only history in the window (its current one is later): still hidden, still said.
    await getDb().query(
      `INSERT INTO public.table_entry_repeats (table_id, field_id, entry_id, value) VALUES ($1, $2, $3, $4::jsonb)
       ON CONFLICT (field_id, entry_id) DO UPDATE SET value = EXCLUDED.value`,
      [
        TABLE,
        ID.due,
        E3,
        JSON.stringify({
          rrule: 'FREQ=SECONDLY',
          dtstart: '2026-03-01T09:00:00',
          current: '2026-03-20T09:00:00',
          tz: 'America/New_York',
        }),
      ]
    );
    await getDb().query(
      `INSERT INTO public.table_entry_occurrences (table_id, field_id, entry_id, occurrence, kind) VALUES ($1, $2, $3, '2026-03-10T10:00:00', 'done')`,
      [TABLE, ID.due, E3]
    );
    const history = await listOccurrences({
      from: '2026-03-10',
      to: '2026-03-11',
      tz: 'America/New_York',
    });
    expect(rowsOf(history)).toEqual([]);
    expect(history.truncated).toEqual([hidden]);
    await getDb().query('DELETE FROM public.table_entry_occurrences WHERE table_id = $1', [TABLE]);
    // Ended before the window: nothing to say.
    await write('FREQ=SECONDLY;COUNT=10');
    const after = await listOccurrences({
      from: '2026-03-10',
      to: '2026-03-11',
      tz: 'America/New_York',
    });
    expect(rowsOf(after)).toEqual([]);
    expect(after.truncated).toBeUndefined();
    // Once a minute is still drawn.
    await write('FREQ=MINUTELY');
    const minutely = await listOccurrences({
      from: '2026-03-10',
      to: '2026-03-11',
      tz: 'America/New_York',
    });
    expect(rowsOf(minutely).length).toBeGreaterThan(400);
    expect(minutely.truncated?.[0]?.hidden).toBeUndefined();
  });

  it('marks an interval row overdue once its time has passed, the same day; a daily one waits', async () => {
    const status = await field(ID.status);
    const [todo, done] = status.options!;
    await editField(ID.due, {
      calendarId: cal.id,
      recurrence: {
        statusFieldId: ID.status,
        doneOptionIds: [done!.id],
        resetOptionId: todo!.id,
      },
    });
    // A fixed-offset zone where it is 02:00–21:59 now, so half an hour ago is still today.
    const hour = new Date().getUTCHours();
    const [tz, offsetHours] = hour >= 2 && hour <= 21 ? ['UTC', 0] : ['Asia/Tokyo', 9];
    const startMs = Math.floor((Date.now() - 30 * 60_000) / 60_000) * 60_000;
    const wall = new Date(startMs + offsetHours * 3_600_000).toISOString().slice(0, 19);
    const today = wall.slice(0, 10);
    for (const [id, name, rrule] of [
      [E1, 'hourly', 'FREQ=HOURLY'],
      [E2, 'daily', 'FREQ=DAILY'],
    ] as const) {
      await addEntry(id, { name, [ID.due]: new Date(startMs).toISOString() });
      await getDb().query(
        `INSERT INTO public.table_entry_repeats (table_id, field_id, entry_id, value) VALUES ($1, $2, $3, $4::jsonb)`,
        [TABLE, ID.due, id, JSON.stringify({ rrule, dtstart: wall, current: wall, tz })]
      );
    }
    const res = await listOccurrences({
      from: today,
      to: new Date(Date.parse(`${today}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10),
      tz,
    });
    const current = rowsOf(res).filter((o) => o.repeat!.isCurrent);
    expect(Object.fromEntries(current.map((o) => [o.title, o.repeat!.overdue === true]))).toEqual({
      hourly: true,
      daily: false,
    });
  });

  /** A repeat on the date field `day`, written as the server would. */
  async function repeatOn(entryId: string, value: Record<string, unknown>): Promise<void> {
    await getDb().query(
      `INSERT INTO public.table_entry_repeats (table_id, field_id, entry_id, value) VALUES ($1, $2, $3, $4::jsonb)`,
      [TABLE, ID.day, entryId, JSON.stringify({ tz: 'America/New_York', ...value })]
    );
  }
  const rowsOf = (res: Awaited<ReturnType<typeof listOccurrences>>) =>
    res.occurrences.flatMap((o) => (o.source === 'row' ? [o] : []));

  it('lists a repeating set day on its scheduled days, with no due window', async () => {
    await editField(ID.day, {
      calendarId: cal.id,
      recurrence: { statusFieldId: null, doneOptionIds: [], resetOptionId: null },
    });
    await addEntry(E1, { name: 'rent', [ID.day]: '2026-11-01' });
    await repeatOn(E1, {
      rrule: 'FREQ=MONTHLY',
      dtstart: '2026-11-01',
      current: '2026-11-01',
    });
    const res = await listOccurrences({
      from: '2026-10-26',
      to: '2026-12-07',
      tz: 'America/New_York',
    });
    expect(rowsOf(res).map((o) => o.time)).toEqual([
      { kind: 'all_day', startDate: '2026-11-01', endDate: '2026-11-02' },
      { kind: 'all_day', startDate: '2026-12-01', endDate: '2026-12-02' },
    ]);
    // No due-window key reaches the wire.
    expect(rowsOf(res).every((o) => o.repeat && !('dueBy' in o.repeat))).toBe(true);
    expect(rowsOf(res)[0]!.repeat!.summary).toBe('Every month on the 1st');
  });
});
