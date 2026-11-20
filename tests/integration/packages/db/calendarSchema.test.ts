import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import { getDb } from '@snaglet/db';
import type { PostgresAdapter } from '@snaglet/db/adapters/postgres';
import { transaction } from '@snaglet/db/db';
import { createFreshDatabase } from '../../../support/freshDatabase';

// The event statements run on the integration harness's disposable per-file
// clone; the field-binding floor at the end runs on its own fresh database.
// No calendar API, scheduler or live home is involved.
const PREFIX = 'calendar-schema-test-';
const CALENDAR = `${PREFIX}personal`;
const OTHER_CALENDAR = `${PREFIX}other`;
let nextId = 0;
const id = (kind: string) => `${PREFIX}${kind}-${++nextId}`;

type EventFields = {
  calendar_id?: string;
  title?: string;
  time_kind?: 'timed' | 'all_day';
  time_zone?: string;
  start_at?: string | null;
  end_at?: string | null;
  start_date?: string | null;
  end_date?: string | null;
  recurrence?: (string | null)[];
  recurring_event_id?: string;
  original_start_at?: string;
  original_start_date?: string;
  status?: string;
};

async function event(fields: EventFields = {}) {
  const eventId = id('event');
  const allDay = fields.time_kind === 'all_day';
  const values = {
    id: eventId,
    calendar_id: CALENDAR,
    title: 'Test event',
    time_kind: 'timed',
    time_zone: 'America/Los_Angeles',
    start_at: allDay ? null : '2030-01-10T17:00:00Z',
    end_at: allDay ? null : '2030-01-10T18:00:00Z',
    start_date: allDay ? '2030-01-10' : null,
    end_date: allDay ? '2030-01-11' : null,
    ...fields,
  };
  const columns = Object.keys(values);
  await transaction(async (tx) => {
    await tx.query(`INSERT INTO nodes (id, type) VALUES ($1, 'calendar_event')`, [eventId]);
    await tx.query(
      `INSERT INTO calendar_events (${columns.join(', ')}) VALUES (${columns.map((_, i) => `$${i + 1}`).join(', ')})`,
      Object.values(values)
    );
  });
  return eventId;
}

async function cleanup() {
  // Series deletion is explicit so node-spine rows cannot be orphaned by a
  // cascade that deletes only the kind table for their exceptions.
  await getDb().query(
    `DELETE FROM nodes WHERE id IN
     (SELECT id FROM calendar_events WHERE id LIKE $1 AND recurring_event_id IS NOT NULL)`,
    [`${PREFIX}%`]
  );
  await getDb().query('DELETE FROM nodes WHERE id LIKE $1', [`${PREFIX}%`]);
  await getDb().query('DELETE FROM calendars WHERE id LIKE $1', [`${PREFIX}%`]);
}

