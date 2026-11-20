/**
 * Recurring dates on custom-table date and datetime fields: the pure engine.
 * No I/O, no DB.
 *
 * A repeating row stores a {@link TableRepeat} next to its date. The engine
 * works entirely in **wall-clock time**: occurrences are expanded as floating
 * local times (`YYYY-MM-DD` for date fields, `YYYY-MM-DDTHH:MM:SS` for
 * datetime fields), so "every Monday at 09:00" stays at 09:00 across DST.
 * Datetime columns convert a wall time to an instant in the row's snapshotted
 * `tz` only when writing the column ({@link repeatOccurrenceToColumn}).
 *
 * Series semantics (completion model A):
 * - `dtstart` is the fixed anchor and always the first occurrence, even when
 *   it doesn't match the rule. COUNT counts every occurrence including it.
 * - `current` is the occurrence the row is on now. Completing or skipping
 *   advances it with {@link nextRepeatOccurrence}; a hand-edited date does
 *   not move `current`, so the series never drifts.
 * - UNTIL is inclusive. A date-only UNTIL on a datetime series covers the
 *   whole of that day.
 *
 * **Interval repeats** ("every 1 h 30 min") are the one
 * exception to wall-clock expansion. Their rule is `FREQ=HOURLY|MINUTELY|
 * SECONDLY;INTERVAL=n` (plus COUNT or UNTIL), only on datetime fields, and
 * an interval is a fixed length of **absolute time**: step k is the instant
 * `dtstart` names in `tz` plus k intervals, read back as a wall time in
 * `tz`. So across a DST change the wall clock shifts (every 24 h from 09:00
 * is 10:00 after a spring-forward), unlike "every day", which stays at
 * 09:00. Occurrences are still named by wall time, so in the hour a
 * fall-back repeats a wall time names its second pass (as PostgreSQL reads
 * it) and the first pass's steps are left out; COUNT counts steps from the
 * start, so such a series has fewer. At least {@link REPEAT_INTERVAL_MIN_SECONDS}
 * (one second): every search finds steps by arithmetic, so the length of the
 * interval never changes how much work a call does.
 */
import * as rruleModule from 'rrule';
import {
  tableDateTimeLocalDate,
  tableDateTimeToUtc,
  tableWallMsToInstant,
  tableZoneWallMs,
} from './tableDateTime';
import { REPEAT_WEEKDAYS, type TableRepeatWeekday } from './tableRepeatPeriods';
import type { Options as RRuleOptions, RRule as RRuleType } from 'rrule';

export type { TableRepeatUnit, TableRepeatWeekday } from './tableRepeatPeriods';

// rrule ships CommonJS (main) beside ESM (module). Depending on the loader
// (Vite, esbuild, tsx, jest) the namespace has the named exports directly or
// only under `default`; take whichever is there. Reflect.get keeps Rollup
// (Vite) from rejecting a static `.default` on the ESM build's namespace.
const rruleLib = (
  Reflect.get(rruleModule, 'RRule') ? rruleModule : Reflect.get(rruleModule, 'default')
) as typeof rruleModule;

export type TableRepeatKind = 'date' | 'datetime';

/** The per-row repeat value stored beside a repeating date. */
export interface TableRepeat {
  /** RFC 5545 RRULE body, normalized, without `RRULE:` or DTSTART. */
  rrule: string;
  /** The series anchor, as a wall time: the first occurrence on set days. */
  dtstart: string;
  /** The occurrence the row is on now, as a wall time. */
  current: string;
  /** IANA zone snapshotted when the repeat was set. */
  tz: string;
}

export type TableRepeatResult<T> = { ok: true; value: T } | { ok: false; error: string };

const WEEKDAYS = REPEAT_WEEKDAYS;
const FREQS = new Set(['DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY']);
const ALLOWED_PARTS = new Set([
  'FREQ',
  'INTERVAL',
  'COUNT',
  'UNTIL',
  'BYDAY',
  'BYMONTHDAY',
  'BYMONTH',
  'BYSETPOS',
  'BYYEARDAY',
  'BYWEEKNO',
  'WKST',
]);
const POSITIVE_INT = /^[1-9]\d{0,5}$/;
const UNTIL_VALUE = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})Z?)?$/;
const BYDAY_ITEM = /^([+-]?(?:[1-9]|[1-4]\d|5[0-3]))?(MO|TU|WE|TH|FR|SA|SU)$/;
const SIGNED_INT_LIST = /^[+-]?\d{1,3}(,[+-]?\d{1,3})*$/;
const WALL_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const WALL_DATE_TIME = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})$/;
const ZONE_NAME = /^[A-Za-z][A-Za-z0-9_+\-/]*$/;
const DAY_MS = 86_400_000;
/** Hard cap on occurrences walked in one call (skip-to-upcoming, COUNT checks). */
export const TABLE_REPEAT_SCAN_LIMIT = 5000;

/**
 * The shortest interval repeat, in seconds: one second. The shared
 * validator, the server (through it) and the editor all use it. What keeps
 * a very short interval safe is elsewhere: the engine finds steps by
 * arithmetic (it never walks a run of them), the calendar doesn't draw a
 * series that repeats more often than once a minute, and reminders space
 * themselves out to at least a minute.
 */
export const REPEAT_INTERVAL_MIN_SECONDS = 1;
/** The longest interval repeat, in seconds: 999 days 23 h 59 min 59 s. */
export const REPEAT_INTERVAL_MAX_SECONDS = 1000 * 86_400 - 1;
/** Interval rules: seconds in one INTERVAL step of each FREQ. */
const INTERVAL_FREQ_SECONDS: Record<string, number> = { HOURLY: 3600, MINUTELY: 60, SECONDLY: 1 };
/** The parts an interval rule may have. */
const INTERVAL_PARTS = new Set(['FREQ', 'INTERVAL', 'COUNT', 'UNTIL']);
const INTERVAL_STEPS = /^[1-9]\d{0,8}$/;
/**
 * Most rounds one search makes: finding the first kept step past a
 * fall-back's repeated hour is a binary search over the steps of one shift
 * (about a dozen rounds at one second), so this only guards against a zone
 * the runtime reads inconsistently.
 */
