import type { BuiltinToolDefinition } from '@server/services/ToolService/types';
import { CALENDAR_OCCURRENCES_MAX_DAYS, REMINDER_SOUNDS } from '@snaglet/shared/types';
import { CALENDAR_READ_OPS, CALENDAR_WRITE_OPS } from '@snaglet/shared/utils';
import {
  CALENDAR_QUERY_KINDS,
  CALENDAR_QUERY_LIMIT,
  CALENDAR_QUERY_RANGES,
  CALENDAR_QUERY_STATUSES,
  CALENDAR_REPEAT_FILTERS,
} from '@server/services/ToolService/handlers/calendar/constants';

/**
 * calendar(op) — the calendar as agents use it: a
 * thin adapter over the same calendar, table-repeat and reminder functions
 * the HTTP routes call, so the UI, realtime events and undo keep working.
 *
 * Schema is flat (like `table` and `doc`): each property says which op reads
 * it, and tool.ts refuses a field that belongs only to other ops before any
 * handler runs (CALENDAR_OP_FIELDS). Reads return `rev`; writes need it.
 * `calendar_read` / `calendar_write` are op-family aliases in toolAliases.ts,
 * so an access rule naming one covers exactly its ops. Only delete_event is
 * confirm-gated; restore_event undoes it. Table rows follow the caller's
 * `table` tool access (handlers/calendar/access.ts).
 */
