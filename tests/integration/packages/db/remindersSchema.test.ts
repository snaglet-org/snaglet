/**
 * The database floor of calendar reminders:
 *
 * - reminder_settings keys one row per item through its generated item_key
 *   (event, table_entry or automation), holds each kind to its own columns,
 *   defaults to an enabled chime, and keeps offsets an array;
 * - an event's and an automation's settings go with the item;
 * - reminder_deliveries delivers a key once.
 */
import { describe, expect, it } from '@jest/globals';
import type { PostgresAdapter } from '@snaglet/db/adapters/postgres';
import { createFreshDatabase } from '../../../support/freshDatabase';

const AGENT = 'test-agent-a';
const THREAD = 'thread-1111111111111-remaaaaaa';
const CALENDAR = 'calendar-aaaaaaaa-0000-4000-8000-000000000001';
const EVENT = 'event-1111111111111-remaaaaaa';
const AUTOMATION = 'automation-1111111111111-remaaaaaa';

async function seedItems(db: PostgresAdapter): Promise<void> {
  await db.query(`INSERT INTO public.agents (id, name) VALUES ($1, 'Test Agent A')`, [AGENT]);
  await db.query(`INSERT INTO public.nodes (id, type) VALUES ($1, 'thread')`, [THREAD]);
  await db.query(`INSERT INTO public.threads (id, title) VALUES ($1, 'Test thread')`, [THREAD]);
  await db.query(`INSERT INTO public.calendars (id, title) VALUES ($1, 'Test calendar')`, [
    CALENDAR,
  ]);
  await db.query(`INSERT INTO public.nodes (id, type) VALUES ($1, 'calendar_event')`, [EVENT]);
  await db.query(
    `INSERT INTO public.calendar_events (id, calendar_id, title, time_kind, time_zone, start_at, end_at)
     VALUES ($1, $2, 'Test event', 'timed', 'UTC', now() + interval '1 hour', now() + interval '2 hours')`,
    [EVENT, CALENDAR]
  );
  await db.query(
    `INSERT INTO public.automations
       (id, name, prompt, tz, thread_id, agent_id, when_kind, at, calendar_id)
     VALUES ($1, 'Check in', 'Look at the build.', 'UTC', $2, $3, 'once', now() + interval '1 hour', $4)`,
    [AUTOMATION, THREAD, AGENT, CALENDAR]
  );
}

async function expectViolation(promise: Promise<unknown>): Promise<void> {
  // Only an integrity-constraint error (SQLSTATE class 23) counts.
  await expect(promise).rejects.toMatchObject({ code: expect.stringMatching(/^23/) });
}

describe('reminders schema', () => {
  it('keys one row per item, holds each kind to its shape, delivers a key once, and cascades', async () => {
    const { db, close } = await createFreshDatabase('reminders');
    try {
      await seedItems(db);

      await db.query(
        `INSERT INTO public.reminder_settings (kind, event_id, offsets) VALUES ('event', $1, '[{"amount":15,"unit":"minutes"}]')`,
        [EVENT]
      );
      await db.query(
        `INSERT INTO public.reminder_settings (kind, automation_id, at_start) VALUES ('automation', $1, true)`,
        [AUTOMATION]
      );
      const { rows } = await db.query<{ item_key: string; sound: string; enabled: boolean }>(
        'SELECT item_key, sound, enabled FROM public.reminder_settings ORDER BY item_key'
      );
      expect(rows).toEqual([
        { item_key: `automation:${AUTOMATION}`, sound: 'chime', enabled: true },
        { item_key: `event:${EVENT}`, sound: 'chime', enabled: true },
      ]);

      // One row per item; no mixed shapes; offsets stay an array.
      await expectViolation(
        db.query(`INSERT INTO public.reminder_settings (kind, event_id) VALUES ('event', $1)`, [
          EVENT,
        ])
      );
      await expectViolation(
        db.query(
          `INSERT INTO public.reminder_settings (kind, event_id, automation_id) VALUES ('event', $1, $2)`,
          [EVENT, AUTOMATION]
        )
      );
      await expectViolation(
        db.query(
          `INSERT INTO public.reminder_settings (kind, automation_id, offsets) VALUES ('automation', $1, '{}')`,
          [AUTOMATION]
        )
      );
      await expectViolation(
        db.query(`INSERT INTO public.reminder_settings (kind) VALUES ('table_entry')`)
      );

      // The ledger delivers a key once.
      await db.query(`INSERT INTO public.reminder_deliveries (key) VALUES ('event:x@t#start')`);
      await expectViolation(
        db.query(`INSERT INTO public.reminder_deliveries (key) VALUES ('event:x@t#start')`)
      );

      // Purging the event node and deleting the automation take their settings.
      await db.query('DELETE FROM public.nodes WHERE id = $1', [EVENT]);
      await db.query('DELETE FROM public.automations WHERE id = $1', [AUTOMATION]);
      expect((await db.query('SELECT 1 FROM public.reminder_settings')).rows).toHaveLength(0);
    } finally {
      await close();
    }
  });
});
