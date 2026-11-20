/**
 * Automation timing: the pure rules for an automation's `when`. No
 * I/O, no DB.
 *
 * - {@link normalizeAutomationWhen} turns what an agent or person wrote
 *   (`{in}`, `{at}`, `{repeat, at, starts?}`, `{every, at?}`,
 *   `{every, window_start, window_end}`, `{first_open, after?}`) into the
 *   stored shape, with the tool's exact error texts.
 * - {@link nextWindowedIntervalRun} / {@link isWithinIntervalWindow} keep an
 *   interval to its daily window (wall clock in its zone).
 * - {@link nextRepeatRun} / {@link repeatRunsBetween} expand a repeat with the
 *   shared tableRecurrence engine in wall-clock time (DST safe): the series
 *   starts at the rule's first match on or after `startsOn` at `timeOfDay`.
 * - {@link nextFirstOpenRun} / {@link firstOpenTick} decide when a
 *   first-open wake runs: once a local day, at the first scheduler tick at or
 *   after its `after` time.
 * - {@link describeAutomationWhen} says the timing in words; the quick-choice
 *   helpers back the Edit form's Repeat choices.
 */
import * as rruleModule from 'rrule';
import {
  AUTOMATION_FIRST_OPEN_DEFAULT_AFTER,
  type AutomationWhen,
  type AutomationWhenInput,
} from '../types/automations';
import { tableDateTimeToUtc } from './tableDateTime';
import {
  describeTableRepeat,
  nextRepeatOccurrence,
  normalizeRepeatRule,
  skipTableRepeatToUpcoming,
  type TableRepeat,
} from './tableRecurrence';

// rrule ships CommonJS beside ESM; take whichever namespace has the exports
// (same interop as tableRecurrence.ts).
const rruleLib = (
  Reflect.get(rruleModule, 'RRule') ? rruleModule : Reflect.get(rruleModule, 'default')
) as typeof rruleModule;

const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;
/** Longest interval: 7 days. */
export const AUTOMATION_MAX_EVERY_MS = 7 * DAY_MS;
/** A person's interval floor: one minute (the schedules floor). */
export const AUTOMATION_HUMAN_MIN_EVERY_MS = MINUTE_MS;
/**
 * The agents' interval floor with a short window
 * ({@link AUTOMATION_SHORT_WINDOW_MAX_MS} at most): five minutes, or their
 * usual floor when that is lower.
 */
export const AUTOMATION_WINDOWED_MIN_EVERY_MS = 5 * MINUTE_MS;
/** The longest window that earns the windowed floor: two hours. */
export const AUTOMATION_SHORT_WINDOW_MAX_MS = 2 * HOUR_MS;

const WALL_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const WALL_LOCAL = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/;
const TIME_OF_DAY = /^([01]\d|2[0-3]):([0-5]\d)$/;
const DURATION = /^([1-9]\d{0,5})(m|h|d)$/;
const ZONE_NAME = /^[A-Za-z][A-Za-z0-9_+\-/]*$/;

export type AutomationWhenResult =
  | { ok: true; value: AutomationWhen }
  | { ok: false; error: string };

/** Whether the runtime knows `zone` (an IANA name). */
export function isKnownTimeZone(zone: string): boolean {
  if (!ZONE_NAME.test(zone)) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone });
    return tableDateTimeToUtc('2026-01-01T00:00:00', zone) !== null;
  } catch {
    return false;
  }
}

/** `30m` / `2h` / `1d` → milliseconds, or null. */
export function parseAutomationDuration(text: unknown): number | null {
  if (typeof text !== 'string') return null;
  const m = DURATION.exec(text.trim().toLowerCase());
  if (!m) return null;
  const n = Number(m[1]);
  return n * (m[2] === 'm' ? MINUTE_MS : m[2] === 'h' ? HOUR_MS : DAY_MS);
}

/** Milliseconds → the shortest `15m` / `2h` / `1d` form that is exact. */
export function formatAutomationDuration(ms: number): string {
  if (ms % DAY_MS === 0) return `${ms / DAY_MS}d`;
  if (ms % HOUR_MS === 0) return `${ms / HOUR_MS}h`;
  return `${Math.round(ms / MINUTE_MS)}m`;
}

