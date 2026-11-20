/**
 * Reminder wording and frame parsing: the banner's second line ("Starts in
 * 15 minutes", "Starting now") and the `reminder:due` / `reminders:changed`
 * socket frames read from untrusted JSON.
 */
import {
  DEFAULT_REMINDER_SOUND,
  REMINDER_DUE_EVENT,
  REMINDER_SOUNDS,
  REMINDER_UNITS,
  REMINDERS_CHANGED_EVENT,
  type ReminderDue,
  type ReminderOffset,
  type ReminderSoundId,
} from '@snaglet/shared/types';
import { parseReminderItem } from './nativeNotifications';

const UNIT_MS = { minutes: 60_000, hours: 3_600_000, days: 86_400_000 } as const;

/** "15 minutes", "1 hour", "2 days". */
export function formatOffset(offset: ReminderOffset): string {
  const unit = offset.amount === 1 ? offset.unit.replace(/s$/, '') : offset.unit;
  return `${offset.amount} ${unit}`;
}

/** A duration in the largest whole unit that fits: "45 minutes", "2 hours". */
function roughDuration(ms: number): string {
  const minutes = Math.max(1, Math.round(ms / UNIT_MS.minutes));
  if (minutes < 60) return formatOffset({ amount: minutes, unit: 'minutes' });
  const hours = Math.round(ms / UNIT_MS.hours);
  if (hours < 24) return formatOffset({ amount: hours, unit: 'hours' });
  return formatOffset({ amount: Math.round(ms / UNIT_MS.days), unit: 'days' });
}

/**
 * The banner's lead: the reminder's own offset when it arrives on time,
 * else the real time left (a reminder delivered late, e.g. after sleep).
 */
export function reminderLead(due: ReminderDue, now: number = Date.now()): string {
  const left = Date.parse(due.startsAt) - now;
  if (Number.isNaN(left))
    return due.offset ? `Starts in ${formatOffset(due.offset)}` : 'Starting now';
  if (left <= 30_000) {
    return left < -90_000 ? `Started ${roughDuration(-left)} ago` : 'Starting now';
  }
  const onTime = Math.abs(Date.parse(due.fireAt) - now) < 90_000;
  if (due.offset && onTime) return `Starts in ${formatOffset(due.offset)}`;
  return `Starts in ${roughDuration(left)}`;
}

function parseOffset(value: unknown): ReminderOffset | null | undefined {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'object') return undefined;
  const v = value as { amount?: unknown; unit?: unknown };
  if (typeof v.amount !== 'number' || !Number.isInteger(v.amount) || v.amount < 1) return undefined;
  if (!(REMINDER_UNITS as readonly unknown[]).includes(v.unit)) return undefined;
  return { amount: v.amount, unit: v.unit as ReminderOffset['unit'] };
}

/** A {@link ReminderDue} from a frame payload (bare, or wrapped as `{ reminder }`). */
export function parseReminderDue(payload: unknown): ReminderDue | null {
  if (!payload || typeof payload !== 'object') return null;
  const wrapped = (payload as { reminder?: unknown }).reminder;
  const p = (wrapped && typeof wrapped === 'object' ? wrapped : payload) as Record<string, unknown>;
  const item = parseReminderItem(p.item);
  const offset = parseOffset(p.offset);
  if (
    !item ||
    offset === undefined ||
    typeof p.key !== 'string' ||
    typeof p.startsAt !== 'string' ||
    typeof p.fireAt !== 'string'
  ) {
    return null;
  }
  const sound = (REMINDER_SOUNDS as readonly unknown[]).includes(p.sound)
    ? (p.sound as ReminderSoundId)
    : DEFAULT_REMINDER_SOUND;
  return {
    key: p.key,
    item,
    title: typeof p.title === 'string' && p.title.trim() ? p.title : 'Untitled',
    calendarName: typeof p.calendarName === 'string' && p.calendarName ? p.calendarName : null,
    startsAt: p.startsAt,
    fireAt: p.fireAt,
    offset,
    sound,
  };
}

/** Frame names in both the colon and dotted spellings (the calendar does the same). */
export function isReminderDueFrame(type: unknown): boolean {
  return type === REMINDER_DUE_EVENT || type === 'reminder.due';
}

export function isRemindersChangedFrame(type: unknown): boolean {
  return type === REMINDERS_CHANGED_EVENT || type === 'reminders.changed';
}
