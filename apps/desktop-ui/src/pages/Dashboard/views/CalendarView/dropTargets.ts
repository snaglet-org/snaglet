/**
 * Where a dragged item would land. Grids mark their drop zones with data
 * attributes; this module reads the zone under the pointer and returns the
 * occurrence's new time, or null for an invalid drop.
 *
 *   [data-cal-drop="timed"][data-cal-day]   Week / Day column (minutes from y)
 *   [data-cal-drop="allday"][data-cal-day]  Week / Day all-day band cell
 *   [data-cal-drop="month"][data-cal-day]   Month day cell
 *
 * Minutes come from `minutesAtY` (a ratio of the column's viewport rect), so
 * the pane's CSS zoom never enters the math. A drag never changes an item
 * between timed and all-day. An event's resized edge stays on its own day; a
 * range row's edges may land on other days.
 */
import type { CalendarOccurrenceTime } from '@snaglet/shared/types';
import {
  addDays,
  diffDays,
  instantToZoned,
  lastZonedDate,
  zonedToInstant,
} from '@desktop/features/calendar/calendarDates';
import {
  minutesAtY,
  moveAllDayTo,
  moveTimedTo,
  moveToDay,
  resizeAllDayEnd,
  resizeTimed,
  SNAP_MIN,
} from '@desktop/features/calendar/occurrenceMoves';

export type DragKind = 'move' | 'resize-start' | 'resize-end';

export interface DropZone {
  kind: 'timed' | 'allday' | 'month';
  day: string;
  el: HTMLElement;
}

export function zoneAt(
  root: HTMLElement | null,
  clientX: number,
  clientY: number
): DropZone | null {
  if (!root || typeof document.elementsFromPoint !== 'function') return null;
  for (const el of document.elementsFromPoint(clientX, clientY)) {
    if (!(el instanceof HTMLElement) || !root.contains(el)) continue;
    const zone = el.closest<HTMLElement>('[data-cal-drop][data-cal-day]');
    if (!zone || !root.contains(zone)) continue;
    const kind = zone.dataset.calDrop as DropZone['kind'];
    if (kind !== 'timed' && kind !== 'allday' && kind !== 'month') continue;
    return { kind, day: zone.dataset.calDay!, el: zone };
  }
  return null;
}

/** Where on the item the pointer grabbed it, so the item doesn't jump to the pointer. */
export interface Grab {
  /** Timed: ms from the item's start to the pointer. */
  ms: number;
  /** All-day: days from the item's first day to the grabbed day. */
  days: number;
}

export function grabOf(
  time: CalendarOccurrenceTime,
  zone: DropZone | null,
  clientY: number,
  timeZone: string
): Grab {
  if (!zone) return { ms: 0, days: 0 };
  if (time.kind === 'all_day') {
    return { ms: 0, days: Math.max(0, diffDays(zone.day, time.startDate)) };
  }
  if (zone.kind !== 'timed') return { ms: 0, days: 0 };
  const minutes = minutesAtY(clientY, zone.el.getBoundingClientRect());
  const pointer = Date.parse(zonedToInstant(zone.day, minutes, timeZone));
  return { ms: Math.max(0, pointer - Date.parse(time.start)), days: 0 };
}

/**
 * The new time for a drop on `zone`, or null when it can't land there.
 * `acrossDays`: a range row, whose resized edges may land on other days.
 * `step`: the snap in minutes for a timed drop.
 */
export function resolveDrop(
  time: CalendarOccurrenceTime,
  kind: DragKind,
  zone: DropZone | null,
  clientY: number,
  grab: Grab,
  timeZone: string,
  acrossDays = false,
  step: number = SNAP_MIN
): CalendarOccurrenceTime | null {
  if (!zone) return null;
  if (kind !== 'move') {
    if (time.kind === 'all_day') {
      if (kind !== 'resize-end' || zone.kind === 'timed' || zone.day < time.startDate) return null;
      return resizeAllDayEnd(time, zone.day);
    }
    if (zone.kind !== 'timed') return null;
    const startDay = instantToZoned(time.start, timeZone).date;
    const endDay = lastZonedDate(time.start, time.end, timeZone);
    if (acrossDays) {
      if (kind === 'resize-end' ? zone.day < startDay : zone.day > endDay) return null;
    } else if (zone.day !== (kind === 'resize-start' ? startDay : endDay)) return null;
    const minutes = minutesAtY(clientY, zone.el.getBoundingClientRect());
    return resizeTimed(
      time,
      kind === 'resize-start' ? 'start' : 'end',
      minutes,
      timeZone,
      zone.day,
      step
    );
  }
  if (time.kind === 'all_day') {
    if (zone.kind === 'timed') return null;
    return moveAllDayTo(time, addDays(zone.day, -grab.days));
  }
  if (zone.kind === 'allday') return null;
  if (zone.kind === 'month') return moveToDay(time, zone.day, timeZone);
  const minutes = minutesAtY(clientY, zone.el.getBoundingClientRect());
  const pointer = Date.parse(zonedToInstant(zone.day, minutes, timeZone));
  const start = instantToZoned(new Date(pointer - grab.ms).toISOString(), timeZone);
  return moveTimedTo(time, start.date, start.minutes, timeZone, step);
}
