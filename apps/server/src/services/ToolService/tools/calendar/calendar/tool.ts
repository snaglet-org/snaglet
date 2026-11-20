import type { ToolHandler, ToolHandlerContext } from '@server/services/ToolService/types';
import {
  calendarCaller,
  type CalendarCaller,
} from '@server/services/ToolService/handlers/calendar/access';
import {
  createCalendarOp,
  listCalendarsOp,
} from '@server/services/ToolService/handlers/calendar/calendars';
import { runCalendarTool } from '@server/services/ToolService/handlers/calendar/errors';
import {
  createEventOp,
  deleteEventOp,
  getEventOp,
  restoreEventOp,
  updateEventOp,
} from '@server/services/ToolService/handlers/calendar/events';
import {
  completeOccurrenceOp,
  moveOccurrenceOp,
  skipOccurrenceOp,
} from '@server/services/ToolService/handlers/calendar/occurrences';
import { queryOp } from '@server/services/ToolService/handlers/calendar/query';
import { datesOp } from '@server/services/ToolService/handlers/calendar/dates';
import { focusOp } from '@server/services/ToolService/handlers/calendar/focus';
import {
  getRemindersOp,
  setRemindersOp,
} from '@server/services/ToolService/handlers/calendar/reminders';

type Input = Record<string, unknown>;

/**
 * The fields each op reads. A field that belongs only to OTHER ops is
 * refused before any handler runs, so a call can never half-mean another op
 * (`move_to` on a query, `before` on create_event); a field no op reads is
 * refused too. Fields several ops share (`id`, `rev`, `tz`, `table`, …) mean
 * the same thing in each.
 */
export const CALENDAR_OP_FIELDS: Readonly<Record<string, readonly string[]>> = {
  list: [],
  query: [
    'range',
    'days',
    'from',
    'to',
    'tz',
    'calendars',
    'kinds',
    'tables',
    'fields',
    'repeats',
    'status',
    'text',
    'project_id',
    'limit',
    'cursor',
  ],
  focus: ['date', 'tz', 'calendars', 'project_id', 'limit'],
  dates: ['date', 'from', 'tz', 'calendars', 'project_id', 'limit'],
  create_calendar: ['title', 'description', 'color', 'tz'],
  get_event: ['id'],
  get_reminders: ['id', 'table', 'entry_id', 'field', 'automation_id'],
  create_event: [
    'id',
    'calendar',
    'title',
    'description',
    'location',
    'start',
    'end',
    'all_day',
    'tz',
  ],
  update_event: [
    'id',
    'rev',
    'calendar',
    'title',
    'description',
    'location',
    'start',
    'end',
    'all_day',
    'tz',
  ],
  delete_event: ['id', 'rev'],
  restore_event: ['id'],
  move_occurrence: ['table', 'entry_id', 'field', 'occurrence', 'move_to', 'rev'],
  complete_occurrence: ['table', 'entry_id', 'field', 'occurrence', 'rev'],
  skip_occurrence: ['table', 'entry_id', 'field', 'occurrence', 'rev'],
  set_reminders: [
    'id',
    'table',
    'entry_id',
    'field',
    'automation_id',
    'enabled',
    'at_start',
    'before',
    'sound',
    'clear',
  ],
};

const ALL_FIELDS = new Set(Object.values(CALENDAR_OP_FIELDS).flat());

function refuseForeignFields(op: string, input: Input): void {
  const own = new Set(CALENDAR_OP_FIELDS[op]);
  for (const [field, value] of Object.entries(input)) {
    if (field === 'op' || own.has(field) || value === undefined || value === null) continue;
    const owners = Object.entries(CALENDAR_OP_FIELDS)
      .filter(([, fields]) => fields.includes(field))
      .map(([owner]) => owner);
    throw new Error(
      ALL_FIELDS.has(field)
        ? `calendar ${op}: \`${field}\` belongs to op ${owners.join(' | ')}, not ${op}. Nothing was changed.`
        : `calendar ${op}: \`${field}\` is not a calendar field (${op} reads ${[...own].join(', ') || 'no fields'}). Nothing was changed.`
    );
  }
}

type OpHandler = (input: Input, caller: CalendarCaller) => Promise<unknown>;

const OPS: Record<string, OpHandler> = {
  list: listCalendarsOp,
  query: (input, caller) => queryOp(input, caller),
  focus: (input, caller) => focusOp(input, caller),
  dates: (input, caller) => datesOp(input, caller),
  create_calendar: (input) => createCalendarOp(input),
  get_event: (input) => getEventOp(input),
  get_reminders: getRemindersOp,
  create_event: (input) => createEventOp(input),
  update_event: (input) => updateEventOp(input),
  delete_event: (input) => deleteEventOp(input),
  restore_event: (input) => restoreEventOp(input),
  move_occurrence: moveOccurrenceOp,
  complete_occurrence: completeOccurrenceOp,
  skip_occurrence: skipOccurrenceOp,
  set_reminders: setRemindersOp,
};

/**
 * calendar(op): one standard noun tool over the calendar, table-repeat and
 * reminder domain functions. Every op returns compact JSON; a failure is
 * one `error <status>: …` line.
 */
const tool: ToolHandler = async (input, _settings, context?: ToolHandlerContext) => {
  const op = typeof input.op === 'string' ? input.op : undefined;
  const handler = op ? OPS[op] : undefined;
  if (!op || !handler) {
    throw new Error(`op is required and must be one of ${Object.keys(OPS).join(' | ')}.`);
  }
  refuseForeignFields(op, input);
  const caller = calendarCaller(context);
  return runCalendarTool(() => handler(input, caller));
};

export default tool;
