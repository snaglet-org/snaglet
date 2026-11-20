/** The calendar tool's fixed vocabularies, shared by its definition and handlers. */

/** query `kinds`: what a calendar item is. */
export const CALENDAR_QUERY_KINDS = ['events', 'table_rows', 'automations'] as const;
export type CalendarQueryKind = (typeof CALENDAR_QUERY_KINDS)[number];

/** query `range`: a named span in the query's zone (weeks start on Monday). */
export const CALENDAR_QUERY_RANGES = [
  'today',
  'tomorrow',
  'this_week',
  'next_week',
  'this_month',
] as const;
export type CalendarQueryRange = (typeof CALENDAR_QUERY_RANGES)[number];

/** query `repeats`: keep, drop or keep only repeating items. */
export const CALENDAR_REPEAT_FILTERS = ['include', 'exclude', 'only'] as const;
export type CalendarRepeatFilter = (typeof CALENDAR_REPEAT_FILTERS)[number];

/** query `status`: an occurrence's state (CalendarOccurrenceStatus). */
export const CALENDAR_QUERY_STATUSES = ['upcoming', 'done', 'skipped', 'moved'] as const;

/** query `limit`: occurrences per page. */
export const CALENDAR_QUERY_LIMIT = { min: 1, max: 200, default: 50 } as const;

/** Days a query with no span covers, from today. */
export const CALENDAR_DEFAULT_DAYS = 7;
