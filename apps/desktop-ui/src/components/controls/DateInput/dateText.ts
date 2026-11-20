/**
 * Typed text and locale display for the Snaglet date and time pickers.
 *
 * Values travel in the native wire formats — `YYYY-MM-DD`,
 * `YYYY-MM-DDTHH:mm[:ss[.fff]]` and `HH:mm[:ss]` — so every caller that used
 * a native `<input type="date|datetime-local|time">` keeps working. Days are
 * plain calendar strings (calendarDates): a date never passes through UTC
 * midnight, and a wall time never through a zone.
 */
import { addDays } from '@desktop/features/calendar/calendarDates';

export type PickerKind = 'date' | 'datetime-local' | 'time';

/** The time a datetime gets when only its date is typed or picked. */
export const DEFAULT_TIME = '09:00';

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const ISO_TIME = /^([01]\d|2[0-3]):([0-5]\d)(?::([0-5]\d)(\.\d{1,3})?)?$/;

const pad = (n: number) => String(n).padStart(2, '0');

function daysInMonth(year: number, month: number): number {
  const date = new Date(0);
  date.setUTCFullYear(year, month, 0);
  return date.getUTCDate();
}

/** `YYYY-MM-DD` for a real calendar day, else null. */
function ymd(year: number, month: number, day: number): string | null {
  if (!Number.isInteger(year) || year < 1 || year > 9999) return null;
  if (!Number.isInteger(month) || month < 1 || month > 12) return null;
  if (!Number.isInteger(day) || day < 1 || day > daysInMonth(year, month)) return null;
  return `${String(year).padStart(4, '0')}-${pad(month)}-${pad(day)}`;
}

export function isIsoDate(text: string): boolean {
  const m = ISO_DATE.exec(text);
  return !!m && ymd(Number(m[1]), Number(m[2]), Number(m[3])) === text;
}

function isIsoTime(text: string): boolean {
  return ISO_TIME.test(text);
}

function isIsoDateTime(text: string): boolean {
  return (
    text.length > 11 &&
    text[10] === 'T' &&
    isIsoDate(text.slice(0, 10)) &&
    isIsoTime(text.slice(11))
  );
}

/** A complete value in the kind's wire format. */
export function isWireValue(kind: PickerKind, text: string): boolean {
  if (kind === 'date') return isIsoDate(text);
  if (kind === 'time') return isIsoTime(text);
  return isIsoDateTime(text);
}

/** The calendar day a value sits on (`''` for a time or nothing). */
export function dayOf(kind: PickerKind, value: string): string {
  if (kind === 'date') return isIsoDate(value) ? value : '';
  if (kind === 'datetime-local') return isIsoDateTime(value) ? value.slice(0, 10) : '';
  return '';
}

/** The wall time a value sits on (`''` for a date or nothing). */
export function timeOf(kind: PickerKind, value: string): string {
  if (kind === 'time') return isIsoTime(value) ? value : '';
  if (kind === 'datetime-local') return isIsoDateTime(value) ? value.slice(11) : '';
  return '';
}

