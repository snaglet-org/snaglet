/**
 * Calendar date math. Days are plain `YYYY-MM-DD` strings handled as
 * calendar dates (a date never passes through UTC midnight); the
 * arithmetic runs on UTC-noon-free integer day numbers. Timed items convert
 * between ISO instants and wall time in an explicit IANA zone via `Intl`.
 */

export type CalendarZoom = 'month' | 'week' | '3day' | 'day' | 'year';
/** The zoom a user picks and we store; `3day` is what `week` becomes when narrow. */
export type StoredZoom = 'month' | 'week' | 'day' | 'year';

/**
 * Pane widths (CSS px of the pane body). Below `THREE_DAY_PX` Week shows 3
 * days (seven columns would be under about 90 px each); below `NARROW_DAY_PX`
 * one. Below `NARROW_PANE_PX` the pane is narrow: short zoom labels, a
 * compact time gutter, two items a Month cell.
 */
export const THREE_DAY_PX = 700;
export const NARROW_PANE_PX = 520;
export const NARROW_DAY_PX = 380;

const DAY_MS = 86_400_000;
const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

const pad = (n: number) => String(n).padStart(2, '0');

function parts(day: string): [number, number, number] {
  const [y, m, d] = day.split('-').map(Number);
  return [y!, m!, d!];
}

/** Days since the epoch for a calendar date (pure arithmetic on UTC fields). */
function dayNumber(day: string): number {
  const [y, m, d] = parts(day);
  return Math.round(Date.UTC(y, m - 1, d) / DAY_MS);
}

function fromDayNumber(n: number): string {
  const date = new Date(n * DAY_MS);
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
}

export function addDays(day: string, delta: number): string {
  return fromDayNumber(dayNumber(day) + delta);
}

export function diffDays(a: string, b: string): number {
  return dayNumber(a) - dayNumber(b);
}

export function addMonths(day: string, delta: number): string {
  const [y, m, d] = parts(day);
  const index = y * 12 + (m - 1) + delta;
  const year = Math.floor(index / 12);
  const month = index - year * 12;
  const last = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  return `${year}-${pad(month + 1)}-${pad(Math.min(d, last))}`;
}

/** 0 = Sunday … 6 = Saturday. */
export function dayOfWeek(day: string): number {
  return (((dayNumber(day) + 4) % 7) + 7) % 7; // 1970-01-01 was a Thursday
}

export function startOfWeek(day: string, weekStart: number): string {
  const offset = (dayOfWeek(day) - weekStart + 7) % 7;
  return addDays(day, -offset);
}

export function startOfMonth(day: string): string {
  return `${day.slice(0, 7)}-01`;
}

/** Every day of the whole weeks covering `day`'s month. */
export function monthGridDays(day: string, weekStart: number): string[] {
  const first = startOfMonth(day);
  const nextMonth = addMonths(first, 1);
  const start = startOfWeek(first, weekStart);
  const days: string[] = [];
  for (let cur = start; cur < nextMonth || days.length % 7 !== 0; cur = addDays(cur, 1)) {
    days.push(cur);
  }
  return days;
}

function daysBetween(from: string, to: string): string[] {
  const days: string[] = [];
  for (let cur = from; cur < to; cur = addDays(cur, 1)) days.push(cur);
  return days;
}

export interface CalendarRange {
  /** Inclusive first day. */
  from: string;
  /** Exclusive end day. */
  to: string;
  days: string[];
}

export function rangeFor(zoom: CalendarZoom, anchor: string, weekStart: number): CalendarRange {
  let from: string;
  let to: string;
  if (zoom === 'month') {
    const days = monthGridDays(anchor, weekStart);
    return { from: days[0]!, to: addDays(days[days.length - 1]!, 1), days };
  }
  if (zoom === 'year') {
    const year = parts(anchor)[0];
    from = `${year}-01-01`;
    to = `${year + 1}-01-01`;
    return { from, to, days: daysBetween(from, to) };
  }
  if (zoom === 'week') {
    from = startOfWeek(anchor, weekStart);
    to = addDays(from, 7);
  } else if (zoom === '3day') {
    from = anchor;
    to = addDays(anchor, 3);
  } else {
    from = anchor;
    to = addDays(anchor, 1);
  }
  return { from, to, days: daysBetween(from, to) };
}

