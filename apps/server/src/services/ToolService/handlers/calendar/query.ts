/**
 * calendar {op: "query"}: what is on the calendar in a span, as the pane
 * draws it (listOccurrences: events, bound table rows with their repeats
 * expanded, automation wakes), filtered, paged and shown compactly. Table
 * rows come back only when the caller may read tables, automation wakes and
 * Every lines only when it may read automations (access.ts). Rows that
 * repeat more often than one read holds are listed in `truncated`, and so
 * are rows repeating more often than once a minute, which the calendar
 * doesn't draw (`hidden`).
 */
import { Automations } from '@snaglet/db/tables/automations';
import {
  CALENDAR_OCCURRENCES_MAX_DAYS,
  CALENDAR_ROW_OCCURRENCES_MAX,
  type Calendar,
  type CalendarIntervalSpan,
  type CalendarOccurrence,
  type CalendarOccurrenceTime,
  type CalendarRowOccurrence,
  type TableEntryValue,
  type TableField,
} from '@snaglet/shared/types';
import { formatAutomationDuration, userTimeZone } from '@snaglet/shared/utils';
import { listOccurrences } from '@server/domains/calendar/occurrences';
import { getTableEntry } from '@server/domains/tables/tableEntries';
import { listTableFields } from '@server/domains/tables/tableFields';
import { badInput } from '@server/services/ToolService/tools/database/_shared/input';
import type { CalendarCaller } from './access';
import {
  AUTOMATIONS_HIDDEN,
  activeCalendars,
  resolveCalendar,
  TABLE_ROWS_HIDDEN,
  tooFrequentNote,
} from './calendars';
import {
  CALENDAR_DEFAULT_DAYS,
  CALENDAR_QUERY_KINDS,
  CALENDAR_QUERY_LIMIT,
  CALENDAR_QUERY_RANGES,
  CALENDAR_QUERY_STATUSES,
  CALENDAR_REPEAT_FILTERS,
  type CalendarQueryKind,
  type CalendarQueryRange,
  type CalendarRepeatFilter,
} from './constants';
import { ROW_REV_LENGTH } from './errors';
import {
  DATE_ONLY,
  addDays,
  dateInput,
  dayDiff,
  instantInput,
  isoInZone,
  mondayOf,
  todayIn,
  zoneInput,
} from './time';

type Input = Record<string, unknown>;

/** Select fields a row shows when the query names no `fields`. */
const DEFAULT_ROW_FIELDS = 3;
/** Longest text value a row shows; longer ones end in `…`. */
const VALUE_MAX = 200;
/** Most items a list value shows. */
const VALUE_ITEMS_MAX = 20;

// --- input -------------------------------------------------------------------

/** A list of non-empty strings; one string counts as a list of one. */
function stringList(value: unknown, name: string): string[] | undefined {
  if (value === undefined || value === null) return undefined;
  const list = typeof value === 'string' ? [value] : value;
  if (!Array.isArray(list) || !list.length)
    throw badInput(`${name} must be a non-empty list of strings`);
  return list.map((item, index) => {
    if (typeof item !== 'string' || !item.trim())
      throw badInput(`${name}[${index}] must be a non-empty string`);
    return item.trim();
  });
}

function oneOf<T extends string>(value: string, allowed: readonly T[], name: string): T {
  if (!(allowed as readonly string[]).includes(value))
    throw badInput(`${name} must be one of ${allowed.join(', ')}`);
  return value as T;
}

function enumList<T extends string>(
  value: unknown,
  allowed: readonly T[],
  name: string
): T[] | undefined {
  return stringList(value, name)?.map((item, index) => oneOf(item, allowed, `${name}[${index}]`));
}

function optionalText(value: unknown, name: string): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string') throw badInput(`${name} must be text`);
  return value.trim() || undefined;
}

function limitOf(value: unknown): number {
  if (value === undefined || value === null) return CALENDAR_QUERY_LIMIT.default;
  const { min, max } = CALENDAR_QUERY_LIMIT;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max)
    throw badInput(`limit must be an integer ${min}-${max}`);
  return value;
}

function offsetOf(value: unknown): number {
  if (value === undefined || value === null || value === '') return 0;
  const text = typeof value === 'number' ? String(value) : value;
  if (typeof text !== 'string' || !/^\d{1,6}$/.test(text))
    throw badInput('cursor must be the `next` value of the previous page');
  return Number(text);
}

// --- span ----------------------------------------------------------------------