const definition: BuiltinToolDefinition = {
  id: 'calendar',
  name: 'Calendar',
  description:
    'Snaglet calendars: events, dated table rows, automation wakes. ' +
    `op query: what is on in a span (≤${CALENDAR_OCCURRENCES_MAX_DAYS} days), filtered, paged; ` +
    'focus: what to do next, ranked; dates: a year’s marked days; list: calendars and their date fields; ' +
    'create_calendar; get_event, create_event, update_event, delete_event, restore_event: one event; ' +
    'move_occurrence, complete_occurrence, skip_occurrence: one occurrence of a repeating row; ' +
    'get_reminders, set_reminders (before:["15m","1d"], at_start, sound, enabled, clear:true). Writes need a read’s rev. ' +
    'These reminder fields, color and query’s tables, fields, repeats, status, project_id are unlisted: tool({op:"schema", name:"calendar"}) returns them as unlisted_parameters.',
  type: 'builtin',
  tier: 'standard',
  contextRequirement: 'agent-optional',
  destructiveOps: ['delete_event'],
  aliases: ['calendar_read', 'calendar_write'],
  keywords: [
    'calendar',
    'schedule',
    'agenda',
    'event',
    'events',
    'meeting',
    'appointment',
    'all-day',
    'today',
    'tomorrow',
    'this week',
    'upcoming',
    'due',
    'due dates',
    'deadline',
    'occurrence',
    'reschedule',
    'move event',
    'mark done',
    'skip',
    'reminder',
    'reminders',
    'notify me',
  ],
  parameters_schema: {
    type: 'object',
    additionalProperties: false,
    required: ['op'],
    properties: {
      op: { type: 'string', enum: [...CALENDAR_READ_OPS, ...CALENDAR_WRITE_OPS] },
      range: {
        type: 'string',
        enum: [...CALENDAR_QUERY_RANGES],
        description: 'query: a named span (weeks start Monday); or days, or from+to',
      },
      days: {
        type: 'integer',
        description: `query: days from \`from\` (default today), 1-${CALENDAR_OCCURRENCES_MAX_DAYS}`,
      },
      from: {
        type: 'string',
        description:
          'query: start, YYYY-MM-DD or date-time; alone, that one day; no span: next 7 days. dates: only days from it',
      },
      to: { type: 'string', description: 'query: exclusive end' },
      date: {
        type: 'string',
        description: 'focus, dates: any day, YYYY-MM-DD (default today; dates: its year)',
      },
      tz: {
        type: 'string',
        description:
          'IANA zone. Reads: the span’s and times shown (default: the one calendar named, else the user’s); events: the event’s (default its calendar’s); create_calendar: its zone (default the user’s)',
      },
      calendars: {
        type: 'array',
        items: { type: 'string' },
        description: 'query, focus, dates: calendar names or ids (default all active)',
      },
      kinds: {
        type: 'array',
        items: { enum: [...CALENDAR_QUERY_KINDS] },
        description: 'query: default all',
      },
      text: { type: 'string', description: 'query: title contains this (any case)' },
      limit: {
        type: 'integer',
        description: `query: ${CALENDAR_QUERY_LIMIT.min}-${CALENDAR_QUERY_LIMIT.max} (default ${CALENDAR_QUERY_LIMIT.default}); focus: 1-50 (10); dates: 1-200 days (60)`,
      },
      cursor: { type: 'string', description: 'query: the `next` of the previous page' },
      id: {
        type: 'string',
        description:
          'event ops, reminders: the event id; create_event: optional own id (retry-safe)',
      },
      rev: {
        type: 'string',
        description: 'update/delete_event: the event’s rev; occurrence ops: the row’s rev',
      },
      calendar: {
        type: 'string',
        description: 'create/update_event: calendar name or id (default Default)',
      },
      title: { type: 'string', description: 'create_calendar (required), create/update_event' },
      description: { type: 'string', description: 'create_calendar, create/update_event' },
      location: { type: 'string', description: 'create/update_event' },
      start: {
        type: 'string',
        description:
          'create/update_event: YYYY-MM-DDTHH:MM in tz, or ISO with offset; YYYY-MM-DD = all-day. update: start alone moves it, keeping its length',
      },
      end: {
        type: 'string',
        description:
          'create/update_event: timed: exclusive (default start + 1h); all-day: the last day (default start)',
      },
      all_day: { type: 'boolean', description: 'create/update_event: true = dates only' },
      table: {
        type: 'string',
        description: 'occurrence ops, reminders: the row’s table (name or id)',
      },
      entry_id: { type: 'string', description: 'occurrence ops, reminders: the row id' },
      field: {
        type: 'string',
        description: 'occurrence ops, reminders: the date field (name or id)',
      },
      occurrence: {
        type: 'string',
        description:
          'occurrence ops: repeat.occurrence from query; move: which one (default current); complete/skip: the current one only',
      },
      move_to: {
        type: 'string',
        description:
          'move_occurrence: new date (date field) or date-time (in the repeat’s zone, or with an offset)',
      },
    },
  },
  // Query's rarer filters, create_calendar's color and set_reminders' fields:
  // accepted (tool.ts checks fields against CALENDAR_OP_FIELDS, never this
  // schema) but not advertised, to save tokens on every turn.
  // tool(op:schema) returns them as `unlisted_parameters`; TOOL.md lists them.
  unlisted_params: {
    tables: {
      type: 'array',
      items: { type: 'string' },
      description:
        'query: only rows of these tables (names or ids); kinds then defaults to table_rows',
    },
    fields: {
      type: 'array',
      items: { type: 'string' },
      description: 'query: row fields to return as values (default: the table’s select fields)',
    },
    repeats: {
      type: 'string',
      enum: [...CALENDAR_REPEAT_FILTERS],
      description: 'query: repeating rows and automations (default include)',
    },
    status: {
      type: 'array',
      items: { enum: [...CALENDAR_QUERY_STATUSES] },
      description: 'query: occurrence status (default all)',
    },
    project_id: {
      type: 'string',
      description:
        'query: only rows of this project’s tables (events stay); focus, dates: only its tables’ rows',
    },
    color: { type: 'string', description: 'create_calendar: #rgb or #rrggbb (default none)' },
    automation_id: { type: 'string', description: 'get/set_reminders: an automation' },
    enabled: { type: 'boolean', description: 'set_reminders: master switch (default true)' },
    at_start: { type: 'boolean', description: 'set_reminders: notify at the start (default true)' },
    before: {
      type: 'array',
      items: { type: 'string' },
      description: 'set_reminders: advance reminders, e.g. ["15m", "2h", "1d"] (replaces the list)',
    },
    sound: { type: 'string', enum: [...REMINDER_SOUNDS], description: 'set_reminders' },
    clear: { type: 'boolean', description: 'set_reminders: true removes the item’s reminders' },
  },
};

export default definition;