describe('calendar schema foundation', () => {
  beforeAll(async () => {
    await cleanup();
    await getDb().query(
      `INSERT INTO calendars (id, title, time_zone) VALUES ($1, 'Personal', 'America/Los_Angeles'), ($2, 'Work', 'UTC')`,
      [CALENDAR, OTHER_CALENDAR]
    );
  });
  afterAll(cleanup);

  it('keeps timed instants with their named time zone and exclusive end', async () => {
    const eventId = await event();
    const { rows } = await getDb().query(
      `SELECT e.time_kind, e.time_zone, EXTRACT(EPOCH FROM (e.end_at - e.start_at))::int AS seconds,
       e.revision, n.type::text AS node_type FROM calendar_events e JOIN nodes n USING (id) WHERE e.id = $1`,
      [eventId]
    );
    expect(rows[0]).toEqual({
      time_kind: 'timed',
      time_zone: 'America/Los_Angeles',
      seconds: 3600,
      revision: 1,
      node_type: 'calendar_event',
    });
  });

  it('keeps all-day dates independent of the SQL session time zone', async () => {
    const eventId = await event({ time_kind: 'all_day' });
    await transaction(async (tx) => {
      await tx.query(`SET LOCAL TIME ZONE 'Pacific/Auckland'`);
      const { rows } = await tx.query(
        `SELECT start_date::text, end_date::text, start_at, end_at, end_date - start_date AS days
         FROM calendar_events WHERE id = $1`,
        [eventId]
      );
      expect(rows[0]).toEqual({
        start_date: '2030-01-10',
        end_date: '2030-01-11',
        start_at: null,
        end_at: null,
        days: 1,
      });
    });
  });

  it.each<EventFields>([
    { start_date: '2030-01-10' },
    { end_at: null },
    { end_at: '2030-01-10T17:00:00Z' },
    { start_at: '-infinity' },
    { time_kind: 'all_day', end_date: '2030-01-10' },
    { time_kind: 'all_day', end_date: null },
    { time_kind: 'all_day', start_at: '2030-01-10T17:00:00Z' },
    { time_zone: 'Not/A_Timezone' },
    { start_at: null, end_at: null, status: 'cancelled' },
  ])('rejects incomplete, mixed or invalid event timing: %j', async (fields) => {
    await expect(event(fields)).rejects.toMatchObject({ code: '23514' });
  });

  it('accepts recurrence lines but rejects malformed arrays and embedded DTSTART', async () => {
    await event({
      recurrence: ['RRULE:FREQ=WEEKLY;BYDAY=TH', 'EXDATE;TZID=America/Los_Angeles:20300117T090000'],
    });
    for (const recurrence of [
      ['DTSTART:20300110T090000'],
      ['RRULE:'],
      [null],
      ['RRULE:FREQ=DAILY\nEXDATE:20300111T090000'],
    ]) {
      await expect(event({ recurrence })).rejects.toMatchObject({ code: '23514' });
    }
  });

  it('moves an exception without changing its original occurrence identity or series UID', async () => {
    const root = await event({ recurrence: ['RRULE:FREQ=WEEKLY;COUNT=3'] });
    const exception = await event({
      recurring_event_id: root,
      original_start_at: '2030-01-17T17:00:00Z',
      start_at: '2030-01-18T17:00:00Z',
      end_at: '2030-01-18T18:00:00Z',
    });
    await getDb().query(
      `UPDATE calendar_events SET start_at = start_at + interval '1 hour', end_at = end_at + interval '1 hour', revision = revision + 1 WHERE id = $1`,
      [exception]
    );
    const { rows } = await getDb().query(
      `SELECT e.original_start_at = '2030-01-17T17:00:00Z'::timestamptz AS original,
       e.ical_uid = root.ical_uid AS shared_uid, e.revision FROM calendar_events e JOIN calendar_events root ON root.id = e.recurring_event_id WHERE e.id = $1`,
      [exception]
    );
    expect(rows[0]).toEqual({ original: true, shared_uid: true, revision: 2 });
    // Equivalent instants, including different timezone offsets, are one slot.
    await expect(
      event({ recurring_event_id: root, original_start_at: '2030-01-17T09:00:00-08:00' })
    ).rejects.toMatchObject({ code: '23505' });
    await expect(
      getDb().query(
        `UPDATE calendar_events SET original_start_at = original_start_at + interval '1 day' WHERE id = $1`,
        [exception]
      )
    ).rejects.toMatchObject({ code: '23514' });
  });

  it('retains sparse cancellation exceptions for timed and all-day series', async () => {
    for (const time_kind of ['timed', 'all_day'] as const) {
      const root = await event({ time_kind, recurrence: ['RRULE:FREQ=DAILY;COUNT=3'] });
      await event({
        time_kind,
        recurring_event_id: root,
        status: 'cancelled',
        title: '',
        start_at: null,
        end_at: null,
        start_date: null,
        end_date: null,
        ...(time_kind === 'timed'
          ? { original_start_at: '2030-01-11T17:00:00Z' }
          : { original_start_date: '2030-01-11' }),
      });
    }
  });

  it('rejects nested exceptions, mismatched calendars/kinds and stripping recurrence under exceptions', async () => {
    const once = await event();
    await expect(
      event({ recurring_event_id: once, original_start_at: '2030-01-10T17:00:00Z' })
    ).rejects.toMatchObject({ code: '23514' });
    const root = await event({ recurrence: ['RRULE:FREQ=DAILY;COUNT=3'] });
    const exception = await event({
      recurring_event_id: root,
      original_start_at: '2030-01-11T17:00:00Z',
    });
    await expect(
      event({ recurring_event_id: exception, original_start_at: '2030-01-12T17:00:00Z' })
    ).rejects.toMatchObject({ code: '23514' });
    await expect(
      event({
        calendar_id: OTHER_CALENDAR,
        recurring_event_id: root,
        original_start_at: '2030-01-12T17:00:00Z',
      })
    ).rejects.toMatchObject({ code: '23514' });
    await expect(
      event({ time_kind: 'all_day', recurring_event_id: root, original_start_date: '2030-01-12' })
    ).rejects.toMatchObject({ code: '23514' });
    await expect(
      getDb().query(`UPDATE calendar_events SET recurrence = '{}' WHERE id = $1`, [root])
    ).rejects.toMatchObject({ code: '23514' });
    await expect(
      getDb().query(`UPDATE calendar_events SET calendar_id = $2 WHERE id = $1`, [
        root,
        OTHER_CALENDAR,
      ])
    ).rejects.toMatchObject({ code: '23514' });
  });

  it('requires explicit series purge and prevents a calendar deletion from deleting its events', async () => {
    const root = await event({ recurrence: ['RRULE:FREQ=DAILY;COUNT=3'] });
    const exception = await event({
      recurring_event_id: root,
      original_start_at: '2030-01-11T17:00:00Z',
    });
    await expect(getDb().query('DELETE FROM nodes WHERE id = $1', [root])).rejects.toMatchObject({
      code: '23503',
    });
    await expect(
      getDb().query('DELETE FROM calendars WHERE id = $1', [CALENDAR])
    ).rejects.toMatchObject({ code: '23503' });
    await transaction(async (tx) => {
      await tx.query('DELETE FROM nodes WHERE id = $1', [exception]);
      await tx.query('DELETE FROM nodes WHERE id = $1', [root]);
    });
    expect(
      (
        await getDb().query('SELECT id FROM calendar_events WHERE id = ANY($1)', [
          [root, exception],
        ])
      ).rows
    ).toHaveLength(0);
  });
});

