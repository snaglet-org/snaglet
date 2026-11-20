/**
 * GET /api/calendar/occurrences: events plus bound-field rows inside
 * [from, to) in the viewer's zone. Rows are read through the restricted
 * tables reader, one query per visible binding. Repeating rows are expanded
 * with the repeat engine (wall time in each row's saved zone) and merged with
 * the occurrence log (done / skipped / moved).
 *
 * Time rules: date values are calendar dates and never pass through UTC
 * midnight; datetime values are instants; repeating datetime occurrences are
 * wall times converted in the repeat's own `tz`. A range field (End date on)
 * shows its rows as spans: a date range all-day through its last day, a
 * datetime range timed to its end; one holding only a start is one day or
 * the default block. Every (interval) automations come back apart, in
 * `intervals`: a span per day each is active (automationOccurrences.ts).
 */
import { getDb } from '@snaglet/db/db';
import { Calendars } from '@snaglet/db/tables/calendars';
import {
  CalendarEvents,
  CalendarReaderUnavailableError,
  listBindings,
  readBindingRows,
  type BindingMeta,
  type BindingRow,
  type CalendarEventRow,
} from '@snaglet/db/tables/calendar_events';
import { listOccurrenceLog, listRepeatsForFields } from '@snaglet/db/tables/table_entries';
import {
  instantToWall,
  msToWall,
  shiftRuleByDays,
  wallMs,
  type OccurrenceLogRow,
} from '@snaglet/db/tables/table_entries/repeats';
import {
  CALENDAR_DEFAULT_BLOCK_MINUTES,
  CALENDAR_INTERVAL_MIN_SECONDS,
  CALENDAR_OCCURRENCES_MAX_DAYS,
  CALENDAR_ROW_OCCURRENCES_MAX,
  ErrorCode,
  HTTP_STATUS,
  type CalendarEventOccurrence,
  type CalendarOccurrence,
  type CalendarOccurrencesResponse,
  type CalendarRowOccurrence,
  type CalendarTruncatedRow,
} from '@snaglet/shared/types';
import {
  AppError,
  isTableRepeatOverdue,
  tableDateTimeToUtc,
  tableRepeatIntervalOccurrences,
  tableRepeatIntervalSeconds,
  tableRepeatSummary,
  upcomingRepeatOccurrences,
  userTimeZone,
  type TableRepeat,
} from '@snaglet/shared/utils';
import { calendarBadRequest } from '@snaglet/db/tables/calendars';
import { eventTableRepeat } from './eventRepeat';
import {
  automationIntervals,
  automationOccurrences,
  type IntervalWindowDay,
} from './automationOccurrences';

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const ZONE = /^[A-Za-z0-9_+\-/]+$/;
const DAY_MS = 86_400_000;

// --- small date helpers (pure calendar-date arithmetic, no zones) -----------

function dateToMs(date: string): number {
  return Date.UTC(
    Number(date.slice(0, 4)),
    Number(date.slice(5, 7)) - 1,
    Number(date.slice(8, 10))
  );
}

function addDays(date: string, days: number): string {
  return new Date(dateToMs(date) + days * DAY_MS).toISOString().slice(0, 10);
}

/** Whole days from `from` to `to` (calendar dates). */
function dayDiff(from: string, to: string): number {
  return Math.round((dateToMs(to) - dateToMs(from)) / DAY_MS);
}

function validDate(value: unknown, name: string): string {
  if (typeof value !== 'string' || !DATE_ONLY.test(value))
    throw calendarBadRequest(`${name} must be a date (YYYY-MM-DD).`);
  if (addDays(value, 0) !== value) throw calendarBadRequest(`${name} is not a real date.`);
  return value;
}

/** The instant a wall time names in `tz`. */
function wallInstant(wall: string, tz: string): string {
  const utc = tableDateTimeToUtc(wall, tz);
  if (!utc) throw new Error(`Invalid wall time ${wall}`);
  return new Date(utc).toISOString();
}