export function minutesOf(time: string): number | null {
  const m = ISO_TIME.exec(time);
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

export function minutesToTime(minutes: number): string {
  const m = ((minutes % 1440) + 1440) % 1440;
  return `${pad(Math.floor(m / 60))}:${pad(m % 60)}`;
}

// Locale

const EN_MONTHS = [
  'january',
  'february',
  'march',
  'april',
  'may',
  'june',
  'july',
  'august',
  'september',
  'october',
  'november',
  'december',
];
const EN_WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

interface LocaleInfo {
  locale: string;
  /** `13/10` reads day-first here. */
  dayFirst: boolean;
  /** Times read with AM/PM. */
  hour12: boolean;
  /** Lower-case, dot-free names per month index (English plus the locale's). */
  months: string[][];
  weekdays: string[];
}

const localeCache = new Map<string, LocaleInfo>();

export function defaultLocale(): string {
  try {
    const lang = typeof navigator === 'undefined' ? '' : navigator.language;
    if (lang && Intl.DateTimeFormat.supportedLocalesOf(lang).length) return lang;
  } catch {
    // An invalid tag falls back below.
  }
  return 'en-US';
}

const clean = (name: string) => name.toLowerCase().replace(/\./g, '').trim();

function localeInfo(locale: string = defaultLocale()): LocaleInfo {
  const cached = localeCache.get(locale);
  if (cached) return cached;
  const sample = Date.UTC(2026, 9, 13, 15, 0);
  let dayFirst = false;
  let hour12 = true;
  const months = EN_MONTHS.map((name) => [name, name.slice(0, 3)]);
  const weekdays = [...EN_WEEKDAYS, ...EN_WEEKDAYS.map((name) => name.slice(0, 3))];
  try {
    const numeric = new Intl.DateTimeFormat(locale, {
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      timeZone: 'UTC',
    }).formatToParts(sample);
    dayFirst =
      numeric.findIndex((p) => p.type === 'day') < numeric.findIndex((p) => p.type === 'month');
    hour12 = new Intl.DateTimeFormat(locale, { hour: 'numeric', timeZone: 'UTC' })
      .formatToParts(sample)
      .some((p) => p.type === 'dayPeriod');
    const long = new Intl.DateTimeFormat(locale, { month: 'long', timeZone: 'UTC' });
    const short = new Intl.DateTimeFormat(locale, { month: 'short', timeZone: 'UTC' });
    for (let i = 0; i < 12; i++) {
      const at = Date.UTC(2026, i, 1);
      for (const name of [clean(long.format(at)), clean(short.format(at))])
        if (name && !months[i].includes(name)) months[i].push(name);
    }
    const weekdayLong = new Intl.DateTimeFormat(locale, { weekday: 'long', timeZone: 'UTC' });
    const weekdayShort = new Intl.DateTimeFormat(locale, { weekday: 'short', timeZone: 'UTC' });
    for (let i = 0; i < 7; i++) {
      const at = Date.UTC(2026, 9, 11 + i);
      weekdays.push(clean(weekdayLong.format(at)), clean(weekdayShort.format(at)));
    }
  } catch {
    // English names and US order stay.
  }
  const info: LocaleInfo = { locale, dayFirst, hour12, months, weekdays };
  localeCache.set(locale, info);
  return info;
}

function monthIndex(token: string, info: LocaleInfo): number | null {
  let found: number | null = null;
  for (let i = 0; i < 12; i++) {
    const names = info.months[i]!;
    const hit =
      names.includes(token) ||
      (token.length >= 3 && names.some((name) => name.length > 3 && name.startsWith(token)));
    if (!hit) continue;
    if (found !== null && found !== i) return null; // ambiguous prefix
    found = i;
  }
  return found;
}

function isWeekday(token: string, info: LocaleInfo): boolean {
  return (
    info.weekdays.includes(token) ||
    (token.length >= 3 && EN_WEEKDAYS.some((name) => name.startsWith(token)))
  );
}

/** Lower-case, one space between words, the narrow spaces Intl uses folded in. */
function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/[\s  ]+/g, ' ')
    .trim();
}

// Parsing

const RELATIVE: Record<string, number> = {
  today: 0,
  tomorrow: 1,
  tmrw: 1,
  tmr: 1,
  yesterday: -1,
};

const yearOf = (day: string) => Number(day.slice(0, 4));

/**
 * A typed day: ISO (`2026-10-13`, `2026/10/13`), numeric in the locale's
 * order (`10/13`, `10/13/2026`, `13.10.26`), month names in either order
 * (`oct 13`, `13 October 2026`, `Tue, Oct 13`), or `today` / `tomorrow` /
 * `yesterday`. A missing year is `today`'s.
 */