function pad(n: number, width = 2): string {
  return String(n).padStart(width, '0');
}

const wallFormatters = new Map<string, Intl.DateTimeFormat>();

/** The wall clock in `tz` at `instant`, as `YYYY-MM-DDTHH:MM:SS`. */
export function instantToWallTime(instant: Date, tz: string): string {
  let formatter = wallFormatters.get(tz);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-CA', {
      timeZone: tz,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    });
    wallFormatters.set(tz, formatter);
  }
  const parts: Record<string, string> = {};
  for (const part of formatter.formatToParts(instant)) parts[part.type] = part.value;
  return `${parts.year}-${parts.month}-${parts.day}T${pad(Number(parts.hour) % 24)}:${parts.minute}:${parts.second}`;
}

/** The instant a wall time (`YYYY-MM-DDTHH:MM[:SS]`) names in `tz`; gaps resolve forward (02:30 → 03:30). */
export function wallTimeToInstant(wall: string, tz: string): Date | null {
  const utc = tableDateTimeToUtc(wall, tz);
  return utc ? new Date(utc) : null;
}

function validDate(text: string): boolean {
  const m = WALL_DATE.exec(text);
  if (!m) return false;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return d.getUTCMonth() === Number(m[2]) - 1 && d.getUTCDate() === Number(m[3]);
}

/** Wall time → a Date whose UTC fields are the wall-clock fields (rrule's floating time). */
function wallClock(wall: string): Date {
  const m = WALL_LOCAL.exec(wall)!;
  return new Date(
    Date.UTC(
      Number(m[1]),
      Number(m[2]) - 1,
      Number(m[3]),
      Number(m[4]),
      Number(m[5]),
      Number(m[6] ?? 0)
    )
  );
}

function clockToWall(clock: Date): string {
  return `${pad(clock.getUTCFullYear(), 4)}-${pad(clock.getUTCMonth() + 1)}-${pad(clock.getUTCDate())}T${pad(clock.getUTCHours())}:${pad(clock.getUTCMinutes())}:${pad(clock.getUTCSeconds())}`;
}

export interface RepeatTiming {
  rrule: string;
  /** HH:mm */
  timeOfDay: string;
  /** YYYY-MM-DD */
  startsOn: string;
}

/**
 * The series as the tableRecurrence engine sees it, anchored on the rule's
 * first match on or after `startsOn` at `timeOfDay` (the engine would
 * otherwise treat a non-matching start as an extra first occurrence), or null
 * when the rule has no occurrence from there (UNTIL already past).
 */
export function repeatSeries(timing: RepeatTiming, tz: string): TableRepeat | null {
  const rule = normalizeRepeatRule(timing.rrule);
  if (!rule.ok) throw new Error(rule.error);
  if (!validDate(timing.startsOn) || !TIME_OF_DAY.test(timing.timeOfDay)) {
    throw new Error('A repeat needs a start day (YYYY-MM-DD) and a time (HH:mm).');
  }
  const start = wallClock(`${timing.startsOn}T${timing.timeOfDay}:00`);
  const options = rruleLib.RRule.parseString(rule.value);
  options.dtstart = start;
  options.tzid = null;
  const untilPart = /(?:^|;)UNTIL=([^;]+)/.exec(rule.value)?.[1];
  if (options.until && untilPart && !untilPart.includes('T')) {
    // A date-only UNTIL covers the whole of that day (as the engine reads it).
    const u = options.until;
    options.until = new Date(
      Date.UTC(u.getUTCFullYear(), u.getUTCMonth(), u.getUTCDate()) + DAY_MS - 1000
    );
  }
  const first = new rruleLib.RRule(options).after(new Date(start.getTime() - 1000), false);
  if (!first) return null;
  const anchor = clockToWall(first);
  return { rrule: rule.value, dtstart: anchor, current: anchor, tz };
}