function plusMinutes(instant: string, minutes: number): string {
  return new Date(Date.parse(instant) + minutes * 60_000).toISOString();
}

function iso(instant: string): string {
  return new Date(instant).toISOString();
}

/** Whether the runtime knows `zone` (invalid names throw a RangeError). */
function knownZone(zone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone });
    return tableDateTimeToUtc('2026-01-01T00:00:00', zone) !== null;
  } catch {
    return false;
  }
}

// --- query parsing -----------------------------------------------------------

interface ParsedOccurrencesQuery {
  from: string;
  to: string;
  tz: string;
  calendarIds?: string[];
  projectId?: string;
}

function parseOccurrencesQuery(query: Record<string, unknown>): ParsedOccurrencesQuery {
  const from = validDate(query.from, 'from');
  const to = validDate(query.to, 'to');
  const days = (dateToMs(to) - dateToMs(from)) / DAY_MS;
  if (days < 1) throw calendarBadRequest('to must be after from (the end is exclusive).');
  if (days > CALENDAR_OCCURRENCES_MAX_DAYS)
    throw calendarBadRequest(`A window is at most ${CALENDAR_OCCURRENCES_MAX_DAYS} days.`);
  let tz = userTimeZone();
  if (query.tz !== undefined && query.tz !== '') {
    if (typeof query.tz !== 'string' || !ZONE.test(query.tz) || !knownZone(query.tz))
      throw calendarBadRequest('tz must be a known IANA time zone name.');
    tz = query.tz;
  }
  let calendarIds: string[] | undefined;
  const rawIds = query.calendarIds ?? query.calendars;
  if (rawIds !== undefined && rawIds !== '') {
    const list = Array.isArray(rawIds) ? rawIds : String(rawIds).split(',');
    calendarIds = list.map((id) => String(id).trim()).filter(Boolean);
  }
  const projectId =
    typeof query.projectId === 'string' && query.projectId.trim()
      ? query.projectId.trim()
      : undefined;
  return {
    from,
    to,
    tz,
    ...(calendarIds ? { calendarIds } : {}),
    ...(projectId ? { projectId } : {}),
  };
}

// --- events ------------------------------------------------------------------

function singleEventOccurrence(event: CalendarEventRow): CalendarEventOccurrence {
  const time =
    event.time.kind === 'timed'
      ? { kind: 'timed' as const, start: event.time.startAt, end: event.time.endAt }
      : { kind: 'all_day' as const, startDate: event.time.startDate, endDate: event.time.endDate };
  return {
    key: `event:${event.id}`,
    source: 'event',
    eventId: event.id,
    revision: event.revision,
    timeZone: event.time.timeZone,
    calendarId: event.calendarId,
    title: event.title,
    time,
    status: 'upcoming',
    canMove: true,
    canResize: event.time.kind === 'timed',
  };
}

/**
 * A repeating event's occurrences inside the window: its rule expanded from
 * the event's start, each the event's own length. The first keeps the plain
 * `event:<id>` key; later ones add their wall time. Series-wide, so none
 * can be moved or resized on its own.
 */
function repeatingEventOccurrences(
  event: CalendarEventRow,
  window: Window
): CalendarEventOccurrence[] {
  const repeat = event.repeat ? eventTableRepeat(event.repeat, event.time) : null;
  if (!repeat) return [singleEventOccurrence(event)];
  const summary = tableRepeatSummary(repeat, { hasEnd: true });
  const out: CalendarEventOccurrence[] = [];
  for (const wall of expandRepeat(repeat, window)) {
    let time: CalendarEventOccurrence['time'];
    if (event.time.kind === 'all_day') {
      const length = dayDiff(event.time.startDate, event.time.endDate);
      const startDate = wall.slice(0, 10);
      time = { kind: 'all_day', startDate, endDate: addDays(startDate, length) };
    } else {
      const length = Date.parse(event.time.endAt) - Date.parse(event.time.startAt);
      const start = wallInstant(wall, repeat.tz);
      time = { kind: 'timed', start, end: new Date(Date.parse(start) + length).toISOString() };
    }
    if (!overlaps(time, window)) continue;
    out.push({
      ...singleEventOccurrence(event),
      key: wall === repeat.dtstart ? `event:${event.id}` : `event:${event.id}:${wall}`,
      time,
      canMove: false,
      canResize: false,
      repeatSummary: summary,
    });
  }
  return out;
}

