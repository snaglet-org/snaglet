/**
 * Single calendar events (public.calendar_events). Each event is a workspace node
 * (`nodes.type = 'calendar_event'`): create ensures the node in the same
 * transaction; delete archives the node (undoable through the archive
 * routes); purge is the node FK cascade. A repeating event is one row whose
 * `recurrence` holds a single `RRULE:` line (the table date-field rule body);
 * no exception rows are written, so every edit changes the whole series.
 */
import { getDb, type DbQueryable } from '@snaglet/db/db';
import { Nodes } from '@snaglet/db/tables/nodes';
import type { CalendarEvent, CalendarEventRepeat, CalendarEventTime } from '@snaglet/shared/types';

interface RawEvent {
  id: string;
  calendar_id: string;
  title: string;
  description: string;
  location: string;
  time_kind: 'timed' | 'all_day';
  time_zone: string;
  start_at: string | null;
  end_at: string | null;
  start_date: string | null;
  end_date: string | null;
  recurrence: string[];
  revision: number;
  created_at: string;
  updated_at: string;
  archived: boolean;
}

export interface CalendarEventRow extends CalendarEvent {
  /** The event node is archived (deleted in the UI, restorable). */
  archived: boolean;
}

const ISO = `'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'`;
const COLUMNS = `e.id, e.calendar_id, e.title, e.description, e.location, e.time_kind, e.time_zone,
  to_char(e.start_at AT TIME ZONE 'UTC', ${ISO}) AS start_at,
  to_char(e.end_at AT TIME ZONE 'UTC', ${ISO}) AS end_at,
  to_char(e.start_date, 'YYYY-MM-DD') AS start_date,
  to_char(e.end_date, 'YYYY-MM-DD') AS end_date,
  e.recurrence,
  e.revision,
  to_char(n.created_at AT TIME ZONE 'UTC', ${ISO}) AS created_at,
  to_char(n.updated_at AT TIME ZONE 'UTC', ${ISO}) AS updated_at,
  n.archived`;
const FROM = 'public.calendar_events e JOIN public.nodes n ON n.id = e.id';

const RRULE_PREFIX = 'RRULE:';

function repeatOf(lines: string[]): CalendarEventRepeat | null {
  const line = lines.find((l) => l.startsWith(RRULE_PREFIX));
  return line ? { rrule: line.slice(RRULE_PREFIX.length) } : null;
}

function recurrenceOf(repeat: CalendarEventRepeat | null): string[] {
  return repeat ? [`${RRULE_PREFIX}${repeat.rrule}`] : [];
}

function toEvent(raw: RawEvent): CalendarEventRow {
  const time: CalendarEventTime =
    raw.time_kind === 'timed'
      ? { kind: 'timed', startAt: raw.start_at!, endAt: raw.end_at!, timeZone: raw.time_zone }
      : {
          kind: 'all_day',
          startDate: raw.start_date!,
          endDate: raw.end_date!,
          timeZone: raw.time_zone,
        };
  return {
    id: raw.id,
    calendarId: raw.calendar_id,
    title: raw.title,
    description: raw.description,
    location: raw.location,
    time,
    repeat: repeatOf(raw.recurrence ?? []),
    revision: raw.revision,
    createdAt: raw.created_at,
    updatedAt: raw.updated_at,
    archived: raw.archived,
  };
}

/** Public shape (drops the archived flag). */
export function publicEvent(row: CalendarEventRow): CalendarEvent {
  const { archived: _archived, ...event } = row;
  return event;
}

function timeParams(time: CalendarEventTime): unknown[] {
  return time.kind === 'timed'
    ? ['timed', time.timeZone, time.startAt, time.endAt, null, null]
    : ['all_day', time.timeZone, null, null, time.startDate, time.endDate];
}

export interface InsertEventInput {
  id: string;
  calendarId: string;
  title: string;
  description: string;
  location: string;
  time: CalendarEventTime;
  repeat: CalendarEventRepeat | null;
  memberId: string | null;
}

export interface UpdateEventInput {
  calendarId: string;
  title: string;
  description: string;
  location: string;
  time: CalendarEventTime;
  repeat: CalendarEventRepeat | null;
  memberId: string | null;
}

/** Window rows: [fromIso, toIso) instants for timed, [fromDate, toDate) for all-day. */
export interface EventWindow {
  calendarIds: string[];
  fromInstant: string;
  toInstant: string;
  fromDate: string;
  toDate: string;
}

