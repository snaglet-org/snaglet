/**
 * Event writes with undo. Each write records one step on the
 * calendar undo stack (`calendarUndo.ts`), whose Cmd+Z and toast Undo both
 * revert it: a reverse PATCH for edits and moves, archive restore for a
 * delete, a delete for a create. Redo re-applies the write.
 *
 * Writes mark their own echo (`markOwnWrite`) so realtime doesn't refetch a
 * second time after the optimistic update.
 */
import type {
  CalendarEvent,
  CalendarEventTime,
  CalendarOccurrenceTime,
  CreateCalendarEventRequest,
  UpdateCalendarEventRequest,
} from '@snaglet/shared/types';
import { generateId, getErrorMessage } from '@snaglet/shared/utils';
import { FetchError } from '@desktop/utils/api/core';
import { showToast } from '@desktop/utils/toast';
import { archiveApi } from '@desktop/utils/api';
import { calendarApi } from './calendarApi';
import { addDays, instantToZoned, zonedToInstant } from './calendarDates';
import { markOwnWrite } from './calendarRealtime';
import { offerUndo, recordStep } from './calendarUndo';

type EventPatch = Omit<UpdateCalendarEventRequest, 'expectedRevision'>;

/** PATCH at the event's current revision (undo / redo run later than the write). */
async function patchCurrent(id: string, patch: EventPatch): Promise<void> {
  markOwnWrite(`event:${id}`);
  const current = await calendarApi.getEvent(id);
  markOwnWrite(`event:${id}`);
  await calendarApi.updateEvent(id, { ...patch, expectedRevision: current.event.revision });
}

export function isConflict(err: unknown): boolean {
  return err instanceof FetchError && err.status === 409;
}

/** Toast for a failed write: conflicts say "refreshed" (caller refetches). */
export function reportWriteError(err: unknown, fallback: string): void {
  showToast(isConflict(err) ? 'Changed elsewhere — refreshed' : getErrorMessage(err, fallback));
}

export async function createEvent(
  input: Omit<CreateCalendarEventRequest, 'id'>
): Promise<CalendarEvent> {
  const id = generateId('calendar-event');
  markOwnWrite(`event:${id}`);
  const { event } = await calendarApi.createEvent({ ...input, id });
  offerUndo(`Added ${event.title || 'event'}`, {
    label: 'Add event',
    undo: async () => {
      markOwnWrite(`event:${event.id}`);
      const current = await calendarApi.getEvent(event.id);
      markOwnWrite(`event:${event.id}`);
      await calendarApi.deleteEvent(event.id, current.event.revision);
    },
    redo: async () => {
      markOwnWrite(`event:${event.id}`);
      await archiveApi.restore(event.id);
    },
  });
  return event;
}

/** Fields an edit can change, and their inverse from the event before. */
function inverseOf(
  before: CalendarEvent,
  patch: Omit<UpdateCalendarEventRequest, 'expectedRevision'>
): Omit<UpdateCalendarEventRequest, 'expectedRevision'> {
  const inverse: Omit<UpdateCalendarEventRequest, 'expectedRevision'> = {};
  if (patch.title !== undefined) inverse.title = before.title;
  if (patch.description !== undefined) inverse.description = before.description;
  if (patch.location !== undefined) inverse.location = before.location;
  if (patch.calendarId !== undefined) inverse.calendarId = before.calendarId;
  if (patch.time !== undefined) inverse.time = before.time;
  if (patch.repeat !== undefined) inverse.repeat = before.repeat;
  return inverse;
}

/**
 * One field edit = one undo step. `before` is the event as it was
 * before the edit (for a debounced text burst: before the burst).
 */
export async function updateEvent(
  before: CalendarEvent,
  patch: Omit<UpdateCalendarEventRequest, 'expectedRevision'>,
  expectedRevision: number,
  label: string
): Promise<CalendarEvent> {
  markOwnWrite(`event:${before.id}`);
  const { event } = await calendarApi.updateEvent(before.id, { ...patch, expectedRevision });
  const inverse = inverseOf(before, patch);
  recordStep({
    label,
    undo: () => patchCurrent(before.id, inverse),
    redo: () => patchCurrent(before.id, patch),
  });
  return event;
}

export async function deleteEvent(
  event: CalendarEvent | { id: string; title: string; revision: number }
) {
  markOwnWrite(`event:${event.id}`);
  await calendarApi.deleteEvent(event.id, event.revision);
  offerUndo(`Deleted ${event.title || 'event'}`, {
    label: 'Delete event',
    undo: async () => {
      // DELETE archives the event node; restoring the node brings it back.
      markOwnWrite(`event:${event.id}`);
      await archiveApi.restore(event.id);
    },
    redo: async () => {
      markOwnWrite(`event:${event.id}`);
      const current = await calendarApi.getEvent(event.id);
      markOwnWrite(`event:${event.id}`);
      await calendarApi.deleteEvent(event.id, current.event.revision);
    },
  });
}

/**
 * Move or resize (drag, Alt+arrows, Move to…): one PATCH of `time` at the
 * occurrence's revision, then the "Moved … · Undo" toast.
 */
export async function moveEvent(
  eventId: string,
  expectedRevision: number,
  before: CalendarEventTime,
  after: CalendarEventTime,
  message: string,
  label = 'Move event'
): Promise<CalendarEvent> {
  markOwnWrite(`event:${eventId}`);
  const { event } = await calendarApi.updateEvent(eventId, { time: after, expectedRevision });
  offerUndo(message, {
    label,
    undo: () => patchCurrent(eventId, { time: before }),
    redo: () => patchCurrent(eventId, { time: after }),
  });
  return event;
}

/** An occurrence's time as an event's, saved in `timeZone`. */
export function toEventTime(time: CalendarOccurrenceTime, timeZone: string): CalendarEventTime {
  return time.kind === 'timed'
    ? { kind: 'timed', startAt: time.start, endAt: time.end, timeZone }
    : { kind: 'all_day', startDate: time.startDate, endDate: time.endDate, timeZone };
}

/** An event's time as an occurrence time (the same span). */
export function eventSpan(time: CalendarEventTime): CalendarOccurrenceTime {
  return time.kind === 'timed'
    ? { kind: 'timed', start: time.startAt, end: time.endAt }
    : { kind: 'all_day', startDate: time.startDate, endDate: time.endDate };
}

type TimedEventTime = Extract<CalendarEventTime, { kind: 'timed' }>;

/**
 * A timed event with its end set to `minutes` on the end's own day in
 * `zone`, so a multi-day event keeps its last day. The end's day is the one
 * the time line names (`describeSpan`): an end at the midnight right after
 * the start's day is that day's 24:00. An end that would not come after the
 * start moves on a day (an overnight block).
 */
export function withEndTime(time: TimedEventTime, minutes: number, zone: string): TimedEventTime {
  const s = instantToZoned(time.startAt, zone);
  const e = instantToZoned(time.endAt, zone);
  const endDay = e.minutes === 0 && e.date === addDays(s.date, 1) ? s.date : e.date;
  let endAt = zonedToInstant(endDay, minutes, zone);
  if (Date.parse(endAt) <= Date.parse(time.startAt))
    endAt = zonedToInstant(addDays(endDay, 1), minutes, zone);
  return { ...time, endAt };
}