// --- rows ---------------------------------------------------------------------

interface Window {
  from: string;
  to: string;
  tz: string;
  fromInstant: string;
  toInstant: string;
}

type RowTime = CalendarRowOccurrence['time'];

function overlaps(time: RowTime, window: Window): boolean {
  if (time.kind === 'all_day') return time.startDate < window.to && time.endDate > window.from;
  return (
    Date.parse(time.start) < Date.parse(window.toInstant) &&
    Date.parse(time.end) > Date.parse(window.fromInstant)
  );
}

/**
 * Where a row's own value sits: a date (range) is all-day through its last
 * day; a datetime range runs to its end; a datetime, or a datetime range
 * holding only a start, is the default block.
 */
function plainRowTime(binding: BindingMeta, row: BindingRow): RowTime | null {
  if (!row.start) return null;
  if (binding.fieldType === 'date') {
    const date = row.start.slice(0, 10);
    return { kind: 'all_day', startDate: date, endDate: addDays(row.end ?? date, 1) };
  }
  const start = iso(row.start);
  const end = row.end ? iso(row.end) : plusMinutes(start, CALENDAR_DEFAULT_BLOCK_MINUTES);
  return { kind: 'timed', start, end };
}

/**
 * How long each occurrence of a repeating row lasts: the length of the row's
 * current value, in whole days for a date range and in
 * wall-clock time in the repeat's zone for a datetime range, so 9:00 Fri –
 * 17:00 Mon still ends at 17:00 after a DST change. Zero = one day / the
 * default block.
 */
interface RowLength {
  days: number;
  wallMs: number;
}

function rowLength(binding: BindingMeta, row: BindingRow, repeat: TableRepeat): RowLength {
  if (!row.start || !row.end) return { days: 0, wallMs: 0 };
  if (binding.fieldType === 'date')
    return { days: Math.max(0, dayDiff(row.start.slice(0, 10), row.end)), wallMs: 0 };
  const from = instantToWall(row.start, repeat.tz);
  const to = instantToWall(row.end, repeat.tz);
  const ms = from && to ? (wallMs(to) ?? 0) - (wallMs(from) ?? 0) : 0;
  return { days: 0, wallMs: Math.max(0, ms) };
}

/** Whether occurrences of that length have an end of their own. */
function hasLength(length: RowLength): boolean {
  return length.days > 0 || length.wallMs > 0;
}

/**
 * The END of the occurrence that starts at wall `start`, as a wall time of the
 * same kind — the last day for a date range, the end instant's wall for a
 * timed one. Returns `undefined` for a single-day / point-in-time row (no
 * length), so overdue falls back to the start-day comparison. Fed to
 * {@link isTableRepeatOverdue} so a range is overdue only after it finishes.
 */
function occurrenceEndWall(start: string, length: RowLength): string | undefined {
  if (!hasLength(length)) return undefined;
  if (DATE_ONLY.test(start)) return length.days > 0 ? addDays(start, length.days) : undefined;
  const startMs = wallMs(start);
  if (length.wallMs <= 0 || startMs === null) return undefined;
  return msToWall(startMs + length.wallMs, 'datetime');
}

