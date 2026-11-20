/**
 * How a date field's value reads in the grid, the entry modal, the calendar's
 * row popover and on Board cards (all through `TableEntryValueView`).
 *
 * A range with an end: "Oct 12 – 15", "Oct 12 – Nov 3", "Oct 12, 9:00 –
 * 10:30 AM", "Oct 12, 9:00 AM – Oct 13, 5:00 PM". A year shows when the range
 * leaves the current year or spans two. Wording follows the calendar's labels
 * (English, en dash).
 *
 * A single value reads as the date field's own text does (`DateInput`, in
 * the viewer's locale): "Tue, Oct 13", "Oct 13, 9:00 AM", with the year
 * outside the current one.
 *
 * Times are the viewer's wall clock.
 */
import { parseTableDateRange, userTimeZone, type TableDateRangeKind } from '@snaglet/shared/utils';
import {
  defaultLocale,
  formatDayLabel,
  formatTimeLabel,
  formatValue,
  isIsoDate,
} from '@desktop/components/controls/DateInput/dateText';
import {
  addDays,
  formatClock,
  instantToZoned,
  todayIn,
} from '@desktop/features/calendar/calendarDates';
import { toDateTimeInput } from './dateTimeInput';

interface DateRangeText {
  /** What the cell shows. */
  text: string;
  /** The same range in words, for the title and screen readers ("October 12 to October 15"). */
  label: string;
}

interface DateRangeTextOptions {
  /** Defaults to the viewer's zone. */
  timeZone?: string;
  /** Decides whether years show; defaults to the current time. */
  now?: Date;
}

interface DateTextOptions extends DateRangeTextOptions {
  /** Defaults to the viewer's locale (as `DateInput` reads it). */
  locale?: string;
}

const monthNames = (month: 'short' | 'long') => {
  const format = new Intl.DateTimeFormat('en-US', { month, timeZone: 'UTC' });
  return Array.from({ length: 12 }, (_, index) =>
    format.format(new Date(Date.UTC(2000, index, 15)))
  );
};
const SHORT_MONTHS = monthNames('short');
const LONG_MONTHS = monthNames('long');

interface Day {
  year: number;
  month: number;
  day: number;
}

function dayOf(date: string): Day {
  const [year, month, day] = date.split('-').map(Number);
  return { year: year ?? 0, month: month ?? 1, day: day ?? 1 };
}

function dayText(day: Day, long: boolean, withYear: boolean): string {
  const month = (long ? LONG_MONTHS : SHORT_MONTHS)[day.month - 1] ?? '';
  return `${month} ${day.day}${withYear ? `, ${day.year}` : ''}`;
}

const half = (minutes: number) => (minutes % 1440 < 720 ? 'AM' : 'PM');
const timeText = (minutes: number) => `${formatClock(minutes % 1440)} ${half(minutes)}`;

/** First through last day, both inclusive. */
function daysText(first: string, last: string, currentYear: number): DateRangeText {
  const a = dayOf(first);
  const b = dayOf(last);
  const withYear = a.year !== b.year || a.year !== currentYear;
  if (first === last)
    return {
      text: `${dayText(a, false, withYear)}, all day`,
      label: `${dayText(a, true, withYear)}, all day`,
    };
  const label = `${dayText(a, true, withYear)} to ${dayText(b, true, withYear)}`;
  if (a.year !== b.year)
    return { text: `${dayText(a, false, true)} – ${dayText(b, false, true)}`, label };
  const year = withYear ? `, ${a.year}` : '';
  const end = a.month === b.month ? String(b.day) : dayText(b, false, false);
  return { text: `${dayText(a, false, false)} – ${end}${year}`, label };
}

function instantsText(
  start: string,
  end: string,
  timeZone: string,
  currentYear: number
): DateRangeText {
  const s = instantToZoned(start, timeZone);
  const e = instantToZoned(end, timeZone);
  // Midnight to midnight is whole days (Include time turned on for a date range).
  if (s.minutes === 0 && e.minutes === 0) return daysText(s.date, addDays(e.date, -1), currentYear);
  // An end at midnight closes the day before, never "12:00 AM" of the next one.
  const atMidnight = e.minutes === 0;
  const endDate = atMidnight ? addDays(e.date, -1) : e.date;
  const a = dayOf(s.date);
  const b = dayOf(endDate);
  const withYear = a.year !== b.year || a.year !== currentYear;
  const startDay = dayText(a, false, withYear);
  const startLabel = `${dayText(a, true, withYear)}, ${timeText(s.minutes)}`;
  if (s.date === endDate) {
    // "9:00 – 10:30 AM" shares one suffix; a midnight end keeps both ("9:00 AM – 12:00 AM").
    const startTime =
      !atMidnight && half(s.minutes) === half(e.minutes)
        ? formatClock(s.minutes)
        : timeText(s.minutes);
    return {
      text: `${startDay}, ${startTime} – ${timeText(e.minutes)}`,
      label: `${startLabel} to ${atMidnight ? 'midnight' : timeText(e.minutes)}`,
    };
  }
  const endDay = dayText(b, false, withYear);
  const endDayLabel = dayText(b, true, withYear);
  return atMidnight
    ? {
        text: `${startDay}, ${timeText(s.minutes)} – ${endDay}, end of day`,
        label: `${startLabel} to the end of ${endDayLabel}`,
      }
    : {
        text: `${startDay}, ${timeText(s.minutes)} – ${endDay}, ${timeText(e.minutes)}`,
        label: `${startLabel} to ${endDayLabel}, ${timeText(e.minutes)}`,
      };
}

/**
 * The text of a range value with an end, or null for a single value or text
 * that is not a valid range (those display as a plain date or time does).
 */
export function dateRangeText(
  value: string,
  kind: TableDateRangeKind,
  { timeZone = userTimeZone(), now = new Date() }: DateRangeTextOptions = {}
): DateRangeText | null {
  const parsed = parseTableDateRange(value, kind, timeZone);
  if (!parsed.ok || parsed.range.end === null) return null;
  const currentYear = Number(todayIn(timeZone, now).slice(0, 4));
  const { start, end } = parsed.range;
  return kind === 'date'
    ? daysText(start, end, currentYear)
    : instantsText(start, end, timeZone, currentYear);
}

/**
 * The text of a single date or date-time value (a range field's start with
 * no end too), or null for text that isn't one (shown as stored). Seconds
 * are left out, as a cell has no room for them.
 */
export function singleDateText(
  value: string,
  kind: TableDateRangeKind,
  { timeZone = userTimeZone(), now = new Date(), locale = defaultLocale() }: DateTextOptions = {}
): DateRangeText | null {
  const today = todayIn(timeZone, now);
  if (kind === 'date') {
    if (!isIsoDate(value)) return null;
    return {
      text: formatValue('date', value, { today, locale }),
      label: formatDayLabel(value, locale),
    };
  }
  const wall = toDateTimeInput(value, timeZone).slice(0, 16);
  if (!wall) return null;
  const minutes = Number(wall.slice(11, 13)) * 60 + Number(wall.slice(14, 16));
  return {
    text: formatValue('datetime-local', wall, { today, locale }),
    label: `${formatDayLabel(wall.slice(0, 10), locale)}, ${formatTimeLabel(minutes, locale)}`,
  };
}