interface Span {
  /** Window dates in `tz`: `from` inclusive, `to` exclusive. */
  from: string;
  to: string;
  tz: string;
  /** Present when from / to carried a time: occurrences must overlap these instants. */
  fromInstant?: string;
  toInstant?: string;
}

interface Point {
  date: string;
  instant?: string;
}

/** A query bound: a date, or a date-time (with an offset, or wall time in tz). */
function point(value: unknown, tz: string, name: string): Point {
  if (typeof value === 'string' && DATE_ONLY.test(value)) return { date: dateInput(value, name) };
  const instant = instantInput(value, tz, name);
  return { date: isoInZone(instant, tz).slice(0, 10), instant };
}

function rangeSpan(range: CalendarQueryRange, today: string): { from: string; to: string } {
  switch (range) {
    case 'today':
      return { from: today, to: addDays(today, 1) };
    case 'tomorrow':
      return { from: addDays(today, 1), to: addDays(today, 2) };
    case 'this_week': {
      const monday = mondayOf(today);
      return { from: monday, to: addDays(monday, 7) };
    }
    case 'next_week': {
      const monday = addDays(mondayOf(today), 7);
      return { from: monday, to: addDays(monday, 7) };
    }
    case 'this_month': {
      const first = `${today.slice(0, 7)}-01`;
      const next = addDays(first, 32);
      return { from: first, to: `${next.slice(0, 7)}-01` };
    }
  }
}

function parseSpan(input: Input, tz: string, now: Date): Span {
  const today = todayIn(tz, now);
  const days =
    input.days === undefined || input.days === null
      ? undefined
      : (() => {
          const value = input.days;
          if (
            typeof value !== 'number' ||
            !Number.isInteger(value) ||
            value < 1 ||
            value > CALENDAR_OCCURRENCES_MAX_DAYS
          )
            throw badInput(`days must be an integer 1-${CALENDAR_OCCURRENCES_MAX_DAYS}`);
          return value;
        })();
  const given = (key: string) => input[key] !== undefined && input[key] !== null;
  let span: Span;
  if (given('range')) {
    if (given('from') || given('to') || days !== undefined)
      throw badInput('pass range, or days / from / to, not both');
    const range = oneOf(String(input.range), CALENDAR_QUERY_RANGES, 'range');
    span = { ...rangeSpan(range, today), tz };
  } else if (days !== undefined) {
    if (given('to')) throw badInput('pass days or to, not both');
    const start = given('from') ? point(input.from, tz, 'from') : { date: today };
    span = {
      from: start.date,
      to: addDays(start.date, days),
      tz,
      ...(start.instant ? { fromInstant: start.instant } : {}),
    };
  } else if (given('from')) {
    const start = point(input.from, tz, 'from');
    const end = given('to') ? point(input.to, tz, 'to') : { date: addDays(start.date, 1) };
    // A to with a time past midnight still needs its own day in the window.
    const endDate =
      end.instant && isoInZone(end.instant, tz).slice(11, 19) !== '00:00:00'
        ? addDays(end.date, 1)
        : end.date;
    span = {
      from: start.date,
      to: endDate,
      tz,
      ...(start.instant ? { fromInstant: start.instant } : {}),
      ...(end.instant ? { toInstant: end.instant } : {}),
    };
  } else if (given('to')) {
    throw badInput('to needs from (or use days)');
  } else {
    span = { from: today, to: addDays(today, CALENDAR_DEFAULT_DAYS), tz };
  }
  const length = dayDiff(span.from, span.to);
  if (length < 1 || (span.fromInstant && span.toInstant && span.toInstant <= span.fromInstant))
    throw badInput('to must be after from (to is exclusive)');
  if (length > CALENDAR_OCCURRENCES_MAX_DAYS)
    throw badInput(
      `a query covers at most ${CALENDAR_OCCURRENCES_MAX_DAYS} days; this one is ${length}. Page through shorter spans.`
    );
  return span;
}

// --- filters -------------------------------------------------------------------

function kindOf(occurrence: CalendarOccurrence): CalendarQueryKind {
  return occurrence.source === 'event'
    ? 'events'
    : occurrence.source === 'row'
      ? 'table_rows'
      : 'automations';
}

/** Midnight of `date` in `tz` as an instant. */
function midnight(date: string, tz: string): number {
  return Date.parse(instantInput(`${date}T00:00:00`, tz, 'date'));
}