/** Where a wall-time occurrence of `repeat` sits, `length` long. */
function wallTime(wall: string, repeat: TableRepeat, length: RowLength): RowTime {
  if (DATE_ONLY.test(wall))
    return { kind: 'all_day', startDate: wall, endDate: addDays(wall, 1 + length.days) };
  const start = wallInstant(wall, repeat.tz);
  const startMs = wallMs(wall);
  if (!length.wallMs || startMs === null)
    return { kind: 'timed', start, end: plusMinutes(start, CALENDAR_DEFAULT_BLOCK_MINUTES) };
  const end = wallInstant(msToWall(startMs + length.wallMs, 'datetime'), repeat.tz);
  // A wall end inside a DST gap can map before the start; keep the real length then.
  return Date.parse(end) > Date.parse(start)
    ? { kind: 'timed', start, end }
    : { kind: 'timed', start, end: plusMinutes(start, length.wallMs / 60_000) };
}

function startOf(time: RowTime): string {
  return time.kind === 'timed' ? time.start : time.startDate;
}

/**
 * Wall-time occurrences of `repeat` from its current one up to the window
 * end (bounded by the engine's scan limit).
 */
function expandRepeat(repeat: TableRepeat, window: Window): string[] {
  const endWall = DATE_ONLY.test(repeat.current) ? window.to : null;
  let count = 64;
  for (;;) {
    const result = upcomingRepeatOccurrences(repeat, count);
    if (!result.ok) return [];
    const list = result.value;
    const last = list[list.length - 1];
    const pastEnd =
      !last ||
      list.length < count ||
      (endWall !== null
        ? last >= endWall
        : Date.parse(wallInstant(last, repeat.tz)) >= Date.parse(window.toInstant));
    if (pastEnd || count >= 4096) return list;
    count *= 4;
  }
}

/**
 * Reminders are at least this far apart for one row and reminder offset: a
 * row repeating more often reminds on every n-th occurrence counted from its
 * start, n the fewest steps that span a minute (every 60th at one second,
 * every other at 30 s, every other at 45 s, so 90 s apart). Two offsets on
 * one row are spaced each on its own.
 */
const REMINDER_MIN_SPACING_SECONDS = 60;

/** Every how many steps reminders read for an interval of `seconds` (1 when it is a minute or more). */
function reminderStride(seconds: number): number {
  return seconds >= REMINDER_MIN_SPACING_SECONDS
    ? 1
    : Math.ceil(REMINDER_MIN_SPACING_SECONDS / seconds);
}

/**
 * An interval repeat's occurrences for the window, its current one first:
 * the engine steps straight to the window (so "every 1 min" doesn't walk
 * from a current one weeks back) and stops at
 * {@link CALENDAR_ROW_OCCURRENCES_MAX}; `truncated` when the window holds
 * more. Starts up to one occurrence's length before the window still reach
 * into it. With a `stride` (reminders on a short interval) only every
 * `stride`-th step from the start is read, the current one too, so it isn't
 * put first.
 */
function expandInterval(
  repeat: TableRepeat,
  window: Window,
  length: RowLength,
  stride = 1
): { list: string[]; truncated: boolean } {
  const lead = length.wallMs || CALENDAR_DEFAULT_BLOCK_MINUTES * 60_000;
  const result = tableRepeatIntervalOccurrences(repeat, {
    from: new Date(Date.parse(window.fromInstant) - lead).toISOString(),
    to: window.toInstant,
    limit: CALENDAR_ROW_OCCURRENCES_MAX,
    stride,
  });
  if (!result.ok) return { list: [], truncated: false };
  if (stride > 1) return { list: result.value.occurrences, truncated: result.value.truncated };
  const rest = result.value.occurrences.filter((occurrence) => occurrence !== repeat.current);
  return { list: [repeat.current, ...rest], truncated: result.value.truncated };
}

/**
 * Whether an interval repeat has an occurrence in the window, read without
 * expanding it (the engine steps straight there and stops at the first).
 */