export function navigate(zoom: CalendarZoom, anchor: string, direction: 1 | -1): string {
  if (zoom === 'month') return addMonths(anchor, direction);
  if (zoom === 'year') return addMonths(anchor, 12 * direction);
  if (zoom === 'week') return addDays(anchor, 7 * direction);
  if (zoom === '3day') return addDays(anchor, 3 * direction);
  return addDays(anchor, direction);
}

const shortMonth = (day: string) => MONTHS[parts(day)[1] - 1].slice(0, 3);

/** The month's full name, e.g. "October". */
export function monthName(day: string): string {
  return MONTHS[parts(day)[1] - 1]!;
}

export function monthTitle(day: string): string {
  const [y, m] = parts(day);
  return `${MONTHS[m - 1]} ${y}`;
}

export function longDayLabel(day: string): string {
  const [, m, d] = parts(day);
  return `${WEEKDAYS[dayOfWeek(day)]}, ${MONTHS[m - 1]} ${d}`;
}

export function weekdayShort(day: string): string {
  return WEEKDAYS[dayOfWeek(day)].slice(0, 3);
}

export function shortDayLabel(day: string): string {
  return `${weekdayShort(day)} ${shortMonth(day)} ${parts(day)[2]}`;
}

export function dayOfMonth(day: string): number {
  return parts(day)[2];
}

export function rangeLabel(zoom: CalendarZoom, anchor: string, weekStart: number): string {
  if (zoom === 'month') return monthTitle(anchor);
  if (zoom === 'year') return String(parts(anchor)[0]);
  if (zoom === 'day') return longDayLabel(anchor);
  const { from, to } = rangeFor(zoom, anchor, weekStart);
  const last = addDays(to, -1);
  const [fy, , fd] = parts(from);
  const [ly, , ld] = parts(last);
  if (fy !== ly) return `${shortMonth(from)} ${fd}, ${fy} – ${shortMonth(last)} ${ld}, ${ly}`;
  if (shortMonth(from) !== shortMonth(last)) {
    return `${shortMonth(from)} ${fd} – ${shortMonth(last)} ${ld}, ${ly}`;
  }
  return `${shortMonth(from)} ${fd} – ${ld}, ${ly}`;
}

/** The zoom actually shown at a pane width. */
export function clampZoom(zoom: CalendarZoom, paneWidth: number): CalendarZoom {
  if (zoom === 'month' || zoom === 'day' || zoom === 'year') return zoom;
  if (paneWidth < NARROW_DAY_PX) return 'day';
  if (paneWidth < THREE_DAY_PX) return '3day';
  return 'week';
}

/** Locale week start (0 = Sunday), Monday when the runtime can't tell. */
export function localeWeekStart(locale?: string): number {
  try {
    const loc = new Intl.Locale(locale ?? navigator.language) as Intl.Locale & {
      weekInfo?: { firstDay: number };
      getWeekInfo?: () => { firstDay: number };
    };
    const info = loc.getWeekInfo?.() ?? loc.weekInfo;
    if (info && Number.isFinite(info.firstDay)) return info.firstDay % 7; // ISO 7 = Sunday
  } catch {
    // fall through
  }
  return 1;
}

export function viewerTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

const formatters = new Map<string, Intl.DateTimeFormat>();
function zoneFormatter(timeZone: string): Intl.DateTimeFormat {
  let f = formatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    formatters.set(timeZone, f);
  }
  return f;
}

/** Wall date + minutes-after-midnight of an instant in `timeZone`. */
export function instantToZoned(iso: string, timeZone: string): { date: string; minutes: number } {
  const map: Record<string, string> = {};
  for (const p of zoneFormatter(timeZone).formatToParts(new Date(iso))) map[p.type] = p.value;
  const hour = Number(map.hour) % 24;
  return {
    date: `${map.year}-${map.month}-${map.day}`,
    minutes: hour * 60 + Number(map.minute),
  };
}

