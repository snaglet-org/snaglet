/**
 * Calendar service: calendars CRUD, single events CRUD, and the window
 * read (see occurrences.ts). Wire contract: packages/shared/types/calendar.ts.
 *
 * Every calendar and event write emits `calendar:changed` (surface
 * realtime/surfaces/calendar.ts) once its transaction commits; a write made
 * inside a caller's transaction goes through {@link PendingCalendarChanges}.
 * Binding writes go through the table field routes, which emit
 * `kind: 'binding'`.
 */
import { getDb, transaction, type DbQueryable } from '@snaglet/db/db';
import {
  assertTimeZone,
  calendarBadRequest,
  mapCalendarForeignKeyError,
  calendarConflict,
  calendarNotFound,
  Calendars,
  lockCalendarCatalog,
  validCalendarColor,
  validCalendarTitle,
  validRevision,
  type CalendarRow,
} from '@snaglet/db/tables/calendars';
import {
  CalendarEvents,
  countUnscheduled,
  listBindings,
  publicEvent,
  type CalendarEventRow,
} from '@snaglet/db/tables/calendar_events';
import {
  CALENDAR_EVENT_DESCRIPTION_MAX_LENGTH,
  CALENDAR_EVENT_TITLE_MAX_LENGTH,
  type Calendar,
  type CalendarBoundField,
  type CalendarChangedEvent,
  type CalendarEvent,
  type CalendarEventTime,
  type CreateCalendarRequest,
} from '@snaglet/shared/types';
import { validEventRepeat } from './eventRepeat';
import { generateId, parseTableDateTime, userTimeZone } from '@snaglet/shared/utils';
import { emitCalendarChanged } from '@server/realtime/surfaces/calendar';
import { resolveCurrentActorMemberId } from '@server/realtime/actorMember';

const DESCRIPTION_MAX = CALENDAR_EVENT_DESCRIPTION_MAX_LENGTH;
const LOCATION_MAX = 1_000;
const EVENT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

function record(input: unknown, what: string): Record<string, unknown> {
  if (typeof input !== 'object' || input === null || Array.isArray(input))
    throw calendarBadRequest(`Request body must be ${what}.`);
  return input as Record<string, unknown>;
}

function optionalText(value: unknown, name: string, max: number): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') throw calendarBadRequest(`${name} must be text.`);
  if (value.length > max) throw calendarBadRequest(`${name} is at most ${max} characters.`);
  if (value.includes('\0')) throw calendarBadRequest(`${name} cannot contain null characters.`);
  return value;
}

// --- calendars -------------------------------------------------------------

/** The bound fields of each calendar (active tables and fields only). */
async function boundFieldsByCalendar(
  calendarIds: string[],
  runner: DbQueryable = getDb()
): Promise<Map<string, CalendarBoundField[]>> {
  const result = new Map<string, CalendarBoundField[]>(calendarIds.map((id) => [id, []]));
  const bindings = await listBindings(calendarIds, runner);
  for (const binding of bindings) {
    if (binding.tableState !== 'active' || binding.fieldState !== 'active') continue;
    result.get(binding.calendarId)?.push({
      tableId: binding.tableId,
      tableName: binding.tableName,
      projectId: binding.projectId,
      fieldId: binding.fieldId,
      fieldName: binding.fieldName,
      fieldType: binding.fieldType,
      repeats: binding.repeats,
      unscheduledCount: await countUnscheduled(binding, runner),
    });
  }
  return result;
}

async function withBound(rows: CalendarRow[], runner?: DbQueryable): Promise<Calendar[]> {
  const bound = await boundFieldsByCalendar(
    rows.map((row) => row.id),
    runner
  );
  return rows.map((row) => ({ ...row, boundFields: bound.get(row.id) ?? [] }));
}

async function oneCalendar(row: CalendarRow): Promise<Calendar> {
  return (await withBound([row]))[0]!;
}

/**
 * `calendar:changed` events a transaction owes, sent once it commits: writes
 * inside the transaction `add` them, and the caller calls `emit()` after the
 * transaction resolves. A transaction that throws rolls back and never gets
 * there, so listeners never hear of a calendar that does not exist.
 */
