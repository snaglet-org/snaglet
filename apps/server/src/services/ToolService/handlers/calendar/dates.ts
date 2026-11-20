/**
 * calendar {op: "dates"}: the days of a year worth marking, as the Year view
 * circles them: things that happen on a date (a one-off event or row) and
 * repeats that land only a few times a year (every year, quarterly, twice a
 * year), by day with what is on each. Frequent repeats (daily, weekly) are
 * left out. The rule is `notableByDay` in `@snaglet/shared/utils`, the
 * same one the Year view uses. Rows come only when the caller may read tables
 * (access.ts); events always. A year is read as windows of at most 62 days, one
 * at a time (the table reader has few connections).
 */
import type { CalendarOccurrence, CalendarTruncatedRow } from '@snaglet/shared/types';
import { notableByDay, userTimeZone } from '@snaglet/shared/utils';
import { listOccurrences } from '@server/domains/calendar/occurrences';
import { badInput } from '@server/services/ToolService/tools/database/_shared/input';
import type { CalendarCaller } from './access';
import { TABLE_ROWS_HIDDEN, activeCalendars, resolveCalendar, tooFrequentNote } from './calendars';
import { ROW_REV_LENGTH } from './errors';
import { dateInput, isoInZone, todayIn, windows, zoneInput } from './time';

type Input = Record<string, unknown>;

const LIMIT = { default: 60, max: 200 } as const;

function limitOf(value: unknown): number {
  if (value === undefined || value === null) return LIMIT.default;
  if (!Number.isInteger(value) || (value as number) < 1 || (value as number) > LIMIT.max)
    throw badInput(`limit must be a whole number from 1 to ${LIMIT.max}`);
  return value as number;
}

function itemView(o: CalendarOccurrence, tz: string, calendarTitle: (id: string) => string) {
  const base = {
    title: o.title.trim() || 'Untitled',
    ...(o.time.kind === 'timed'
      ? { start: isoInZone(o.time.start, tz), end: isoInZone(o.time.end, tz) }
      : {}),
    calendar: calendarTitle(o.calendarId),
    status: o.status,
  };
  if (o.source === 'event')
    return {
      kind: 'event',
      ...base,
      ...(o.repeatSummary ? { repeats: o.repeatSummary } : {}),
      event_id: o.eventId,
      rev: String(o.revision),
    };
  if (o.source === 'row')
    return {
      kind: 'table_row',
      ...base,
      ...(o.repeat ? { repeats: o.repeat.summary } : {}),
      table: o.tableName,
      table_id: o.tableId,
      entry_id: o.entryId,
      field_id: o.fieldId,
      rev: o.entryRevision.slice(0, ROW_REV_LENGTH),
      ...(o.repeat ? { occurrence: o.repeat.occurrence } : {}),
    };
  return { kind: 'automation', ...base };
}

export async function datesOp(
  input: Input,
  caller: CalendarCaller,
  now: Date = new Date()
): Promise<unknown> {
  const calendars = await activeCalendars();
  const keys =
    Array.isArray(input.calendars) && input.calendars.length
      ? (input.calendars as unknown[]).map(String)
      : undefined;
  const chosen = keys?.map((key, index) => resolveCalendar(calendars, key, `calendars[${index}]`));
  const only = chosen?.length === 1 ? chosen[0] : undefined;
  const tz = zoneInput(input.tz) ?? only?.timeZone ?? userTimeZone();
  const today = todayIn(tz, now);
  const date =
    input.date === undefined || input.date === null ? today : dateInput(input.date, 'date');
  const year = date.slice(0, 4);
  const from =
    input.from === undefined || input.from === null
      ? `${year}-01-01`
      : dateInput(input.from, 'from');
  const limit = limitOf(input.limit);
  const projectId =
    typeof input.project_id === 'string' && input.project_id.trim()
      ? input.project_id.trim()
      : undefined;

  const hidden: string[] = [];
  const rows = await caller.tableAccess('read');
  if (!rows.allowed) hidden.push(`${TABLE_ROWS_HIDDEN}: ${rows.reason}`);

  // One window at a time: the table reader has few connections.
  const seen = new Map<string, CalendarOccurrence>();
  // Rows repeating more often than once a minute, which no window lists.
  const tooFrequent = new Map<string, CalendarTruncatedRow>();
  for (const window of windows(`${year}-01-01`, `${year}-12-31`)) {
    const result = await listOccurrences({
      from: window.from,
      to: window.to,
      tz,
      ...(chosen ? { calendarIds: chosen.map((c) => c.id) } : {}),
      ...(projectId ? { projectId } : {}),
    });
    for (const o of result.occurrences) {
      if (o.source === 'row' && !rows.allowed) continue;
      seen.set(o.key, o);
    }
    if (rows.allowed)
      for (const row of result.truncated ?? [])
        if (row.hidden) tooFrequent.set(`${row.fieldId}:${row.entryId}`, row);
  }
  const tooFrequentLine = tooFrequentNote([...tooFrequent.values()]);

  const titles = new Map(calendars.map((c) => [c.id, c.title]));
  const calendarTitle = (id: string) => titles.get(id) ?? id;
  const byDay = notableByDay([...seen.values()], (instant) => isoInZone(instant, tz).slice(0, 10));
  const days = [...byDay.entries()]
    .filter(([day]) => day >= from && day.slice(0, 4) === year)
    .sort(([a], [b]) => a.localeCompare(b));
  return {
    year: Number(year),
    tz,
    today,
    from,
    total_days: days.length,
    days: days.slice(0, limit).map(([day, items]) => ({
      day,
      items: items.map((o) => itemView(o, tz, calendarTitle)),
    })),
    ...(days.length > limit
      ? { note: `showing the first ${limit} days; pass from to continue` }
      : {}),
    ...(hidden.length ? { hidden } : {}),
    ...(tooFrequentLine ? { notes: [tooFrequentLine] } : {}),
  };
}