/** The repeat's first wake strictly after `after`, or null when the series has ended. */
export function nextRepeatRun(timing: RepeatTiming, tz: string, after: Date): Date | null {
  const series = repeatSeries(timing, tz);
  if (!series) return null;
  // Walk in wall time to a day before `after` (a wall time skipped by a
  // spring-forward maps an hour later, so a plain wall cut could drop it),
  // then step on by instant. Rules are at most daily, so a few steps do.
  const skipped = skipTableRepeatToUpcoming(
    series,
    instantToWallTime(new Date(after.getTime() - DAY_MS), tz)
  );
  if (!skipped.ok) throw new Error(skipped.error);
  let current: TableRepeat | null = skipped.value.next;
  for (let step = 0; current && step < 8; step += 1) {
    const at = wallTimeToInstant(current.current, tz);
    if (at && at.getTime() > after.getTime()) return at;
    const next = nextRepeatOccurrence(current);
    if (!next.ok) throw new Error(next.error);
    current = next.value ? { ...current, current: next.value } : null;
  }
  return null;
}

/** Wakes of a repeat in [from, to), oldest first, at most `limit`. */
export function repeatRunsBetween(
  timing: RepeatTiming,
  tz: string,
  from: Date,
  to: Date,
  limit: number
): Date[] {
  const out: Date[] = [];
  let cursor = new Date(from.getTime() - 1);
  while (out.length < limit) {
    const next = nextRepeatRun(timing, tz, cursor);
    if (!next || next.getTime() >= to.getTime()) break;
    out.push(next);
    cursor = next;
  }
  return out;
}

/**
 * An interval's daily window: HH:mm wall-clock times in its zone. Runs fall
 * at `start`, then every interval, up to and including `end`; an `end`
 * before `start` crosses midnight.
 */
export interface IntervalWindow {
  start: string;
  end: string;
}

/** A stored interval's window, or null when it has none (it needs both ends). */
export function intervalWindowOf(value: {
  windowStart?: string | null;
  windowEnd?: string | null;
}): IntervalWindow | null {
  return value.windowStart && value.windowEnd
    ? { start: value.windowStart, end: value.windowEnd }
    : null;
}

function minuteOfDay(time: string): number {
  return Number(time.slice(0, 2)) * 60 + Number(time.slice(3, 5));
}

function assertWindow(window: IntervalWindow): void {
  if (
    !TIME_OF_DAY.test(window.start) ||
    !TIME_OF_DAY.test(window.end) ||
    window.start === window.end
  ) {
    throw new Error('An interval window needs two different times (HH:mm).');
  }
}

/** How long the window is open, in milliseconds (one crossing midnight wraps). */
export function intervalWindowMs(window: IntervalWindow): number {
  const span = minuteOfDay(window.end) - minuteOfDay(window.start);
  return (span > 0 ? span : span + 24 * 60) * MINUTE_MS;
}

