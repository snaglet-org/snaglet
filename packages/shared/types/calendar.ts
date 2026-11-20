/**
 * Calendar wire contract.
 *
 * Routes (all under /api/calendar, JSON, the usual { ok, data } envelope):
 *
 *   GET    /calendars                     → CalendarsResponse
 *            Lists calendars in sort_order with bound fields. Empty stays empty.
 *   POST   /calendars                     CreateCalendarRequest → CalendarResponse
 *   PATCH  /calendars/:id                 UpdateCalendarRequest → CalendarResponse
 *            (rename, color, description, time zone; expectedRevision)
 *   GET    /calendars/:id/deletion        → CalendarDeletionPreview (app only)
 *   DELETE /calendars/:id                 { token } → { id } (app only)
 *   PUT    /calendars/order               ReorderCalendarsRequest → CalendarsResponse
 *
 *   POST   /events                        CreateCalendarEventRequest → CalendarEventResponse
 *   GET    /events/:id                    → CalendarEventResponse
 *   PATCH  /events/:id                    UpdateCalendarEventRequest → CalendarEventResponse
 *   DELETE /events/:id?expectedRevision=N → { id }  (archives the event node; undoable)
 *   POST   /events/:id/restore            → CalendarEventResponse  (undo of a delete)
 *
 *   GET    /occurrences?from=&to=&calendarIds=&projectId=&tz=
 *                                         → CalendarOccurrencesResponse
 *            Events plus bound-field rows inside [from, to). Repeating rows
 *            are expanded by the recurrence engine; logged done / skipped /
 *            moved occurrences inside the window are included with their
 *            status. Once and repeat automations on the calendars come too.
 *
 * Moving a row occurrence has no calendar route: the client writes
 * the field through the normal table entry update (single row) or the
 * repeat routes (repeating row: move-one / shift-all), so it lands in the
 * table's undo history.
 *
 * Realtime: surface `calendar`, event `calendar:changed` with
 * CalendarChangedEvent; clients refetch the visible window. Row changes keep
 * arriving on the tables surface; the client refetches occurrences when an
 * entry of a bound table changes.
 */

import { TABLE_SELECT_OPTION_COLORS } from './table-select-options';

/**
 * The calendar palette: the table select-option colors (same tokens, so the
 * theme re-skins both). Automatic colors (null) are assigned from it by sort
 * order.
 */
export const CALENDAR_COLORS = TABLE_SELECT_OPTION_COLORS;
export type CalendarPaletteColor = (typeof CALENDAR_COLORS)[number];
/** Prefix of a color that names a workspace theme token (`theme:detail`). */
export const CALENDAR_THEME_COLOR_PREFIX = 'theme:';
/** A workspace theme token by name, so the calendar follows theme edits. */
export type CalendarThemeColor = `theme:${string}`;
/** A custom color: lowercase six-digit hex (`#3a7bd5`). */
export type CalendarCustomColor = `#${string}`;
/**
 * A calendar color as stored (`calendars.color`, plain text): a palette id,
 * a theme token reference or a custom hex. null = automatic. Check and
 * normalize any input with `normalizeCalendarColor` (@snaglet/shared/utils).
 */
export type CalendarColor = CalendarPaletteColor | CalendarThemeColor | CalendarCustomColor;

export const CALENDAR_TITLE_MAX_LENGTH = 500;
export const CALENDAR_EVENT_TITLE_MAX_LENGTH = 500;
/** An event's description (chip markdown included) is at most this long. */
export const CALENDAR_EVENT_DESCRIPTION_MAX_LENGTH = 10_000;
/** The title the service gives the Default calendar when it creates it. */
export const DEFAULT_CALENDAR_TITLE = 'Default calendar';
/** Widest window one occurrences read may ask for, in days. */
export const CALENDAR_OCCURRENCES_MAX_DAYS = 62;
/** A timed row with no end (a datetime, or a datetime range holding only a start) is drawn as this many minutes. */
export const CALENDAR_DEFAULT_BLOCK_MINUTES = 30;
/**
 * Most occurrences one interval-repeating row ("every 1 min") puts in one
 * occurrences read; past it the read lists the row in `truncated`. Reminders
 * read rows through the same expansion, so it bounds them too.
 */
