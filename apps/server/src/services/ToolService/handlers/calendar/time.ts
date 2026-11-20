/**
 * Calendar-tool time helpers. Dates are calendar dates (`YYYY-MM-DD`) and
 * never pass through UTC midnight; date-times are instants, read in a named
 * zone when they carry no offset, and shown back as ISO with the zone's
 * offset (`2026-10-15T09:00:00-07:00`).
 */
import { CALENDAR_OCCURRENCES_MAX_DAYS } from '@snaglet/shared/types';
import {
  instantToWallTime,
  isKnownTimeZone,
  parseTableDateTime,
  tableDateTimeLocalDate,
  tableDateTimeToUtc,
} from '@snaglet/shared/utils';
import { badInput } from '@server/services/ToolService/tools/database/_shared/input';

export const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 86_400_000;

function dateMs(date: string): number {
  return Date.UTC(
    Number(date.slice(0, 4)),
    Number(date.slice(5, 7)) - 1,
    Number(date.slice(8, 10))
  );
}

export function addDays(date: string, days: number): string {
  return new Date(dateMs(date) + days * DAY_MS).toISOString().slice(0, 10);
}

/** Windows of at most CALENDAR_OCCURRENCES_MAX_DAYS covering from..to (inclusive), `to` exclusive in each. */
export function windows(from: string, to: string): Array<{ from: string; to: string }> {
  const out: Array<{ from: string; to: string }> = [];
  const end = addDays(to, 1);
  for (let start = from; start < end; ) {
    const next = addDays(start, CALENDAR_OCCURRENCES_MAX_DAYS);
    const stop = next < end ? next : end;
    out.push({ from: start, to: stop });
    start = stop;
  }
  return out;
}

/** Whole days from `from` to `to`. */
export function dayDiff(from: string, to: string): number {
  return Math.round((dateMs(to) - dateMs(from)) / DAY_MS);
}

/** The Monday on or before `date`. */
export function mondayOf(date: string): string {
  const weekday = new Date(dateMs(date)).getUTCDay();
  return addDays(date, -((weekday + 6) % 7));
}

/** Today's date in `tz`. */
export function todayIn(tz: string, now: Date = new Date()): string {
  return tableDateTimeLocalDate(now.toISOString(), tz) ?? now.toISOString().slice(0, 10);
}

/** A real calendar date, or a 400 naming `name`. */
export function dateInput(value: unknown, name: string): string {
  if (typeof value !== 'string' || !DATE_ONLY.test(value) || !parseTableDateTime(value))
    throw badInput(`${name} must be a date (YYYY-MM-DD)`);
  return value;
}

/** A known IANA zone name, or undefined when not given. */
export function zoneInput(value: unknown, name = 'tz'): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string' || !isKnownTimeZone(value))
    throw badInput(`${name} must be a known IANA time zone, e.g. America/New_York`);
  return value;
}

/**
 * A date-time as an ISO instant (`…Z`): with an offset it is that instant,
 * without one it is wall time in `tz`. A bare date is refused (callers that
 * accept one check DATE_ONLY first).
 */
export function instantInput(value: unknown, tz: string, name: string): string {
  if (typeof value !== 'string' || DATE_ONLY.test(value))
    throw badInput(`${name} must be a date and time, e.g. 2026-10-15T09:00`);
  const withSeconds = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value) ? `${value}:00` : value;
  const utc = tableDateTimeToUtc(withSeconds, tz);
  if (!utc) throw badInput(`${name} must be a date and time, e.g. 2026-10-15T09:00`);
  return new Date(utc).toISOString();
}

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

/** `instant` as the wall time in `tz` with that zone's offset, to the second. */
export function isoInZone(instant: string, tz: string): string {
  const at = new Date(instant);
  const wall = instantToWallTime(at, tz);
  const offsetMinutes = Math.round(
    (Date.parse(`${wall}Z`) - Math.floor(at.getTime() / 1000) * 1000) / 60_000
  );
  const sign = offsetMinutes < 0 ? '-' : '+';
  const abs = Math.abs(offsetMinutes);
  return `${wall}${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}
