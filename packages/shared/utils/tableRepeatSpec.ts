/**
 * The repeat editor's model (docs/architecture.md): a plain draft of what the
 * person picks — set days (the period and its days) or an interval, and
 * Ends — and its round trip to the stored {@link TableRepeat}. Every
 * sentence the UI shows comes from here, so the editor, the grid, the
 * calendar and the agent tools say the same thing.
 *
 * Dates are wall values (`YYYY-MM-DD`, or `YYYY-MM-DDTHH:MM:SS` on datetime
 * fields), read field by field; the series math is the engine's.
 */
import { capitalize } from './strings';
import {
  createTableRepeat,
  describeTableRepeat,
  formatRepeatInterval,
  intervalRepeatRule,
  repeatIntervalProblem,
  tableRepeatFirstOn,
  tableRepeatIntervalSeconds,
  upcomingTableRepeatItems,
  type TableRepeat,
  type TableRepeatItem,
  type TableRepeatResult,
} from './tableRecurrence';
import {
  REPEAT_WEEKDAYS,
  dayOf,
  daysInMonthOf,
  weekdayOfDay,
  type TableRepeatUnit,
  type TableRepeatWeekday,
} from './tableRepeatPeriods';

type Weekday = TableRepeatWeekday;
type Unit = TableRepeatUnit;

/**
 * - schedule ("On set days"): it shows up on chosen days, each with its own
 *   time to do it (that day, a few days, or until the next one);
 * - interval ("Every 1 h 30 min"): a fixed length of time from the cell's
 *   date and time, on datetime fields only (the editor's Custom offers it
 *   as the unit Interval: days, hours, minutes and seconds).
 */
export type RepeatMode = 'schedule' | 'interval';
/** An interval's parts as the editor shows them: days, hours, minutes, seconds. */
export interface RepeatEvery {
  days: number;
  hours: number;
  minutes: number;
  seconds: number;
}
export type RepeatMonthOn = 'dates' | 'weekday';
export type RepeatEnds =
  | { kind: 'never' }
  | { kind: 'on'; date: string }
  | { kind: 'after'; count: number };

export interface RepeatDraft {
  /** The cell's date: where the series starts. */
  anchor: string;
  mode: RepeatMode;
  interval: number;
  unit: Unit;
  weekdays: Weekday[];
  monthOn: RepeatMonthOn;
  /** Days of the month, 1–31, or -1 for the last day. */
  monthDates: number[];
  /** 1–4, or -1 for the last. */
  nth: number;
  nthDay: Weekday;
  ends: RepeatEnds;
  /** The field has an End date (a range): set days only. */
  hasEnd: boolean;
  /** Interval only: how long between occurrences. */
  every: RepeatEvery;
}

/** What a save sends: the series starts on `date`. */
export interface TableRepeatInput {
  rrule: string;
  date: string;
}

