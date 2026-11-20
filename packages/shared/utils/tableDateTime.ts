/**
 * Values of custom-table `datetime` fields. Writes take ISO 8601: a date and
 * time with an offset (`Z`, `±HH:MM`, `±HHMM` or `±HH`), a date and time
 * without one (wall-clock time in the user's time zone), or a bare date
 * (midnight there). They are stored as UTC `timestamptz` and read back as
 * {@link tableDateTimeToUtc}'s canonical form.
 */

const ISO_DATE_TIME =
  /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,6}))?)?(Z|[+-]\d{2}(?::?\d{2})?)?)?$/;

/** IANA names only, so the zone can be embedded in SQL as a literal. */
const ZONE_NAME = /^[A-Za-z][A-Za-z0-9_+\-/]*$/;
const DAY_MS = 86_400_000;

export interface ParsedTableDateTime {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  /** Fractional seconds as six digits. */
  micros: string;
  /** Minutes east of UTC; null when the value is wall-clock time. */
  offsetMinutes: number | null;
}

/**
 * The user's IANA time zone: the Snaglet process's local zone, as
 * `get_current_datetime` reports it (in the desktop app, the zone of the
 * machine Snaglet runs on). Falls back to UTC.
 */
export function userTimeZone(): string {
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  return typeof zone === 'string' && ZONE_NAME.test(zone) ? zone : 'UTC';
}

function wallMs(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  second: number
): number {
  // setUTCFullYear keeps years 0–99 literal, unlike Date.UTC.
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  date.setUTCHours(hour, minute, second, 0);
  return date.getTime();
}

/** A syntactically valid ISO 8601 value with in-range parts, or null. */
export function parseTableDateTime(value: string): ParsedTableDateTime | null {
  const match = ISO_DATE_TIME.exec(value);
  if (!match) return null;
  const part = (index: number) => Number(match[index] ?? '0');
  const [year, month, day, hour, minute, second] = [1, 2, 3, 4, 5, 6].map(part) as [
    number,
    number,
    number,
    number,
    number,
    number,
  ];
  if (year < 1 || hour > 23 || minute > 59 || second > 59) return null;
  const calendar = new Date(wallMs(year, month, day, 0, 0, 0));
  if (calendar.getUTCMonth() !== month - 1 || calendar.getUTCDate() !== day) return null;
  const zone = match[8];
  let offsetMinutes: number | null = null;
  if (zone === 'Z') offsetMinutes = 0;
  else if (zone) {
    const digits = zone.slice(1).replace(':', '');
    const hours = Number(digits.slice(0, 2));
    const minutes = Number(digits.slice(2) || '0');
    if (hours > 15 || minutes > 59) return null;
    offsetMinutes = (zone.startsWith('-') ? -1 : 1) * (hours * 60 + minutes);
  }
  return {
    year,
    month,
    day,
    hour,
    minute,
    second,
    micros: (match[7] ?? '').padEnd(6, '0'),
    offsetMinutes,
  };
}

export function isTableDateTime(value: unknown): value is string {
  return typeof value === 'string' && parseTableDateTime(value) !== null;
}

const zoneFormatters = new Map<string, Intl.DateTimeFormat>();

function zoneFormatter(timeZone: string): Intl.DateTimeFormat {
  let formatter = zoneFormatters.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      era: 'short',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
    });
    zoneFormatters.set(timeZone, formatter);
  }
  return formatter;
}

/** The zone's wall clock at `instant`, as milliseconds of a UTC clock. */
function zoneWall(instant: number, timeZone: string): number {
  const parts: Record<string, string> = {};
  for (const part of zoneFormatter(timeZone).formatToParts(new Date(instant)))
    parts[part.type] = part.value;
  const year = Number(parts.year);
  return wallMs(
    parts.era === 'BC' ? 1 - year : year,
    Number(parts.month),
    Number(parts.day),
    Number(parts.hour) % 24,
    Number(parts.minute),
    Number(parts.second)
  );
}

/** Milliseconds the zone is ahead of UTC at `instant`. */
function zoneOffset(instant: number, timeZone: string): number {
  return zoneWall(instant, timeZone) - Math.floor(instant / 1000) * 1000;
}

/**
 * The instant a wall-clock time names in `timeZone`. Transitions resolve as
 * PostgreSQL resolves them, so SQL conversions agree: a time repeated by a
 * fall-back takes the later offset, a time skipped by a spring-forward the
 * earlier one (02:30 becomes 03:30).
 */
function wallToInstant(wall: number, timeZone: string): number {
  const before = zoneOffset(wall - DAY_MS, timeZone);
  const after = zoneOffset(wall + DAY_MS, timeZone);
  const late = wall - after;
  return zoneOffset(late, timeZone) === after ? late : wall - before;
}

/**
 * Millisecond forms of the two conversions above, for engines that step in
 * absolute time (interval repeats): the zone's wall clock at `instant` (a
 * UTC clock's milliseconds, whole seconds), and the instant a wall clock
 * names (DST resolved as {@link wallToInstant} resolves it). Both throw a
 * RangeError for a zone the runtime doesn't know.
 */
export function tableZoneWallMs(instant: number, timeZone: string): number {
  return zoneWall(instant, timeZone);
}

export function tableWallMsToInstant(wall: number, timeZone: string): number {
  return wallToInstant(wall, timeZone);
}

function pad(value: number, width = 2): string {
  return String(value).padStart(width, '0');
}

/** The instant (whole seconds, in ms) of a valid value; the fraction is kept aside. */
function instantOf(parsed: ParsedTableDateTime, timeZone: string): number | null {
  const wall = wallMs(
    parsed.year,
    parsed.month,
    parsed.day,
    parsed.hour,
    parsed.minute,
    parsed.second
  );
  const instant =
    parsed.offsetMinutes === null
      ? wallToInstant(wall, timeZone)
      : wall - parsed.offsetMinutes * 60_000;
  const year = new Date(instant).getUTCFullYear();
  return year < 1 || year > 9999 ? null : instant;
}

function isoDate(clock: Date): string {
  return `${pad(clock.getUTCFullYear(), 4)}-${pad(clock.getUTCMonth() + 1)}-${pad(clock.getUTCDate())}`;
}

/**
 * `value` as the UTC instant it names, in the form entry reads return
 * (`2026-10-01T22:30:00.000000Z`), or null when it is not a valid ISO 8601
 * value within years 1–9999. Values without an offset are read in `timeZone`.
 */
export function tableDateTimeToUtc(value: string, timeZone: string): string | null {
  const parsed = parseTableDateTime(value);
  const instant = parsed && instantOf(parsed, timeZone);
  if (!parsed || instant === null) return null;
  const utc = new Date(instant);
  return `${isoDate(utc)}T${pad(utc.getUTCHours())}:${pad(utc.getUTCMinutes())}:${pad(utc.getUTCSeconds())}.${parsed.micros}Z`;
}

/** The calendar date (`YYYY-MM-DD`) `value` falls on in `timeZone`, or null when invalid. */
export function tableDateTimeLocalDate(value: string, timeZone: string): string | null {
  const parsed = parseTableDateTime(value);
  const instant = parsed && instantOf(parsed, timeZone);
  if (instant === null) return null;
  const wall = new Date(zoneWall(instant, timeZone));
  return wall.getUTCFullYear() < 1 ? null : isoDate(wall);
}
