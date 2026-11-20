/**
 * The database floor of per-thread run-ended notification settings, and the
 * ThreadNotificationSettingsTable model against real SQL:
 *
 * - one row per thread, with opt-in defaults (off, chime, both outcomes on),
 *   no row for a thread that does not exist, and a non-empty sound;
 * - settings go with the thread they belong to;
 * - the model's get / save / remove round trip.
 */
import { describe, expect, it } from '@jest/globals';
import type { PostgresAdapter } from '@snaglet/db/adapters/postgres';
import { ThreadNotificationSettingsTable } from '@snaglet/db/tables/thread_notification_settings';
import { createFreshDatabase } from '../../../support/freshDatabase';

const TABLE = 'thread_notification_settings';

const THREAD = 'thread-1111111111111-notifaaaa';
const OTHER_THREAD = 'thread-2222222222222-notifbbbb';

async function seedThreads(db: PostgresAdapter): Promise<void> {
  for (const [id, title] of [
    [THREAD, 'Test thread'],
    [OTHER_THREAD, 'Other thread'],
  ]) {
    await db.query(`INSERT INTO public.nodes (id, type) VALUES ($1, 'thread')`, [id]);
    await db.query(`INSERT INTO public.threads (id, title) VALUES ($1, $2)`, [id, title]);
  }
}

async function expectViolation(promise: Promise<unknown>): Promise<void> {
  // Only an integrity-constraint error (SQLSTATE class 23) counts.
  await expect(promise).rejects.toMatchObject({ code: expect.stringMatching(/^23/) });
}

describe('thread notification settings schema', () => {
  it('keys one row per thread, defaults to off, and cascades with the thread', async () => {
    const { db, close } = await createFreshDatabase('thread_notif');
    try {
      await seedThreads(db);

      // Opt-in: a bare row is OFF, chime, both outcomes on.
      await db.query(`INSERT INTO public.${TABLE} (thread_id) VALUES ($1)`, [THREAD]);
      const { rows } = await db.query<{
        thread_id: string;
        enabled: boolean;
        sound: string;
        on_completed: boolean;
        on_failed: boolean;
      }>(`SELECT thread_id, enabled, sound, on_completed, on_failed FROM public.${TABLE}`);
      expect(rows).toEqual([
        { thread_id: THREAD, enabled: false, sound: 'chime', on_completed: true, on_failed: true },
      ]);

      // thread_id is the primary key: one row per thread.
      await expectViolation(
        db.query(`INSERT INTO public.${TABLE} (thread_id) VALUES ($1)`, [THREAD])
      );
      // No settings for a thread that does not exist.
      await expectViolation(
        db.query(`INSERT INTO public.${TABLE} (thread_id) VALUES ('thread-nope')`)
      );
      // The sound check refuses an empty string; the server validates the id
      // against REMINDER_SOUNDS.
      await expectViolation(
        db.query(`INSERT INTO public.${TABLE} (thread_id, sound) VALUES ($1, '')`, [OTHER_THREAD])
      );

      // Deleting the thread takes its settings.
      await db.query(`INSERT INTO public.${TABLE} (thread_id, enabled) VALUES ($1, true)`, [
        OTHER_THREAD,
      ]);
      await db.query('DELETE FROM public.threads WHERE id = $1', [THREAD]);
      const { rows: left } = await db.query<{ thread_id: string }>(
        `SELECT thread_id FROM public.${TABLE}`
      );
      expect(left).toEqual([{ thread_id: OTHER_THREAD }]);
    } finally {
      await close();
    }
  });

  it('round-trips through the model: get / save / remove', async () => {
    const { db, close } = await createFreshDatabase('thread_notif_model');
    try {
      await seedThreads(db);

      // Never configured: no row at all, so callers fall back to the defaults.
      expect(await ThreadNotificationSettingsTable.get(THREAD, db)).toBeNull();

      const saved = await ThreadNotificationSettingsTable.save(
        THREAD,
        { enabled: true, sound: 'bell', onCompleted: true, onFailed: false },
        db
      );
      expect(saved).toEqual({
        threadId: THREAD,
        enabled: true,
        sound: 'bell',
        onCompleted: true,
        onFailed: false,
        updatedAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/),
      });
      expect(await ThreadNotificationSettingsTable.get(THREAD, db)).toEqual(saved);

      // Saving again replaces in place — still one row for the thread.
      const again = await ThreadNotificationSettingsTable.save(
        THREAD,
        { enabled: false, sound: 'none', onCompleted: false, onFailed: true },
        db
      );
      expect(again).toMatchObject({
        enabled: false,
        sound: 'none',
        onCompleted: false,
        onFailed: true,
      });
      const { rows } = await db.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM public.${TABLE}`
      );
      expect(rows[0]?.count).toBe('1');

      expect(await ThreadNotificationSettingsTable.remove(THREAD, db)).toBe(true);
      expect(await ThreadNotificationSettingsTable.remove(THREAD, db)).toBe(false);
      expect(await ThreadNotificationSettingsTable.get(THREAD, db)).toBeNull();
    } finally {
      await close();
    }
  });
});
