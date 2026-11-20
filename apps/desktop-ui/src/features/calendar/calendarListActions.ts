/**
 * Calendar list writes from the sidebar: create, rename, color,
 * reorder, and the Default calendar a "Default calendar (new)" pick makes.
 * Each patches the shared store from the server's reply.
 */
import {
  CALENDAR_TITLE_MAX_LENGTH,
  DEFAULT_CALENDAR_TITLE,
  type Calendar,
  type CalendarColor,
} from '@snaglet/shared/types';
import { calendarApi } from './calendarApi';
import { markOwnWrite } from './calendarRealtime';
import {
  getCalendarsSnapshot,
  loadCalendars,
  setCalendarsOrder,
  upsertCalendar,
} from './calendarStore';
import { isConflict, reportWriteError } from './eventActions';

function failed(err: unknown, fallback: string) {
  reportWriteError(err, fallback);
  if (isConflict(err)) void loadCalendars();
}

export async function createCalendar(title: string): Promise<Calendar | null> {
  const clean = title.trim().slice(0, CALENDAR_TITLE_MAX_LENGTH);
  if (!clean) return null;
  try {
    const { calendar } = await calendarApi.createCalendar({ title: clean });
    markOwnWrite(`calendar:${calendar.id}`);
    upsertCalendar(calendar);
    return calendar;
  } catch (err) {
    failed(err, "Couldn't create the calendar");
    return null;
  }
}

let defaultInFlight: Promise<Calendar> | null = null;

/**
 * The calendar a "Default calendar (new)" pick lands on: the Default one if
 * the list has calendars by now (else its first), otherwise a new one titled
 * Default calendar (with none left, the first calendar is the Default).
 * Picks made while that create is in flight share it, so two quick moves
 * never make two calendars. Rejects when the create fails.
 */
export function ensureDefaultCalendar(): Promise<Calendar> {
  const list = getCalendarsSnapshot().calendars ?? [];
  const existing = list.find((c) => c.isDefault) ?? list[0];
  if (existing) return Promise.resolve(existing);
  defaultInFlight ??= calendarApi
    .createCalendar({ title: DEFAULT_CALENDAR_TITLE })
    .then(({ calendar }) => {
      markOwnWrite(`calendar:${calendar.id}`);
      upsertCalendar(calendar);
      return calendar;
    })
    .finally(() => {
      defaultInFlight = null;
    });
  return defaultInFlight;
}

export async function renameCalendar(calendar: Calendar, title: string): Promise<boolean> {
  const clean = title.trim().slice(0, CALENDAR_TITLE_MAX_LENGTH);
  if (!clean || clean === calendar.title) return true;
  try {
    markOwnWrite(`calendar:${calendar.id}`);
    const { calendar: saved } = await calendarApi.updateCalendar(calendar.id, {
      title: clean,
      expectedRevision: calendar.revision,
    });
    upsertCalendar(saved);
    return true;
  } catch (err) {
    failed(err, "Couldn't rename the calendar");
    return false;
  }
}

export async function recolorCalendar(
  calendar: Calendar,
  color: CalendarColor | null
): Promise<void> {
  if (color === calendar.color) return;
  try {
    markOwnWrite(`calendar:${calendar.id}`);
    const { calendar: saved } = await calendarApi.updateCalendar(calendar.id, {
      color,
      expectedRevision: calendar.revision,
    });
    upsertCalendar(saved);
  } catch (err) {
    failed(err, "Couldn't change the color");
  }
}

export async function reorderCalendars(ids: string[]): Promise<void> {
  const before = (getCalendarsSnapshot().calendars ?? []).map((c) => c.id);
  setCalendarsOrder(ids); // optimistic
  try {
    const { calendars } = await calendarApi.reorderCalendars({ calendarIds: ids });
    for (const c of calendars) upsertCalendar(c);
  } catch (err) {
    setCalendarsOrder(before);
    failed(err, "Couldn't reorder calendars");
  }
}

/** Move `id` to `toIndex` among `ids` (pure). */
export function moveId(ids: readonly string[], id: string, toIndex: number): string[] {
  const rest = ids.filter((x) => x !== id);
  const at = Math.max(0, Math.min(toIndex, rest.length));
  return [...rest.slice(0, at), id, ...rest.slice(at)];
}