function overlapsInstants(time: CalendarOccurrenceTime, span: Span): boolean {
  const from = span.fromInstant ? Date.parse(span.fromInstant) : -Infinity;
  const to = span.toInstant ? Date.parse(span.toInstant) : Infinity;
  const [start, end] =
    time.kind === 'timed'
      ? [Date.parse(time.start), Date.parse(time.end)]
      : [midnight(time.startDate, span.tz), midnight(time.endDate, span.tz)];
  return start < to && end > from;
}

function tableMatches(occurrence: CalendarRowOccurrence, tables: readonly string[]): boolean {
  return tables.some(
    (table) =>
      table === occurrence.tableId || table.toLowerCase() === occurrence.tableName.toLowerCase()
  );
}

// --- views ---------------------------------------------------------------------

function timeView(time: CalendarOccurrenceTime, tz: string) {
  return time.kind === 'timed'
    ? { start: isoInZone(time.start, tz), end: isoInZone(time.end, tz), all_day: false }
    : // All-day ends are shown as the last day, as table date ranges are.
      { start: time.startDate, end: addDays(time.endDate, -1), all_day: true };
}

function shownStart(value: string, tz: string): string {
  return DATE_ONLY.test(value) ? value : isoInZone(value, tz);
}

function repeatView(repeat: NonNullable<CalendarRowOccurrence['repeat']>, tz: string) {
  return {
    occurrence: repeat.occurrence,
    current: repeat.isCurrent,
    summary: repeat.summary,
    ...(repeat.overdue ? { overdue: true } : {}),
    ...(repeat.originalStart ? { moved_from: shownStart(repeat.originalStart, tz) } : {}),
  };
}

function shortValue(value: TableEntryValue): TableEntryValue {
  if (typeof value === 'string')
    return value.length > VALUE_MAX ? `${value.slice(0, VALUE_MAX - 1)}…` : value;
  if (Array.isArray(value)) return value.slice(0, VALUE_ITEMS_MAX);
  return value;
}

/** Which fields each table's rows show: the asked-for ones, else its first select fields. */
function shownFields(
  fields: readonly TableField[],
  wanted: readonly string[] | undefined,
  boundFieldIds: ReadonlySet<string>
): TableField[] {
  if (wanted) {
    return wanted
      .map((name) =>
        fields.find((field) => field.id === name || field.name.toLowerCase() === name.toLowerCase())
      )
      .filter((field): field is TableField => field !== undefined);
  }
  return fields
    .filter((field) => field.type === 'select' && !boundFieldIds.has(field.id))
    .slice(0, DEFAULT_ROW_FIELDS);
}

type RowValues = Map<string, Record<string, TableEntryValue>>;

/** The shown values of each row on the page, keyed `tableId:entryId`. */
async function rowValues(
  rows: readonly CalendarRowOccurrence[],
  wanted: readonly string[] | undefined,
  notes: string[]
): Promise<RowValues> {
  const out: RowValues = new Map();
  const byTable = new Map<string, { entries: Set<string>; bound: Set<string> }>();
  for (const row of rows) {
    const group = byTable.get(row.tableId) ?? { entries: new Set(), bound: new Set() };
    group.entries.add(row.entryId);
    group.bound.add(row.fieldId);
    byTable.set(row.tableId, group);
  }
  const found = new Set<string>();
  for (const [tableId, group] of byTable) {
    const fields = shownFields(await listTableFields(tableId), wanted, group.bound);
    for (const field of fields) found.add(field.name.toLowerCase()).add(field.id);
    if (!fields.length) continue;
    for (const entryId of group.entries) {
      const { entry } = await getTableEntry(tableId, entryId);
      const values: Record<string, TableEntryValue> = {};
      for (const field of fields) values[field.name] = shortValue(entry.values[field.id] ?? null);
      out.set(`${tableId}:${entryId}`, values);
    }
  }
  const missing = (wanted ?? []).filter(
    (name) => !found.has(name) && !found.has(name.toLowerCase())
  );
  if (rows.length && missing.length)
    notes.push(`fields not in these rows' tables: ${missing.join(', ')}`);
  return out;
}

interface ViewContext {
  tz: string;
  calendarTitle: (id: string) => string;
  fieldName: (id: string) => string;
  values: RowValues;
  repeatingAutomations: ReadonlySet<string>;
}

