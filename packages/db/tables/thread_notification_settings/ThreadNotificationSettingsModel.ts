/**
 * Per-thread run-ended notification settings: one row per thread in
 * `thread_notification_settings`, keyed by `thread_id`. Plain SQL; the
 * server's threads domain validates input before it gets here.
 *
 * A thread with no row is not configured, which reads as off: `get` answers
 * null and callers fall back to `defaultThreadNotificationSettings`.
 */
import { getDb, type DbQueryable } from '@snaglet/db/db';
import type { ReminderSoundId, ThreadNotificationSettings } from '@snaglet/shared/types';

interface RawSettings {
  thread_id: string;
  enabled: boolean;
  sound: ReminderSoundId;
  on_completed: boolean;
  on_failed: boolean;
  updated_at: string;
}

const COLUMNS = `thread_id, enabled, sound, on_completed, on_failed,
  to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS updated_at`;

function toSettings(raw: RawSettings): ThreadNotificationSettings {
  return {
    threadId: raw.thread_id,
    enabled: raw.enabled,
    sound: raw.sound,
    onCompleted: raw.on_completed,
    onFailed: raw.on_failed,
    updatedAt: raw.updated_at,
  };
}

interface SaveThreadNotificationSettingsInput {
  enabled: boolean;
  sound: ReminderSoundId;
  onCompleted: boolean;
  onFailed: boolean;
}

export const ThreadNotificationSettingsTable = {
  /** One thread's saved settings, or null when it has never been configured. */
  async get(
    threadId: string,
    runner: DbQueryable = getDb()
  ): Promise<ThreadNotificationSettings | null> {
    const { rows } = await runner.query<RawSettings>(
      `SELECT ${COLUMNS} FROM public.thread_notification_settings WHERE thread_id = $1`,
      [threadId]
    );
    return rows[0] ? toSettings(rows[0]) : null;
  },

  /** Insert or replace a thread's settings. */
  async save(
    threadId: string,
    input: SaveThreadNotificationSettingsInput,
    runner: DbQueryable = getDb()
  ): Promise<ThreadNotificationSettings> {
    const { rows } = await runner.query<RawSettings>(
      `INSERT INTO public.thread_notification_settings
         (thread_id, enabled, sound, on_completed, on_failed)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (thread_id) DO UPDATE
         SET enabled = EXCLUDED.enabled, sound = EXCLUDED.sound,
             on_completed = EXCLUDED.on_completed, on_failed = EXCLUDED.on_failed,
             updated_at = now()
       RETURNING ${COLUMNS}`,
      [threadId, input.enabled, input.sound, input.onCompleted, input.onFailed]
    );
    return toSettings(rows[0]!);
  },

  /** Remove a thread's settings; true when there were any. */
  async remove(threadId: string, runner: DbQueryable = getDb()): Promise<boolean> {
    const result = await runner.query(
      `DELETE FROM public.thread_notification_settings WHERE thread_id = $1`,
      [threadId]
    );
    return (result.rowCount ?? 0) > 0;
  },
};
