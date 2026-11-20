/**
 * Values of custom-table date fields with an end (`range`).
 * On the wire a range is an ISO 8601
 * interval, `start/end`, and always a string:
 *
 * - date range: `2026-10-12/2026-10-15`, the end INCLUSIVE (the 12th through
 *   the 15th). Stored as `daterange(start, end + 1, '[)')`.
 * - datetime range: `<instant>/<instant>`, the end the instant it stops.
 *   Stored as `tstzrange(start, end, '[)')`; instants follow
 *   {@link tableDateTimeToUtc} (no offset = wall-clock time in `timeZone`).
 *
 * A range field may hold a single day or instant: written without `/` (or
 * with the end equal to the start), it reads back without `/`.
 */
import { tableDateTimeToUtc } from './tableDateTime';

export type TableDateRangeKind = 'date' | 'datetime';

export interface TableDateRange {
  /** `YYYY-MM-DD`, or a canonical UTC instant for datetime ranges. */
  start: string;
  /** Same form as `start`; null for a single day or instant. */
  end: string | null;
}

export type TableDateRangeParse =
  | { ok: true; range: TableDateRange }
  | { ok: false; problem: string };

function isDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  if (!year || !month || !day || month > 12) return false;
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return day <= (days[month - 1] ?? 0);
}

function part(
  text: string,
  kind: TableDateRangeKind,
  timeZone: string,
  which: 'start' | 'end'
): { ok: true; value: string } | { ok: false; problem: string } {
  const value = text.trim();
  if (!value) return { ok: false, problem: `The range's ${which} is empty.` };
  if (kind === 'date') {
    return isDate(value)
      ? { ok: true, value }
      : { ok: false, problem: `The range's ${which} must be a date like 2026-10-12.` };
  }
  const utc = tableDateTimeToUtc(value, timeZone);
  return utc
    ? { ok: true, value: utc }
    : {
        ok: false,
        problem: `The range's ${which} must be a date and time like 2026-10-12T09:00.`,
      };
}

/**
 * Parse a range field's value into its canonical parts. Both parts use the
 * same canonical form, so they compare as strings.
 */
export function parseTableDateRange(
  value: string,
  kind: TableDateRangeKind,
  timeZone: string
): TableDateRangeParse {
  const pieces = value.split('/');
  if (pieces.length > 2)
    return { ok: false, problem: 'Write a range as start/end, with one slash.' };
  const start = part(pieces[0] ?? '', kind, timeZone, 'start');
  if (!start.ok) return start;
  if (pieces.length === 1) return { ok: true, range: { start: start.value, end: null } };
  const end = part(pieces[1] ?? '', kind, timeZone, 'end');
  if (!end.ok) return end;
  if (end.value < start.value) return { ok: false, problem: 'The end is before the start.' };
  return {
    ok: true,
    range: { start: start.value, end: end.value === start.value ? null : end.value },
  };
}

/** The wire form of a parsed range: `start/end`, or `start` alone for a single value. */
export function formatTableDateRange(range: TableDateRange): string {
  return range.end === null ? range.start : `${range.start}/${range.end}`;
}

/** `value` in canonical wire form, or null when it is not a valid range of `kind`. */
export function tableDateRangeToCanonical(
  value: string,
  kind: TableDateRangeKind,
  timeZone: string
): string | null {
  const parsed = parseTableDateRange(value, kind, timeZone);
  return parsed.ok ? formatTableDateRange(parsed.range) : null;
}
