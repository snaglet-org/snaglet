/**
 * Wall-date helpers for the repeat UI (the row's Repeat section, the
 * advance toast, the date popover's dots): field-wise parsing and
 * formatting that never passes through a time zone or UTC midnight, the
 * "All upcoming" guard, and the days a month holds a repeat's next
 * occurrences on. The repeat editor's model and sentences live in
 * `@snaglet/shared/utils` (tableRepeatSpec).
 *
 * Dates are wall values (`YYYY-MM-DD` or `YYYY-MM-DDTHH:MM:SS`).
 */

import {
  isTableRepeatUpcoming,
  tableRepeatIntervalOccurrences,
  tableRepeatIntervalSeconds,
  type TableRepeat,
  type TableRepeatWeekday,
} from '@snaglet/shared/utils';
import { addDays, zonedToInstant } from '@desktop/features/calendar/calendarDates';
import type { OccurrenceLogRow } from '@desktop/utils/api/tableRepeats';

type Weekday = TableRepeatWeekday;

const WEEKDAYS: readonly Weekday[] = ['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU'];
const WEEKDAY_SHORT: Record<Weekday, string> = {
  MO: 'Mon',
  TU: 'Tue',
  WE: 'Wed',
  TH: 'Thu',
  FR: 'Fri',
  SA: 'Sat',
  SU: 'Sun',
};
const MONTH_SHORT = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
];

interface WallParts {
  year: number;
  month: number; // 1–12
  day: number;
  hour: number | null;
  minute: number;
  weekday: Weekday;
}

const WALL = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2}))?)?/;

function daysInMonth(year: number, month: number): number {
  const d = new Date(0);
  d.setUTCFullYear(year, month, 0);
  return d.getUTCDate();
}

/** Field-wise parse; the helper Date only names the weekday of that calendar date. */
export function wallParts(wall: string): WallParts | null {
  const m = WALL.exec(wall);
  if (!m) return null;
  const [year, month, day] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)) return null;
  const clock = new Date(0);
  clock.setUTCFullYear(year, month - 1, day);
  return {
    year,
    month,
    day,
    hour: m[4] === undefined ? null : Number(m[4]),
    minute: m[5] === undefined ? 0 : Number(m[5]),
    weekday: WEEKDAYS[(clock.getUTCDay() + 6) % 7]!,
  };
}

function clockText(hour: number, minute: number): string {
  const h = hour % 12 === 0 ? 12 : hour % 12;
  return `${h}:${String(minute).padStart(2, '0')} ${hour < 12 ? 'AM' : 'PM'}`;
}

/** "Mon, Oct 12, 2026" / "Mon, Oct 12, 2026, 9:05 AM". Options drop the weekday or year. */
export function formatWallDate(
  wall: string,
  options: { weekday?: boolean; year?: boolean; time?: boolean } = {}
): string {
  const p = wallParts(wall);
  if (!p) return wall;
  const { weekday = true, year = true, time = true } = options;
  let out = `${MONTH_SHORT[p.month - 1]} ${p.day}`;
  if (weekday) out = `${WEEKDAY_SHORT[p.weekday]}, ${out}`;
  if (year) out += `, ${p.year}`;
  if (time && p.hour !== null) out += `, ${clockText(p.hour, p.minute)}`;
  return out;
}

const FIXED_DAY_PARTS = ['BYMONTHDAY', 'BYYEARDAY', 'BYWEEKNO', 'BYSETPOS', 'BYMONTH'];

/**
 * Whether "All upcoming" can move the series by days. Mirrors the server's
 * `shiftRuleByDays` (`packages/db/tables/table_entries/repeats.ts`).
 */
export function canShiftAllUpcoming(rrule: string): { ok: true } | { ok: false; reason: string } {
  const parts = new Map(
    rrule
      .replace(/^RRULE:/i, '')
      .split(';')
      .map((part) => part.split('=') as [string, string])
      .map(([key, value]) => [key.trim().toUpperCase(), (value ?? '').trim().toUpperCase()])
  );
  if (FIXED_DAY_PARTS.some((key) => parts.has(key)))
    return {
      ok: false,
      reason:
        'This repeat is pinned to fixed days, so it can’t move by days. Edit the repeat instead.',
    };
  const byday = parts.get('BYDAY');
  if (byday && byday.split(',').some((d) => !WEEKDAYS.includes(d as Weekday)))
    return {
      ok: false,
      reason:
        'This repeat is pinned to a numbered weekday, so it can’t move by days. Edit the repeat instead.',
    };
  return { ok: true };
}

/** Most of an interval's times one day is asked for: enough to see past the current one and a moved one. */
const INTERVAL_DAY_LIMIT = 3;

/**
 * The days of `month` (its first day, `YYYY-MM-01`) that hold one of the
 * repeat's next occurrences, the ones after its current one: the dots in
 * the date popover's month. The shared engine answers day by day for that
 * month only, so an end date ends the dots, and a far month costs what this
 * one does. An interval dots a day with any of its times on it. An upcoming
 * one moved by hand (a calendar drag, in `log`) dots where it went.
 */
export function repeatDaysInMonth(
  repeat: TableRepeat,
  month: string,
  log: readonly Pick<OccurrenceLogRow, 'kind' | 'occurrence' | 'movedTo'>[] = []
): Set<string> {
  const days = new Set<string>();
  const ym = month.slice(0, 7);
  const after = (wall: string) => wall > repeat.current;
  // A live move is the only one logged for its occurrence (a new one replaces it).
  const moved = new Set<string>();
  for (const row of log) {
    if (row.kind !== 'moved' || !row.movedTo || !after(row.occurrence)) continue;
    moved.add(row.occurrence);
    if (row.movedTo.startsWith(ym)) days.add(row.movedTo.slice(0, 10));
  }
  const kept = (wall: string) => after(wall) && !moved.has(wall);
  const first = repeat.current.slice(0, 10);
  const interval = tableRepeatIntervalSeconds(repeat.rrule) !== null;
  // Set days keep the start's time of day (a rule has no BYHOUR).
  const time = repeat.dtstart.slice(10);
  for (let day = `${ym}-01`; day.startsWith(ym); day = addDays(day, 1)) {
    if (day < first) continue;
    if (!interval) {
      const wall = `${day}${time}`;
      if (kept(wall) && isTableRepeatUpcoming(repeat, wall)) days.add(day);
      continue;
    }
    const on = intervalOn(repeat, day, kept);
    if (on === null) return days;
    if (on) days.add(day);
  }
  return days;
}

/**
 * Whether an interval repeat has a `kept` time on `day` in its zone, or
 * null when it can't say (a zone this runtime doesn't know: no dots then).
 */
function intervalOn(
  repeat: TableRepeat,
  day: string,
  kept: (wall: string) => boolean
): boolean | null {
  try {
    const found = tableRepeatIntervalOccurrences(repeat, {
      from: zonedToInstant(day, 0, repeat.tz),
      to: zonedToInstant(addDays(day, 1), 0, repeat.tz),
      limit: INTERVAL_DAY_LIMIT,
    });
    if (!found.ok) return null;
    return found.value.truncated || found.value.occurrences.some(kept);
  } catch {
    return null;
  }
}