function intervalTouches(repeat: TableRepeat, window: Window): boolean {
  const result = tableRepeatIntervalOccurrences(repeat, {
    from: window.fromInstant,
    to: window.toInstant,
    limit: 1,
  });
  return result.ok && (result.value.occurrences.length > 0 || result.value.truncated);
}

/** Who reads: the calendar (its views, the agent's calendar tool) or reminders. */
type OccurrencesReader = 'calendar' | 'reminders';

interface RowContext {
  binding: BindingMeta;
  schemaVersion: string;
  /** The field holds ranges: its rows can be resized. */
  range: boolean;
  /** Where a read collects the rows it cut short or hides (interval repeats). */
  truncated?: CalendarTruncatedRow[];
  /**
   * The calendar hides a row repeating more often than once a minute;
   * reminders read it, spaced to a minute.
   */
  reader: OccurrencesReader;
}

function baseRow(
  ctx: RowContext,
  row: BindingRow,
  time: RowTime,
  key: string,
  hasEnd: boolean
): CalendarRowOccurrence {
  return {
    key,
    source: 'row',
    calendarId: ctx.binding.calendarId,
    title: row.title.trim() || 'Untitled',
    time,
    status: 'upcoming',
    // Snaglet writes a managed field (`created_at`), never the calendar: its rows
    // show but don't move or resize (the entry API refuses the write too).
    canMove: !ctx.binding.managed,
    // A range field's own end: datetime ranges in Week/Day, a date range's
    // right edge in Month and the all-day lane.
    canResize: ctx.range && !ctx.binding.managed,
    tableId: ctx.binding.tableId,
    tableName: ctx.binding.tableName,
    projectId: ctx.binding.projectId,
    entryId: row.entryId,
    fieldId: ctx.binding.fieldId,
    range: ctx.range,
    hasEnd,
    entryRevision: row.revision,
    schemaVersion: ctx.schemaVersion,
  };
}

/**
 * One repeating row's occurrences in the window: expanded upcoming ones plus
 * logged history. Every one (logged done / skipped / moved too; the log keeps
 * only starts) takes the length of the row's current value.
 */