function addDays(day: string, days: number): string {
  const date = new Date(`${day}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

/**
 * The instants the window that opens on `day` (YYYY-MM-DD in `tz`) opens and
 * closes, or null when it does not open that day: a daylight-saving change
 * can move its start past its end (02:30–03:00 on a spring-forward day runs
 * from 03:30, after 03:00), and then it is skipped. One end before the other
 * on the wall clock closes the next day.
 */
function windowBounds(
  day: string,
  window: IntervalWindow,
  tz: string
): { open: number; close: number } | null {
  const crosses = window.end < window.start;
  const open = wallTimeToInstant(`${day}T${window.start}:00`, tz);
  const close = wallTimeToInstant(`${crosses ? addDays(day, 1) : day}T${window.end}:00`, tz);
  if (!open || !close || open.getTime() > close.getTime()) return null;
  return { open: open.getTime(), close: close.getTime() };
}

/**
 * Whether `instant` is inside one of the window's openings (both ends
 * included), the same openings {@link nextWindowedIntervalRun} runs in, so
 * the two agree on daylight-saving change days too.
 */
export function isWithinIntervalWindow(instant: Date, window: IntervalWindow, tz: string): boolean {
  assertWindow(window);
  const at = instant.getTime();
  const today = instantToWallTime(instant, tz).slice(0, 10);
  // Yesterday's opening too: one crossing midnight is still open after it.
  return [-1, 0].some((offset) => {
    const bounds = windowBounds(addDays(today, offset), window, tz);
    return bounds !== null && at >= bounds.open && at <= bounds.close;
  });
}

/**
 * The first run of a windowed interval strictly after `after`. Each day the
 * window opens at `start` (wall clock in `tz`); runs fall on start + k * every
 * up to and including `end`, and after the last one the next is the next
 * window's start. A window crossing midnight belongs to the day it opens.
 */
export function nextWindowedIntervalRun(
  everyMs: number,
  window: IntervalWindow,
  tz: string,
  after: Date
): Date {
  assertWindow(window);
  if (!Number.isFinite(everyMs) || everyMs <= 0) throw new Error('Interval must be positive.');
  const at = after.getTime();
  const today = instantToWallTime(after, tz).slice(0, 10);
  // Yesterday's window first: one crossing midnight may still be open.
  for (let offset = -1; offset <= 3; offset += 1) {
    const bounds = windowBounds(addDays(today, offset), window, tz);
    if (!bounds) continue;
    if (bounds.open > at) return new Date(bounds.open);
    const next = bounds.open + (Math.floor((at - bounds.open) / everyMs) + 1) * everyMs;
    if (next <= bounds.close) return new Date(next);
  }
  throw new Error('Could not calculate the next run in the interval window.');
}

// First open of the day

/** The instant `after` (HH:mm) names on the local day of `instant` in `tz`; a gap resolves forward. */
export function firstOpenSlot(after: string, tz: string, instant: Date): Date {
  if (!TIME_OF_DAY.test(after)) throw new Error('A first-open time must use HH:mm.');
  const day = instantToWallTime(instant, tz).slice(0, 10);
  const slot = wallTimeToInstant(`${day}T${after}:00`, tz);
  if (!slot) throw new Error('Could not calculate the first-open time.');
  return slot;
}

/**
 * The first `after` strictly after `instant`: today's while it is still
 * ahead, else the next day's. A first-open wake is due from then on.
 */
export function nextFirstOpenRun(after: string, tz: string, instant: Date): Date {
  if (!TIME_OF_DAY.test(after)) throw new Error('A first-open time must use HH:mm.');
  const today = instantToWallTime(instant, tz).slice(0, 10);
  for (let offset = 0; offset <= 2; offset += 1) {
    const slot = wallTimeToInstant(`${addDays(today, offset)}T${after}:00`, tz);
    if (slot && slot.getTime() > instant.getTime()) return slot;
  }
  throw new Error('Could not calculate the next first-open time.');
}

/** The local day of `instant` in `tz`, as the instants it starts and ends (exclusive). */
export function localDayBounds(instant: Date, tz: string): { start: Date; end: Date } {
  const day = instantToWallTime(instant, tz).slice(0, 10);
  const start = wallTimeToInstant(`${day}T00:00:00`, tz);
  const end = wallTimeToInstant(`${addDays(day, 1)}T00:00:00`, tz);
  if (!start || !end) throw new Error('Could not calculate the local day.');
  return { start, end };
}

/**
 * What a scheduler tick does with a due first-open wake: run it now, claimed
 * for today's `slot` (its `after`, one key a day), or wait until `nextRunAt`.
 */
export type FirstOpenTick = { run: true; slot: Date } | { run: false; nextRunAt: Date };

/**
 * A due first-open wake at a scheduler tick at `now` (Snaglet is running and the
 * machine is awake): it runs when `now` is at or after today's `after` and it
 * has not run today (`ranToday`, the caller's ledger). Before `after` it
 * waits for today's; once it ran, for tomorrow's. Nothing looks back, so a
 * day Snaglet was never open is not caught up.
 */
export function firstOpenTick(
  after: string,
  tz: string,
  now: Date,
  ranToday: boolean
): FirstOpenTick {
  const slot = firstOpenSlot(after, tz, now);
  if (now.getTime() < slot.getTime()) return { run: false, nextRunAt: slot };
  if (ranToday) return { run: false, nextRunAt: nextFirstOpenRun(after, tz, now) };
  return { run: true, slot };
}

export interface NormalizeWhenOptions {
  now: Date;
  /** Used when the input names no `tz`. */
  defaultTz: string;
  /** The interval floor for this caller (agents 15 min by default, people 1 min). */
  minEveryMs: number;
  /** The agents' floor, for the error text. */
  agentMinEveryMs: number;
}

const EXACTLY_ONE = 'when must have exactly one of in, at, repeat, every, first_open.';
const BAD_IN = 'in must look like "30m", "2h" or "1d".';
const BAD_AT = 'at must be a local date-time like "2026-10-14T09:00".';
const IN_PAST = 'That time is in the past.';
const REPEAT_NEEDS_AT = 'repeat needs at, e.g. {repeat:"FREQ=DAILY", at:"09:00"}.';
const BAD_STARTS = 'starts must be a date like "2026-10-14".';
const BAD_EVERY = 'every must look like "15m", "2h" or "1d".';
const NO_RUNS = 'That repeat has no runs left.';
const WINDOW_NEEDS_EVERY = 'window_start and window_end work only with every.';
const WINDOW_PAIR =
  'A window needs both window_start and window_end, e.g. {every:"5m", window_start:"05:05", window_end:"06:00"}.';
const BAD_WINDOW_START = 'window_start must be a time like "05:05".';
const BAD_WINDOW_END = 'window_end must be a time like "06:00".';
const WINDOW_EMPTY = 'window_start and window_end must differ.';
const WINDOW_WITH_AT = 'every with a window runs from window_start each day; leave out at.';
const WINDOW_EVERY_MAX = 'every with a window must be under 1d (the window repeats each day).';
const BAD_FIRST_OPEN = 'first_open must be true, e.g. {first_open:true, after:"05:00"}.';
const BAD_AFTER = 'after must be a time like "05:00".';
const AFTER_NEEDS_FIRST_OPEN = 'after works only with first_open.';

/**
 * Why a stored interval is under the caller's floor (an agent or an external
 * client enabling one whose timing a rollback or a raised floor left too
 * short), or null when it is not, or is no interval.
 */
export function automationFloorError(
  when: AutomationWhen,
  options: Pick<NormalizeWhenOptions, 'minEveryMs' | 'agentMinEveryMs'>
): string | null {
  if (when.kind !== 'interval') return null;
  return everyFloorError(when.everyMs, intervalWindowOf(when), options);
}

/**
 * Why `ms` is under the caller's interval floor, or null when it is not. The
 * floor is the caller's (`minEveryMs`); a window of at most 2h lowers it to
 * 5m (never raises it), so a short interval always has an end each day.
 */
function everyFloorError(
  ms: number,
  window: IntervalWindow | null,
  options: Pick<NormalizeWhenOptions, 'minEveryMs' | 'agentMinEveryMs'>
): string | null {
  const shortWindow = window !== null && intervalWindowMs(window) <= AUTOMATION_SHORT_WINDOW_MAX_MS;
  const windowedFloor = Math.min(options.minEveryMs, AUTOMATION_WINDOWED_MIN_EVERY_MS);
  if (ms >= (shortWindow ? windowedFloor : options.minEveryMs)) return null;
  const people = formatAutomationDuration(AUTOMATION_HUMAN_MIN_EVERY_MS);
  if (shortWindow) {
    return `every must be at least ${formatAutomationDuration(windowedFloor)} for agents, even with a window (${people} for people).`;
  }
  const floor = `every must be at least ${formatAutomationDuration(options.agentMinEveryMs)} for agents (${people} for people).`;
  const agentWindowedFloor = Math.min(options.agentMinEveryMs, AUTOMATION_WINDOWED_MIN_EVERY_MS);
  if (agentWindowedFloor >= options.agentMinEveryMs) return floor;
  return `${floor} Down to ${formatAutomationDuration(agentWindowedFloor)} works with a window of at most ${formatAutomationDuration(AUTOMATION_SHORT_WINDOW_MAX_MS)}: add window_start and window_end, e.g. "05:05" and "06:00".`;
}

/**
 * Validates and normalizes a `when`. `in` and `at` become a once at an
 * absolute instant; `repeat` keeps its normalized RRULE body, time of day and
 * start day; `every` becomes milliseconds (with `at`, an anchor instant);
 * `first_open` keeps its earliest time (`after`, default 05:00).
 */
export function normalizeAutomationWhen(
  raw: unknown,
  options: NormalizeWhenOptions
): AutomationWhenResult {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw))
    return { ok: false, error: EXACTLY_ONE };
  const input = raw as AutomationWhenInput & Record<string, unknown>;
  const has = (key: string) => input[key] !== undefined && input[key] !== null;
  const shapes = ['in', 'repeat', 'every', 'first_open'].filter(has);
  if (has('at') && !has('repeat') && !has('every')) shapes.push('at');
  if (shapes.length !== 1) return { ok: false, error: EXACTLY_ONE };
  if (has('starts') && !has('repeat')) return { ok: false, error: EXACTLY_ONE };
  const windowed = has('window_start') || has('window_end');
  if (windowed && !has('every')) return { ok: false, error: WINDOW_NEEDS_EVERY };
  if (has('after') && !has('first_open')) return { ok: false, error: AFTER_NEEDS_FIRST_OPEN };

  let tz = options.defaultTz;
  if (has('tz')) {
    if (typeof input.tz !== 'string' || !isKnownTimeZone(input.tz.trim())) {
      return { ok: false, error: `Unknown time zone "${String(input.tz)}".` };
    }
    tz = input.tz.trim();
  }
  const shape = shapes[0];

  if (shape === 'first_open') {
    if (input.first_open !== true) return { ok: false, error: BAD_FIRST_OPEN };
    let after = AUTOMATION_FIRST_OPEN_DEFAULT_AFTER;
    if (has('after')) {
      const text = typeof input.after === 'string' ? input.after.trim() : '';
      if (!TIME_OF_DAY.test(text)) return { ok: false, error: BAD_AFTER };
      after = text;
    }
    return { ok: true, value: { kind: 'first_open', after, tz } };
  }

  if (shape === 'in') {
    const ms = parseAutomationDuration(input.in);
    if (ms === null) return { ok: false, error: BAD_IN };
    return {
      ok: true,
      value: { kind: 'once', at: new Date(options.now.getTime() + ms).toISOString(), tz },
    };
  }

  /** `at` as an instant in `tz`, or null when it is not a valid local date-time. */
  const parseAt = (): Date | null => {
    const m = WALL_LOCAL.exec(typeof input.at === 'string' ? input.at.trim() : '');
    if (!m || !validDate(`${m[1]}-${m[2]}-${m[3]}`) || Number(m[4]) > 23 || Number(m[5]) > 59) {
      return null;
    }
    return wallTimeToInstant(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6] ?? '00'}`, tz);
  };

  if (shape === 'at') {
    const at = parseAt();
    if (!at) return { ok: false, error: BAD_AT };
    if (at.getTime() <= options.now.getTime()) return { ok: false, error: IN_PAST };
    return { ok: true, value: { kind: 'once', at: at.toISOString(), tz } };
  }

  if (shape === 'every') {
    const ms = parseAutomationDuration(input.every);
    if (ms === null) return { ok: false, error: BAD_EVERY };
    let window: IntervalWindow | null = null;
    if (windowed) {
      if (!has('window_start') || !has('window_end')) return { ok: false, error: WINDOW_PAIR };
      const start = typeof input.window_start === 'string' ? input.window_start.trim() : '';
      const end = typeof input.window_end === 'string' ? input.window_end.trim() : '';
      if (!TIME_OF_DAY.test(start)) return { ok: false, error: BAD_WINDOW_START };
      if (!TIME_OF_DAY.test(end)) return { ok: false, error: BAD_WINDOW_END };
      if (start === end) return { ok: false, error: WINDOW_EMPTY };
      if (has('at')) return { ok: false, error: WINDOW_WITH_AT };
      window = { start, end };
    }
    const floorError = everyFloorError(ms, window, options);
    if (floorError) return { ok: false, error: floorError };
    if (ms > AUTOMATION_MAX_EVERY_MS) return { ok: false, error: 'every must be at most 7d.' };
    if (window) {
      if (ms >= DAY_MS) return { ok: false, error: WINDOW_EVERY_MAX };
      return {
        ok: true,
        value: {
          kind: 'interval',
          everyMs: ms,
          tz,
          windowStart: window.start,
          windowEnd: window.end,
        },
      };
    }
    if (!has('at')) return { ok: true, value: { kind: 'interval', everyMs: ms, tz } };
    // `at` anchors the interval: runs fall on at + k * every (a past anchor
    // aligns to the next slot, a future one is the first run).
    const anchor = parseAt();
    if (!anchor) return { ok: false, error: BAD_AT };
    return {
      ok: true,
      value: { kind: 'interval', everyMs: ms, tz, anchor: anchor.toISOString() },
    };
  }

  // repeat
  if (typeof input.repeat !== 'string') {
    return { ok: false, error: 'repeat: Repeat rule must be a string.' };
  }
  const rule = normalizeRepeatRule(input.repeat);
  if (!rule.ok) return { ok: false, error: `repeat: ${rule.error}` };
  const time = typeof input.at === 'string' ? input.at.trim() : '';
  if (!TIME_OF_DAY.test(time)) return { ok: false, error: REPEAT_NEEDS_AT };
  let startsOn = instantToWallTime(options.now, tz).slice(0, 10);
  if (has('starts')) {
    if (typeof input.starts !== 'string' || !validDate(input.starts.trim())) {
      return { ok: false, error: BAD_STARTS };
    }
    startsOn = input.starts.trim();
  }
  const timing: RepeatTiming = { rrule: rule.value, timeOfDay: time, startsOn };
  let next: Date | null;
  try {
    next = nextRepeatRun(timing, tz, options.now);
  } catch (error) {
    return { ok: false, error: `repeat: ${(error as Error).message}` };
  }
  if (!next) return { ok: false, error: NO_RUNS };
  return { ok: true, value: { kind: 'repeat', ...timing, tz } };
}