const INTERVAL_SEARCH_LIMIT = 64;

function pad(value: number, width = 2): string {
  return String(value).padStart(width, '0');
}

/** Wall time → a Date whose UTC fields are the wall-clock fields. */
function wallToDate(wall: string): Date | null {
  const date = WALL_DATE.exec(wall);
  const time = date ? null : WALL_DATE_TIME.exec(wall);
  const m = date ?? time;
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const [h, mi, s] = time ? [Number(time[4]), Number(time[5]), Number(time[6])] : [0, 0, 0];
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59 || s > 59) return null;
  const out = utcClock(y, mo - 1, d, h, mi, s);
  // Rejects Feb 30 and friends: Date.UTC would roll them over.
  if (out.getUTCMonth() !== mo - 1 || out.getUTCDate() !== d) return null;
  return y < 1 || y > 9999 ? null : out;
}

function dateToWall(clock: Date, kind: TableRepeatKind): string {
  const day = `${pad(clock.getUTCFullYear(), 4)}-${pad(clock.getUTCMonth() + 1)}-${pad(clock.getUTCDate())}`;
  if (kind === 'date') return day;
  return `${day}T${pad(clock.getUTCHours())}:${pad(clock.getUTCMinutes())}:${pad(clock.getUTCSeconds())}`;
}

function wallKind(wall: string): TableRepeatKind | null {
  if (WALL_DATE.test(wall)) return 'date';
  if (WALL_DATE_TIME.test(wall)) return 'datetime';
  return null;
}

/** Date.UTC without its 0–99 → 1900s year mapping; months/days overflow normally. */
function utcClock(year: number, month0: number, day: number, h = 0, mi = 0, s = 0): Date {
  const out = new Date(0);
  out.setUTCFullYear(year, month0, day);
  out.setUTCHours(h, mi, s, 0);
  return out;
}

function startOfDay(clock: Date): Date {
  return utcClock(clock.getUTCFullYear(), clock.getUTCMonth(), clock.getUTCDate());
}

/** An RRULE body's parts (upper case), or why it isn't one. */
function splitRuleParts(input: string): TableRepeatResult<Map<string, string>> {
  if (typeof input !== 'string') return { ok: false, error: 'Repeat rule must be a string.' };
  const body = input.trim().replace(/^RRULE:/i, '');
  if (!body) return { ok: false, error: 'Repeat rule is empty.' };
  if (/[\r\n]/.test(body)) return { ok: false, error: 'Repeat rule must be a single RRULE line.' };
  const parts = new Map<string, string>();
  for (const raw of body.split(';')) {
    if (!raw) continue;
    const eq = raw.indexOf('=');
    if (eq <= 0) return { ok: false, error: `Malformed rule part "${raw}".` };
    const key = raw.slice(0, eq).trim().toUpperCase();
    const value = raw
      .slice(eq + 1)
      .trim()
      .toUpperCase();
    if (!ALLOWED_PARTS.has(key)) {
      return {
        ok: false,
        error:
          key === 'DTSTART' || key === 'TZID'
            ? `${key} isn't allowed in the rule; the row's date is the start.`
            : `Unsupported rule part ${key}.`,
      };
    }
    if (parts.has(key)) return { ok: false, error: `Rule part ${key} appears twice.` };
    if (!value) return { ok: false, error: `Rule part ${key} is empty.` };
    parts.set(key, value);
  }
  if (!parts.get('FREQ')) return { ok: false, error: 'Repeat rule needs FREQ.' };
  return { ok: true, value: parts };
}

/**
 * Validates and normalizes an RRULE body. Accepts an optional `RRULE:`
 * prefix; rejects DTSTART/TZID (the anchor lives in the row), sub-daily
 * frequencies, unknown parts, and COUNT together with UNTIL. (Table rows
 * also take interval rules; automations, which have their own "every",
 * read rules through this one only.)
 */
export function normalizeRepeatRule(input: string): TableRepeatResult<string> {
  const parts = splitRuleParts(input);
  return parts.ok ? normalizeDayRule(parts.value) : parts;
}

/** An interval rule, read (see the module comment). */
interface IntervalRule {
  /** Normalized: the coarsest FREQ that fits, INTERVAL left out at 1. */
  rule: string;
  seconds: number;
  /** COUNT: steps from the start, the start included. */
  count: number | null;
  /** UNTIL as a wall clock (UTC-clock ms), inclusive; a date covers its whole day. */
  until: number | null;
}

/** The interval rule body for `seconds`: "FREQ=MINUTELY;INTERVAL=90" for 1 h 30 min. */
export function intervalRepeatRule(seconds: number): string {
  const [freq, unit] =
    seconds % 3600 === 0
      ? ['HOURLY', 3600]
      : seconds % 60 === 0
        ? ['MINUTELY', 60]
        : ['SECONDLY', 1];
  const n = Math.round(seconds / (unit as number));
  return n === 1 ? `FREQ=${freq}` : `FREQ=${freq};INTERVAL=${n}`;
}

