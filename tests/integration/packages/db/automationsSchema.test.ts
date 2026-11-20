/**
 * The database floor of public.automations and the tables it leans on:
 *
 * - each timing kind holds its own shape: once (at), repeat (rrule +
 *   time_of_day + starts_on), interval (every_ms, one minute to seven days,
 *   on a calendar or not) and first_open (its earliest time_of_day);
 * - only an interval may carry a daily window, with both ends in HH:mm and
 *   different (a window may cross midnight);
 * - trigger is 'time', status and paused_reason come from fixed sets, name and
 *   prompt have bounded lengths, and the failure count never goes negative;
 * - a row with status 'cancelled' owns no schedule, and a schedule backs one
 *   automation;
 * - schedules take the automation action and the rrule and first_open kinds,
 *   notifications take the automation type, and a schedule run is not manual
 *   unless marked;
 * - deleting the thread or the agent removes the automation; deleting its
 *   calendar or its schedule clears the link;
 * - the table is listed in the catalog as a built-in.
 */
import { describe, expect, it } from '@jest/globals';
import type { PostgresAdapter } from '@snaglet/db/adapters/postgres';
import { createFreshDatabase } from '../../../support/freshDatabase';

const AGENT = 'test-agent-a';
const THREAD = 'thread-1111111111111-autoaaaaa';
const CALENDAR = 'calendar-aaaaaaaa-0000-4000-8000-000000000001';
const SCHEDULE = 'schedule-1111111111111-autoaaaaa';
const SCHEDULE_B = 'schedule-1111111111111-autobbbbb';
const AUTO = 'automation-1111111111111-aaaaaaaaa';

async function expectViolation(promise: Promise<unknown>): Promise<void> {
  // Only an integrity-constraint error (SQLSTATE class 23) counts, so a typo
  // in the statement cannot pass.
  await expect(promise).rejects.toMatchObject({ code: expect.stringMatching(/^23/) });
}

async function seedOwners(db: PostgresAdapter): Promise<void> {
  await db.query(`INSERT INTO public.agents (id, name) VALUES ($1, 'Test Agent A')`, [AGENT]);
  await db.query(`INSERT INTO public.nodes (id, type) VALUES ($1, 'thread')`, [THREAD]);
  await db.query(`INSERT INTO public.threads (id, title) VALUES ($1, 'Test thread')`, [THREAD]);
  await db.query(`INSERT INTO public.calendars (id, title) VALUES ($1, 'Test calendar')`, [
    CALENDAR,
  ]);
}

async function seedSchedule(db: PostgresAdapter, id: string, kind = 'once'): Promise<void> {
  await db.query(
    `INSERT INTO public.schedules (id, name, schedule_kind, schedule_json, action_kind, action_json)
     VALUES ($1, 'Test schedule', $2, '{}', 'automation', $3)`,
    [id, kind, JSON.stringify({ automationId: AUTO })]
  );
}

const INSERT_ONCE = `INSERT INTO public.automations
   (id, name, prompt, when_kind, at, tz, calendar_id, thread_id, agent_id, schedule_id)
 VALUES ($1, 'Check in', 'Look at the build.', 'once', now() + interval '1 hour', 'UTC', $2, $3, $4, $5)`;

async function insertOnce(
  db: PostgresAdapter,
  scheduleId: string | null = SCHEDULE
): Promise<void> {
  await db.query(INSERT_ONCE, [AUTO, CALENDAR, THREAD, AGENT, scheduleId]);
}

/** An automation insert with these extra columns and values (SQL literals). */
function automationInsert(columns: string, values: string): string {
  return `INSERT INTO public.automations (id, name, prompt, tz, thread_id, agent_id, ${columns})
          VALUES ('${AUTO}', 'n', 'p', 'UTC', '${THREAD}', '${AGENT}', ${values})`;
}

async function refused(db: PostgresAdapter, columns: string, values: string): Promise<void> {
  await expectViolation(db.query(automationInsert(columns, values)));
}

/** The row lands; it is removed again so the next one can use the same id. */
async function lands(db: PostgresAdapter, columns: string, values: string): Promise<void> {
  await db.query(automationInsert(columns, values));
  await db.query(`DELETE FROM public.automations WHERE id = $1`, [AUTO]);
}