function occurrenceView(occurrence: CalendarOccurrence, ctx: ViewContext) {
  const base = {
    title: occurrence.title,
    ...timeView(occurrence.time, ctx.tz),
    calendar: ctx.calendarTitle(occurrence.calendarId),
    status: occurrence.status,
  };
  if (occurrence.source === 'event')
    return {
      kind: 'event',
      ...base,
      event_id: occurrence.eventId,
      rev: String(occurrence.revision),
    };
  if (occurrence.source === 'automation')
    return {
      kind: 'automation',
      ...base,
      ...(occurrence.note ? { note: occurrence.note } : {}),
      automation_id: occurrence.automationId,
      agent: occurrence.agentName,
      repeats: ctx.repeatingAutomations.has(occurrence.automationId),
    };
  const shown = ctx.values.get(`${occurrence.tableId}:${occurrence.entryId}`);
  return {
    kind: 'table_row',
    ...base,
    table: occurrence.tableName,
    table_id: occurrence.tableId,
    entry_id: occurrence.entryId,
    field: ctx.fieldName(occurrence.fieldId),
    field_id: occurrence.fieldId,
    rev: occurrence.entryRevision.slice(0, ROW_REV_LENGTH),
    ...(occurrence.repeat ? { repeat: repeatView(occurrence.repeat, ctx.tz) } : {}),
    ...(shown ? { values: shown } : {}),
  };
}

function intervalView(span: CalendarIntervalSpan, calendarTitle: (id: string) => string) {
  return {
    automation_id: span.automationId,
    title: span.name,
    every: formatAutomationDuration(span.everyMs),
    // Runs only inside it, wall clock in the automation's zone.
    ...(span.window ? { window: span.window } : {}),
    calendar: calendarTitle(span.calendarId),
    agent: span.agentName,
    next_run: span.nextRunAt,
  };
}

// --- op ------------------------------------------------------------------------