/** An interval in words: "1 h 30 min", "2 days 6 h", "1 min 30 s", "1 day". */
export function formatRepeatInterval(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  const days = Math.floor(total / 86_400);
  const hours = Math.floor((total % 86_400) / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  const parts: string[] = [];
  if (days) parts.push(`${days} ${days === 1 ? 'day' : 'days'}`);
  if (hours) parts.push(`${hours} h`);
  if (minutes) parts.push(`${minutes} min`);
  if (secs) parts.push(`${secs} s`);
  return parts.length ? parts.join(' ') : '0 s';
}

/**
 * Why `seconds` can't be an interval repeat, or null: a whole number of
 * seconds from {@link REPEAT_INTERVAL_MIN_SECONDS} to {@link REPEAT_INTERVAL_MAX_SECONDS}.
 */
export function repeatIntervalProblem(seconds: number): string | null {
  if (!Number.isInteger(seconds) || seconds < REPEAT_INTERVAL_MIN_SECONDS)
    return `The shortest interval is ${formatRepeatInterval(REPEAT_INTERVAL_MIN_SECONDS)}.`;
  if (seconds > REPEAT_INTERVAL_MAX_SECONDS) return 'The longest interval is 999 days.';
  return null;
}

function normalizeIntervalParts(parts: Map<string, string>): TableRepeatResult<IntervalRule> {
  const freq = parts.get('FREQ')!;
  for (const key of parts.keys())
    if (!INTERVAL_PARTS.has(key))
      return {
        ok: false,
        error: `An interval repeat (FREQ=${freq}) takes INTERVAL and COUNT or UNTIL, not ${key}.`,
      };
  const steps = parts.get('INTERVAL') ?? '1';
  if (!INTERVAL_STEPS.test(steps))
    return { ok: false, error: 'INTERVAL must be a positive whole number.' };
  const seconds = Number(steps) * INTERVAL_FREQ_SECONDS[freq]!;
  const tooShortOrLong = repeatIntervalProblem(seconds);
  if (tooShortOrLong) return { ok: false, error: tooShortOrLong };
  const count = parts.get('COUNT');
  const until = parts.get('UNTIL');
  if (count !== undefined && !POSITIVE_INT.test(count))
    return { ok: false, error: 'COUNT must be a positive whole number.' };
  if (count !== undefined && until !== undefined)
    return { ok: false, error: 'A rule can end after COUNT times or on an UNTIL date, not both.' };
  let untilWall: number | null = null;
  let untilPart: string | null = null;
  if (until !== undefined) {
    const m = UNTIL_VALUE.exec(until);
    const day = m ? wallToDate(`${m[1]}-${m[2]}-${m[3]}`) : null;
    const at = m?.[4]
      ? wallToDate(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}`)
      : day && new Date(day.getTime() + DAY_MS - 1000);
    if (!m || !at)
      return { ok: false, error: 'UNTIL must be a date like 20261231 or 20261231T235959.' };
    untilWall = at.getTime();
    // Floating, as on set days: the wall-clock reading, never an instant.
    untilPart = until.replace(/Z$/, '');
  }
  const ends = count !== undefined ? `;COUNT=${count}` : untilPart ? `;UNTIL=${untilPart}` : '';
  return {
    ok: true,
    value: {
      rule: `${intervalRepeatRule(seconds)}${ends}`,
      seconds,
      count: count === undefined ? null : Number(count),
      until: untilWall,
    },
  };
}

/** A table row's rule: a day-based RRULE (as {@link normalizeRepeatRule}) or an interval one. */
function parseTableRule(
  input: string
): TableRepeatResult<{ value: string; interval: IntervalRule | null }> {
  const parts = splitRuleParts(input);
  if (!parts.ok) return parts;
  if (INTERVAL_FREQ_SECONDS[parts.value.get('FREQ')!] !== undefined) {
    const interval = normalizeIntervalParts(parts.value);
    return interval.ok
      ? { ok: true, value: { value: interval.value.rule, interval: interval.value } }
      : interval;
  }
  const rule = normalizeDayRule(parts.value, ', or HOURLY, MINUTELY or SECONDLY for an interval');
  return rule.ok ? { ok: true, value: { value: rule.value, interval: null } } : rule;
}

/** An interval repeat's length in seconds ("every 1 h 30 min" is 5400), or null for any other rule. */
export function tableRepeatIntervalSeconds(rrule: string): number | null {
  if (!/(?:^|;)FREQ=(?:HOURLY|MINUTELY|SECONDLY)(?:;|$)/i.test(rrule.replace(/^RRULE:/i, '')))
    return null;
  const rule = parseTableRule(rrule);
  return rule.ok ? (rule.value.interval?.seconds ?? null) : null;
}

function normalizeDayRule(parts: Map<string, string>, alsoAllowed = ''): TableRepeatResult<string> {
  const freq = parts.get('FREQ')!;
  if (!FREQS.has(freq)) {
    return {
      ok: false,
      error: `FREQ must be DAILY, WEEKLY, MONTHLY or YEARLY${alsoAllowed} (got ${freq}).`,
    };
  }
  for (const key of ['INTERVAL', 'COUNT']) {
    const value = parts.get(key);
    if (value !== undefined && !POSITIVE_INT.test(value)) {
      return { ok: false, error: `${key} must be a positive whole number.` };
    }
  }
  if (parts.has('COUNT') && parts.has('UNTIL')) {
    return { ok: false, error: 'A rule can end after COUNT times or on an UNTIL date, not both.' };
  }
  const until = parts.get('UNTIL');
  if (until !== undefined) {
    const m = UNTIL_VALUE.exec(until);
    if (!m || !wallToDate(`${m[1]}-${m[2]}-${m[3]}`)) {
      return { ok: false, error: 'UNTIL must be a date like 20261231 or 20261231T235959.' };
    }
    // Floating series: a trailing Z would name an instant, which a wall-clock
    // series can't compare against. Keep the wall-clock reading.
    parts.set('UNTIL', until.replace(/Z$/, ''));
  }
  const byday = parts.get('BYDAY');
  if (byday !== undefined) {
    for (const item of byday.split(',')) {
      const m = BYDAY_ITEM.exec(item);
      if (!m) return { ok: false, error: `BYDAY item "${item}" isn't valid.` };
      if (m[1] && freq !== 'MONTHLY' && freq !== 'YEARLY') {
        return { ok: false, error: 'Numbered BYDAY (like 2TU) needs FREQ=MONTHLY or YEARLY.' };
      }
    }
  }
  for (const key of ['BYMONTHDAY', 'BYMONTH', 'BYSETPOS', 'BYYEARDAY', 'BYWEEKNO']) {
    const value = parts.get(key);
    if (value !== undefined && !SIGNED_INT_LIST.test(value)) {
      return { ok: false, error: `${key} must be a comma-separated list of whole numbers.` };
    }
  }
  const wkst = parts.get('WKST');
  if (wkst !== undefined && !WEEKDAYS.includes(wkst as TableRepeatWeekday)) {
    return { ok: false, error: 'WKST must be a weekday code like MO.' };
  }
  const ordered = ['FREQ', ...[...parts.keys()].filter((k) => k !== 'FREQ')];
  const normalized = ordered.map((k) => `${k}=${parts.get(k)}`).join(';');
  try {
    // Out-of-range numbers (BYMONTHDAY=40) are caught by rrule itself.
    const options = rruleLib.RRule.parseString(normalized);
    new rruleLib.RRule(options).after(new Date(Date.UTC(2000, 0, 1)), true);
  } catch (error) {
    return { ok: false, error: `Repeat rule rejected: ${(error as Error).message}` };
  }
  return { ok: true, value: normalized };
}