function zoneOffsetMs(instant: number, timeZone: string): number {
  const z = instantToZoned(new Date(instant).toISOString(), timeZone);
  const [y, m, d] = parts(z.date);
  const asUtc = Date.UTC(y, m - 1, d) + z.minutes * 60_000;
  return asUtc - Math.floor(instant / 60_000) * 60_000;
}

/**
 * The ISO instant of a wall date + minutes in `timeZone` (DST-safe, two
 * passes). A repeated wall time (the fall-back hour) is its first instant.
 * One that doesn't exist (the spring-forward gap, or midnight where clocks
 * jump at midnight) moves on by the gap, as Temporal's "compatible" does:
 * 2:30 AM becomes 3:30 AM, never 1:30.
 */
export function zonedToInstant(day: string, minutes: number, timeZone: string): string {
  const [y, m, d] = parts(day);
  const wall = Date.UTC(y, m - 1, d) + minutes * 60_000;
  const first = wall - zoneOffsetMs(wall, timeZone);
  const second = wall - zoneOffsetMs(first, timeZone);
  const back = instantToZoned(new Date(second).toISOString(), timeZone);
  const exists = back.date === day && back.minutes === minutes;
  return new Date(exists ? second : Math.max(first, second)).toISOString();
}

/** The last day of an all-day span (`endDate` is exclusive); an empty span keeps its first. */
export function lastDate(startDate: string, endDate: string): string {
  const last = addDays(endDate, -1);
  return last < startDate ? startDate : last;
}

/**
 * The last day an instant span touches in `timeZone` (`end` is exclusive,
 * so an end at midnight closes the day before).
 */
export function lastZonedDate(start: string, end: string, timeZone: string): string {
  const first = instantToZoned(start, timeZone).date;
  const endMs = Date.parse(end);
  if (!(endMs > Date.parse(start))) return first;
  const last = instantToZoned(new Date(endMs - 1).toISOString(), timeZone).date;
  return last < first ? first : last;
}

export function todayIn(timeZone: string, now: Date = new Date()): string {
  return instantToZoned(now.toISOString(), timeZone).date;
}

/** "9:00 AM" / "9 AM" style, or the compact "9a" gutter label. */
export function formatMinutes(minutes: number, opts: { compact?: boolean } = {}): string {
  const h = Math.floor(minutes / 60) % 24;
  const m = minutes % 60;
  const suffix = h < 12 ? 'AM' : 'PM';
  const h12 = h % 12 === 0 ? 12 : h % 12;
  if (opts.compact) return `${h12}${suffix[0].toLowerCase()}`;
  return m === 0 ? `${h12} ${suffix}` : `${h12}:${pad(m)} ${suffix}`;
}

export function formatClock(minutes: number): string {
  const h = Math.floor(minutes / 60) % 24;
  const m = minutes % 60;
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${pad(m)}`;
}

/**
 * Day minutes `start` to `end` (`end` up to 1440, midnight): "9:00 – 10:30
 * AM" shares one suffix when both ends are in the same half of the day;
 * "11:30 AM – 12:30 PM" and a midnight end ("10 AM – 12:00 AM") keep both.
 */
export function formatClockRange(start: number, end: number): string {
  const endMinutes = end % 1440;
  const endSuffix = endMinutes < 720 ? 'AM' : 'PM';
  const sameHalf = endMinutes !== 0 && start < 720 === endMinutes < 720;
  const left = sameHalf ? formatClock(start) : formatMinutes(start);
  return `${left} – ${formatClock(endMinutes)} ${endSuffix}`;
}

/** "Mon Oct 12, 9:00 – 9:30 AM". */
export function formatTimedRange(day: string, start: number, end: number): string {
  return `${shortDayLabel(day)}, ${formatClockRange(start, end)}`;
}

/** Short zone label like "PDT", with the IANA name as fallback. */
export function zoneAbbreviation(timeZone: string, now: Date = new Date()): string {
  try {
    const part = new Intl.DateTimeFormat('en-US', { timeZone, timeZoneName: 'short' })
      .formatToParts(now)
      .find((p) => p.type === 'timeZoneName');
    return part?.value ?? timeZone;
  } catch {
    return timeZone;
  }
}