describe('automations schema', () => {
  it('holds each timing kind to its own shape', async () => {
    const { db, close } = await createFreshDatabase('auto_shapes');
    try {
      await seedOwners(db);

      // once: at only.
      await refused(db, 'when_kind', `'once'`);
      await refused(db, 'when_kind, at, rrule', `'once', now(), 'FREQ=DAILY'`);
      await refused(db, 'when_kind, at, every_ms', `'once', now(), 60000`);
      // repeat: rrule + time_of_day (HH:mm) + starts_on, nothing else.
      await refused(db, 'when_kind, rrule, starts_on', `'repeat', 'FREQ=DAILY', current_date`);
      await refused(db, 'when_kind, rrule, time_of_day', `'repeat', 'FREQ=DAILY', '09:00'`);
      await refused(
        db,
        'when_kind, rrule, time_of_day, starts_on, at',
        `'repeat', 'FREQ=DAILY', '09:00', current_date, now()`
      );
      await refused(
        db,
        'when_kind, rrule, time_of_day, starts_on',
        `'repeat', 'FREQ=DAILY', '9:00', current_date`
      );
      // interval: every_ms from one minute to seven days, no time columns.
      await refused(db, 'when_kind', `'interval'`);
      await refused(db, 'when_kind, every_ms', `'interval', 59999`);
      await refused(db, 'when_kind, every_ms', `'interval', 604800001`);
      await refused(db, 'when_kind, every_ms, rrule', `'interval', 900000, 'FREQ=DAILY'`);
      await refused(db, 'when_kind, every_ms, at', `'interval', 900000, now()`);
      // first_open: its earliest time_of_day (HH:mm), nothing else.
      await refused(db, 'when_kind', `'first_open'`);
      await refused(db, 'when_kind, time_of_day, rrule', `'first_open', '05:00', 'FREQ=DAILY'`);
      await refused(db, 'when_kind, time_of_day', `'first_open', '5am'`);
      // No other kind.
      await refused(db, 'when_kind, every_ms', `'sometimes', 900000`);
      await refused(db, 'when_kind, time_of_day', `'sometimes', '05:00'`);

      // Each valid shape lands; every kind may sit on a calendar.
      await lands(db, 'when_kind, at, calendar_id', `'once', now(), '${CALENDAR}'`);
      await lands(
        db,
        'when_kind, rrule, time_of_day, starts_on, calendar_id',
        `'repeat', 'FREQ=WEEKLY;BYDAY=MO', '09:00', current_date, '${CALENDAR}'`
      );
      await lands(db, 'when_kind, every_ms', `'interval', 60000`);
      await lands(db, 'when_kind, every_ms, calendar_id', `'interval', 900000, '${CALENDAR}'`);
      await lands(db, 'when_kind, time_of_day', `'first_open', '05:00'`);
    } finally {
      await close();
    }
  });

  it('lets only an interval carry a daily window, with both ends in HH:mm and different', async () => {
    const { db, close } = await createFreshDatabase('auto_window');
    try {
      await seedOwners(db);
      const columns = 'when_kind, every_ms, window_start, window_end';

      await lands(db, columns, `'interval', 300000, '05:05', '06:00'`);
      // A window may cross midnight.
      await lands(db, columns, `'interval', 300000, '23:30', '01:00'`);

      await refused(
        db,
        'when_kind, at, window_start, window_end',
        `'once', now() + interval '1 hour', '05:05', '06:00'`
      );
      await refused(db, 'when_kind, every_ms, window_start', `'interval', 300000, '05:05'`);
      await refused(db, columns, `'interval', 300000, '5:05', '06:00'`);
      await refused(db, columns, `'interval', 300000, '05:05', '24:00'`);
      await refused(db, columns, `'interval', 300000, '05:05', '05:05'`);
    } finally {
      await close();
    }
  });

  it('holds trigger, status, paused reason, failure count, name and prompt to their rules', async () => {
    const { db, close } = await createFreshDatabase('auto_columns');
    try {
      await seedOwners(db);

      await refused(db, 'when_kind, every_ms, trigger', `'interval', 900000, 'event'`);
      await refused(db, 'when_kind, every_ms, status', `'interval', 900000, 'done'`);
      // A paused reason only on a paused row.
      await refused(db, 'when_kind, every_ms, paused_reason', `'interval', 900000, 'user'`);
      await refused(db, 'when_kind, every_ms, consecutive_failures', `'interval', 900000, -1`);
      await expectViolation(
        db.query(
          `INSERT INTO public.automations (id, name, prompt, tz, thread_id, agent_id, when_kind, every_ms)
           VALUES ($1, '', 'p', 'UTC', $2, $3, 'interval', 900000)`,
          [AUTO, THREAD, AGENT]
        )
      );
      await expectViolation(
        db.query(
          `INSERT INTO public.automations (id, name, prompt, tz, thread_id, agent_id, when_kind, every_ms)
           VALUES ($1, 'n', repeat('p', 4001), 'UTC', $2, $3, 'interval', 900000)`,
          [AUTO, THREAD, AGENT]
        )
      );

      await db.query(automationInsert('when_kind, every_ms', `'interval', 60000`));
      await db.query(
        `UPDATE public.automations SET status = 'paused', paused_reason = 'failures' WHERE id = $1`,
        [AUTO]
      );
    } finally {
      await close();
    }
  });

  it("keeps a 'cancelled' automation off its schedule and one automation per schedule", async () => {
    const { db, close } = await createFreshDatabase('auto_schedule');
    try {
      await seedOwners(db);
      await seedSchedule(db, SCHEDULE);
      await insertOnce(db);

      await expectViolation(
        db.query(`UPDATE public.automations SET status = 'cancelled' WHERE id = $1`, [AUTO])
      );
      await db.query(
        `UPDATE public.automations SET status = 'cancelled', schedule_id = NULL WHERE id = $1`,
        [AUTO]
      );

      await db.query(
        `UPDATE public.automations SET status = 'active', schedule_id = $2 WHERE id = $1`,
        [AUTO, SCHEDULE]
      );
      await expectViolation(
        db.query(
          `INSERT INTO public.automations
             (id, name, prompt, when_kind, every_ms, tz, thread_id, agent_id, schedule_id)
           VALUES ('automation-1111111111111-bbbbbbbbb', 'n', 'p', 'interval', 900000, 'UTC', $1, $2, $3)`,
          [THREAD, AGENT, SCHEDULE]
        )
      );
    } finally {
      await close();
    }
  });

  it('lets schedules, schedule runs and notifications carry automations', async () => {
    const { db, close } = await createFreshDatabase('auto_neighbors');
    try {
      // Schedules take the automation action with the rrule and first_open kinds.
      await seedSchedule(db, SCHEDULE, 'rrule');
      await seedSchedule(db, SCHEDULE_B, 'first_open');
      await expectViolation(
        db.query(
          `INSERT INTO public.schedules (id, name, schedule_kind, action_kind)
           VALUES ('schedule-1111111111111-autoccccc', 'n', 'cron', 'automation')`
        )
      );

      // A schedule run is not manual unless marked.
      await db.query(
        `INSERT INTO public.schedule_runs (id, schedule_id, scheduled_for, status)
         VALUES ('schedule_run-1111111111111-autoa', $1, now(), 'succeeded')`,
        [SCHEDULE]
      );
      expect(
        (
          await db.query(`SELECT manual FROM public.schedule_runs WHERE schedule_id = $1`, [
            SCHEDULE,
          ])
        ).rows
      ).toEqual([{ manual: false }]);

      await db.query(
        `INSERT INTO public.notifications (id, type, title)
         VALUES ('notif-test-automation', 'automation', 't')`
      );
      await expectViolation(
        db.query(
          `INSERT INTO public.notifications (id, type, title) VALUES ('notif-test-nope', 'nope', 't')`
        )
      );
    } finally {
      await close();
    }
  });

  it('cascades from the thread and the agent, and clears the calendar and schedule links', async () => {
    const { db, close } = await createFreshDatabase('auto_cascade');
    try {
      await seedOwners(db);
      await seedSchedule(db, SCHEDULE);
      await insertOnce(db);

      await db.query(`DELETE FROM public.calendars WHERE id = $1`, [CALENDAR]);
      await db.query(`DELETE FROM public.schedules WHERE id = $1`, [SCHEDULE]);
      expect(
        (
          await db.query(`SELECT calendar_id, schedule_id FROM public.automations WHERE id = $1`, [
            AUTO,
          ])
        ).rows
      ).toEqual([{ calendar_id: null, schedule_id: null }]);

      await db.query(`DELETE FROM public.threads WHERE id = $1`, [THREAD]);
      expect((await db.query(`SELECT 1 FROM public.automations`)).rows).toHaveLength(0);

      await db.query(`INSERT INTO public.threads (id, title) VALUES ($1, 'Test thread')`, [THREAD]);
      await db.query(`INSERT INTO public.calendars (id, title) VALUES ($1, 'Test calendar')`, [
        CALENDAR,
      ]);
      await insertOnce(db, null);
      await db.query(`DELETE FROM public.agents WHERE id = $1`, [AGENT]);
      expect((await db.query(`SELECT 1 FROM public.automations`)).rows).toHaveLength(0);
    } finally {
      await close();
    }
  });

  it('is listed in the table catalog as a built-in', async () => {
    const { db, close } = await createFreshDatabase('auto_catalog');
    try {
      const { rows } = await db.query(
        `SELECT id, name, table_name, origin FROM public.table_catalog
          WHERE id = 'table-builtin-automations'`
      );
      expect(rows).toEqual([
        {
          id: 'table-builtin-automations',
          name: 'Automations',
          table_name: 'automations',
          origin: 'builtin',
        },
      ]);
    } finally {
      await close();
    }
  });
});