/** The whole-day number of a wall clock (days since 1970-01-01, UTC clock). */
function dayNumber(clock: Date): number {
  return Math.floor(clock.getTime() / DAY_MS);
}

interface CompiledSeries {
  kind: TableRepeatKind;
  dtstart: Date;
  /** On set days: the RRULE. Null for an interval repeat. */
  rule: RRuleType | null;
  /** True when dtstart isn't itself an occurrence of the rule. */
  extraStart: boolean;
  /** Time of day of dtstart (ms). */
  tod: number;
  /** An interval repeat's steps in absolute time. Null otherwise. */
  interval: IntervalSeries | null;
}

interface IntervalSeries {
  /** One step: a whole number of seconds, one or more. */
  everyMs: number;
  /** The instant dtstart names in `tz`: step k is at startMs + k × everyMs. */
  startMs: number;
  count: number | null;
  /** UNTIL as a wall clock (UTC-clock ms), inclusive. */
  until: number | null;
  tz: string;
}

function compile(repeat: TableRepeat): TableRepeatResult<CompiledSeries> {
  const parsed = parseTableRule(repeat.rrule);
  if (!parsed.ok) return parsed;
  const rule = { value: parsed.value.value };
  const kind = wallKind(repeat.dtstart);
  const dtstart = wallToDate(repeat.dtstart);
  if (!kind || !dtstart)
    return { ok: false, error: 'Repeat start must be a wall-clock date or date-time.' };
  if (wallKind(repeat.current) !== kind || !wallToDate(repeat.current)) {
    return { ok: false, error: 'Repeat current occurrence must match the start format.' };
  }
  if (typeof repeat.tz !== 'string' || !ZONE_NAME.test(repeat.tz)) {
    return { ok: false, error: 'Repeat time zone must be an IANA zone name.' };
  }
  const tod = dtstart.getTime() - startOfDay(dtstart).getTime();
  const interval = parsed.value.interval;
  if (interval) return compileInterval(repeat, interval, kind, dtstart, tod);
  const options: Partial<RRuleOptions> = rruleLib.RRule.parseString(rule.value);
  options.dtstart = dtstart;
  options.tzid = null;
  const untilPart = /(?:^|;)UNTIL=([^;]+)/.exec(rule.value)?.[1];
  if (options.until && untilPart && !untilPart.includes('T')) {
    // A date-only UNTIL covers the whole of that day.
    options.until = new Date(startOfDay(options.until).getTime() + DAY_MS - 1000);
  }
  const probe = new rruleLib.RRule({ ...options, count: null, until: null });
  const startMatches =
    probe.after(new Date(dtstart.getTime() - 1000), false)?.getTime() === dtstart.getTime();
  if (!startMatches && options.count) {
    // dtstart counts as occurrence #1, so the rule supplies one fewer. With
    // COUNT=1 that leaves none: an UNTIL before dtstart yields nothing.
    options.count -= 1;
    if (options.count === 0) {
      options.count = null;
      options.until = new Date(dtstart.getTime() - DAY_MS);
    }
  }
  return {
    ok: true,
    value: {
      kind,
      dtstart,
      rule: new rruleLib.RRule(options),
      extraStart: !startMatches,
      tod,
      interval: null,
    },
  };
}

/**
 * An interval repeat's series (see the module comment): datetime only;
 * anchored at the instant `dtstart` names in `tz`, so the zone must be one
 * the runtime knows.
 */
function compileInterval(
  repeat: TableRepeat,
  rule: IntervalRule,
  kind: TableRepeatKind,
  dtstart: Date,
  tod: number
): TableRepeatResult<CompiledSeries> {
  if (kind !== 'datetime')
    return {
      ok: false,
      error: 'An interval repeat needs a date with a time (turn on Include time).',
    };
  let startMs: number;
  try {
    startMs = tableWallMsToInstant(dtstart.getTime(), repeat.tz);
  } catch {
    return { ok: false, error: `Repeat time zone ${repeat.tz} isn't a known zone.` };
  }
  return {
    ok: true,
    value: {
      kind,
      dtstart,
      rule: null,
      extraStart: false,
      tod,
      interval: {
        everyMs: rule.seconds * 1000,
        startMs,
        count: rule.count,
        until: rule.until,
        tz: repeat.tz,
      },
    },
  };
}

type IntervalStep = { wall: Date; instant: number } | 'skip' | 'end';

/**
 * Step `k` of an interval series: its wall time and instant; 'skip' for a
 * step in the first pass of an hour a fall-back repeats (that wall time
 * names the second pass, as PostgreSQL reads it, so the name is taken);
 * 'end' past COUNT or UNTIL. Step 0 is dtstart as stored.
 */
function intervalStep(series: CompiledSeries, k: number): IntervalStep {
  const iv = series.interval!;
  if (iv.count !== null && k >= iv.count) return 'end';
  if (k === 0) return { wall: series.dtstart, instant: iv.startMs };
  const instant = iv.startMs + k * iv.everyMs;
  const wall = tableZoneWallMs(instant, iv.tz);
  if (tableWallMsToInstant(wall, iv.tz) !== instant) return 'skip';
  if (iv.until !== null && wall > iv.until) return 'end';
  return { wall: new Date(wall), instant };
}

/** The first step strictly after the instant `wall` names in the zone (at least step 1). */
function intervalIndexAfter(series: CompiledSeries, wall: Date): number {
  const iv = series.interval!;
  const at = tableWallMsToInstant(wall.getTime(), iv.tz);
  return Math.max(1, Math.floor((at - iv.startMs) / iv.everyMs) + 1);
}

/**
 * Whether step `k` (k ≥ 1) is left out: it falls in the first pass of an
 * hour a fall-back repeats, so its wall time names the second pass.
 */
function isSkippedStep(iv: IntervalSeries, k: number): boolean {
  const instant = iv.startMs + k * iv.everyMs;
  return tableWallMsToInstant(tableZoneWallMs(instant, iv.tz), iv.tz) !== instant;
}