export class PendingCalendarChanges {
  private readonly changes: CalendarChangedEvent[] = [];

  add(change: CalendarChangedEvent): void {
    this.changes.push(change);
  }

  emit(): void {
    for (const change of this.changes.splice(0)) emitCalendarChanged(change);
  }
}

/**
 * The Default calendar, creating it when no calendar exists. A new one
 * is added to `changes`, for the caller to emit after its transaction commits.
 */
export async function ensureDefaultCalendar(
  tx: DbQueryable,
  changes: PendingCalendarChanges
): Promise<CalendarRow> {
  const { calendar, created } = await Calendars.ensureDefault(tx, userTimeZone());
  if (created) changes.add({ kind: 'calendar', calendarId: calendar.id });
  return calendar;
}

/** Reading an empty workspace never creates a calendar. */
export async function listCalendars(): Promise<Calendar[]> {
  return withBound(await Calendars.list());
}

export async function createCalendar(input: unknown): Promise<Calendar> {
  const body = record(input, 'a calendar') as Partial<CreateCalendarRequest> &
    Record<string, unknown>;
  const title = validCalendarTitle(body.title);
  const description = optionalText(body.description, 'description', DESCRIPTION_MAX) ?? '';
  const color = body.color === undefined ? null : validCalendarColor(body.color);
  if (
    body.sortOrder !== undefined &&
    (typeof body.sortOrder !== 'number' ||
      !Number.isSafeInteger(body.sortOrder) ||
      body.sortOrder < 0)
  )
    throw calendarBadRequest('sortOrder must be a whole number of 0 or more.');
  const createdBy = await resolveCurrentActorMemberId();
  const row = await transaction(async (tx) => {
    const timeZone =
      body.timeZone === undefined ? userTimeZone() : await assertTimeZone(body.timeZone, tx);
    await lockCalendarCatalog(tx);
    return Calendars.insert(
      {
        title,
        description,
        timeZone,
        color,
        createdBy,
        isDefault: (await Calendars.list(tx)).length === 0,
        ...(body.sortOrder !== undefined ? { sortOrder: body.sortOrder } : {}),
      },
      tx
    );
  });
  emitCalendarChanged({ kind: 'calendar', calendarId: row.id });
  return oneCalendar(row);
}

export async function updateCalendar(id: string, input: unknown): Promise<Calendar> {
  const body = record(input, 'a calendar update');
  const expectedRevision = validRevision(body.expectedRevision);
  const title = body.title === undefined ? undefined : validCalendarTitle(body.title);
  const description = optionalText(body.description, 'description', DESCRIPTION_MAX);
  const color = body.color === undefined ? undefined : validCalendarColor(body.color);
  const { calendar, changed } = await transaction(async (tx) => {
    const timeZone =
      body.timeZone === undefined ? undefined : await assertTimeZone(body.timeZone, tx);
    return Calendars.update(
      id,
      {
        expectedRevision,
        ...(title !== undefined ? { title } : {}),
        ...(description !== undefined ? { description } : {}),
        ...(timeZone !== undefined ? { timeZone } : {}),
        ...(color !== undefined ? { color } : {}),
      },
      tx
    );
  });
  if (changed) emitCalendarChanged({ kind: 'calendar', calendarId: id });
  return oneCalendar(calendar);
}

export async function reorderCalendars(input: unknown): Promise<Calendar[]> {
  const body = record(input, '{ calendarIds }');
  const rows = await transaction((tx) => Calendars.reorder(body.calendarIds, tx));
  emitCalendarChanged({ kind: 'calendar' });
  return withBound(rows);
}

// --- events ------------------------------------------------------------------

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

function validDate(value: unknown, name: string): string {
  if (typeof value !== 'string' || !DATE_ONLY.test(value) || !parseTableDateTime(value))
    throw calendarBadRequest(`${name} must be a date (YYYY-MM-DD).`);
  return value;
}

/** An ISO instant with an explicit offset (or Z). */
function validInstant(value: unknown, name: string): string {
  const parsed = typeof value === 'string' ? parseTableDateTime(value) : null;
  if (!parsed || parsed.offsetMinutes === null || DATE_ONLY.test(value as string))
    throw calendarBadRequest(
      `${name} must be an ISO date and time with an offset, e.g. 2026-03-09T09:00:00Z.`
    );
  return new Date(value as string).toISOString();
}