/**
 * The next wake of `when` strictly after `after` (intervals: from `anchor`,
 * or inside their window when they have one; first-open: the next time it
 * may run, its next `after`), or null.
 */
export function nextAutomationRun(when: AutomationWhen, after: Date, anchor?: Date): Date | null {
  if (when.kind === 'once') {
    const at = new Date(when.at);
    return at.getTime() > after.getTime() ? at : null;
  }
  if (when.kind === 'repeat') return nextRepeatRun(when, when.tz, after);
  if (when.kind === 'first_open') return nextFirstOpenRun(when.after, when.tz, after);
  const window = intervalWindowOf(when);
  if (window) return nextWindowedIntervalRun(when.everyMs, window, when.tz, after);
  const start = anchor ?? (when.anchor ? new Date(when.anchor) : after);
  if (start.getTime() > after.getTime()) return start;
  const elapsed = after.getTime() - start.getTime();
  return new Date(start.getTime() + (Math.floor(elapsed / when.everyMs) + 1) * when.everyMs);
}

function plural(n: number, unit: string): string {
  return n === 1 ? `every ${unit}` : `every ${n} ${unit}s`;
}

/** An interval in words: "every 15 minutes", "every hour", "every 2 days". */
export function describeEvery(ms: number): string {
  if (ms % DAY_MS === 0) return plural(ms / DAY_MS, 'day');
  if (ms % HOUR_MS === 0) return plural(ms / HOUR_MS, 'hour');
  return plural(Math.round(ms / MINUTE_MS), 'minute');
}