/**
 * The first step at or after `k` (k ≥ 1) that isn't left out, found by
 * arithmetic, however short the interval. Left-out steps come in one run
 * (the first pass of a repeated hour), and the second pass of a left-out
 * step's wall time is kept and at most one shift later, so a binary search
 * over the steps in between finds the run's end: about a dozen checks at one
 * second, where walking would check thousands.
 */
function firstKeptStep(iv: IntervalSeries, k: number): number | null {
  if (!isSkippedStep(iv, k)) return k;
  let skipped = k;
  let kept: number | null = null;
  for (let round = 0; round < INTERVAL_SEARCH_LIMIT && kept === null; round++) {
    const instant = iv.startMs + skipped * iv.everyMs;
    const second = tableWallMsToInstant(tableZoneWallMs(instant, iv.tz), iv.tz);
    const probe = Math.max(skipped + 1, Math.ceil((second - iv.startMs) / iv.everyMs));
    if (isSkippedStep(iv, probe)) skipped = probe;
    else kept = probe;
  }
  if (kept === null) return null;
  for (let round = 0; kept - skipped > 1 && round < INTERVAL_SEARCH_LIMIT; round++) {
    const mid = Math.floor((skipped + kept) / 2);
    if (isSkippedStep(iv, mid)) skipped = mid;
    else kept = mid;
  }
  return kept;
}

/** Step `k` read through: the first kept step at or after it, its wall time, or null at the end. */
function keptStepWall(series: CompiledSeries, k: number): Date | null {
  const kept = firstKeptStep(series.interval!, k);
  if (kept === null) return null;
  const step = intervalStep(series, kept);
  return typeof step === 'object' ? step.wall : null;
}

/**
 * The interval occurrence after `wall` (strictly): the first kept step
 * after the instant `wall` names. Wall times only grow along the series,
 * so every caller that walks `current` forward (done, skip, the calendar)
 * sees the same occurrences.
 */
function nextIntervalAfter(series: CompiledSeries, wall: Date): Date | null {
  return keptStepWall(series, intervalIndexAfter(series, wall));
}

/**
 * The first kept interval step (step 1 on) not before `at`, or null when the
 * series ends first. An `instant` (ms) compares instants: the first kept step
 * at or after it. A `wall` time compares wall times, the way Skip to upcoming
 * reads them with a wall `now`: kept steps' wall times only grow, so it
 * starts two hours of absolute time before the instant the wall time names
 * (more than any DST shift, and a wall time a spring-forward skips names an
 * instant an hour on) and binary-searches from there for the first kept step
 * whose wall time isn't before it: a few dozen checks however short the
 * interval.
 */
function intervalAtOrAfter(
  series: CompiledSeries,
  at: { wall: Date } | { instant: number }
): Date | null {
  const iv = series.interval!;
  if ('instant' in at)
    return keptStepWall(series, Math.max(1, Math.ceil((at.instant - iv.startMs) / iv.everyMs)));
  const wall = at.wall.getTime();
  const named = tableWallMsToInstant(wall, iv.tz);
  const reaches = (k: number): boolean | null => {
    const kept = firstKeptStep(iv, k);
    if (kept === null) return null;
    return tableZoneWallMs(iv.startMs + kept * iv.everyMs, iv.tz) >= wall;
  };
  let lo = Math.max(1, Math.ceil((named - 2 * 3_600_000 - iv.startMs) / iv.everyMs));
  const first = reaches(lo);
  if (first === null) return null;
  if (first) return keptStepWall(series, lo);
  // Every kept step from the instant the wall time names on reads at or after it.
  let hi = Math.max(lo + 1, Math.ceil((named - iv.startMs) / iv.everyMs));
  for (let round = 0; round < INTERVAL_SEARCH_LIMIT; round++) {
    const found = reaches(hi);
    if (found === null) return null;
    if (found) break;
    lo = hi;
    hi += Math.max(1, Math.ceil(3_600_000 / iv.everyMs));
  }
  for (let round = 0; hi - lo > 1 && round < INTERVAL_SEARCH_LIMIT; round++) {
    const mid = Math.floor((lo + hi) / 2);
    if (reaches(mid)) hi = mid;
    else lo = mid;
  }
  return keptStepWall(series, hi);
}

/**
 * Starts a series on `date` (a wall date or date-time; its form decides date
 * vs datetime), on `date` itself. Snapshots `tz` (pass `userTimeZone()` at
 * write time).
 */
export function createTableRepeat(input: {
  date: string;
  rrule: string;
  tz: string;
}): TableRepeatResult<TableRepeat> {
  const parsed = parseTableRule(input.rrule);
  if (!parsed.ok) return parsed;
  const rule = { value: parsed.value.value };
  const repeat: TableRepeat = {
    rrule: rule.value,
    dtstart: input.date,
    current: input.date,
    tz: input.tz,
  };
  const compiled = compile(repeat);
  return compiled.ok ? { ok: true, value: repeat } : compiled;
}

/** Re-validates a stored value (e.g. read back from the DB). */
export function tableRepeatProblem(value: unknown): string | null {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    return 'Repeat must be an object.';
  const v = value as Partial<TableRepeat>;
  if (
    typeof v.rrule !== 'string' ||
    typeof v.dtstart !== 'string' ||
    typeof v.current !== 'string'
  ) {
    return 'Repeat needs rrule, dtstart and current.';
  }
  const compiled = compile(v as TableRepeat);
  if (!compiled.ok) return compiled.error;
  if (wallToDate(v.current)!.getTime() < compiled.value.dtstart.getTime()) {
    return 'Repeat current occurrence is before the start.';
  }
  return null;
}

/** The occurrence after `wall` (strictly), or null when the series has ended. */
function nextAfter(series: CompiledSeries, wall: Date): Date | null {
  if (wall.getTime() < series.dtstart.getTime()) return series.dtstart;
  if (series.interval) return nextIntervalAfter(series, wall);
  return series.rule!.after(wall, false);
}

/**
 * The occurrence after `repeat.current`, as a wall time, or null when the
 * series has ended (COUNT reached or past UNTIL).
 */