async function validEventTime(value: unknown, tx: DbQueryable): Promise<CalendarEventTime> {
  const time = record(value, 'an event time');
  const timeZone = await assertTimeZone(time.timeZone, tx);
  if (time.kind === 'timed') {
    const startAt = validInstant(time.startAt, 'time.startAt');
    const endAt = validInstant(time.endAt, 'time.endAt');
    if (Date.parse(endAt) <= Date.parse(startAt))
      throw calendarBadRequest('An event must end after it starts.');
    return { kind: 'timed', startAt, endAt, timeZone };
  }
  if (time.kind === 'all_day') {
    const startDate = validDate(time.startDate, 'time.startDate');
    const endDate = validDate(time.endDate, 'time.endDate');
    if (endDate <= startDate)
      throw calendarBadRequest(
        'An all-day event ends on a later date than it starts (the end is exclusive).'
      );
    return { kind: 'all_day', startDate, endDate, timeZone };
  }
  throw calendarBadRequest("time.kind must be 'timed' or 'all_day'.");
}

function rejectRecurrence(body: Record<string, unknown>): void {
  for (const key of ['recurrence', 'rrule', 'recurringEventId'])
    if (body[key] !== undefined)
      throw calendarBadRequest('Send a repeat as repeat: { rrule }, not as raw recurrence lines.');
}

function eventTitle(value: unknown): string {
  if (typeof value !== 'string') throw calendarBadRequest('title must be text.');
  const title = value.trim();
  if (title.length > CALENDAR_EVENT_TITLE_MAX_LENGTH)
    throw calendarBadRequest(
      `Event titles are at most ${CALENDAR_EVENT_TITLE_MAX_LENGTH} characters.`
    );
  return title;
}

async function writableCalendar(
  id: unknown,
  tx: DbQueryable,
  changes: PendingCalendarChanges
): Promise<CalendarRow> {
  if (id === undefined || id === null) return ensureDefaultCalendar(tx, changes);
  if (typeof id !== 'string') throw calendarBadRequest('calendarId must be a calendar id.');
  const calendar = await Calendars.findById(id, tx);
  if (!calendar)
    throw calendarBadRequest('That calendar no longer exists. Choose another calendar.');
  return calendar;
}

function staleEvent(current: CalendarEventRow) {
  return calendarConflict('This event changed since you loaded it. Reload and try again.', {
    event: publicEvent(current),
  });
}

export async function getEvent(id: string): Promise<CalendarEvent> {
  const event = await CalendarEvents.findById(id);
  if (!event || event.archived) throw calendarNotFound('Event');
  return publicEvent(event);
}

export async function createEvent(
  input: unknown
): Promise<{ event: CalendarEvent; created: boolean }> {
  const body = record(input, 'an event');
  rejectRecurrence(body);
  const id = body.id === undefined ? generateId('event') : body.id;
  if (typeof id !== 'string' || !EVENT_ID_PATTERN.test(id))
    throw calendarBadRequest('id must be letters, digits, - or _ (at most 128).');
  const title = eventTitle(body.title);
  const description = optionalText(body.description, 'description', DESCRIPTION_MAX) ?? '';
  const location = optionalText(body.location, 'location', LOCATION_MAX) ?? '';
  const memberId = await resolveCurrentActorMemberId();
  const changes = new PendingCalendarChanges();
  const result = await transaction(async (tx) => {
    const time = await validEventTime(body.time, tx);
    const existing = await CalendarEvents.findById(id, tx);
    if (existing) {
      // An idempotent retry of the same create returns the event; anything else is a clash.
      if (!existing.archived && existing.title === title)
        return { event: existing, created: false };
      throw calendarConflict('An event with this id already exists.');
    }
    const { rows } = await tx.query<{ type: string }>(
      'SELECT type FROM public.nodes WHERE id = $1',
      [id]
    );
    if (rows[0]) throw calendarConflict('This id belongs to another workspace item.');
    const calendar = await writableCalendar(body.calendarId, tx, changes);
    const repeat = validEventRepeat(body.repeat, time);
    const event = await CalendarEvents.insert(
      { id, calendarId: calendar.id, title, description, location, time, repeat, memberId },
      tx
    );
    return { event, created: true };
  }).catch(mapCalendarForeignKeyError);
  changes.emit();
  if (result.created)
    emitCalendarChanged({ kind: 'event', calendarId: result.event.calendarId, eventId: id });
  return { event: publicEvent(result.event), created: result.created };
}

