/**
 * calendar {op: "focus"}: what to do next, ranked, as the calendar's Focus
 * list ranks it. Rows (not events: those happen, they are not to be done) that
 * are overdue, due today or due tomorrow, from one read of the last 30 days to
 * tomorrow:
 *
 * - overdue rows first, longest overdue on top;
 * - then rows due today;
 * - then rows due tomorrow.
 *
 * Rows need table read access (access.ts); without it the list is empty with a
 * note. Each item carries what `complete_occurrence` / `skip_occurrence` need
 * (`table`, `entry_id`, `field_id`, `rev`, `occurrence`).
 */
import type { CalendarOccurrence, CalendarRowOccurrence } from '@snaglet/shared/types';
import { userTimeZone } from '@snaglet/shared/utils';
import { listOccurrences } from '@server/domains/calendar/occurrences';
import { badInput } from '@server/services/ToolService/tools/database/_shared/input';
import type { CalendarCaller } from './access';
import { TABLE_ROWS_HIDDEN, activeCalendars, resolveCalendar, tooFrequentNote } from './calendars';
import { ROW_REV_LENGTH } from './errors';
import { addDays, dateInput, dayDiff, isoInZone, todayIn, zoneInput } from './time';

type Input = Record<string, unknown>;

/** Days before today the read looks back for overdue rows. */
const LOOKBACK_DAYS = 30;
const LIMIT = { default: 10, max: 50 } as const;

interface Item {
  score: number;
  view: Record<string, unknown>;
}

function limitOf(value: unknown): number {
  if (value === undefined || value === null) return LIMIT.default;
  if (!Number.isInteger(value) || (value as number) < 1 || (value as number) > LIMIT.max)
    throw badInput(`limit must be a whole number from 1 to ${LIMIT.max}`);
  return value as number;
}

/** The day an occurrence starts on, in `tz`. */
const dayOf = (o: CalendarOccurrence, tz: string): string =>
  o.time.kind === 'all_day' ? o.time.startDate : isoInZone(o.time.start, tz).slice(0, 10);

function rowItem(
  o: CalendarRowOccurrence,
  why: string,
  score: number,
  tz: string,
  calendarTitle: (id: string) => string
): Item {
  return {
    score,
    view: {
      kind: 'row',
      title: o.title.trim() || `Untitled · ${o.tableName}`,
      why,
      day: dayOf(o, tz),
      calendar: calendarTitle(o.calendarId),
      table: o.tableName,
      table_id: o.tableId,
      entry_id: o.entryId,
      field_id: o.fieldId,
      rev: o.entryRevision.slice(0, ROW_REV_LENGTH),
      ...(o.repeat ? { occurrence: o.repeat.occurrence } : {}),
    },
  };
}

export async function focusOp(
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
  const tomorrow = addDays(date, 1);
  const limit = limitOf(input.limit);
  const projectId =
    typeof input.project_id === 'string' && input.project_id.trim()
      ? input.project_id.trim()
      : undefined;

  const rows = await caller.tableAccess('read');
  if (!rows.allowed) {
    return {
      date,
      today,
      tz,
      next: [],
      coming_up: [],
      hidden: [`${TABLE_ROWS_HIDDEN}: ${rows.reason}`],
    };
  }

  const result = await listOccurrences({
    from: addDays(date, -LOOKBACK_DAYS),
    to: addDays(date, 2),
    tz,
    ...(chosen ? { calendarIds: chosen.map((c) => c.id) } : {}),
    ...(projectId ? { projectId } : {}),
  });
  const titles = new Map(calendars.map((c) => [c.id, c.title]));
  const calendarTitle = (id: string) => titles.get(id) ?? id;
  const items: Item[] = [];

  // Rows to do: overdue, due today, due tomorrow. Events and wakes are left out.
  for (const o of result.occurrences) {
    if (o.source !== 'row' || o.status !== 'upcoming') continue;
    const day = dayOf(o, tz);
    if (day < date || o.repeat?.overdue) {
      const days = Math.max(1, dayDiff(day, date));
      items.push(rowItem(o, `Overdue since ${day}`, 1000 + days, tz, calendarTitle));
    } else if (day === date) items.push(rowItem(o, 'Due today', 900, tz, calendarTitle));
    else if (day === tomorrow) items.push(rowItem(o, 'Due tomorrow', 700, tz, calendarTitle));
  }

  items.sort((a, b) => b.score - a.score);
  const ranked = items.map((item, index) => ({ rank: index + 1, ...item.view }));
  const tooFrequent = tooFrequentNote(result.truncated ?? []);
  return {
    date,
    today,
    tz,
    total: ranked.length,
    next: ranked.slice(0, limit),
    coming_up: ranked.slice(limit, limit + limit),
    ...(tooFrequent ? { notes: [tooFrequent] } : {}),
  };
}
