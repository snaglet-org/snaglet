/**
 * Per-thread "run ended" notifications: when a run finishes in a thread the
 * user asked to be told about, Snaglet raises an OS banner and plays a sound, the
 * way a calendar reminder does.
 *
 * Opt-in per thread — a thread with no saved settings is off
 * ({@link DEFAULT_THREAD_NOTIFICATION_SETTINGS}). The sound ids are the
 * reminder sounds (`REMINDER_SOUNDS` in ./reminders), reused rather than
 * duplicated so both features stay in step and share the same WAV files.
 *
 * Shared by the server (settings routes, run:end delivery), the desktop UI
 * (the thread's Notifications settings tab, the alert handler) and the
 * desktop shell (native notifications).
 */
import { DEFAULT_REMINDER_SOUND, type ReminderSoundId } from './reminders';

/** A run outcome that can alert. An aborted run (the user pressed stop) never does. */
export const THREAD_RUN_ALERT_STATUSES = ['completed', 'failed'] as const;
export type ThreadRunAlertStatus = (typeof THREAD_RUN_ALERT_STATUSES)[number];

/** One thread's run-ended notification settings. */
export interface ThreadNotificationSettings {
  threadId: string;
  /** Master switch; off alerts for nothing but keeps the choices below. */
  enabled: boolean;
  /** Sound played with the alert; `none` alerts silently. */
  sound: ReminderSoundId;
  /** Alert when a run finishes normally (including one that asks a question). */
  onCompleted: boolean;
  /** Alert when a run fails. */
  onFailed: boolean;
  /** ISO-8601, UTC. Null for a thread that has never been configured. */
  updatedAt: string | null;
}

/**
 * What an unconfigured thread reads as: off, with the defaults the settings
 * form shows before the user saves anything.
 */
export function defaultThreadNotificationSettings(threadId: string): ThreadNotificationSettings {
  return {
    threadId,
    enabled: false,
    sound: DEFAULT_REMINDER_SOUND,
    onCompleted: true,
    onFailed: true,
    updatedAt: null,
  };
}

/** PUT body: the full settings shape minus the server-owned fields. */
export interface UpdateThreadNotificationSettingsRequest {
  enabled: boolean;
  sound: ReminderSoundId;
  onCompleted: boolean;
  onFailed: boolean;
}

/** GET / PUT response. */
export interface ThreadNotificationSettingsResponse {
  settings: ThreadNotificationSettings;
}

/**
 * One run-ended alert, carried by the `thread.run_alert` workspace event.
 *
 * It is not a tray notification: the existing `run_completed` / `run_failed`
 * (or question `mention`) notification remains the single tray entry, and
 * `notificationId` points at it so a client can tie the two together. This
 * event only says "alert the user about this, with this sound".
 */
export interface ThreadRunAlert {
  threadId: string;
  runId: string;
  status: ThreadRunAlertStatus;
  sound: ReminderSoundId;
  /** Banner title, the same wording the tray notification uses. */
  title: string;
  /** Banner body, when there is one. */
  body: string | null;
  /** The tray notification this alert accompanies, when one was created. */
  notificationId?: string;
}
