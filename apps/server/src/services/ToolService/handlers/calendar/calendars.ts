/**
 * calendar {op: "list"} and calendar addressing. Agents name a calendar by
 * id or title (any case); a title two calendars share needs the id.
 */
import { ErrorCode, HTTP_STATUS, type Calendar } from '@snaglet/shared/types';
import { AppError } from '@snaglet/shared/utils';
import { createCalendar, listCalendars } from '@server/domains/calendar/calendarService';
import { badInput } from '@server/services/ToolService/tools/database/_shared/input';
import type { CalendarCaller } from './access';
import { zoneInput } from './time';

const NAMES_SHOWN = 10;

/** Calendars; a read never creates a default. */
export function activeCalendars(): Promise<Calendar[]> {
  return listCalendars();
}

/** The calendar `key` names among `calendars`: its id, or its title in any case. */
export function resolveCalendar(
  calendars: readonly Calendar[],
  key: unknown,
  name: string
): Calendar {
  if (typeof key !== 'string' || !key.trim())
    throw badInput(`${name} must be a calendar name or id`);
  const wanted = key.trim();
  const byId = calendars.find((calendar) => calendar.id === wanted);
  if (byId) return byId;
  const byTitle = calendars.filter(
    (calendar) => calendar.title.toLowerCase() === wanted.toLowerCase()
  );
  const [onlyByTitle] = byTitle;
  if (byTitle.length === 1 && onlyByTitle) return onlyByTitle;
  if (byTitle.length > 1)
    throw badInput(
      `${byTitle.length} calendars are called "${wanted}"; pass an id: ${byTitle.map((c) => c.id).join(', ')}`
    );
  const known = calendars.slice(0, NAMES_SHOWN).map((calendar) => `"${calendar.title}"`);
  throw new AppError(
    `No calendar "${wanted}". Calendars: ${known.join(', ') || 'none'}.`,
    ErrorCode.NOT_FOUND,
    HTTP_STATUS.NOT_FOUND
  );
}

function boundFieldView(field: Calendar['boundFields'][number]) {
  return {
    table: field.tableName,
    table_id: field.tableId,
    field: field.fieldName,
    field_id: field.fieldId,
    type: field.fieldType,
    repeats: field.repeats,
    unscheduled: field.unscheduledCount,
    ...(field.projectId ? { project_id: field.projectId } : {}),
  };
}

export const TABLE_ROWS_HIDDEN = 'table rows and bound table fields are left out';

/**
 * The note for rows repeating more often than once a minute, which the
 * calendar doesn't list (`hidden` in an occurrences read's `truncated`), or
 * null when there are none. query, focus and dates all say it.
 */
export function tooFrequentNote(
  rows: readonly { title: string; hidden?: boolean }[]
): string | null {
  const titles = [...new Set(rows.filter((row) => row.hidden).map((row) => `"${row.title}"`))];
  if (!titles.length) return null;
  const one = titles.length === 1;
  const named = titles.length > 3 ? `${titles.slice(0, 3).join(', ')}, …` : titles.join(', ');
  return (
    `${one ? `${named} repeats` : `${titles.length} rows (${named}) repeat`} more often than once a minute: ` +
    `the calendar lists none of ${one ? 'its' : 'their'} times; ` +
    `${one ? 'the row and its repeat still work' : 'the rows and their repeats still work'} in the table`
  );
}
export const AUTOMATIONS_HIDDEN = 'automation wakes and Every lines are left out';

function calendarView(calendar: Calendar) {
  return {
    id: calendar.id,
    title: calendar.title,
    tz: calendar.timeZone,
    ...(calendar.description ? { description: calendar.description } : {}),
    ...(calendar.color ? { color: calendar.color } : {}),
    ...(calendar.isDefault ? { default: true } : {}),
    rev: String(calendar.revision),
  };
}

/** `list`: calendars with their zone, color and rev, and the table date fields on each. */
export async function listCalendarsOp(
  input: Record<string, unknown>,
  caller: CalendarCaller
): Promise<unknown> {
  const calendars = await listCalendars();
  const rows = await caller.tableAccess('read');
  return {
    calendars: calendars.map((calendar) => ({
      ...calendarView(calendar),
      ...(rows.allowed ? { bound_fields: calendar.boundFields.map(boundFieldView) } : {}),
    })),
    ...(rows.allowed ? {} : { hidden: `${TABLE_ROWS_HIDDEN}: ${rows.reason}` }),
  };
}

/**
 * `create_calendar`: a new calendar with a `title`, and optionally its
 * `description`, `color` (#rgb or #rrggbb) and `tz` (default: the user's
 * zone). A title another calendar has is allowed; address it by id then.
 */
export async function createCalendarOp(input: Record<string, unknown>): Promise<unknown> {
  const { title, description, color } = input;
  if (typeof title !== 'string' || !title.trim()) throw badInput('title is required');
  if (description !== undefined && description !== null && typeof description !== 'string')
    throw badInput('description must be text');
  if (color !== undefined && color !== null && typeof color !== 'string')
    throw badInput('color must be text such as #3366cc');
  const timeZone = zoneInput(input.tz);
  const calendar = await createCalendar({
    title,
    ...(typeof description === 'string' ? { description } : {}),
    ...(typeof color === 'string' ? { color } : {}),
    ...(timeZone ? { timeZone } : {}),
  });
  return { calendar: calendarView(calendar), created: true };
}
