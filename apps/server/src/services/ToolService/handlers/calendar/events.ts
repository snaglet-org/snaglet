/**
 * calendar event ops: thin wrappers over calendarService (the functions the
 * /api/calendar/events routes call), so realtime and undo behave as in the
 * UI. Reads return `rev` (the event revision); writes map it to
 * `expectedRevision`, and the service refuses a stale one. Times: a timed
 * event is two instants, written as ISO with an offset or as wall time in
 * `tz` (default: the calendar's zone) and shown in the event's own zone; an
 * all-day event is dates (its end given and shown as the last day), never
 * moved through UTC. Single events only: rows already repeat.
 */
import { userTimeZone } from '@snaglet/shared/utils';
import { Calendars } from '@snaglet/db/tables/calendars';
import type { CalendarEvent, CalendarEventTime } from '@snaglet/shared/types';
import {
  createEvent,
  deleteEvent,
  getEvent,
  restoreEvent,
  updateEvent,
} from '@server/domains/calendar/calendarService';
import { badInput } from '@server/services/ToolService/tools/database/_shared/input';
import { activeCalendars, resolveCalendar } from './calendars';
import { DATE_ONLY, addDays, dateInput, dayDiff, instantInput, isoInZone, zoneInput } from './time';

type Input = Record<string, unknown>;

/** A timed event given only a start lasts this long. */
const DEFAULT_EVENT_MS = 3_600_000;

function given(input: Input, key: string): boolean {
  return input[key] !== undefined && input[key] !== null;
}

function eventId(input: Input): string {
  if (typeof input.id !== 'string' || !input.id.trim())
    throw badInput('id (the event id) is required');
  return input.id.trim();
}

/** The event's `rev` as the service's expectedRevision. */
function eventRev(input: Input): number {
  const rev = input.rev;
  const value = typeof rev === 'string' && /^\d+$/.test(rev.trim()) ? Number(rev) : rev;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1)
    throw badInput('rev is required: the event’s rev from get_event or query');
  return value;
}

function text(input: Input, key: string): string | undefined {
  if (!given(input, key)) return undefined;
  if (typeof input[key] !== 'string') throw badInput(`${key} must be text`);
  return input[key] as string;
}

function allDayFlag(input: Input): boolean | undefined {
  if (!given(input, 'all_day')) return undefined;
  if (typeof input.all_day !== 'boolean') throw badInput('all_day must be true or false');
  return input.all_day;
}

/** A whole new time from `start` (and `end`): all-day for a date, timed for a date-time. */
function newTime(input: Input, allDay: boolean | undefined, tz: string): CalendarEventTime {
  const start = text(input, 'start');
  if (start === undefined) throw badInput('start is required');
  const end = text(input, 'end');
  if (allDay ?? DATE_ONLY.test(start)) {
    if (!DATE_ONLY.test(start))
      throw badInput('an all-day event starts on a date (YYYY-MM-DD), not a date and time');
    const last = dateInput(end ?? start, 'end');
    if (last < start) throw badInput('end (the last day) is before start');
    return {
      kind: 'all_day',
      startDate: dateInput(start, 'start'),
      endDate: addDays(last, 1),
      timeZone: tz,
    };
  }
  if (DATE_ONLY.test(start))
    throw badInput('a timed event starts at a date and time; a date alone is all-day');
  const startAt = instantInput(start, tz, 'start');
  const endAt =
    end === undefined
      ? new Date(Date.parse(startAt) + DEFAULT_EVENT_MS).toISOString()
      : instantInput(end, tz, 'end');
  return { kind: 'timed', startAt, endAt, timeZone: tz };
}

/**
 * The time an update asks for, from the current one: `start` alone moves
 * the event and keeps its length, `end` alone changes its end, `tz` alone
 * keeps the times and changes the saved zone. Switching between timed and
 * all-day needs a new `start`. Undefined when no time field is given.
 */
