/**
 * Drag to create: press on empty grid and sweep a range, like Google
 * Calendar. Pure math: which slot the sweep covers, where its ghost pieces
 * sit in each day column, and the ghost's label.
 *
 * Timed sweeps count cells of the snap step (15 minutes at the default
 * zoom, 5 or 1 zoomed in): the pressed cell and the cell under the pointer
 * are both inside the range, so a 15-minute sweep up from 9:07 to 8:20 gives
 * 8:15 – 9:15. In Week and 3-day views a sweep may run into another day's
 * column; the end is then that day's time (a multi-day timed event), the way
 * Google does it. All-day sweeps count whole days of the band.
 */
import type { QuickAddSlot } from './QuickAddPopover';
import { addDays, formatClockRange, formatMinutes, weekdayShort } from './calendarDates';
import { SNAP_MIN } from './occurrenceMoves';

const DAY_MIN = 24 * 60;

type TimedSlot = Extract<QuickAddSlot, { kind: 'timed' }>;
type AllDaySlot = Extract<QuickAddSlot, { kind: 'all_day' }>;

/** A point on the time grid: a column of `days` and day minutes (unsnapped). */
export interface GridPoint {
  dayIndex: number;
  minutes: number;
}

function cellOf(point: GridPoint, days: number, step: number): number {
  const cells = DAY_MIN / step;
  const day = Math.min(Math.max(point.dayIndex, 0), days - 1);
  const cell = Math.min(Math.max(Math.floor(point.minutes / step), 0), cells - 1);
  return day * cells + cell;
}

/** The timed slot between the pressed point and the pointer (cells of `step` minutes, both inside). */
export function sweepTimed(
  days: readonly string[],
  from: GridPoint,
  to: GridPoint,
  step: number = SNAP_MIN
): TimedSlot {
  const cells = DAY_MIN / step;
  const a = cellOf(from, days.length, step);
  const b = cellOf(to, days.length, step);
  const first = Math.min(a, b);
  const end = Math.max(a, b) + 1; // exclusive
  const startDay = Math.floor(first / cells);
  // An end on a midnight belongs to the day before (24:00), not 0:00 next day.
  const endDay = Math.floor((end - 1) / cells);
  const slot: TimedSlot = {
    kind: 'timed',
    day: days[startDay]!,
    start: (first - startDay * cells) * step,
    end: (end - endDay * cells) * step,
  };
  if (endDay !== startDay) slot.endDay = days[endDay]!;
  return slot;
}

/** The all-day slot over band columns `from`..`to` (either order, both inside). */
export function sweepAllDay(days: readonly string[], from: number, to: number): AllDaySlot {
  const clamp = (i: number) => Math.min(Math.max(i, 0), days.length - 1);
  const first = clamp(Math.min(from, to));
  const last = clamp(Math.max(from, to));
  return { kind: 'all_day', startDate: days[first]!, endDate: addDays(days[last]!, 1) };
}

/** The column under `clientX`, clamped to the first / last (rects in viewport px). */
export function columnAtX(
  rects: ReadonlyArray<{ left: number; right: number }>,
  x: number
): number {
  if (rects.length === 0) return 0;
  for (let i = 0; i < rects.length; i++) if (x < rects[i].right) return i;
  return rects.length - 1;
}

/** One piece of a timed slot per day column it covers; the label sits on the first. */
export function timedPieces(
  slot: TimedSlot,
  days: readonly string[]
): Map<string, { start: number; end: number; first: boolean }> {
  const out = new Map<string, { start: number; end: number; first: boolean }>();
  const last = slot.endDay ?? slot.day;
  for (const day of days) {
    if (day < slot.day || day > last) continue;
    out.set(day, {
      start: day === slot.day ? slot.start : 0,
      end: day === last ? slot.end : DAY_MIN,
      first: day === slot.day,
    });
  }
  return out;
}

/** "9:00 – 10:30 AM"; "11:30 AM – 12:30 PM"; across days "Mon 9 PM – Tue 1 AM". */
export function sweepLabel(slot: TimedSlot): string {
  if (slot.endDay && slot.endDay !== slot.day) {
    return `${weekdayShort(slot.day)} ${formatMinutes(slot.start)} – ${weekdayShort(slot.endDay)} ${formatMinutes(slot.end)}`;
  }
  return formatClockRange(slot.start, slot.end);
}

export function sameSlot(a: QuickAddSlot, b: QuickAddSlot): boolean {
  if (a.kind === 'timed' && b.kind === 'timed') {
    return a.day === b.day && a.start === b.start && a.end === b.end && a.endDay === b.endDay;
  }
  if (a.kind === 'all_day' && b.kind === 'all_day') {
    return a.startDate === b.startDate && a.endDate === b.endDate;
  }
  return false;
}