export function nextRepeatOccurrence(repeat: TableRepeat): TableRepeatResult<string | null> {
  const compiled = compile(repeat);
  if (!compiled.ok) return compiled;
  const next = nextAfter(compiled.value, wallToDate(repeat.current)!);
  return { ok: true, value: next ? dateToWall(next, compiled.value.kind) : null };
}

/** Up to `count` occurrences starting at `repeat.current` (inclusive). */
export function upcomingRepeatOccurrences(
  repeat: TableRepeat,
  count: number
): TableRepeatResult<string[]> {
  const compiled = compile(repeat);
  if (!compiled.ok) return compiled;
  const out: string[] = [];
  let at: Date | null = wallToDate(repeat.current)!;
  const limit = Math.min(Math.max(0, Math.floor(count)), TABLE_REPEAT_SCAN_LIMIT);
  while (at && out.length < limit) {
    out.push(dateToWall(at, compiled.value.kind));
    at = nextAfter(compiled.value, at);
  }
  return { ok: true, value: out };
}

/**
 * An interval repeat's occurrences from `current` on (inclusive) whose
 * instants fall in [`from`, `to`) (ISO instants), oldest first, at most
 * `limit`; `truncated` when the window holds more. It steps straight to the
 * window, so a row whose current one is far behind (never marked done)
 * still shows the window's occurrences, and a short interval can't flood a
 * calendar or a reminder sync. With `stride`, only every `stride`-th step
 * counted from the start (step 0) is read, `current` too (reminders space a
 * short interval out this way). Fails for any other repeat.
 */
export function tableRepeatIntervalOccurrences(
  repeat: TableRepeat,
  window: { from: string; to: string; limit: number; stride?: number }
): TableRepeatResult<{ occurrences: string[]; truncated: boolean }> {
  const compiled = compile(repeat);
  if (!compiled.ok) return compiled;
  const series = compiled.value;
  const iv = series.interval;
  if (!iv) return { ok: false, error: 'Not an interval repeat.' };
  const from = Date.parse(window.from);
  const to = Date.parse(window.to);
  if (Number.isNaN(from) || Number.isNaN(to))
    return { ok: false, error: 'from and to must be ISO instants.' };
  const limit = Math.min(Math.max(0, Math.floor(window.limit)), TABLE_REPEAT_SCAN_LIMIT);
  const stride = Math.max(1, Math.floor(window.stride ?? 1));
  /** The first step at or after `k` that is one of the stride's. */
  const onStride = (k: number) => Math.ceil(k / stride) * stride;
  const out: string[] = [];
  let truncated = false;
  const current = wallToDate(repeat.current)!;
  const currentAt = tableWallMsToInstant(current.getTime(), iv.tz);
  const currentOnStride = stride === 1 || (currentAt - iv.startMs) % (stride * iv.everyMs) === 0;
  if (currentOnStride && currentAt >= from && currentAt < to) {
    if (limit === 0) return { ok: true, value: { occurrences: [], truncated: true } };
    out.push(repeat.current);
  }
  let k = onStride(
    Math.max(intervalIndexAfter(series, current), Math.ceil((from - iv.startMs) / iv.everyMs))
  );
  while (iv.startMs + k * iv.everyMs < to) {
    const kept = firstKeptStep(iv, k);
    if (kept === null) break;
    if (kept !== k) {
      // A fall-back's repeated hour: on to the first kept step (on the stride).
      k = onStride(kept);
      continue;
    }
    const step = intervalStep(series, k);
    if (step === 'end') break;
    if (step === 'skip') break;
    if (out.length >= limit) {
      truncated = true;
      break;
    }
    out.push(dateToWall(step.wall, 'datetime'));
    k += stride;
  }
  return { ok: true, value: { occurrences: out, truncated } };
}

/**
 * Whether `wall` is the row's current occurrence or one after it, without
 * walking the series (an interval's may be thousands away).
 */
export function isTableRepeatUpcoming(repeat: TableRepeat, wall: string): boolean {
  if (wall === repeat.current) return true;
  const compiled = compile(repeat);
  if (!compiled.ok) return false;
  const series = compiled.value;
  const at = wallKind(wall) === series.kind ? wallToDate(wall) : null;
  if (!at || at.getTime() <= wallToDate(repeat.current)!.getTime()) return false;
  const iv = series.interval;
  if (iv) {
    // A step: a whole number of intervals after the start, kept under its name.
    const offset = tableWallMsToInstant(at.getTime(), iv.tz) - iv.startMs;
    if (offset <= 0 || offset % iv.everyMs !== 0) return false;
    const step = intervalStep(series, offset / iv.everyMs);
    return typeof step === 'object' && step.wall.getTime() === at.getTime();
  }
  return nextAfter(series, new Date(at.getTime() - 1000))?.getTime() === at.getTime();
}

/**
 * Completion model A: the row's current occurrence is done (or skipped).
 * Returns the finished occurrence and the advanced value; `next` is null
 * when the series has ended (the row then just stays done).
 */
export function advanceTableRepeat(
  repeat: TableRepeat
): TableRepeatResult<{ finished: string; next: TableRepeat | null }> {
  const next = nextRepeatOccurrence(repeat);
  if (!next.ok) return next;
  return {
    ok: true,
    value: {
      finished: repeat.current,
      next: next.value ? { ...repeat, current: next.value } : null,
    },
  };
}

/**
 * "Skip to next upcoming": every occurrence from `current` that is past is
 * skipped. Past means before `now` (a wall time in the row's zone; a date
 * for date fields compares by day). Returns them oldest first plus the
 * advanced value (null when the series ends while skipping). Nothing is
 * skipped when `current` isn't past.
 *
 * `now` may be the moment (a `Date`, to the whole second; the server's clock
 * when no `now` is sent): a repeat at an interval then compares instants,
 * exact in a fall-back's repeated hour, and any other repeat reads its wall
 * time in the zone ({@link tableRepeatWallTime}) as before.
 */
