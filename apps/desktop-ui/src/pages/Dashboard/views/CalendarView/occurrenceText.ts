/**
 * Text for occurrences: display title, accessible label, hover card
 * lines and the overdue rule (repeating rows only). Every
 * automations' lines: "Every 15 minutes · Check inbox".
 */
import type { Calendar, CalendarIntervalSpan, CalendarOccurrence } from '@snaglet/shared/types';
import { describeEvery } from '@snaglet/shared/utils';
import {
  addDays,
  formatClock,
  formatMinutes,
  instantToZoned,
  longDayLabel,
  todayIn,
  viewerTimeZone,
  weekdayShort,
} from '@desktop/features/calendar/calendarDates';

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

export function displayTitle(o: CalendarOccurrence): string {
  const t = o.title.trim();
  if (t) return t;
  return o.source === 'row' ? `Untitled · ${o.tableName}` : 'Untitled';
}

/** The item's whole label: the title. */
export function itemLabel(o: CalendarOccurrence): string {
  return displayTitle(o);
}

/**
 * The current occurrence of a repeating row, still upcoming, whose date has
 * passed. The server says so itself (`repeat.overdue`). When that field is
 * absent: timed when its start is past; all-day only once its (exclusive) end
 * date has come in the viewer's zone, so a row due today is not overdue today.
 */
export function isOverdue(
  o: CalendarOccurrence,
  now: Date = new Date(),
  zone: string = viewerTimeZone()
): boolean {
  if (o.source !== 'row' || !o.repeat?.isCurrent || o.status !== 'upcoming') return false;
  if (o.repeat.overdue !== undefined) return o.repeat.overdue === true;
  if (o.time.kind === 'all_day') return o.time.endDate <= todayIn(zone, now);
  const start = Date.parse(o.time.start);
  return Number.isFinite(start) && start < now.getTime();
}

/**
 * Where a moved occurrence was planned (`repeat.originalStart`), or null:
 * `day` is "Mon", `time` the planned start ("9:00 AM") for timed slots.
 */
export function movedFrom(
  o: CalendarOccurrence,
  zone: string = viewerTimeZone()
): { day: string; time: string | null } | null {
  const original = o.source === 'row' ? o.repeat?.originalStart : undefined;
  if (!original) return null;
  if (DATE_ONLY.test(original)) return { day: weekdayShort(original), time: null };
  if (!Number.isFinite(Date.parse(original))) return null;
  const at = instantToZoned(original, zone);
  const suffix = at.minutes % 1440 < 720 ? 'AM' : 'PM';
  return { day: weekdayShort(at.date), time: `${formatClock(at.minutes)} ${suffix}` };
}

function timeText(o: CalendarOccurrence, zone: string): string {
  if (o.time.kind === 'all_day') {
    const last = addDays(o.time.endDate, -1);
    return last > o.time.startDate
      ? `${longDayLabel(o.time.startDate)} to ${longDayLabel(last)}, all day`
      : `${longDayLabel(o.time.startDate)}, all day`;
  }
  const s = instantToZoned(o.time.start, zone);
  const e = instantToZoned(o.time.end, zone);
  // Past the next midnight (a range over several days): name the end's day too.
  if (e.date > addDays(s.date, 1) || (e.date > s.date && e.minutes > 0))
    return `${longDayLabel(s.date)}, ${formatMinutes(s.minutes)} to ${longDayLabel(e.date)}, ${formatMinutes(e.minutes)}`;
  return `${longDayLabel(s.date)}, ${formatMinutes(s.minutes)} to ${formatMinutes(e.minutes)}`;
}

/**
 * "Pay rent, row in Tasks, Monday October 12, all day, repeats weekly, done".
 */
export function ariaLabelFor(o: CalendarOccurrence, zone: string, now?: Date): string {
  const parts = [displayTitle(o)];
  parts.push(
    o.source === 'row'
      ? `row in ${o.tableName}`
      : o.source === 'automation'
        ? `automation for ${o.agentName}`
        : 'event'
  );
  parts.push(timeText(o, zone).replace(/, (\w+) (\d+)/g, ' $1 $2'));
  if (o.source === 'row' && o.repeat) parts.push(`repeats ${o.repeat.summary.toLowerCase()}`);
  if (o.source === 'event' && o.repeatSummary)
    parts.push(`repeats ${o.repeatSummary.toLowerCase()}`);
  if (o.status !== 'upcoming') parts.push(o.note === 'failed' ? 'failed' : o.status);
  const from = movedFrom(o, zone);
  if (from) parts.push(`moved from ${from.day}${from.time ? ` ${from.time}` : ''}`);
  if (isOverdue(o, now, zone)) parts.push('overdue');
  return parts.join(', ');
}

/**
 * Native hover card text: title, time, calendar; a repeating event adds its
 * repeat; rows add ▦ table (· field), repeat, status. The items themselves
 * carry no table glyph: this and the popover say where a row comes from.
 */
export function hoverText(
  o: CalendarOccurrence,
  zone: string,
  calendar: Calendar | undefined,
  fieldName?: string
): string {
  const lines = [itemLabel(o), timeText(o, zone)];
  if (calendar) lines.push(calendar.title);
  if (o.source === 'event' && o.repeatSummary) lines.push(`↻ ${o.repeatSummary}`);
  if (o.source === 'automation') {
    lines.push(`◷ Wakes ${o.agentName}`);
    if (o.status !== 'upcoming')
      lines.push(o.note === 'failed' ? 'Failed' : o.status === 'done' ? 'Ran' : 'Skipped');
  }
  if (o.source === 'row') {
    // The field from the calendar's bindings when the caller didn't name it.
    const field =
      fieldName ??
      calendar?.boundFields.find((b) => b.tableId === o.tableId && b.fieldId === o.fieldId)
        ?.fieldName;
    lines.push(`▦ ${field ? `${o.tableName} · ${field}` : o.tableName}`);
    if (o.repeat) lines.push(`↻ ${o.repeat.summary}`);
    const from = movedFrom(o, zone);
    if (from) lines.push(`Moved from ${from.day}${from.time ? ` ${from.time}` : ''}`);
    if (o.status !== 'upcoming') lines.push(o.status[0]!.toUpperCase() + o.status.slice(1));
    if (isOverdue(o, undefined, zone)) lines.push('Overdue');
  }
  return lines.join('\n');
}

/**
 * An Every automation's timing in words: "Every 15 minutes", "Every hour",
 * "Every 5 minutes from 05:05 to 06:00" (a daily window, in its own zone).
 */
export function intervalText(span: Pick<CalendarIntervalSpan, 'everyMs' | 'window'>): string {
  const words = describeEvery(span.everyMs);
  const window = span.window ? ` from ${span.window.start} to ${span.window.end}` : '';
  return words[0].toUpperCase() + words.slice(1) + window;
}

function intervalName(span: CalendarIntervalSpan): string {
  return span.name.trim() || 'Untitled';
}

/** The line's hover text: "Every 15 minutes · Check inbox". */
export function intervalHover(span: CalendarIntervalSpan): string {
  return `${intervalText(span)} · ${intervalName(span)}`;
}

/** The line's accessible name: "Every 15 minutes automation: Check inbox". */
export function intervalAriaLabel(span: CalendarIntervalSpan): string {
  return `${intervalText(span)} automation: ${intervalName(span)}`;
}