export function parseDateText(
  text: string,
  today: string,
  locale: string = defaultLocale()
): string | null {
  const s = normalize(text);
  if (!s) return null;
  const relative = RELATIVE[s];
  if (relative !== undefined) return addDays(today, relative);
  const info = localeInfo(locale);
  const thisYear = yearOf(today);

  let m = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/.exec(s);
  if (m) return ymd(Number(m[1]), Number(m[2]), Number(m[3]));

  m = /^(\d{1,2})[/.-](\d{1,2})(?:[/.-](\d{2}|\d{4}))?\.?$/.exec(s);
  if (m) {
    const year = m[3] ? (m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3])) : thisYear;
    const a = Number(m[1]);
    const b = Number(m[2]);
    const [month, day] = info.dayFirst ? [b, a] : [a, b];
    // `13/10` in a month-first locale can only mean the 13th of October.
    return ymd(year, month, day) ?? ymd(year, day, month);
  }

  let month: number | null = null;
  const numbers: string[] = [];
  for (const raw of s.replace(/,/g, ' ').split(' ')) {
    const token = raw.replace(/\.$/, '');
    if (!token || token === 'the' || token === 'of') continue;
    const number = /^(\d{1,4})(?:st|nd|rd|th)?$/.exec(token);
    if (number) {
      numbers.push(number[1]!);
      continue;
    }
    const index: number | null = month === null ? monthIndex(clean(token), info) : null;
    if (index !== null) {
      month = index;
      continue;
    }
    if (isWeekday(clean(token), info)) continue;
    return null;
  }
  if (month === null) return null;
  const days = numbers.filter((n) => n.length <= 2);
  const years = numbers.filter((n) => n.length === 4);
  if (days.length !== 1 || years.length > 1 || days.length + years.length !== numbers.length)
    return null;
  const year = years[0] ? Number(years[0]) : thisYear;
  if (year < 1900 || year > 2199) return null;
  return ymd(year, month + 1, Number(days[0]));
}

/**
 * A typed wall time: `9`, `930`, `0930`, `9:30`, `9.30`, `9:30p`,
 * `9:30 pm`, `9:30 p.m.`, `21:30`, `21:30:15`, `noon`, `midnight`.
 * Returns `HH:mm` (or `HH:mm:ss[.fff]` when seconds were typed).
 */
export function parseTimeText(text: string): string | null {
  let s = normalize(text);
  if (!s) return null;
  if (s === 'noon' || s === 'midday') return '12:00';
  if (s === 'midnight') return '00:00';
  s = s.replace(/([ap])\.? ?m\.?$/, '$1m').replace(/ /g, '');
  const m = /^(\d{1,2})(?:[:.h]?(\d{2}))?(?::(\d{2})(\.\d{1,3})?)?(am|pm|a|p)?$/.exec(s);
  if (!m) return null;
  let hour = Number(m[1]);
  const minute = m[2] ? Number(m[2]) : 0;
  const meridiem = m[5]?.[0];
  if (minute > 59) return null;
  if (meridiem) {
    if (hour < 1 || hour > 12) return null;
    hour = (hour % 12) + (meridiem === 'p' ? 12 : 0);
  } else if (hour > 23) {
    return null;
  }
  const base = `${pad(hour)}:${pad(minute)}`;
  if (!m[3]) return base;
  if (Number(m[3]) > 59) return null;
  return `${base}:${m[3]}${m[4] ?? ''}`;
}

export interface ParseContext {
  today: string;
  locale?: string;
  /** The current value: a typed date keeps its time, a typed time keeps its day. */
  current?: string;
}

/**
 * A typed date and time: ISO (`2026-10-13T09:30`, `2026-10-13 9:30`), a day
 * and a time in any of the forms above (`tomorrow 9am`, `oct 13 at 9:30 pm`,
 * `10/13 930`), or either half alone.
 */