function patchedTime(input: Input, current: CalendarEventTime): CalendarEventTime | undefined {
  if (!['start', 'end', 'all_day', 'tz'].some((key) => given(input, key))) return undefined;
  const tz = zoneInput(input.tz) ?? current.timeZone;
  const start = text(input, 'start');
  const end = text(input, 'end');
  const allDay =
    allDayFlag(input) ?? (start !== undefined ? DATE_ONLY.test(start) : current.kind === 'all_day');
  if (allDay !== (current.kind === 'all_day')) {
    if (start === undefined)
      throw badInput(`making the event ${allDay ? 'all-day' : 'timed'} needs a new start`);
    return newTime(input, allDay, tz);
  }
  if (current.kind === 'timed') {
    const startAt = start === undefined ? current.startAt : instantInput(start, tz, 'start');
    const length = Date.parse(current.endAt) - Date.parse(current.startAt);
    const endAt =
      end !== undefined
        ? instantInput(end, tz, 'end')
        : start !== undefined
          ? new Date(Date.parse(startAt) + length).toISOString()
          : current.endAt;
    return { kind: 'timed', startAt, endAt, timeZone: tz };
  }
  const startDate = start === undefined ? current.startDate : dateInput(start, 'start');
  const endDate =
    end !== undefined
      ? addDays(dateInput(end, 'end'), 1)
      : start !== undefined
        ? addDays(startDate, dayDiff(current.startDate, current.endDate))
        : current.endDate;
  if (endDate <= startDate) throw badInput('end (the last day) is before start');
  return { kind: 'all_day', startDate, endDate, timeZone: tz };
}

async function eventView(event: CalendarEvent) {
  const calendar = await Calendars.findById(event.calendarId);
  const tz = event.time.timeZone;
  const time =
    event.time.kind === 'timed'
      ? {
          start: isoInZone(event.time.startAt, tz),
          end: isoInZone(event.time.endAt, tz),
          all_day: false,
        }
      : { start: event.time.startDate, end: addDays(event.time.endDate, -1), all_day: true };
  return {
    id: event.id,
    title: event.title,
    ...time,
    tz,
    calendar: calendar?.title ?? event.calendarId,
    calendar_id: event.calendarId,
    ...(event.description ? { description: event.description } : {}),
    ...(event.location ? { location: event.location } : {}),
    rev: String(event.revision),
  };
}

export async function getEventOp(input: Input): Promise<unknown> {
  return { event: await eventView(await getEvent(eventId(input))) };
}

export async function createEventOp(input: Input): Promise<unknown> {
  const title = text(input, 'title');
  if (title === undefined || !title.trim()) throw badInput('title is required');
  const calendar = given(input, 'calendar')
    ? resolveCalendar(await activeCalendars(), input.calendar, 'calendar')
    : (await activeCalendars()).find((calendar) => calendar.isDefault);
  const tz = zoneInput(input.tz) ?? calendar?.timeZone ?? userTimeZone();
  const { event, created } = await createEvent({
    ...(given(input, 'id') ? { id: input.id } : {}),
    ...(calendar ? { calendarId: calendar.id } : {}),
    title,
    ...(given(input, 'description') ? { description: text(input, 'description') } : {}),
    ...(given(input, 'location') ? { location: text(input, 'location') } : {}),
    time: newTime(input, allDayFlag(input), tz),
  });
  return { event: await eventView(event), created };
}

export async function updateEventOp(input: Input): Promise<unknown> {
  const id = eventId(input);
  const expectedRevision = eventRev(input);
  const current = await getEvent(id);
  const time = patchedTime(input, current.time);
  const calendarId = given(input, 'calendar')
    ? resolveCalendar(await activeCalendars(), input.calendar, 'calendar').id
    : undefined;
  const event = await updateEvent(id, {
    expectedRevision,
    ...(calendarId !== undefined ? { calendarId } : {}),
    ...(given(input, 'title') ? { title: text(input, 'title') } : {}),
    ...(given(input, 'description') ? { description: text(input, 'description') } : {}),
    ...(given(input, 'location') ? { location: text(input, 'location') } : {}),
    ...(time ? { time } : {}),
  });
  return { event: await eventView(event), changed: event.revision !== current.revision };
}

/** Archives the event; restore_event brings it back. Confirm-gated (destructiveOps). */
export async function deleteEventOp(input: Input): Promise<unknown> {
  const id = eventId(input);
  await deleteEvent(id, eventRev(input));
  return { deleted: id, undo: `calendar {op: "restore_event", id: "${id}"}` };
}

export async function restoreEventOp(input: Input): Promise<unknown> {
  return { event: await eventView(await restoreEvent(eventId(input))), restored: true };
}
