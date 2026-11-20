/**
 * Day primitives shared by the recurrence engine (`tableRecurrence.ts`) and
 * the repeat editor model (`tableRepeatSpec.ts`): weekday codes, the units,
 * and whole-day math (day numbers, days in a month, a period's first day).
 *
 * Days are integers: days since 1970-01-01 on a UTC clock, so a day is
 * always a day and nothing passes through a time zone.
 */

export type TableRepeatUnit = 'day' | 'week' | 'month' | 'year';
export type TableRepeatWeekday = 'MO' | 'TU' | 'WE' | 'TH' | 'FR' | 'SA' | 'SU';

export const REPEAT_WEEKDAYS: readonly TableRepeatWeekday[] = [
  'MO',
  'TU',
  'WE',
  'TH',
  'FR',
  'SA',
  'SU',
];

const DAY_MS = 86_400_000;

// days

/** A `YYYY-MM-DD` date as a day number, or null when malformed or not a real date. */
export function dayOf(date: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(date);
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const clock = new Date(0);
  clock.setUTCFullYear(y, mo - 1, d);
  if (clock.getUTCFullYear() !== y || clock.getUTCMonth() !== mo - 1 || clock.getUTCDate() !== d)
    return null;
  return Math.round(clock.getTime() / DAY_MS);
}

export function dateOf(day: number): string {
  const clock = new Date(day * DAY_MS);
  const pad = (n: number, w = 2) => String(n).padStart(w, '0');
  return `${pad(clock.getUTCFullYear(), 4)}-${pad(clock.getUTCMonth() + 1)}-${pad(clock.getUTCDate())}`;
}

function parts(day: number): { year: number; month: number; date: number } {
  const clock = new Date(day * DAY_MS);
  return { year: clock.getUTCFullYear(), month: clock.getUTCMonth() + 1, date: clock.getUTCDate() };
}

/** Day number of `year`-`month`-`date` (month 1–12; overflow rolls over). */
function dayAt(year: number, month: number, date: number): number {
  const clock = new Date(0);
  clock.setUTCFullYear(year, month - 1, date);
  return Math.round(clock.getTime() / DAY_MS);
}

export function weekdayOfDay(day: number): TableRepeatWeekday {
  // 1970-01-01 was a Thursday.
  return REPEAT_WEEKDAYS[(((day + 3) % 7) + 7) % 7]!;
}

export function daysInMonthOf(day: number): number {
  const { year, month } = parts(day);
  return dayAt(year, month + 1, 0) - dayAt(year, month, 0);
}

/** The first day of the period of `unit` that contains `day` (weeks begin on Monday). */
export function periodStartOf(day: number, unit: TableRepeatUnit): number {
  if (unit === 'day') return day;
  if (unit === 'week') return day - REPEAT_WEEKDAYS.indexOf(weekdayOfDay(day));
  const { year, month } = parts(day);
  return unit === 'month' ? dayAt(year, month, 1) : dayAt(year, 1, 1);
}

// `parts`, `dayAt` and the weekday/day helpers above are what the recurrence
// engine and the editor model use.