export function skipTableRepeatToUpcoming(
  repeat: TableRepeat,
  now: string | Date
): TableRepeatResult<{ skipped: string[]; next: TableRepeat | null }> {
  const compiled = compile(repeat);
  if (!compiled.ok) return compiled;
  const series = compiled.value;
  const nowDate = wallToDate(now instanceof Date ? tableRepeatWallTime(now, repeat.tz) : now);
  if (!nowDate) return { ok: false, error: '"now" must be a wall-clock date or date-time.' };
  const cutoff = series.kind === 'date' ? startOfDay(nowDate) : nowDate;
  const iv = series.interval;
  const nowMs = iv && now instanceof Date ? wholeSecond(now) : null;
  const isPast = (at: Date) => {
    // Its wall time names one instant: the second pass in a repeated hour, as for its steps.
    if (nowMs !== null) return tableWallMsToInstant(at.getTime(), iv!.tz) < nowMs;
    return at.getTime() < cutoff.getTime();
  };
  const skipped: string[] = [];
  let at: Date | null = wallToDate(repeat.current)!;
  while (at && isPast(at)) {
    if (skipped.length >= TABLE_REPEAT_SCAN_LIMIT) {
      return {
        ok: false,
        // Each one is logged as skipped, so they are listed; an interval can jump instead.
        error: `More than ${TABLE_REPEAT_SCAN_LIMIT} missed occurrences; edit the date${iv ? ' or use Jump to now' : ''} instead.`,
      };
    }
    skipped.push(dateToWall(at, series.kind));
    at = nextAfter(series, at);
  }
  return {
    ok: true,
    value: {
      skipped,
      next: at ? { ...repeat, current: dateToWall(at, series.kind) } : null,
    },
  };
}

/**
 * "Jump to now" on a repeat at an interval: `current` moves straight to the
 * first step that isn't past at `now` (a wall time in the row's zone, read
 * as {@link skipTableRepeatToUpcoming} reads it), found by arithmetic. It
 * lands where Skip to upcoming would, without listing the steps in between,
 * so it works however far behind the row is (past that one's
 * {@link TABLE_REPEAT_SCAN_LIMIT}). Returns the moved value; the same value
 * when `current` isn't past; null when the series ends before `now`. Fails
 * for any other repeat (Skip to upcoming walks those). A `Date` `now` (to the
 * whole second) compares instants, as Skip to upcoming does with one.
 */
export function jumpTableRepeatToUpcoming(
  repeat: TableRepeat,
  now: string | Date
): TableRepeatResult<TableRepeat | null> {
  const compiled = compile(repeat);
  if (!compiled.ok) return compiled;
  const series = compiled.value;
  if (!series.interval)
    return {
      ok: false,
      error: 'Only a repeat at an interval can jump to now; skip or move this one instead.',
    };
  const current = wallToDate(repeat.current)!;
  let next: Date | null;
  if (now instanceof Date) {
    const nowMs = wholeSecond(now);
    const iv = series.interval;
    if (tableWallMsToInstant(current.getTime(), iv.tz) >= nowMs) return { ok: true, value: repeat };
    next = intervalAtOrAfter(series, { instant: nowMs });
  } else {
    const nowDate = wallToDate(now);
    if (!nowDate) return { ok: false, error: '"now" must be a wall-clock date or date-time.' };
    if (current.getTime() >= nowDate.getTime()) return { ok: true, value: repeat };
    next = intervalAtOrAfter(series, { wall: nowDate });
  }
  return { ok: true, value: next ? { ...repeat, current: dateToWall(next, series.kind) } : null };
}

/**
 * The column value for an occurrence: date fields store the wall date as is;
 * datetime fields store the instant the wall time names in the row's `tz`
 * (DST gaps and overlaps resolve as PostgreSQL resolves them).
 */
export function repeatOccurrenceToColumn(repeat: TableRepeat, occurrence: string): string | null {
  const kind = wallKind(occurrence);
  if (!kind || !wallToDate(occurrence)) return null;
  return kind === 'date' ? occurrence : tableDateTimeToUtc(occurrence, repeat.tz);
}

/** A short human summary, e.g. "every week on Monday". */
export function describeTableRepeat(repeat: TableRepeat): TableRepeatResult<string> {
  const compiled = compile(repeat);
  if (!compiled.ok) return compiled;
  const interval = compiled.value.interval;
  if (interval) {
    const until = /(?:^|;)UNTIL=(\d{4})(\d{2})(\d{2})/.exec(repeat.rrule);
    const ends =
      interval.count !== null
        ? ` for ${interval.count} times`
        : until
          ? ` until ${until[1]}-${until[2]}-${until[3]}`
          : '';
    return { ok: true, value: `every ${formatRepeatInterval(interval.everyMs / 1000)}${ends}` };
  }
  const rule = new rruleLib.RRule(rruleLib.RRule.parseString(repeat.rrule)).toText();
  return { ok: true, value: rule };
}

// Repeats: today, overdue (docs/architecture.md)

/** Today's date (`YYYY-MM-DD`) in `tz`: the day overdue counts in. */
export function tableRepeatToday(tz: string, now: Date = new Date()): string {
  return tableDateTimeLocalDate(now.toISOString(), tz) ?? now.toISOString().slice(0, 10);
}

/**
 * The wall date-time (`YYYY-MM-DDTHH:MM:SS`) `at` shows in `tz`, to the
 * second; UTC's when the runtime doesn't know the zone. The one reading of
 * a moment as a repeat's wall time: the server's "now" (`nowWall`), and Skip
 * to upcoming on a `Date` for a repeat that isn't at an interval.
 */
export function tableRepeatWallTime(at: Date, tz: string): string {
  const ms = wholeSecond(at);
  try {
    return dateToWall(new Date(tableZoneWallMs(ms, tz)), 'datetime');
  } catch {
    return dateToWall(new Date(ms), 'datetime');
  }
}

/** A moment's milliseconds, down to its whole second (wall times have no fraction). */
function wholeSecond(at: Date): number {
  return Math.floor(at.getTime() / 1000) * 1000;
}

/** A logged occurrence as the engine reads it (the server's log rows fit). */
export interface TableRepeatLogEntry {
  occurrence: string;
  kind: 'done' | 'skipped' | 'moved';
}