export const CALENDAR_ROW_OCCURRENCES_MAX = 500;
/**
 * The shortest interval the calendar draws, in seconds: a row repeating more
 * often than once a minute isn't drawn in any view (its chips, history and
 * day dots), and an occurrences read lists it in `truncated` as `hidden`
 * without expanding it. The row, its Repeat section and its reminders (spaced
 * to a minute) keep working.
 */
export const CALENDAR_INTERVAL_MIN_SECONDS = 60;

/** A date/datetime field bound to a calendar. */
export interface CalendarBoundField {
  tableId: string;
  tableName: string;
  /** The table's project, or null for a workspace-level table. */
  projectId: string | null;
  fieldId: string;
  fieldName: string;
  fieldType: 'date' | 'datetime';
  /** True when the field has a repeat setting (rows may repeat). */
  repeats: boolean;
  /** Rows of the table with no value in this field (and no repeat): the sidebar's "unscheduled" count. */
  unscheduledCount: number;
}

export interface Calendar {
  id: string;
  title: string;
  description: string;
  /** IANA zone. */
  timeZone: string;
  color: CalendarColor | null;
  /** The service-created Default calendar (at most one). Renaming keeps it. */
  isDefault: boolean;
  /** Manual sidebar position, 0-based among calendars. */
  sortOrder: number;
  revision: number;
  createdAt: string;
  updatedAt: string;
  boundFields: CalendarBoundField[];
}

export interface CalendarsResponse {
  calendars: Calendar[];
}

export interface CalendarResponse {
  calendar: Calendar;
}

export interface CreateCalendarRequest {
  title: string;
  description?: string;
  timeZone?: string;
  color?: CalendarColor | null;
  /** Slot among calendars; omit to append. */
  sortOrder?: number;
}

export interface UpdateCalendarRequest {
  title?: string;
  description?: string;
  timeZone?: string;
  color?: CalendarColor | null;
  expectedRevision: number;
}

export interface ReorderCalendarsRequest {
  /** Every calendar id, in the new order. */
  calendarIds: string[];
}

/**
 * A single (non-repeating) event. Writes refuse `recurrence`; the event
 * series columns are unused. Timed events use `startAt`/`endAt` (ISO
 * instants, exclusive end); all-day events use `startDate`/`endDate`
 * (YYYY-MM-DD, exclusive end).
 */
export type CalendarEventTime =
  | { kind: 'timed'; startAt: string; endAt: string; timeZone: string }
  | { kind: 'all_day'; startDate: string; endDate: string; timeZone: string };

/**
 * How an event repeats: the same RFC 5545 rule body table date fields use
 * (`FREQ=WEEKLY;BYDAY=MO,WE`, with its end as `COUNT` / `UNTIL`), anchored on
 * the event's own start. The whole series is one event: edits change every
 * occurrence.
 */
export interface CalendarEventRepeat {
  rrule: string;
}

export interface CalendarEvent {
  /** A node id (nodes.type = 'calendar_event'). */
  id: string;
  calendarId: string;
  title: string;
  description: string;
  location: string;
  time: CalendarEventTime;
  /** Null for a single event. */
  repeat: CalendarEventRepeat | null;
  revision: number;
  createdAt: string;
  updatedAt: string;
}

export interface CalendarEventResponse {
  event: CalendarEvent;
}

export interface CreateCalendarEventRequest {
  /** Client-minted node id for idempotent retries (optional). */
  id?: string;
  /** Omit for the Default calendar (created if needed). */
  calendarId?: string;
  title: string;
  description?: string;
  location?: string;
  time: CalendarEventTime;
  repeat?: CalendarEventRepeat | null;
}

export interface UpdateCalendarEventRequest {
  calendarId?: string;
  title?: string;
  description?: string;
  location?: string;
  time?: CalendarEventTime;
  /** Null stops the event repeating. */
  repeat?: CalendarEventRepeat | null;
  expectedRevision: number;
}