/** A repeat's rule in words, e.g. "every weekday", "every month on the 14th". */
export function describeRepeatRule(rrule: string): string {
  const rule = normalizeRepeatRule(rrule);
  if (!rule.ok) return 'repeats';
  const text = describeTableRepeat({
    rrule: rule.value,
    dtstart: '2026-01-05T09:00:00',
    current: '2026-01-05T09:00:00',
    tz: 'UTC',
  });
  return text.ok ? text.value : 'repeats';
}

const INSTANT_FIELDS: Intl.DateTimeFormatOptions = {
  weekday: 'short',
  month: 'short',
  day: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
};

/**
 * An instant as the wall clock in `tz` with the zone's short name, e.g.
 * "Tue, Oct 13, 1:50 PM PDT" (a zone without one reads "GMT+2").
 */
export function formatAutomationInstant(instant: Date | string, tz: string): string {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    ...INSTANT_FIELDS,
    timeZoneName: 'short',
  }).format(new Date(instant));
}

/**
 * A wall-clock "HH:mm" on the 12-hour clock the app shows times in (next
 * runs, the calendar): "05:05" → "5:05 AM", "00:30" → "12:30 AM". Anything
 * else (a time still being typed) comes back as it is.
 */
export function formatTimeOfDay(hhmm: string): string {
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(hhmm);
  if (!m) return hhmm;
  const hour = Number(m[1]);
  return `${hour % 12 === 0 ? 12 : hour % 12}:${m[2]} ${hour < 12 ? 'AM' : 'PM'}`;
}

