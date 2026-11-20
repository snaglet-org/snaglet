/**
 * Reminders for calendar items with a start time (events, timed table-row
 * dates, automations): a sound plus a banner, at the start time and/or at
 * offsets before it. Shared by the server (settings, scheduling, delivery),
 * the desktop UI (settings controls, in-app banner, sound) and the desktop
 * shell (native OS notifications).
 */

/** What a reminder is attached to. A table row is identified per date field. */
export type ReminderItemRef =
  | { kind: 'event'; eventId: string }
  | { kind: 'table_entry'; tableId: string; entryId: string; fieldId: string }
  | { kind: 'automation'; automationId: string };

export type ReminderItemKind = ReminderItemRef['kind'];

export const REMINDER_UNITS = ['minutes', 'hours', 'days'] as const;
export type ReminderUnit = (typeof REMINDER_UNITS)[number];

/** "[amount] [unit] before" the start. `amount` is a whole number ≥ 1. */
export interface ReminderOffset {
  amount: number;
  unit: ReminderUnit;
}

/**
 * Built-in sounds: WAV files in `apps/desktop-ui/public/sounds/reminders/<id>.wav`
 * (made by `scripts/generate-reminder-sounds.mjs`). The in-app banner plays
 * them, and the desktop app bundles the same files for native notifications,
 * so a reminder sounds the same either way. `none` notifies silently.
 */
export const REMINDER_SOUNDS = ['chime', 'bell', 'ping', 'pulse', 'marimba', 'none'] as const;
export type ReminderSoundId = (typeof REMINDER_SOUNDS)[number];

export const DEFAULT_REMINDER_SOUND: ReminderSoundId = 'chime';

/** Per-item reminder settings. */
export interface ReminderSettings {
  item: ReminderItemRef;
  /** Master switch; off keeps the choices below but fires nothing. */
  enabled: boolean;
  /** Notify at the start time itself. */
  atStart: boolean;
  /** Advance reminders, e.g. 1 day and 15 minutes before. Duplicates are removed. */
  offsets: ReminderOffset[];
  sound: ReminderSoundId;
  updatedAt: string;
}

/** PUT body for an item's settings (the item comes from the query). */
export interface UpdateReminderSettingsRequest {
  enabled: boolean;
  atStart: boolean;
  offsets: ReminderOffset[];
  sound: ReminderSoundId;
}

export interface ReminderSettingsResponse {
  /** null when the item has no reminder settings yet. */
  settings: ReminderSettings | null;
}

/**
 * One reminder firing for one occurrence. `key` is stable for that item,
 * occurrence and offset, so delivery is deduplicated and an OS-scheduled
 * notification can be replaced or canceled by it.
 */
export interface ReminderDue {
  key: string;
  item: ReminderItemRef;
  /** The item's title as the calendar shows it. */
  title: string;
  /** Calendar name, for the banner's second line. */
  calendarName: string | null;
  /** The occurrence's start (ISO instant). */
  startsAt: string;
  /** When this reminder fires (ISO instant): startsAt minus the offset. */
  fireAt: string;
  /** null = the at-start reminder. */
  offset: ReminderOffset | null;
  sound: ReminderSoundId;
}

/** GET /api/reminders/upcoming — reminders firing in the next window, for OS pre-scheduling. */
export interface UpcomingRemindersResponse {
  reminders: ReminderDue[];
  /** End of the window covered (ISO instant). */
  until: string;
}

/** Socket event the server emits to desktop clients when a reminder fires. */
export const REMINDER_DUE_EVENT = 'reminder:due' as const;

/** Socket event the server emits when upcoming reminders change (settings saved, item moved). */
export const REMINDERS_CHANGED_EVENT = 'reminders:changed' as const;

/**
 * Native OS notifications go through one small desktop-shell interface so
 * each platform plugs in separately. macOS is implemented first; Windows and
 * Linux report `supported: false` until they are, and the in-app banner (on
 * every platform) carries the reminder alone.
 */
export type NativeNotificationPlatform = 'macos' | 'windows' | 'linux';

export interface NativeNotificationStatus {
  platform: NativeNotificationPlatform;
  /** This platform has a native implementation. */
  supported: boolean;
  /** The user granted permission ('unknown' until asked). */
  permission: 'granted' | 'denied' | 'unknown';
  /** The platform can hold notifications scheduled ahead (fires while Snaglet is quit). */
  canSchedule: boolean;
}