export async function queryOp(
  input: Input,
  caller: CalendarCaller,
  now: Date = new Date()
): Promise<unknown> {
  const calendars = await activeCalendars();
  const calendarKeys = stringList(input.calendars, 'calendars');
  const chosen: Calendar[] | undefined = calendarKeys?.map((key, index) =>
    resolveCalendar(calendars, key, `calendars[${index}]`)
  );
  const only = chosen?.length === 1 ? chosen[0] : undefined;
  const tz = zoneInput(input.tz) ?? only?.timeZone ?? userTimeZone();
  const span = parseSpan(input, tz, now);

  const tables = stringList(input.tables, 'tables');
  const wantedFields = stringList(input.fields, 'fields');
  const kinds = new Set<CalendarQueryKind>(
    enumList(input.kinds, CALENDAR_QUERY_KINDS, 'kinds') ??
      (tables ? ['table_rows'] : CALENDAR_QUERY_KINDS)
  );
  const repeats: CalendarRepeatFilter =
    input.repeats === undefined || input.repeats === null
      ? 'include'
      : oneOf(String(input.repeats), CALENDAR_REPEAT_FILTERS, 'repeats');
  const statuses = enumList(input.status, CALENDAR_QUERY_STATUSES, 'status');
  const text = optionalText(input.text, 'text')?.toLowerCase();
  const projectId = optionalText(input.project_id, 'project_id');
  const limit = limitOf(input.limit);
  const offset = offsetOf(input.cursor);

  const notes: string[] = [];
  const hidden: string[] = [];
  if (kinds.has('table_rows')) {
    const rows = await caller.tableAccess('read');
    if (!rows.allowed) {
      kinds.delete('table_rows');
      hidden.push(`${TABLE_ROWS_HIDDEN}: ${rows.reason}`);
    }
  }
  if (kinds.has('automations')) {
    const wakes = await caller.automationAccess();
    if (!wakes.allowed) {
      kinds.delete('automations');
      hidden.push(`${AUTOMATIONS_HIDDEN}: ${wakes.reason}`);
    }
  }
  const queried = chosen ?? calendars;
  if (tables && kinds.has('table_rows')) {
    const bound = queried.flatMap((calendar) => calendar.boundFields);
    const unmatched = tables.filter(
      (table) =>
        !bound.some(
          (field) =>
            field.tableId === table || field.tableName.toLowerCase() === table.toLowerCase()
        )
    );
    if (unmatched.length)
      notes.push(
        `no date field of these tables is on the queried calendars: ${unmatched.join(', ')}`
      );
  }

  const result = await listOccurrences({
    from: span.from,
    to: span.to,
    tz,
    ...(chosen ? { calendarIds: chosen.map((calendar) => calendar.id) } : {}),
    ...(projectId ? { projectId } : {}),
  });

  const automationIds = new Set(
    kinds.has('automations')
      ? result.occurrences.flatMap((o) => (o.source === 'automation' ? [o.automationId] : []))
      : []
  );
  const repeatingAutomations = new Set(
    automationIds.size
      ? (
          await Automations.list({ ids: [...automationIds], whenKinds: ['repeat', 'first_open'] })
        ).map((row) => row.id)
      : []
  );
  const repeating = (occurrence: CalendarOccurrence): boolean =>
    occurrence.source === 'row'
      ? occurrence.repeat !== undefined
      : occurrence.source === 'automation' && repeatingAutomations.has(occurrence.automationId);

  const matched = result.occurrences.filter((occurrence) => {
    if (!kinds.has(kindOf(occurrence))) return false;
    if (tables && occurrence.source === 'row' && !tableMatches(occurrence, tables)) return false;
    if (repeats === 'exclude' && repeating(occurrence)) return false;
    if (repeats === 'only' && !repeating(occurrence)) return false;
    if (statuses && !statuses.includes(occurrence.status)) return false;
    if (text && !occurrence.title.toLowerCase().includes(text)) return false;
    return !(span.fromInstant || span.toInstant) || overlapsInstants(occurrence.time, span);
  });
  const page = matched.slice(offset, offset + limit);

  const titles = new Map(calendars.map((calendar) => [calendar.id, calendar.title]));
  const calendarTitle = (id: string) => titles.get(id) ?? id;
  const boundFields = calendars.flatMap((calendar) => calendar.boundFields);
  const fieldNames = new Map(boundFields.map((field) => [field.fieldId, field.fieldName] as const));
  const tableNames = new Map(boundFields.map((field) => [field.tableId, field.tableName] as const));
  const pageRows = page.filter((o): o is CalendarRowOccurrence => o.source === 'row');
  const ctx: ViewContext = {
    tz,
    calendarTitle,
    fieldName: (id) => fieldNames.get(id) ?? id,
    values: await rowValues(pageRows, wantedFields, notes),
    repeatingAutomations,
  };
  const occurrences = page.map((occurrence) => occurrenceView(occurrence, ctx));

  const intervals =
    kinds.has('automations') && repeats !== 'exclude' && !statuses
      ? [
          ...new Map(
            result.intervals
              .filter((interval) => !text || interval.name.toLowerCase().includes(text))
              .map((interval) => [interval.automationId, intervalView(interval, calendarTitle)])
          ).values(),
        ]
      : [];
  const truncated = kinds.has('table_rows')
    ? (result.truncated ?? [])
        .filter(
          (row) =>
            !tables ||
            tables.some(
              (table) =>
                table === row.tableId ||
                table.toLowerCase() === (tableNames.get(row.tableId) ?? '').toLowerCase()
            )
        )
        .map((row) => ({
          table: tableNames.get(row.tableId) ?? row.tableId,
          table_id: row.tableId,
          entry_id: row.entryId,
          field: ctx.fieldName(row.fieldId),
          title: row.title,
          shown: row.shown,
          ...(row.hidden ? { hidden: true } : {}),
        }))
    : [];
  const cut = truncated.filter((row) => !row.hidden).length;
  if (cut)
    notes.push(
      `${cut === 1 ? 'a row repeats' : `${cut} rows repeat`} more often than one read shows ` +
        `(at most ${CALENDAR_ROW_OCCURRENCES_MAX} times per row): only the first \`shown\` are listed; query a shorter span for the rest`
    );
  const tooFrequent = tooFrequentNote(truncated);
  if (tooFrequent) notes.push(tooFrequent);
  const next = offset + limit < matched.length ? String(offset + limit) : undefined;
  return {
    from: span.fromInstant ? isoInZone(span.fromInstant, tz) : span.from,
    to: span.toInstant ? isoInZone(span.toInstant, tz) : span.to,
    tz,
    calendars: queried.map((calendar) => ({ id: calendar.id, title: calendar.title })),
    total: matched.length,
    occurrences,
    has_more: next !== undefined,
    ...(next ? { next } : {}),
    ...(intervals.length ? { intervals } : {}),
    ...(kinds.has('table_rows') && result.unavailable.length
      ? {
          unavailable: result.unavailable.map((item) => ({
            table_id: item.tableId,
            field_id: item.fieldId,
            reason: item.reason,
          })),
        }
      : {}),
    ...(truncated.length ? { truncated } : {}),
    ...(hidden.length ? { hidden: hidden.join('; ') } : {}),
    ...(notes.length ? { notes } : {}),
  };
}