function repeatingRowOccurrences(
  ctx: RowContext,
  row: BindingRow,
  repeat: TableRepeat,
  log: OccurrenceLogRow[],
  window: Window
): CalendarRowOccurrence[] {
  const seconds = tableRepeatIntervalSeconds(repeat.rrule);
  if (ctx.reader === 'calendar' && seconds !== null && seconds < CALENDAR_INTERVAL_MIN_SECONDS) {
    // Too frequent to draw: none of it (history included), never expanded; the
    // view says so for a row with times in the window, upcoming or logged.
    const length = rowLength(ctx.binding, row, repeat);
    const logged = log.some((entry) =>
      overlaps(wallTime(entry.movedTo ?? entry.occurrence, repeat, length), window)
    );
    if (logged || intervalTouches(repeat, window))
      ctx.truncated?.push({
        tableId: ctx.binding.tableId,
        fieldId: ctx.binding.fieldId,
        entryId: row.entryId,
        title: row.title.trim() || 'Untitled',
        shown: 0,
        hidden: true,
      });
    return [];
  }
  const summary = tableRepeatSummary(repeat, { hasEnd: ctx.range });
  // Same test the shift action runs (a one-day shift fails exactly for fixed-day rules).
  const canShiftAll = shiftRuleByDays(repeat.rrule, 1).ok;
  const length = rowLength(ctx.binding, row, repeat);
  // An interval's current one is overdue once its time has passed, the same day.
  const now = new Date();
  // The latest log entry per planned occurrence wins (undo deletes entries).
  // Moves are kept apart: a done/skipped occurrence that was moved first is
  // shown where it was moved to, not at its planned time.
  const logged = new Map<string, OccurrenceLogRow>();
  const movedTo = new Map<string, string>();
  for (const entry of log) {
    if (entry.kind === 'moved') {
      if (entry.movedTo) movedTo.set(entry.occurrence, entry.movedTo);
      else movedTo.delete(entry.occurrence);
    }
    logged.set(entry.occurrence, entry);
  }
  const out: CalendarRowOccurrence[] = [];
  const seen = new Set<string>();
  const push = (occurrence: string, isCurrent: boolean) => {
    if (seen.has(occurrence)) return;
    seen.add(occurrence);
    const entry = logged.get(occurrence);
    let time = wallTime(occurrence, repeat, length);
    const repeatInfo: NonNullable<CalendarRowOccurrence['repeat']> = {
      occurrence,
      isCurrent,
      summary,
      canShiftAll,
    };
    let status: CalendarRowOccurrence['status'] = 'upcoming';
    if (entry?.kind === 'moved' && entry.movedTo) {
      status = 'moved';
      repeatInfo.originalStart = startOf(time);
      time = wallTime(entry.movedTo, repeat, length);
    } else if (entry) {
      status = entry.kind;
      const to = movedTo.get(occurrence);
      if (to) {
        repeatInfo.originalStart = startOf(time);
        time = wallTime(to, repeat, length);
      }
    } else if (isCurrent) {
      // The current occurrence shows where the row's value is (a hand edit or a move-one).
      time = plainRowTime(ctx.binding, row) ?? time;
    }
    if (!overlaps(time, window)) return;
    const occ = baseRow(
      ctx,
      row,
      time,
      `row:${ctx.binding.fieldId}:${row.entryId}:${occurrence}`,
      hasLength(length)
    );
    occ.status = status;
    // A repeating row is server-authoritative on overdue: the current upcoming
    // one is overdue once its date (or the END of its range) has passed — a
    // multi-day/timed range is not overdue while it is still running.
    if (isCurrent && status === 'upcoming')
      repeatInfo.overdue = isTableRepeatOverdue(repeat, now, {
        log,
        occurrenceEnd: occurrenceEndWall(repeat.current, length),
      });
    occ.repeat = repeatInfo;
    // Only the row's own value is writable by resize (its new length applies to
    // every later occurrence); history is fixed.
    occ.canResize = occ.canResize && isCurrent && status === 'upcoming';
    occ.canMove = occ.canMove && (status === 'upcoming' || status === 'moved');
    out.push(occ);
  };
  // An interval ("every 1 min") is bounded per window, its log included.
  const interval = seconds !== null;
  const stride = seconds !== null && ctx.reader === 'reminders' ? reminderStride(seconds) : 1;
  const expanded = interval
    ? expandInterval(repeat, window, length, stride)
    : { list: expandRepeat(repeat, window), truncated: false };
  for (const [index, occurrence] of expanded.list.entries())
    push(occurrence, stride > 1 ? occurrence === repeat.current : index === 0);
  for (const entry of log) push(entry.occurrence, entry.occurrence === repeat.current);
  if (stride > 1) {
    // Stride bounds expansion, not placement: moves (including off-stride log
    // entries) can land next to another reminder. Space the actual starts,
    // before the cap, without changing the calendar's occurrence/history view.
    out.sort((a, b) => startOf(a.time).localeCompare(startOf(b.time)));
    let lastStart = -Infinity;
    let kept = 0;
    for (const occurrence of out) {
      if (occurrence.status === 'done' || occurrence.status === 'skipped') continue;
      const start = Date.parse(startOf(occurrence.time));
      if (start - lastStart < REMINDER_MIN_SPACING_SECONDS * 1000) continue;
      out[kept++] = occurrence;
      lastStart = start;
    }
    out.length = kept;
  }
  if (!interval || (!expanded.truncated && out.length <= CALENDAR_ROW_OCCURRENCES_MAX)) return out;
  const shown = out.slice(0, CALENDAR_ROW_OCCURRENCES_MAX);
  ctx.truncated?.push({
    tableId: ctx.binding.tableId,
    fieldId: ctx.binding.fieldId,
    entryId: row.entryId,
    title: row.title.trim() || 'Untitled',
    shown: shown.length,
  });
  return shown;
}

