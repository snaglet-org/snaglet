/**
 * Pure time math for moving and resizing occurrences: snapping (15
 * minutes at the default zoom; drags pass a finer step zoomed in), pointer
 * y → minutes, move / resize / keyboard shift, and the labels the drag
 * ghost, toasts and the live region use.
 *
 * Wall time is kept on moves (a 9 AM item dropped across a DST change stays
 * at 9 AM); the duration is kept in real minutes.
 */
import type { CalendarOccurrenceTime } from '@snaglet/shared/types';
import {
  addDays,
  diffDays,
  formatClockRange,
  formatMinutes,
  formatTimedRange,
  instantToZoned,
  longDayLabel,
  shortDayLabel,
  weekdayShort,
  zonedToInstant,
} from './calendarDates';
import { minDurationFor, snapMinutes } from './timeScale';

/** The snap step at the default zoom; drags pass the zoom's own. */
export const SNAP_MIN = 15;
/** The shortest a keyboard resize leaves an item. */
const MIN_DURATION_MIN = 15;
const DAY_MIN = 24 * 60;
const MINUTE_MS = 60_000;

/**
 * Day minutes under a pointer. `rect` is the day column's bounding rect, so
 * both values are viewport px and the pane's CSS zoom cancels out.
 */
export function minutesAtY(clientY: number, rect: { top: number; height: number }): number {
  if (rect.height <= 0) return 0;
  const ratio = (clientY - rect.top) / rect.height;
  return Math.min(Math.max(ratio, 0), 1) * DAY_MIN;
}

/** The real length, kept by a move (zoomed in, items may be shorter than 15 minutes). */
function durationMs(time: { start: string; end: string }): number {
  return Math.max(Date.parse(time.end) - Date.parse(time.start), MINUTE_MS);
}

function timedAt(day: string, minutes: number, lengthMs: number, timeZone: string) {
  const start = zonedToInstant(day, minutes, timeZone);
  return {
    kind: 'timed' as const,
    start,
    end: new Date(Date.parse(start) + lengthMs).toISOString(),
  };
}

/** A timed item dropped at `minutes` (snapped to `step`, kept inside the day) on `day`. */
export function moveTimedTo(
  time: Extract<CalendarOccurrenceTime, { kind: 'timed' }>,
  day: string,
  minutes: number,
  timeZone: string,
  step: number = SNAP_MIN
): Extract<CalendarOccurrenceTime, { kind: 'timed' }> {
  const start = Math.min(Math.max(snapMinutes(minutes, step), 0), DAY_MIN - step);
  return timedAt(day, start, durationMs(time), timeZone);
}

/** An all-day item dropped on `day`: same span. */
export function moveAllDayTo(
  time: Extract<CalendarOccurrenceTime, { kind: 'all_day' }>,
  day: string
): Extract<CalendarOccurrenceTime, { kind: 'all_day' }> {
  const span = Math.max(diffDays(time.endDate, time.startDate), 1);
  return { kind: 'all_day', startDate: day, endDate: addDays(day, span) };
}

/** Any item moved onto `day`, keeping its time of day (Month drops, "Move to…"). */
export function moveToDay(
  time: CalendarOccurrenceTime,
  day: string,
  timeZone: string
): CalendarOccurrenceTime {
  if (time.kind === 'all_day') return moveAllDayTo(time, day);
  const from = instantToZoned(time.start, timeZone);
  return timedAt(day, from.minutes, durationMs(time), timeZone);
}

/**
 * Drag one edge to `minutes` of `day` (default: the item's own start day;
 * a range row's edge may land on another day), snapped to `step`; min 15
 * minutes (5 when snapping finer).
 */
export function resizeTimed(
  time: Extract<CalendarOccurrenceTime, { kind: 'timed' }>,
  edge: 'start' | 'end',
  minutes: number,
  timeZone: string,
  day: string = instantToZoned(time.start, timeZone).date,
  step: number = SNAP_MIN
): Extract<CalendarOccurrenceTime, { kind: 'timed' }> {
  const startMs = Date.parse(time.start);
  const endMs = Date.parse(time.end);
  const snapped = snapMinutes(minutes, step);
  const shortest = minDurationFor(step) * MINUTE_MS;
  if (edge === 'end') {
    const end = Date.parse(zonedToInstant(day, snapped, timeZone));
    const clamped = Math.max(end, startMs + shortest);
    return { kind: 'timed', start: time.start, end: new Date(clamped).toISOString() };
  }
  const start = Date.parse(zonedToInstant(day, Math.max(snapped, 0), timeZone));
  const clamped = Math.min(start, endMs - shortest);
  return { kind: 'timed', start: new Date(clamped).toISOString(), end: time.end };
}

/** Drag an all-day item's right edge onto `day`: it then ends that day (at least one day). */
export function resizeAllDayEnd(
  time: Extract<CalendarOccurrenceTime, { kind: 'all_day' }>,
  day: string
): Extract<CalendarOccurrenceTime, { kind: 'all_day' }> {
  const last = day < time.startDate ? time.startDate : day;
  return { kind: 'all_day', startDate: time.startDate, endDate: addDays(last, 1) };
}