/**
 * Where an occurrence sits. Timed: wall-clock `start`/`end` as ISO instants.
 * All-day / date rows: `startDate` inclusive, `endDate` exclusive.
 */
export type CalendarOccurrenceTime =
  | { kind: 'timed'; start: string; end: string }
  | { kind: 'all_day'; startDate: string; endDate: string };

/**
 * One repeating row's occurrence state:
 * - upcoming: the row's current occurrence or a later expanded one (not done yet);
 * - done / skipped: logged in table_entry_occurrences;
 * - moved: logged as moved; drawn at `moved_to`, with `originalStart` the planned slot.
 * Non-repeating rows and events are always 'upcoming' (they keep no history).
 */
export type CalendarOccurrenceStatus = 'upcoming' | 'done' | 'skipped' | 'moved';

interface CalendarOccurrenceBase {
  /**
   * Stable for the window: `event:<id>`, `row:<fieldId>:<entryId>:<occurrence>` or
   * `automation:<id>:<occurrence ISO>`.
   */
  key: string;
  calendarId: string;
  title: string;
  time: CalendarOccurrenceTime;
  status: CalendarOccurrenceStatus;
  /** The UI offers drag-to-move only when true. */
  canMove: boolean;
  /** The UI offers resize handles only when true (timed events; rows of a range field). */
  canResize: boolean;
  /** A skipped occurrence that actually failed (automations: the wake failed). */
  note?: 'failed';
}

export interface CalendarEventOccurrence extends CalendarOccurrenceBase {
  source: 'event';
  eventId: string;
  revision: number;
  /**
   * The event's own saved IANA zone (`CalendarEventTime.timeZone`), so a
   * write rebuilt from the occurrence (a move, its undo) keeps it. The
   * server always sends it; a client treats a missing one as the viewer's.
   */
  timeZone?: string;
  /** Set on an occurrence of a repeating event: the series' sentence ("Every week on Mon"). */
  repeatSummary?: string;
}

export interface CalendarRowOccurrence extends CalendarOccurrenceBase {
  source: 'row';
  tableId: string;
  tableName: string;
  projectId: string | null;
  entryId: string;
  fieldId: string;
  /**
   * The bound field holds ranges (End date on). A move writes the whole
   * shifted range in one entry update; a resize writes the new end.
   */
  range: boolean;
  /**
   * This occurrence has an end of its own (a range with an end). False for a
   * plain field and for a range holding only a start, which is drawn as one
   * day or the default block and stays a single value when moved.
   */
  hasEnd: boolean;
  /** The entry's revision, for the move write's expectedRevision. */
  entryRevision: string;
  /** The entry's table schemaVersion, for the move write. */
  schemaVersion: string;
  /** Present on a repeating row: the occurrence's wall time and whether it is the row's current one. */
  repeat?: {
    occurrence: string;
    isCurrent: boolean;
    /** Planned slot of a moved occurrence. */
    originalStart?: string;
    /** Plain summary, e.g. "Weekly on Mon". */
    summary: string;
    /**
     * Whether "All upcoming" (shift all) can move this series by days. False
     * for rules pinned to fixed days (numbered BYDAY, BYMONTHDAY, BYMONTH, …),
     * which the shift action refuses with a 400. The server always sends it;
     * a client treats a missing value as true.
     */
    canShiftAll?: boolean;
    /**
     * The row's current occurrence whose date has passed undone; for a repeat
     * at an interval, its time (as of the read). It stays the row's until done
     * or skipped.
     */
    overdue?: boolean;
  };
}

/**
 * One wake of a once or repeat automation. Drawn as a 15-minute block
 * at the wake time; never moved or resized (that would edit its rule). Past
 * wakes are done or skipped (`note: 'failed'` when the wake failed).
 * A paused automation is not on the calendar at all.
 */