async function bindingOccurrences(
  binding: BindingMeta,
  window: Window,
  reader: OccurrencesReader,
  onlyEntryIds?: readonly string[],
  truncated?: CalendarTruncatedRow[]
): Promise<CalendarRowOccurrence[]> {
  const repeats = binding.repeats
    ? ((await listRepeatsForFields(getDb(), [binding.fieldId])).get(binding.fieldId) ??
      new Map<string, TableRepeat>())
    : new Map<string, TableRepeat>();
  if (onlyEntryIds) {
    const only = new Set(onlyEntryIds);
    for (const entryId of [...repeats.keys()]) if (!only.has(entryId)) repeats.delete(entryId);
  }
  const { schemaVersion, range, rows } = await readBindingRows(binding, {
    fromDate: window.from,
    toDate: window.to,
    fromInstant: window.fromInstant,
    toInstant: window.toInstant,
    alsoEntryIds: [...repeats.keys()],
    ...(onlyEntryIds ? { onlyEntryIds } : {}),
    blockMinutes: CALENDAR_DEFAULT_BLOCK_MINUTES,
  });
  // Log wall times are in each row's zone: pad by a day, filter after placing.
  // A logged occurrence of a range starts up to its length before the window.
  // A period's log rows are on its first day, up to a period before the window.
  let spanDays = 0;
  for (const row of rows) {
    const repeat = repeats.get(row.entryId);
    if (!repeat) continue;
    const length = rowLength(binding, row, repeat);
    spanDays = Math.max(spanDays, length.days, Math.ceil(length.wallMs / DAY_MS));
  }
  const log = repeats.size
    ? await listOccurrenceLog(
        getDb(),
        [binding.fieldId],
        addDays(window.from, -1 - spanDays),
        addDays(window.to, 1)
      )
    : [];
  const logByEntry = new Map<string, OccurrenceLogRow[]>();
  for (const entry of log) {
    const list = logByEntry.get(entry.entryId) ?? [];
    list.push(entry);
    logByEntry.set(entry.entryId, list);
  }
  const ctx: RowContext = {
    binding,
    schemaVersion,
    range,
    reader,
    ...(truncated ? { truncated } : {}),
  };
  const out: CalendarRowOccurrence[] = [];
  for (const row of rows) {
    const repeat = repeats.get(row.entryId);
    if (repeat) {
      out.push(
        ...repeatingRowOccurrences(ctx, row, repeat, logByEntry.get(row.entryId) ?? [], window)
      );
      continue;
    }
    const time = plainRowTime(binding, row);
    if (time && overlaps(time, window))
      out.push(
        baseRow(ctx, row, time, `row:${binding.fieldId}:${row.entryId}:value`, row.end !== null)
      );
  }
  return out;
}

/**
 * Reminders: the occurrences of some rows of one binding that overlap
 * [fromInstant, toInstant), placed exactly as the calendar places them
 * (repeats expanded, done / skipped / moved from the log). Read in UTC; the
 * dates only matter for date fields, whose all-day rows reminders skip. A
 * row repeating more often than once a minute, which the calendar doesn't
 * draw, is read here spaced to a minute ({@link REMINDER_MIN_SPACING_SECONDS}).
 */
export async function entryOccurrences(
  binding: BindingMeta,
  entryIds: readonly string[],
  fromInstant: string,
  toInstant: string
): Promise<CalendarRowOccurrence[]> {
  if (!entryIds.length) return [];
  const from = iso(fromInstant);
  const to = iso(toInstant);
  return bindingOccurrences(
    binding,
    {
      from: addDays(from.slice(0, 10), -1),
      to: addDays(to.slice(0, 10), 2),
      tz: 'UTC',
      fromInstant: from,
      toInstant: to,
    },
    'reminders',
    entryIds
  );
}

