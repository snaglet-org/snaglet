/**
 * The days of a year worth marking, as the Year view circles them and the
 * calendar tool's `dates` op lists them: one set of rules so what an agent reads
 * is what the person sees. Input is the year's occurrences; days are plain
 * `YYYY-MM-DD` strings.
 */
import type { CalendarOccurrence } from '../types/calendar';

const DAY_MS = 86_400_000;

/** The day `n` days after `day`. */
function addDays(day: string, n: number): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);
}

/** A series with more occurrences than this in the year repeats too often to circle. */
export const FEW_A_YEAR = 12;
/** Longest span (days) one all-day item is marked over, so a long range doesn't circle a season. */
const MAX_SPAN_DAYS = 31;
/** The series an occurrence belongs to; automations have none (they are left out). */
function seriesKey(o: CalendarOccurrence): string | null {
  if (o.source === 'event') return `event:${o.eventId}`;
  if (o.source === 'row') return `row:${o.fieldId}:${o.entryId}`;
  return null;
}

const startOf = (o: CalendarOccurrence, dayOf: (instant: string) => string): string =>
  o.time.kind === 'all_day' ? o.time.startDate : dayOf(o.time.start);

/** Done and skipped sink; overdue, all-day, then timed by time. */
function order(a: CalendarOccurrence, b: CalendarOccurrence): number {
  const settled = (o: CalendarOccurrence) =>
    o.status === 'done' || o.status === 'skipped' ? 1 : 0;
  const clock = (o: CalendarOccurrence) =>
    o.time.kind === 'all_day' ? -1 : Date.parse(o.time.start);
  return settled(a) - settled(b) || clock(a) - clock(b);
}

/**
 * The items worth a circle in the Year view, by day: things that happen on a
 * date: a one-off event or row, and a repeat that only lands a few times a
 * year (every year, quarterly, twice a year). Something that repeats often
 * (daily, weekly) would circle every day and say nothing, so it is left out.
 * "Often" is counted from what the year
 * actually holds: a series with more than {@link FEW_A_YEAR} occurrences in it.
 * Done and skipped items sink; all-day come before timed ones.
 */
export function notableByDay(
  occurrences: readonly CalendarOccurrence[],
  /** The calendar day a timed instant falls on, in the zone being shown. */
  dayOf: (instant: string) => string
): Map<string, CalendarOccurrence[]> {
  const perSeries = new Map<string, number>();
  for (const o of occurrences) {
    const key = seriesKey(o);
    if (key) perSeries.set(key, (perSeries.get(key) ?? 0) + 1);
  }
  const byDay = new Map<string, CalendarOccurrence[]>();
  const add = (day: string, o: CalendarOccurrence) => {
    const list = byDay.get(day);
    if (list) list.push(o);
    else byDay.set(day, [o]);
  };
  for (const o of occurrences) {
    const key = seriesKey(o);
    if (!key || (perSeries.get(key) ?? 0) > FEW_A_YEAR) continue;
    if (o.time.kind === 'all_day') {
      const last = addDays(o.time.endDate, -1);
      let day = o.time.startDate;
      for (let n = 0; day <= last && n < MAX_SPAN_DAYS; n += 1) {
        add(day, o);
        day = addDays(day, 1);
      }
    } else {
      add(startOf(o, dayOf), o);
    }
  }
  for (const list of byDay.values()) list.sort(order);
  return byDay;
}