/**
 * Calendars and the table fields bound to them: only a date or datetime field
 * binds, and only to a real calendar; at most one calendar is the default and
 * the sidebar order is never negative; deleting a calendar unbinds its fields,
 * and a table with a bound field deletes cleanly.
 */
describe('calendar binding floor', () => {
  const TABLE = 'table-1111111111111-caltab001';
  const DUE = 'field-1111111111111-caldue001';
  const START = 'field-1111111111111-calstart01';
  const NOTE = 'field-1111111111111-calnote001';
  const CAL_A = 'calendar-aaaaaaaa-0000-4000-8000-000000000001';
  const CAL_B = 'calendar-aaaaaaaa-0000-4000-8000-000000000002';

  async function expectViolation(
    db: PostgresAdapter,
    text: string,
    params: unknown[] = [],
    code: string | RegExp = /^23/
  ) {
    // Only an integrity-constraint error (SQLSTATE class 23, or the exact code
    // given) counts, so a typo in the statement cannot pass.
    await expect(db.query(text, params)).rejects.toMatchObject({
      code: expect.stringMatching(code),
    });
  }

  async function seedCalendars(db: PostgresAdapter): Promise<void> {
    await db.query(`INSERT INTO public.calendars (id, title) VALUES ($1, 'Home'), ($2, 'Work')`, [
      CAL_A,
      CAL_B,
    ]);
  }

  async function seedFields(db: PostgresAdapter): Promise<void> {
    await db.query(
      `INSERT INTO public.table_catalog (id, name, table_name, origin)
       VALUES ($1, 'chores', 'chores', 'custom')`,
      [TABLE]
    );
    await db.query(
      `INSERT INTO public.table_fields (id, table_id, column_name, name, type, nullable, position) VALUES
         ($1, $4, 'due', 'due', 'date', true, 0),
         ($2, $4, 'starts', 'starts', 'datetime', true, 1),
         ($3, $4, 'note', 'note', 'text', true, 2)`,
      [DUE, START, NOTE, TABLE]
    );
  }

  it('binds only date and datetime fields, and only to a real calendar', async () => {
    const { db, close } = await createFreshDatabase('calendar_binding');
    try {
      // A fresh install starts with exactly one calendar, the default.
      expect((await db.query(`SELECT is_default FROM public.calendars`)).rows).toEqual([
        { is_default: true },
      ]);
      await seedCalendars(db);
      await seedFields(db);

      // Bindable: date and datetime fields.
      await db.query(`UPDATE public.table_fields SET calendar_id = $2 WHERE id = $1`, [DUE, CAL_A]);
      await db.query(`UPDATE public.table_fields SET calendar_id = $2 WHERE id = $1`, [
        START,
        CAL_A,
      ]);
      // Not bindable: a text field; an unknown calendar.
      await expectViolation(
        db,
        `UPDATE public.table_fields SET calendar_id = $2 WHERE id = $1`,
        [NOTE, CAL_A],
        '23514'
      );
      await expectViolation(
        db,
        `UPDATE public.table_fields SET calendar_id = 'calendar-nope' WHERE id = $1`,
        [DUE],
        '23503'
      );
      // A bound field may move between date and datetime, never to another type.
      await db.query(`UPDATE public.table_fields SET type = 'date' WHERE id = $1`, [START]);
      await expectViolation(
        db,
        `UPDATE public.table_fields SET type = 'text' WHERE id = $1`,
        [DUE],
        '23514'
      );
    } finally {
      await close();
    }
  }, 120_000);

  it('keeps at most one default calendar and a non-negative order', async () => {
    const { db, close } = await createFreshDatabase('calendar_default');
    try {
      await seedCalendars(db);
      // A new calendar is not the default and sorts first.
      expect(
        (
          await db.query(
            `SELECT id, is_default, sort_order FROM public.calendars WHERE id = ANY($1) ORDER BY id`,
            [[CAL_A, CAL_B]]
          )
        ).rows
      ).toEqual([
        { id: CAL_A, is_default: false, sort_order: 0 },
        { id: CAL_B, is_default: false, sort_order: 0 },
      ]);
      // The index is checked per row (not deferrable), so moving the flag is
      // two statements: clear the old one, then set.
      await expectViolation(
        db,
        `UPDATE public.calendars SET is_default = true WHERE id = $1`,
        [CAL_A],
        '23505'
      );
      await db.query(`UPDATE public.calendars SET is_default = false WHERE is_default`);
      await db.query(`UPDATE public.calendars SET is_default = true WHERE id = $1`, [CAL_A]);
      await expectViolation(
        db,
        `UPDATE public.calendars SET is_default = true WHERE id = $1`,
        [CAL_B],
        '23505'
      );
      await db.query(`UPDATE public.calendars SET is_default = false WHERE id = $1`, [CAL_A]);
      await db.query(`UPDATE public.calendars SET is_default = true WHERE id = $1`, [CAL_B]);
      expect((await db.query(`SELECT id FROM public.calendars WHERE is_default`)).rows).toEqual([
        { id: CAL_B },
      ]);
      await expectViolation(
        db,
        `UPDATE public.calendars SET sort_order = -1 WHERE id = $1`,
        [CAL_A],
        '23514'
      );
    } finally {
      await close();
    }
  }, 120_000);

  it('unbinds a field when its calendar is deleted, and a table deletes with its bound fields', async () => {
    const { db, close } = await createFreshDatabase('calendar_unbind');
    try {
      await seedCalendars(db);
      await seedFields(db);
      await db.query(`UPDATE public.table_fields SET calendar_id = $2 WHERE id = $1`, [
        START,
        CAL_A,
      ]);
      await db.query(`UPDATE public.table_fields SET calendar_id = $2 WHERE id = $1`, [DUE, CAL_B]);

      // Deleting the calendar unbinds the field.
      await db.query(`DELETE FROM public.calendars WHERE id = $1`, [CAL_A]);
      expect(
        (await db.query(`SELECT calendar_id FROM public.table_fields WHERE id = $1`, [START])).rows
      ).toEqual([{ calendar_id: null }]);

      // Deleting the table removes its fields, the bound one too.
      await db.query(`DELETE FROM public.table_catalog WHERE id = $1`, [TABLE]);
      expect(
        (await db.query(`SELECT 1 FROM public.table_fields WHERE table_id = $1`, [TABLE])).rows
      ).toHaveLength(0);
      expect(
        (await db.query(`SELECT id FROM public.calendars WHERE id = ANY($1)`, [[CAL_A, CAL_B]]))
          .rows
      ).toEqual([{ id: CAL_B }]);
    } finally {
      await close();
    }
  }, 120_000);
});