function sortKey(occurrence: CalendarOccurrence, tz: string): number {
  return occurrence.time.kind === 'timed'
    ? Date.parse(occurrence.time.start)
    : Date.parse(wallInstant(`${occurrence.time.startDate}T00:00:00`, tz));
}

export async function listOccurrences(
  query: Record<string, unknown>
): Promise<CalendarOccurrencesResponse> {
  const parsed = parseOccurrencesQuery(query);
  const window: Window = {
    from: parsed.from,
    to: parsed.to,
    tz: parsed.tz,
    fromInstant: wallInstant(`${parsed.from}T00:00:00`, parsed.tz),
    toInstant: wallInstant(`${parsed.to}T00:00:00`, parsed.tz),
  };
  const active = await Calendars.list();
  const wanted = parsed.calendarIds ? new Set(parsed.calendarIds) : null;
  const calendarIds = active.filter((c) => !wanted || wanted.has(c.id)).map((c) => c.id);

  const events = await CalendarEvents.listInWindow({
    calendarIds,
    fromInstant: window.fromInstant,
    toInstant: window.toInstant,
    fromDate: window.from,
    toDate: window.to,
  });
  const occurrences: CalendarOccurrence[] = events.flatMap((event) =>
    event.repeat ? repeatingEventOccurrences(event, window) : [singleEventOccurrence(event)]
  );
  // 0046: once and repeat automation wakes (like events, on any project filter).
  occurrences.push(
    ...(await automationOccurrences({
      calendarIds,
      fromInstant: window.fromInstant,
      toInstant: window.toInstant,
    }))
  );
  // Every automations: a span per day each is active, kept apart from the items.
  const days: IntervalWindowDay[] = [];
  for (let day = parsed.from; day < parsed.to; day = addDays(day, 1)) {
    days.push({ day, end: wallInstant(`${addDays(day, 1)}T00:00:00`, parsed.tz) });
  }
  const intervals = await automationIntervals({ calendarIds, days });

  const unavailable: CalendarOccurrencesResponse['unavailable'] = [];
  const truncated: CalendarTruncatedRow[] = [];
  const bindings = (await listBindings(calendarIds)).filter(
    (binding) => !parsed.projectId || binding.projectId === parsed.projectId
  );
  for (const binding of bindings) {
    if (binding.tableState !== 'active') {
      unavailable.push({
        tableId: binding.tableId,
        fieldId: binding.fieldId,
        reason: 'table_archived',
      });
      continue;
    }
    if (binding.fieldState !== 'active') {
      unavailable.push({
        tableId: binding.tableId,
        fieldId: binding.fieldId,
        reason: 'field_archived',
      });
      continue;
    }
    try {
      occurrences.push(
        ...(await bindingOccurrences(binding, window, 'calendar', undefined, truncated))
      );
    } catch (error) {
      if (error instanceof CalendarReaderUnavailableError)
        throw new AppError(
          error.message,
          ErrorCode.SERVICE_UNAVAILABLE,
          HTTP_STATUS.SERVICE_UNAVAILABLE
        );
      // An archived table between the listing and the read reads as unavailable.
      if (error instanceof AppError && error.statusCode === HTTP_STATUS.CONFLICT) {
        unavailable.push({
          tableId: binding.tableId,
          fieldId: binding.fieldId,
          reason: 'table_archived',
        });
        continue;
      }
      throw error;
    }
  }
  occurrences.sort(
    (a, b) => sortKey(a, parsed.tz) - sortKey(b, parsed.tz) || (a.key < b.key ? -1 : 1)
  );
  return {
    from: parsed.from,
    to: parsed.to,
    tz: parsed.tz,
    occurrences,
    intervals,
    unavailable,
    ...(truncated.length ? { truncated } : {}),
  };
}