export interface DescribeAutomationWhenOptions {
  /**
   * Always name the zone: a once ends with its short name ("… 1:50 PM PDT"),
   * a repeat with its IANA zone (a short name would be wrong across DST).
   */
  namedZone?: boolean;
}

/**
 * The timing in words, the one describer every surface uses (the record's
 * `whenText`, the agent tool, the Automations list): "once on Wed, Oct 14,
 * 9:00 AM", "every weekday at 9:00 AM", "every 15 minutes", "every 5 minutes
 * from 5:05 AM to 6:00 AM", "when Snaglet first opens, after 5:00 AM". Times are
 * on the 12-hour clock (`formatTimeOfDay`). The zone of a wall-clock time is
 * named when it differs from `viewerTz`, or always with `namedZone`.
 */
export function describeAutomationWhen(
  when: AutomationWhen,
  viewerTz?: string,
  options: DescribeAutomationWhenOptions = {}
): string {
  if (when.kind === 'first_open') {
    const zone = options.namedZone || (viewerTz && viewerTz !== when.tz) ? ` (${when.tz})` : '';
    return `when Snaglet first opens, after ${formatTimeOfDay(when.after)}${zone}`;
  }
  if (when.kind === 'interval') {
    const window = intervalWindowOf(when);
    if (!window) return describeEvery(when.everyMs);
    const zone = options.namedZone || (viewerTz && viewerTz !== when.tz) ? ` (${when.tz})` : '';
    const from = `${formatTimeOfDay(window.start)} to ${formatTimeOfDay(window.end)}`;
    return `${describeEvery(when.everyMs)} from ${from}${zone}`;
  }
  if (options.namedZone) {
    return when.kind === 'repeat'
      ? `${describeRepeatRule(when.rrule)} at ${formatTimeOfDay(when.timeOfDay)} (${when.tz})`
      : `once on ${formatAutomationInstant(when.at, when.tz)}`;
  }
  const zone = viewerTz && viewerTz !== when.tz ? ` (${when.tz})` : '';
  if (when.kind === 'repeat')
    return `${describeRepeatRule(when.rrule)} at ${formatTimeOfDay(when.timeOfDay)}${zone}`;
  const text = new Intl.DateTimeFormat('en-US', { timeZone: when.tz, ...INSTANT_FIELDS }).format(
    new Date(when.at)
  );
  return `once on ${text}${zone}`;
}