export interface CalendarAutomationOccurrence extends CalendarOccurrenceBase {
  source: 'automation';
  automationId: string;
  agentId: string;
  agentName: string;
  threadId: string;
  automationStatus: 'active' | 'finished';
}

export type CalendarOccurrence =
  | CalendarEventOccurrence
  | CalendarRowOccurrence
  | CalendarAutomationOccurrence;

/**
 * An active Every (interval) automation on the calendar (a paused one is not
 * drawn): one span per visible day, never one item per wake. Drawn as a thin line down the day with
 * a dot at its top: on the day it starts the line begins at `startsAt`, on
 * later days it runs from midnight. It has no end, so every day from its
 * start gets one. Never moved or resized. Sent in
 * {@link CalendarOccurrencesResponse.intervals}, apart from `occurrences`, so
 * the event, row and wake code paths never meet it.
 */
export interface CalendarIntervalSpan {
  /** `automation:<id>:span:<day>`, stable for the window. */
  key: string;
  source: 'automation';
  kind: 'interval';
  automationId: string;
  calendarId: string;
  /** The automation's name. */
  name: string;
  /** The day it is drawn on, YYYY-MM-DD in the query's zone. */
  day: string;
  everyMs: number;
  /**
   * Its daily window, when it has one: it runs only from `start` to
   * `end`, HH:mm wall clock in `tz` (the automation's zone, not the query's).
   */
  window?: { start: string; end: string; tz: string };
  /** When it started (its interval anchor), an ISO instant in UTC. */
  startsAt: string;
  /** The next wake. */
  nextRunAt: string | null;
  agentId: string;
  agentName: string;
  threadId: string;
}

export interface CalendarOccurrencesQuery {
  /** Inclusive start, YYYY-MM-DD in `tz`. */
  from: string;
  /** Exclusive end, YYYY-MM-DD in `tz`; at most CALENDAR_OCCURRENCES_MAX_DAYS after `from`. */
  to: string;
  /** Limit to these calendars (comma-separated on the wire); omit for all active. */
  calendarIds?: string[];
  /** "This project only": rows of tables in this project and events on any calendar. */
  projectId?: string;
  /** Viewer's IANA zone for placing timed items and date rows; defaults to the server's. */
  tz?: string;
}

export interface CalendarOccurrencesResponse {
  from: string;
  to: string;
  tz: string;
  occurrences: CalendarOccurrence[];
  /**
   * Every (interval) automations on the requested calendars: one span per
   * day each is active in the window, oldest start first.
   */
  intervals: CalendarIntervalSpan[];
  /**
   * Bound fields that could not be read (e.g. the table is archived), so the
   * UI can say why rows are missing instead of silently dropping them.
   */
  unavailable: Array<{
    tableId: string;
    fieldId: string;
    reason: 'table_archived' | 'field_archived';
  }>;
  /**
   * Rows that repeat too often to show every time in the window (an interval
   * repeat over {@link CALENDAR_ROW_OCCURRENCES_MAX}): only their first
   * `shown` are in `occurrences`, so the UI can say so; a `hidden` one repeats
   * more often than once a minute and has none there. Absent when none.
   */
  truncated?: CalendarTruncatedRow[];
}

/** A row cut short in an occurrences read (see `CalendarOccurrencesResponse.truncated`). */
export interface CalendarTruncatedRow {
  tableId: string;
  fieldId: string;
  entryId: string;
  title: string;
  /** How many of its occurrences the read holds. */
  shown: number;
  /**
   * Not drawn at all: it repeats more often than once a minute
   * ({@link CALENDAR_INTERVAL_MIN_SECONDS}); `shown` is 0.
   */
  hidden?: boolean;
}

export interface CalendarChangedEvent {
  kind: 'calendar' | 'event' | 'binding' | 'automation';
  /** The calendar touched, when known. */
  calendarId?: string;
  eventId?: string;
  automationId?: string;
}

/** Confirmation snapshot; submit token unchanged to reject stale confirmations. */
export interface CalendarDeletionPreview {
  token: string;
  events: number;
  dateFields: number;
  automations: number;
}