export async function updateEvent(id: string, input: unknown): Promise<CalendarEvent> {
  const body = record(input, 'an event update');
  rejectRecurrence(body);
  const expectedRevision = validRevision(body.expectedRevision);
  const title = body.title === undefined ? undefined : eventTitle(body.title);
  const description = optionalText(body.description, 'description', DESCRIPTION_MAX);
  const location = optionalText(body.location, 'location', LOCATION_MAX);
  const memberId = await resolveCurrentActorMemberId();
  const changes = new PendingCalendarChanges();
  const outcome = await transaction(async (tx) => {
    const current = await CalendarEvents.findById(id, tx, true);
    if (!current || current.archived) throw calendarNotFound('Event');
    if (current.revision !== expectedRevision) throw staleEvent(current);
    const time = body.time === undefined ? current.time : await validEventTime(body.time, tx);
    // The rule is re-checked against the (possibly moved) start: a weekly rule follows its anchor.
    const repeat =
      body.repeat === undefined
        ? validEventRepeat(current.repeat, time)
        : validEventRepeat(body.repeat, time);
    const calendarId =
      body.calendarId === undefined || body.calendarId === current.calendarId
        ? current.calendarId
        : (await writableCalendar(body.calendarId, tx, changes)).id;
    const next = {
      calendarId,
      title: title ?? current.title,
      description: description ?? current.description,
      location: location ?? current.location,
      time,
      repeat,
      memberId,
    };
    if (
      next.calendarId === current.calendarId &&
      next.title === current.title &&
      next.description === current.description &&
      next.location === current.location &&
      JSON.stringify(next.time) === JSON.stringify(current.time) &&
      JSON.stringify(next.repeat) === JSON.stringify(current.repeat)
    )
      return { before: current, after: current, changed: false };
    return { before: current, after: await CalendarEvents.update(id, next, tx), changed: true };
  }).catch(mapCalendarForeignKeyError);
  changes.emit();
  if (outcome.changed) {
    emitCalendarChanged({ kind: 'event', calendarId: outcome.after.calendarId, eventId: id });
    if (outcome.before.calendarId !== outcome.after.calendarId)
      emitCalendarChanged({ kind: 'event', calendarId: outcome.before.calendarId, eventId: id });
  }
  return publicEvent(outcome.after);
}

/** Delete = archive the event node (restorable with {@link restoreEvent}). */
export async function deleteEvent(id: string, expectedRevision: unknown): Promise<{ id: string }> {
  const revision = validRevision(
    typeof expectedRevision === 'string' && /^\d+$/.test(expectedRevision)
      ? Number(expectedRevision)
      : expectedRevision
  );
  const event = await transaction(async (tx) => {
    const current = await CalendarEvents.findById(id, tx, true);
    if (!current) throw calendarNotFound('Event');
    if (current.archived) return null;
    if (current.revision !== revision) throw staleEvent(current);
    await CalendarEvents.archive(id, tx);
    return current;
  });
  if (event) emitCalendarChanged({ kind: 'event', calendarId: event.calendarId, eventId: id });
  return { id };
}

/** Undo a delete: unarchive the event node. */
export async function restoreEvent(id: string): Promise<CalendarEvent> {
  const outcome = await transaction(async (tx) => {
    const current = await CalendarEvents.findById(id, tx, true);
    if (!current) throw calendarNotFound('Event');
    if (!current.archived) return { event: current, changed: false };
    await CalendarEvents.restore(id, tx);
    return { event: (await CalendarEvents.findById(id, tx))!, changed: true };
  });
  if (outcome.changed)
    emitCalendarChanged({ kind: 'event', calendarId: outcome.event.calendarId, eventId: id });
  return publicEvent(outcome.event);
}
