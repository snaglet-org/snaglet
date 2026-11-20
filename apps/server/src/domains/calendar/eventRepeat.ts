/**
 * Repeating events. An event repeats with the same rule body a table date
 * field does, anchored on the event's own start (a wall time in its saved
 * zone, or its start date for an all-day one), so the table engine validates
 * and expands both. A repeat is series-wide: there are no per-occurrence
 * exceptions, so a move or edit changes every occurrence.
 */
import { instantToWall } from '@snaglet/db/tables/table_entries/repeats';
import { calendarBadRequest } from '@snaglet/db/tables/calendars';
import type { CalendarEventRepeat, CalendarEventTime } from '@snaglet/shared/types';
import {
  createTableRepeat,
  tableRepeatIntervalSeconds,
  type TableRepeat,
} from '@snaglet/shared/utils';

/** The event's start as the repeat's anchor: a date, or a wall time in its zone. */
function eventAnchorWall(time: CalendarEventTime): string | null {
  return time.kind === 'all_day' ? time.startDate : instantToWall(time.startAt, time.timeZone);
}

/** The table-engine repeat for an event's rule, or null when it can't be built. */
export function eventTableRepeat(
  repeat: CalendarEventRepeat,
  time: CalendarEventTime
): TableRepeat | null {
  const anchor = eventAnchorWall(time);
  if (!anchor) return null;
  const result = createTableRepeat({ date: anchor, rrule: repeat.rrule, tz: time.timeZone });
  return result.ok ? result.value : null;
}

/** The request's `repeat`, normalized and checked against the event's time; null = no repeat. */
export function validEventRepeat(
  value: unknown,
  time: CalendarEventTime
): CalendarEventRepeat | null {
  if (value === null || value === undefined) return null;
  if (
    typeof value !== 'object' ||
    Array.isArray(value) ||
    typeof (value as { rrule?: unknown }).rrule !== 'string'
  )
    throw calendarBadRequest('repeat must be { rrule } or null.');
  const rrule = (value as { rrule: string }).rrule;
  const anchor = eventAnchorWall(time);
  if (!anchor) throw calendarBadRequest('The event start is not a valid time.');
  const result = createTableRepeat({ date: anchor, rrule, tz: time.timeZone });
  if (!result.ok) throw calendarBadRequest(result.error);
  // Sub-daily rules would flood the grid; a timed event repeats by day or longer.
  if (tableRepeatIntervalSeconds(result.value.rrule) !== null)
    throw calendarBadRequest('An event can repeat daily or less often.');
  return { rrule: result.value.rrule };
}