// Edit form quick choices

export type RepeatQuickChoice = 'daily' | 'weekdays' | 'weekly' | 'monthly';
export const REPEAT_WEEKDAY_CODES = ['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU'] as const;
export type RepeatWeekdayCode = (typeof REPEAT_WEEKDAY_CODES)[number];

export interface RepeatQuick {
  choice: RepeatQuickChoice;
  /** weekly: the day. */
  weekday?: RepeatWeekdayCode;
  /** monthly: the date, 1–31. */
  monthDay?: number;
}

/** The RRULE body for a quick choice. */
export function quickRepeatRule(quick: RepeatQuick): string {
  switch (quick.choice) {
    case 'daily':
      return 'FREQ=DAILY';
    case 'weekdays':
      return 'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR';
    case 'weekly':
      return `FREQ=WEEKLY;BYDAY=${quick.weekday ?? 'MO'}`;
    case 'monthly':
      return `FREQ=MONTHLY;BYMONTHDAY=${Math.min(31, Math.max(1, Math.trunc(quick.monthDay ?? 1)))}`;
  }
}

/** The quick choice a rule is, or null when it is anything else (shown read-only). */
export function matchQuickRepeat(rrule: string): RepeatQuick | null {
  const rule = normalizeRepeatRule(rrule);
  if (!rule.ok) return null;
  const value = rule.value;
  if (value === 'FREQ=DAILY') return { choice: 'daily' };
  if (value === 'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR') return { choice: 'weekdays' };
  const weekly = /^FREQ=WEEKLY;BYDAY=(MO|TU|WE|TH|FR|SA|SU)$/.exec(value);
  if (weekly) return { choice: 'weekly', weekday: weekly[1] as RepeatWeekdayCode };
  const monthly = /^FREQ=MONTHLY;BYMONTHDAY=([1-9]|[12]\d|3[01])$/.exec(value);
  if (monthly) return { choice: 'monthly', monthDay: Number(monthly[1]) };
  return null;
}