/** Keyboard resize of an all-day item: Alt+Shift+←/→ = end ±1 day, min one day. */
export function stretchAllDayEnd(
  time: Extract<CalendarOccurrenceTime, { kind: 'all_day' }>,
  days: number
): Extract<CalendarOccurrenceTime, { kind: 'all_day' }> {
  return resizeAllDayEnd(time, addDays(time.endDate, days - 1));
}

/** Keyboard moves: Alt+↑/↓ = ±15 min, Alt+←/→ = ±1 day. */
export function shiftTime(
  time: CalendarOccurrenceTime,
  by: { days?: number; minutes?: number },
  timeZone: string
): CalendarOccurrenceTime {
  const days = by.days ?? 0;
  if (time.kind === 'all_day') {
    return {
      kind: 'all_day',
      startDate: addDays(time.startDate, days),
      endDate: addDays(time.endDate, days),
    };
  }
  const from = instantToZoned(time.start, timeZone);
  let minutes = from.minutes + (by.minutes ?? 0);
  let day = addDays(from.date, days);
  while (minutes < 0) {
    minutes += DAY_MIN;
    day = addDays(day, -1);
  }
  while (minutes >= DAY_MIN) {
    minutes -= DAY_MIN;
    day = addDays(day, 1);
  }
  return timedAt(day, minutes, durationMs(time), timeZone);
}

/** Keyboard resize: Alt+Shift+↑/↓ = end ±15 min, min 15 minutes. */
export function stretchEnd(
  time: Extract<CalendarOccurrenceTime, { kind: 'timed' }>,
  minutes: number
): Extract<CalendarOccurrenceTime, { kind: 'timed' }> {
  const startMs = Date.parse(time.start);
  const end = Math.max(
    Date.parse(time.end) + minutes * MINUTE_MS,
    startMs + MIN_DURATION_MIN * MINUTE_MS
  );
  return { kind: 'timed', start: time.start, end: new Date(end).toISOString() };
}

/**
 * "Tue Oct 13, 10:15 AM" (toasts, live region) or, with `range`, the ghost
 * label "Tue 10:15 – 10:45 AM", "Fri 9 AM – Mon 5 PM" over several
 * days. All-day: "Tue Oct 13", "Tue Oct 13 – Thu Oct 15".
 */
export function describeTime(
  time: CalendarOccurrenceTime,
  timeZone: string,
  style: 'start' | 'range' = 'start'
): string {
  if (time.kind === 'all_day') {
    const last = addDays(time.endDate, -1);
    return last > time.startDate
      ? `${shortDayLabel(time.startDate)} – ${shortDayLabel(last)}`
      : shortDayLabel(time.startDate);
  }
  const start = instantToZoned(time.start, timeZone);
  if (style === 'start') return `${shortDayLabel(start.date)}, ${formatMinutes(start.minutes)}`;
  const end = instantToZoned(time.end, timeZone);
  // Past the next midnight (a range over several days): name both days.
  if (end.date > addDays(start.date, 1) || (end.date > start.date && end.minutes > 0))
    return `${weekdayShort(start.date)} ${formatMinutes(start.minutes)} – ${weekdayShort(end.date)} ${formatMinutes(end.minutes)}`;
  return `${weekdayShort(start.date)} ${formatClockRange(start.minutes, end.minutes)}`;
}

/**
 * The popovers' time line: "Tue Oct 13 · All day", "Tue Oct 13 – Thu Oct 15
 * · All day", "Tue Oct 13, 9:00 – 9:30 AM" (an end at the next midnight
 * still closes the start's day), or over several days "Fri Oct 16, 9 AM –
 * Mon Oct 19, 5 PM".
 */
export function describeSpan(time: CalendarOccurrenceTime, timeZone: string): string {
  if (time.kind === 'all_day') {
    const last = addDays(time.endDate, -1);
    if (last <= time.startDate) return `${longDayLabel(time.startDate)} · All day`;
    return `${shortDayLabel(time.startDate)} – ${shortDayLabel(last)} · All day`;
  }
  const s = instantToZoned(time.start, timeZone);
  const e = instantToZoned(time.end, timeZone);
  if (s.date === e.date) return formatTimedRange(s.date, s.minutes, e.minutes);
  if (e.minutes === 0 && e.date === addDays(s.date, 1))
    return formatTimedRange(s.date, s.minutes, DAY_MIN);
  return `${shortDayLabel(s.date)}, ${formatMinutes(s.minutes)} – ${shortDayLabel(e.date)}, ${formatMinutes(e.minutes)}`;
}

/** Same place? (No write for a drop back where it started.) */
export function sameTime(a: CalendarOccurrenceTime, b: CalendarOccurrenceTime): boolean {
  if (a.kind === 'timed' && b.kind === 'timed')
    return Date.parse(a.start) === Date.parse(b.start) && Date.parse(a.end) === Date.parse(b.end);
  if (a.kind === 'all_day' && b.kind === 'all_day')
    return a.startDate === b.startDate && a.endDate === b.endDate;
  return false;
}