/**
 * Whether `occurrence` (default: the current one) is overdue at `now`: its
 * date (or, on an interval, its time) is before now in the repeat's zone. A
 * repeat at an interval (sub-daily) is due at its own time, so it is overdue
 * once that time has passed, the same day: given the moment (a `Date`) the
 * two compare as instants, exact across DST (a fall-back's repeated hour
 * included); given a wall date-time in the zone they compare as wall times,
 * as Skip to upcoming compares them. Given only the zone's date
 * (`YYYY-MM-DD`, {@link tableRepeatToday}) it counts by day like the rest.
 * With `log`, a done or skipped one isn't. An overdue occurrence stays the
 * row's until done or skipped.
 */
export function isTableRepeatOverdue(
  repeat: TableRepeat,
  now: string | Date,
  options: {
    occurrence?: string;
    log?: readonly TableRepeatLogEntry[];
    /**
     * The occurrence's END, as a wall time of the same kind as the occurrence
     * (a `YYYY-MM-DD` last day for a date range, a `…T…` end for a timed one).
     * When the occurrence spans more than its start — a date/time RANGE — the
     * row is overdue only once this end has passed, not its start: a Nov 2–13
     * range repeating fortnightly is not overdue on Nov 4. Omit it (or pass the
     * start itself) for a single-day or point-in-time occurrence, which keeps
     * the start-day comparison unchanged.
     */
    occurrenceEnd?: string;
  } = {}
): boolean {
  const occurrence = options.occurrence ?? repeat.current;
  if (!isPastDue(repeat, occurrence, now, options.occurrenceEnd)) return false;
  if (!options.log) return true;
  const done = options.log.some(
    (row) => row.occurrence === occurrence && (row.kind === 'done' || row.kind === 'skipped')
  );
  return !done;
}

/**
 * {@link isTableRepeatOverdue} before the log: `occurrence` is past at `now`.
 * When `occurrenceEnd` names a later wall time than `occurrence`, the END
 * (day or instant) is what must be past — a range is overdue only after it
 * finishes. A single-day/point occurrence (no end, or an end equal to the
 * start) falls back to the start-day comparison unchanged.
 */
function isPastDue(
  repeat: TableRepeat,
  occurrence: string,
  now: string | Date,
  occurrenceEnd?: string
): boolean {
  const compiled = compile(repeat);
  if (!compiled.ok) return false;
  const series = compiled.value;
  const at = wallKind(occurrence) === series.kind ? wallToDate(occurrence) : null;
  if (!at) return false;
  // The point the row stops being due: a range's end when it genuinely extends
  // past its start, otherwise the start itself (single-day / point-in-time).
  const endWall =
    occurrenceEnd && wallKind(occurrenceEnd) === series.kind ? wallToDate(occurrenceEnd) : null;
  const due = endWall && endWall.getTime() > at.getTime() ? endWall : at;
  const iv = series.interval;
  // Its wall time names one instant: the second pass in a repeated hour, as for its steps.
  if (iv && now instanceof Date) return tableWallMsToInstant(due.getTime(), iv.tz) < now.getTime();
  const wall = now instanceof Date ? tableRepeatToday(repeat.tz, now) : now;
  const nowAt = wallToDate(wall);
  if (!nowAt) return false;
  if (iv && wallKind(wall) === 'datetime') return due.getTime() < nowAt.getTime();
  return dayNumber(due) < dayNumber(nowAt);
}

/** An upcoming occurrence: a scheduled day. */
export type TableRepeatItem = {
  kind: 'date';
  occurrence: string;
};

/** Up to `limit` upcoming occurrences from `current` (inclusive). */
export function upcomingTableRepeatItems(
  repeat: TableRepeat,
  limit: number
): TableRepeatResult<TableRepeatItem[]> {
  const compiled = compile(repeat);
  if (!compiled.ok) return compiled;
  const series = compiled.value;
  const out: TableRepeatItem[] = [];
  let at: Date | null = wallToDate(repeat.current)!;
  const max = Math.min(Math.max(0, Math.floor(limit)), TABLE_REPEAT_SCAN_LIMIT);
  while (at && out.length < max) {
    out.push({ kind: 'date', occurrence: dateToWall(at, series.kind) });
    at = nextAfter(series, at);
  }
  return { ok: true, value: out };
}

/**
 * Why `repeat` can't be written, or null: everything
 * {@link tableRepeatProblem} checks, plus the write-only guards that keep an
 * agent from authoring a rule the UI never offers.
 *
 * BYMONTH is "only in these months", which only makes sense on a yearly rule
 * ("every year in March"). On anything else it silently narrows the series
 * — a monthly rule with BYMONTH=3 fires once a year, not monthly — so it is
 * rejected at write time. The general validator still ACCEPTS it so older
 * stored rules keep reading; this guard only blocks new writes.
 */
export function tableRepeatWriteProblem(repeat: TableRepeat): string | null {
  const base = tableRepeatProblem(repeat);
  if (base) return base;
  const parts = splitRuleParts(repeat.rrule);
  if (parts.ok && parts.value.has('BYMONTH') && parts.value.get('FREQ') !== 'YEARLY') {
    return 'BYMONTH (only in certain months) needs FREQ=YEARLY — on any other frequency it narrows the repeat to once a year.';
  }
  return null;
}

/**
 * The first day `rrule` lands on at or after `from` (a wall date or
 * date-time, whose time of day it keeps), or null when its Ends come first.
 * The repeat editor starts a series there, so a Wednesday cell set to "Tue
 * and Thu" starts on Thursday rather than on an extra Wednesday.
 */
export function tableRepeatFirstOn(rrule: string, from: string): string | null {
  const rule = normalizeRepeatRule(rrule);
  const kind = wallKind(from);
  const start = wallToDate(from);
  if (!rule.ok || !kind || !start) return null;
  const options: Partial<RRuleOptions> = rruleLib.RRule.parseString(rule.value);
  options.dtstart = start;
  options.tzid = null;
  const until = options.until;
  options.until = null;
  options.count = null;
  const first = new rruleLib.RRule(options).after(new Date(start.getTime() - 1000), false);
  if (!first) return null;
  const untilPart = /(?:^|;)UNTIL=([^;]+)/.exec(rule.value)?.[1];
  if (until && untilPart) {
    const last = untilPart.includes('T')
      ? until.getTime()
      : startOfDay(until).getTime() + DAY_MS - 1000;
    if (first.getTime() > last) return null;
  }
  return dateToWall(first, kind);
}