export function parseDateTimeText(text: string, context: ParseContext): string | null {
  const s = normalize(text);
  if (!s) return null;
  const { today, locale } = context;
  const iso = /^(\d{4}-\d{2}-\d{2})[t ](\d{1,2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?)$/.exec(s);
  if (iso) {
    const time = isIsoDate(iso[1]!) ? parseTimeText(iso[2]!) : null;
    return time ? `${iso[1]}T${time}` : null;
  }
  const current =
    context.current && isIsoDateTime(context.current)
      ? { date: context.current.slice(0, 10), time: context.current.slice(11) }
      : null;
  const dateOnly = parseDateText(s, today, locale);
  if (dateOnly) return `${dateOnly}T${current?.time ?? DEFAULT_TIME}`;
  const timeOnly = parseTimeText(s);
  if (timeOnly) return `${current?.date ?? today}T${timeOnly}`;
  const tokens = s
    .replace(/,/g, ' ')
    .split(' ')
    .filter((t) => t && t !== 'at' && t !== '@');
  for (let k = tokens.length - 1; k >= 1; k--) {
    const date = parseDateText(tokens.slice(0, k).join(' '), today, locale);
    if (!date) continue;
    const time = parseTimeText(tokens.slice(k).join(' '));
    if (time) return `${date}T${time}`;
  }
  return null;
}

// Range

/** A sortable key: times padded to `HH:mm:ss.fff`, so wire strings compare. */
function sortKey(kind: PickerKind, value: string, edge: 'min' | 'max'): string {
  const fullTime = (time: string) => {
    const [hm = '', rest = ''] = [time.slice(0, 5), time.slice(5)];
    const seconds = rest ? rest.slice(1, 3) : '00';
    const fraction = (rest.split('.')[1] ?? '').padEnd(3, '0');
    return `${hm}:${seconds}.${fraction}`;
  };
  if (kind === 'time') return isIsoTime(value) ? fullTime(value) : value;
  if (kind === 'date') return value.slice(0, 10);
  if (isIsoDate(value)) return `${value}T${edge === 'min' ? '00:00:00.000' : '23:59:59.999'}`;
  return isIsoDateTime(value) ? `${value.slice(0, 11)}${fullTime(value.slice(11))}` : value;
}

export type RangeProblem = 'before-min' | 'after-max';

export function rangeProblem(
  kind: PickerKind,
  value: string,
  min?: string,
  max?: string
): RangeProblem | null {
  if (!value) return null;
  const key = sortKey(kind, value, 'min');
  if (min && key < sortKey(kind, min, 'min')) return 'before-min';
  if (max && key > sortKey(kind, max, 'max')) return 'after-max';
  return null;
}

export function dayInRange(day: string, min?: string, max?: string): boolean {
  return !((min && day < min.slice(0, 10)) || (max && day > max.slice(0, 10)));
}

export type ParseOutcome =
  | { ok: true; value: string }
  | { ok: false; reason: 'unreadable' | RangeProblem };

/** Typed text → a wire value of `kind` inside `min`/`max`, or why not. */
export function parseTyped(
  kind: PickerKind,
  text: string,
  context: ParseContext & { min?: string; max?: string }
): ParseOutcome {
  const trimmed = text.trim();
  if (!trimmed) return { ok: true, value: '' };
  const value =
    kind === 'date'
      ? parseDateText(trimmed, context.today, context.locale)
      : kind === 'time'
        ? parseTimeText(trimmed)
        : parseDateTimeText(trimmed, context);
  if (!value) return { ok: false, reason: 'unreadable' };
  const problem = rangeProblem(kind, value, context.min, context.max);
  return problem ? { ok: false, reason: problem } : { ok: true, value };
}

// Display

const formatters = new Map<string, Intl.DateTimeFormat>();
function formatter(locale: string, options: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  const key = `${locale}|${JSON.stringify(options)}`;
  let f = formatters.get(key);
  if (!f) {
    f = new Intl.DateTimeFormat(locale, { ...options, timeZone: 'UTC' });
    formatters.set(key, f);
  }
  return f;
}

/** Wall fields as a UTC instant, only ever formatted in UTC (no zone math). */
function wallInstant(day: string, time = '00:00'): number {
  const date = new Date(0);
  date.setUTCFullYear(
    Number(day.slice(0, 4)),
    Number(day.slice(5, 7)) - 1,
    Number(day.slice(8, 10))
  );
  const seconds = time.length >= 8 ? Number(time.slice(6, 8)) : 0;
  date.setUTCHours(Number(time.slice(0, 2)), Number(time.slice(3, 5)), seconds, 0);
  return date.getTime();
}

const tidy = (text: string) => text.replace(/[  ]/g, ' ');
const hasSeconds = (time: string) => time.length >= 8 && !/^:00(\.0*)?$/.test(time.slice(5));

function timeOptions(time: string): Intl.DateTimeFormatOptions {
  return hasSeconds(time)
    ? { hour: 'numeric', minute: '2-digit', second: '2-digit' }
    : { hour: 'numeric', minute: '2-digit' };
}

/**
 * The field's text for a value: "Tue, Oct 13, 2026" ("Tue, Oct 13" this
 * year), "Oct 13, 9:00 AM", "9:00 AM". Anything that is not a valid wire
 * value is shown as it is, so a bad stored value stays visible.
 */
export function formatValue(
  kind: PickerKind,
  value: string,
  context: { today: string; locale?: string }
): string {
  if (!value || !isWireValue(kind, value)) return value;
  const locale = context.locale ?? defaultLocale();
  if (kind === 'time')
    return tidy(formatter(locale, timeOptions(value)).format(wallInstant('2026-01-01', value)));
  const day = value.slice(0, 10);
  const year = yearOf(day) === yearOf(context.today) ? undefined : ('numeric' as const);
  if (kind === 'date') {
    return tidy(
      formatter(locale, { weekday: 'short', month: 'short', day: 'numeric', year }).format(
        wallInstant(day)
      )
    );
  }
  const time = value.slice(11);
  return tidy(
    formatter(locale, { month: 'short', day: 'numeric', year, ...timeOptions(time) }).format(
      wallInstant(day, time)
    )
  );
}

/** "9:00 AM" / "09:00" for a time-list row. */
export function formatTimeLabel(minutes: number, locale: string = defaultLocale()): string {
  return tidy(
    formatter(locale, { hour: 'numeric', minute: '2-digit' }).format(
      wallInstant('2026-01-01', minutesToTime(minutes))
    )
  );
}

/** "October 2026". */
export function formatMonthTitle(day: string, locale: string = defaultLocale()): string {
  return tidy(formatter(locale, { month: 'long', year: 'numeric' }).format(wallInstant(day)));
}

/** "Oct". */
export function formatMonthShort(monthIndex: number, locale: string = defaultLocale()): string {
  return tidy(formatter(locale, { month: 'short' }).format(Date.UTC(2026, monthIndex, 1)));
}

/** "October". */
export function formatMonthLong(monthIndex: number, locale: string = defaultLocale()): string {
  return tidy(formatter(locale, { month: 'long' }).format(Date.UTC(2026, monthIndex, 1)));
}

/** "Tuesday, October 13, 2026" — a day cell's accessible name. */
export function formatDayLabel(day: string, locale: string = defaultLocale()): string {
  return tidy(
    formatter(locale, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' }).format(
      wallInstant(day)
    )
  );
}

/** Weekday header: one letter like the calendar's mini month, and the full name. */
export function formatWeekday(
  day: string,
  locale: string = defaultLocale()
): { short: string; long: string } {
  return {
    short: tidy(formatter(locale, { weekday: 'narrow' }).format(wallInstant(day))),
    long: tidy(formatter(locale, { weekday: 'long' }).format(wallInstant(day))),
  };
}