const LONG: Record<Weekday, string> = {
  MO: 'Monday',
  TU: 'Tuesday',
  WE: 'Wednesday',
  TH: 'Thursday',
  FR: 'Friday',
  SA: 'Saturday',
  SU: 'Sunday',
};
export const MONTHS_SHORT = [
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
const WORKWEEK: readonly Weekday[] = ['MO', 'TU', 'WE', 'TH', 'FR'];
const UNIT_FREQ: Record<Unit, string> = {
  day: 'DAILY',
  week: 'WEEKLY',
  month: 'MONTHLY',
  year: 'YEARLY',
};
const FREQ_UNIT: Record<string, Unit> = {
  DAILY: 'day',
  WEEKLY: 'week',
  MONTHLY: 'month',
  YEARLY: 'year',
};

export const weekdayLong = (day: Weekday) => LONG[day];
export const weekdayShort = (day: Weekday) => LONG[day].slice(0, 3);

// dates

function day(wall: string): number {
  return dayOf(wall) ?? 0;
}
const monthOf = (wall: string) => Number(wall.slice(5, 7));
const dayOfMonth = (wall: string) => Number(wall.slice(8, 10));
const yearOf = (wall: string) => Number(wall.slice(0, 4));
export const weekdayOf = (wall: string): Weekday => weekdayOfDay(day(wall));

export const fmtShort = (wall: string) => `${MONTHS_SHORT[monthOf(wall) - 1]} ${dayOfMonth(wall)}`;
export const fmtDay = (wall: string) => `${weekdayShort(weekdayOf(wall))} ${fmtShort(wall)}`;
/** `fmtDay`, plus the year when it isn't `year`. */
export const fmtDayIn = (wall: string, year: number) =>
  yearOf(wall) === year ? fmtDay(wall) : `${fmtDay(wall)}, ${yearOf(wall)}`;
export function fmtRange(start: string, end: string): string {
  if (start.slice(0, 10) === end.slice(0, 10)) return fmtShort(start);
  if (start.slice(0, 7) === end.slice(0, 7)) return `${fmtShort(start)}–${dayOfMonth(end)}`;
  return `${fmtShort(start)} – ${fmtShort(end)}`;
}
/** "9:00 AM" ("9:01:30 AM" off the minute), for a datetime occurrence; null for a date. */
export function fmtClock(wall: string): string | null {
  const m = /T(\d{2}):(\d{2})(?::(\d{2}))?/.exec(wall);
  if (!m) return null;
  const hour = Number(m[1]);
  const h = hour % 12 === 0 ? 12 : hour % 12;
  const secs = m[3] && m[3] !== '00' ? `:${m[3]}` : '';
  return `${h}:${m[2]}${secs} ${hour < 12 ? 'AM' : 'PM'}`;
}

export function ordinal(n: number): string {
  if (n === -1) return 'last';
  const tens = n % 100;
  if (tens >= 11 && tens <= 13) return `${n}th`;
  return `${n}${['th', 'st', 'nd', 'rd'][n % 10] ?? 'th'}`;
}
const dateLabel = (n: number) => (n === -1 ? 'last day' : ordinal(n));

/** Which of its weekday in the month `wall` is: 1–4, or -1 when it's the last. */
export function anchorNth(wall: string): number {
  const date = dayOfMonth(wall);
  return date + 7 > daysInMonthOf(day(wall)) ? -1 : Math.ceil(date / 7);
}

// the draft

/** A fresh draft for a cell's date: weekly on its weekday, nothing else set. */
export function repeatDraftFor(anchor: string, options: { hasEnd?: boolean } = {}): RepeatDraft {
  const date = dayOfMonth(anchor);
  return {
    anchor,
    mode: 'schedule',
    interval: 1,
    unit: 'week',
    weekdays: [weekdayOf(anchor)],
    monthOn: 'dates',
    monthDates: [date],
    nth: Math.min(4, Math.ceil(date / 7)),
    nthDay: weekdayOf(anchor),
    ends: { kind: 'never' },
    hasEnd: options.hasEnd ?? false,
    every: { days: 0, hours: 1, minutes: 0, seconds: 0 },
  };
}

/** Whether the anchor has a time of day: only then is an interval offered. */
export const repeatDraftHasTime = (s: Pick<RepeatDraft, 'anchor'>) => s.anchor.length > 10;

/** An interval's length in seconds. */
export function repeatEverySeconds(every: RepeatEvery): number {
  return every.days * 86_400 + every.hours * 3600 + every.minutes * 60 + every.seconds;
}

/** `seconds` as days, hours (0–23), minutes and seconds (0–59). */
export function repeatEveryOf(seconds: number): RepeatEvery {
  const total = Math.max(0, Math.floor(seconds));
  return {
    days: Math.floor(total / 86_400),
    hours: Math.floor((total % 86_400) / 3600),
    minutes: Math.floor((total % 3600) / 60),
    seconds: total % 60,
  };
}

/**
 * Why the draft's interval can't be saved, or null: whole numbers 0 or
 * more, together at least a second ({@link REPEAT_INTERVAL_MIN_SECONDS})
 * and at most 999 days.
 */
export function repeatDraftIntervalProblem(s: Pick<RepeatDraft, 'every'>): string | null {
  const parts = [s.every.days, s.every.hours, s.every.minutes, s.every.seconds];
  if (parts.some((n) => !Number.isInteger(n) || n < 0)) return 'Use whole numbers, 0 or more.';
  return repeatIntervalProblem(repeatEverySeconds(s.every));
}

function ruleParts(rrule: string): Map<string, string> {
  return new Map(
    rrule
      .replace(/^RRULE:/i, '')
      .split(';')
      .filter(Boolean)
      .map((part) => {
        const eq = part.indexOf('=');
        return [part.slice(0, eq).toUpperCase(), part.slice(eq + 1).toUpperCase()] as [
          string,
          string,
        ];
      })
  );
}

const untilDate = (value: string) =>
  `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}`;
const sortDates = (dates: number[]) =>
  [...new Set(dates)].sort((a, b) => (a === -1 ? 99 : a) - (b === -1 ? 99 : b));

/**
 * The draft a stored repeat reads as, at `anchor` (default: the row's
 * current occurrence). `exact` is false when the rule has parts the editor
 * can't show (an agent's BYSETPOS, a non-year BYMONTH, …); saving from the
 * editor then replaces it with what the draft says.
 */
export function repeatDraftFromRepeat(
  repeat: TableRepeat,
  options: { anchor?: string; hasEnd?: boolean } = {}
): { draft: RepeatDraft; exact: boolean } {
  const anchor = options.anchor ?? repeat.current;
  const draft = repeatDraftFor(anchor, options);
  const parts = ruleParts(repeat.rrule);
  const count = parts.get('COUNT');
  const until = parts.get('UNTIL');
  if (count) draft.ends = { kind: 'after', count: Number(count) };
  else if (until) draft.ends = { kind: 'on', date: untilDate(until) };
  const seconds = tableRepeatIntervalSeconds(repeat.rrule);
  if (seconds !== null) {
    draft.mode = 'interval';
    draft.every = repeatEveryOf(seconds);
    return { draft, exact: repeatDraftHasTime(draft) };
  }
  const unit = FREQ_UNIT[parts.get('FREQ') ?? ''];
  if (!unit) return { draft, exact: false };
  let exact = true;
  draft.unit = unit;
  draft.interval = Number(parts.get('INTERVAL') ?? '1') || 1;
  for (const key of ['BYSETPOS', 'BYYEARDAY', 'BYWEEKNO']) if (parts.has(key)) exact = false;
  // BYMONTH ("only during") is not editable: a rule carrying it on any unit
  // reads as inexact, so saving from the editor drops it.
  if (parts.has('BYMONTH')) exact = false;
  const byday = parts.get('BYDAY');
  const bymonthday = parts.get('BYMONTHDAY');

  const dtstart = repeat.dtstart;
  if (unit === 'week') {
    const days = (byday ?? weekdayOf(dtstart)).split(',');
    if (days.every((d) => REPEAT_WEEKDAYS.includes(d as Weekday)))
      draft.weekdays = days as Weekday[];
    else exact = false;
    if (bymonthday !== undefined) exact = false;
    // Weeks start on Monday. Every few weeks from another week start (an
    // older rule's WKST) lands in other weeks, so saving would move it.
    const wkst = parts.get('WKST');
    if (draft.interval > 1 && wkst !== undefined && wkst !== 'MO') exact = false;
  } else if (unit === 'month') {
    if (byday !== undefined) {
      const m = /^([+-]?\d)(MO|TU|WE|TH|FR|SA|SU)$/.exec(byday);
      const nth = m ? Number(m[1]) : 0;
      if (!m || !(nth === -1 || (nth >= 1 && nth <= 4)) || bymonthday !== undefined) exact = false;
      else {
        draft.monthOn = 'weekday';
        draft.nth = nth;
        draft.nthDay = m[2] as Weekday;
      }
    } else {
      draft.monthOn = 'dates';
      draft.monthDates =
        bymonthday !== undefined
          ? sortDates(bymonthday.split(',').map(Number))
          : [dayOfMonth(dtstart)];
      if (draft.monthDates.some((n) => n === 0 || n < -1 || n > 31)) exact = false;
    }
  } else if (byday !== undefined || bymonthday !== undefined) {
    exact = false;
  }
  return { draft, exact };
}

function scheduleBody(s: RepeatDraft, start: string): string[] {
  const out = [`FREQ=${UNIT_FREQ[s.unit]}`];
  const interval = Math.max(1, Math.floor(s.interval || 1));
  if (interval > 1) out.push(`INTERVAL=${interval}`);
  if (s.unit === 'week') {
    const days = REPEAT_WEEKDAYS.filter((d) => s.weekdays.includes(d));
    out.push(`BYDAY=${(days.length ? days : [weekdayOf(start)]).join(',')}`);
  } else if (s.unit === 'month') {
    if (s.monthOn === 'weekday') out.push(`BYDAY=${s.nth}${s.nthDay}`);
    else {
      const dates = sortDates(s.monthDates.length ? s.monthDates : [dayOfMonth(start)]);
      out.push(`BYMONTHDAY=${dates.join(',')}`);
    }
  }
  return out;
}

function endsPart(s: RepeatDraft): string | null {
  if (s.ends.kind === 'after') return `COUNT=${Math.max(1, Math.floor(s.ends.count || 1))}`;
  if (s.ends.kind === 'on' && s.ends.date) {
    const compact = s.ends.date.slice(0, 10).replace(/-/g, '');
    return `UNTIL=${s.anchor.length > 10 ? `${compact}T235959` : compact}`;
  }
  return null;
}

const NO_DATES = 'No dates: check Ends.';

/** The first scheduled day at or after the anchor, for a rule without Ends (null = none). */
function scheduleStart(s: RepeatDraft): string | null {
  return tableRepeatFirstOn(scheduleBody(s, s.anchor).join(';'), s.anchor);
}

/** The draft with every choice inside what its other choices allow. */
export function normalizeRepeatDraft(s: RepeatDraft): RepeatDraft {
  let next = s;
  if (next.mode === 'interval' && !repeatDraftHasTime(next)) next = { ...next, mode: 'schedule' };
  return next;
}

/** What saving the draft sends, or why there is nothing to save ("No dates"). */
export function repeatInputFromDraft(input: RepeatDraft): TableRepeatResult<TableRepeatInput> {
  const s = normalizeRepeatDraft(input);
  const ends = endsPart(s);
  if (s.mode === 'interval') {
    // From the cell's date and time.
    const problem = repeatDraftIntervalProblem(s);
    if (problem) return { ok: false, error: problem };
    if (s.ends.kind === 'on' && s.ends.date.slice(0, 10) < s.anchor.slice(0, 10))
      return { ok: false, error: 'No dates: check Ends.' };
    const rule = intervalRepeatRule(repeatEverySeconds(s.every));
    return {
      ok: true,
      value: {
        rrule: ends ? `${rule};${ends}` : rule,
        date: s.anchor,
      },
    };
  }
  const start = scheduleStart(s);
  if (!start) return { ok: false, error: NO_DATES };
  const body = scheduleBody(s, start);
  // "Every month on the 12th" from a 12th is plain FREQ=MONTHLY, so All
  // upcoming can still shift it.
  if (
    s.unit === 'month' &&
    s.monthOn === 'dates' &&
    body[body.length - 1] === `BYMONTHDAY=${dayOfMonth(start)}`
  )
    body.pop();
  if (ends) body.push(ends);
  const rrule = body.join(';');
  if (ends && !tableRepeatFirstOn(rrule, start)) return { ok: false, error: NO_DATES };
  return { ok: true, value: { rrule, date: start } };
}

/** The repeat saving the draft would make (zone-free preview), or why not. */
function repeatFromDraft(s: RepeatDraft, tz = 'UTC'): TableRepeatResult<TableRepeat> {
  const input = repeatInputFromDraft(s);
  if (!input.ok) return input;
  return createTableRepeat({ ...input.value, tz });
}

/** The next `limit` scheduled days or periods of the draft ([] when none). */
export function repeatDraftUpcoming(s: RepeatDraft, limit = 4): TableRepeatItem[] {
  const repeat = repeatFromDraft(s);
  if (!repeat.ok) return [];
  const items = upcomingTableRepeatItems(repeat.value, limit);
  return items.ok ? items.value : [];
}

// wording (the prototype's sentences)

const plural = (unit: string, n: number) => (n === 1 ? unit : `${unit}s`);
const every = (s: RepeatDraft) =>
  s.interval === 1 ? `Every ${s.unit}` : `Every ${s.interval} ${s.unit}s`;

function list(items: string[], joiner: 'and' | 'or'): string {
  if (items.length <= 1) return items[0] ?? '';
  return `${items.slice(0, -1).join(', ')} ${joiner} ${items[items.length - 1]}`;
}

/** The draft's days, Monday first. */
const orderedDays = (s: RepeatDraft) => REPEAT_WEEKDAYS.filter((d) => s.weekdays.includes(d));
const orderedDates = (s: RepeatDraft) => sortDates(s.monthDates);

function dayNames(s: RepeatDraft, joiner: 'and' | 'or'): string {
  const days = orderedDays(s);
  if (days.length === 1) return weekdayLong(days[0]!);
  return list(days.map(weekdayShort), joiner);
}

/** "the 1st and 15th", "the last day". */
const dateNames = (s: RepeatDraft, joiner: 'and' | 'or') =>
  `the ${list(orderedDates(s).map(dateLabel), joiner)}`;

function lead(s: RepeatDraft): string {
  if (s.mode === 'interval') return `Every ${formatRepeatInterval(repeatEverySeconds(s.every))}`;
  if (s.unit === 'day') return every(s);
  if (s.unit === 'week') {
    const days = orderedDays(s);
    if (days.length === 7) return s.interval === 1 ? 'Every day' : `${every(s)}, every day`;
    if (days.length === 5 && WORKWEEK.every((d) => days.includes(d)))
      return s.interval === 1 ? 'Every weekday' : `${every(s)} on weekdays`;
    return `${every(s)} on ${dayNames(s, 'and')}`;
  }
  if (s.unit === 'month') {
    if (s.monthOn === 'weekday')
      return `${every(s)} on the ${ordinal(s.nth)} ${weekdayLong(s.nthDay)}`;
    return `${every(s)} on ${dateNames(s, 'and')}`;
  }
  return `${every(s)} on ${fmtShort(s.anchor)}`;
}

function endsText(s: RepeatDraft): string | null {
  const ends = s.ends;
  if (ends.kind === 'never') return null;
  if (ends.kind === 'on') {
    const sameYear = yearOf(ends.date) === yearOf(s.anchor);
    return `until ${fmtShort(ends.date)}${sameYear ? '' : `, ${yearOf(ends.date)}`}`;
  }
  return `${ends.count} ${plural('time', ends.count)}`;
}

/** The live sentence: "Twice a week, on Wed, Sat or Sun, until Dec 31". */
export function repeatDraftSummary(s: RepeatDraft): string {
  return [lead(s), endsText(s)].filter(Boolean).join(', ');
}

/**
 * A stored repeat's sentence ("Every month on the 1st"), or "Doesn’t repeat"
 * for none. A rule the editor can't show reads as the RRULE library words it.
 */
export function tableRepeatSummary(
  repeat: TableRepeat | null,
  options: { hasEnd?: boolean } = {}
): string {
  if (!repeat) return 'Doesn’t repeat';
  const { draft, exact } = repeatDraftFromRepeat(repeat, {
    ...options,
    anchor: repeat.dtstart,
  });
  if (exact) return repeatDraftSummary(draft);
  const described = describeTableRepeat(repeat);
  return described.ok ? capitalize(described.value) : 'Repeats';
}

/**
 * The grid cell's text for a repeating row: its next occurrence, with its
 * time of day ("Sun Nov 1").
 */
export function tableRepeatCellText(repeat: TableRepeat): string {
  const items = upcomingTableRepeatItems(repeat, 1);
  const next = items.ok ? items.value[0] : undefined;
  if (!next) return 'No more dates';
  const clock = fmtClock(next.occurrence);
  return clock ? `${fmtDay(next.occurrence)}, ${clock}` : fmtDay(next.occurrence);
}