class CalendarEventModelClass {
  async findById(
    id: string,
    runner: DbQueryable = getDb(),
    lock = false
  ): Promise<CalendarEventRow | null> {
    const { rows } = await runner.query<RawEvent>(
      `SELECT ${COLUMNS} FROM ${FROM} WHERE e.id = $1${lock ? ' FOR UPDATE OF e' : ''}`,
      [id]
    );
    return rows[0] ? toEvent(rows[0]) : null;
  }

  /** Insert the node and the event in the caller's transaction. */
  async insert(input: InsertEventInput, tx: DbQueryable): Promise<CalendarEventRow> {
    await Nodes.ensure(input.id, 'calendar_event', { runner: tx });
    const [kind, zone, startAt, endAt, startDate, endDate] = timeParams(input.time);
    await tx.query(
      `INSERT INTO public.calendar_events
         (id, calendar_id, title, description, location, time_kind, time_zone,
          start_at, end_at, start_date, end_date, recurrence, created_by, last_edited_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8::timestamptz,$9::timestamptz,$10::date,$11::date,$12::text[],$13,$13)`,
      [
        input.id,
        input.calendarId,
        input.title,
        input.description,
        input.location,
        kind,
        zone,
        startAt,
        endAt,
        startDate,
        endDate,
        recurrenceOf(input.repeat),
        input.memberId,
      ]
    );
    return (await this.findById(input.id, tx))!;
  }

  async update(id: string, input: UpdateEventInput, tx: DbQueryable): Promise<CalendarEventRow> {
    const [kind, zone, startAt, endAt, startDate, endDate] = timeParams(input.time);
    await tx.query(
      `UPDATE public.calendar_events SET calendar_id=$2, title=$3, description=$4, location=$5,
              time_kind=$6, time_zone=$7, start_at=$8::timestamptz, end_at=$9::timestamptz,
              start_date=$10::date, end_date=$11::date, recurrence=$12::text[],
              last_edited_by=$13, revision = revision + 1
        WHERE id = $1`,
      [
        id,
        input.calendarId,
        input.title,
        input.description,
        input.location,
        kind,
        zone,
        startAt,
        endAt,
        startDate,
        endDate,
        recurrenceOf(input.repeat),
        input.memberId,
      ]
    );
    await Nodes.touch(id, tx);
    return (await this.findById(id, tx))!;
  }

  /** Archive the event's node (the UI's delete). */
  async archive(id: string, tx: DbQueryable): Promise<void> {
    await tx.query(
      'UPDATE public.nodes SET archived = true, archived_at = now() WHERE id = $1 AND NOT archived',
      [id]
    );
  }

  /** Unarchive the event's node (undo of a delete). */
  async restore(id: string, tx: DbQueryable): Promise<void> {
    await tx.query(
      'UPDATE public.nodes SET archived = false, archived_at = NULL WHERE id = $1 AND archived',
      [id]
    );
  }

  /**
   * Active events on these calendars that overlap the window, plus every
   * repeating event that starts before it ends (its later occurrences may land
   * inside; the caller expands them).
   */
  async listInWindow(
    window: EventWindow,
    runner: DbQueryable = getDb()
  ): Promise<CalendarEventRow[]> {
    if (!window.calendarIds.length) return [];
    const { rows } = await runner.query<RawEvent>(
      `SELECT ${COLUMNS} FROM ${FROM}
        WHERE NOT n.archived AND e.calendar_id = ANY($1::text[])
          AND e.recurring_event_id IS NULL AND e.status <> 'cancelled'
          AND ((e.time_kind = 'timed' AND e.start_at < $3::timestamptz
                AND (e.end_at > $2::timestamptz OR cardinality(e.recurrence) > 0))
            OR (e.time_kind = 'all_day' AND e.start_date < $5::date
                AND (e.end_date > $4::date OR cardinality(e.recurrence) > 0)))
        ORDER BY COALESCE(e.start_at, e.start_date::timestamp AT TIME ZONE 'UTC'), e.id`,
      [window.calendarIds, window.fromInstant, window.toInstant, window.fromDate, window.toDate]
    );
    return rows.map(toEvent);
  }
}

export const CalendarEvents = new CalendarEventModelClass();
