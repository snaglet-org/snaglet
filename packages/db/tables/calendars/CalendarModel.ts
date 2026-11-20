/**
 * Calendars: the local calendars the Calendar pane shows. Rows only;
 * bound fields are read by the calendar service. Every write bumps
 * `revision` and checks the caller's `expectedRevision`.
 */
import { getDb, type DbQueryable } from '@snaglet/db/db';
import {
  CALENDAR_TITLE_MAX_LENGTH,
  DEFAULT_CALENDAR_TITLE,
  ErrorCode,
  type CalendarColor,
} from '@snaglet/shared/types';
import { AppError, CALENDAR_COLOR_FORMATS, normalizeCalendarColor } from '@snaglet/shared/utils';

export interface CalendarRow {
  id: string;
  title: string;
  description: string;
  timeZone: string;
  color: CalendarColor | null;
  isDefault: boolean;
  sortOrder: number;
  revision: number;
  createdAt: string;
  updatedAt: string;
}

interface RawCalendar {
  id: string;
  title: string;
  description: string;
  time_zone: string;
  color: string | null;
  is_default: boolean;
  sort_order: number;
  revision: number;
  created_at: string;
  updated_at: string;
}

const COLUMNS = `id, title, description, time_zone, color, is_default, sort_order, revision,
  to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS created_at,
  to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS updated_at`;

/** Advisory key serializing Default-calendar creation and calendar ordering. */
export const CALENDAR_CATALOG_LOCK = 'snaglet.calendars';

function toCalendar(raw: RawCalendar): CalendarRow {
  return {
    id: raw.id,
    title: raw.title,
    description: raw.description,
    timeZone: raw.time_zone,
    // A stored color that does not parse (e.g. an unknown theme token) reads as automatic.
    color: normalizeCalendarColor(raw.color),
    isDefault: raw.is_default,
    sortOrder: raw.sort_order,
    revision: raw.revision,
    createdAt: raw.created_at,
    updatedAt: raw.updated_at,
  };
}

export function calendarBadRequest(message: string): AppError {
  return new AppError(message, ErrorCode.VALIDATION_ERROR, 400);
}

/** Translate only a calendar FK race; unrelated FK failures retain their meaning. */
export function mapCalendarForeignKeyError(error: unknown): never {
  const pg = error as { code?: string; constraint?: string };
  if (
    pg.code === '23503' &&
    [
      'calendar_events_calendar_id_fkey',
      'automations_calendar_id_fkey',
      'table_fields_calendar_id_fkey',
    ].includes(pg.constraint ?? '')
  )
    throw calendarBadRequest('That calendar no longer exists');
  throw error;
}

export function calendarNotFound(what = 'Calendar'): AppError {
  return new AppError(`${what} not found`, ErrorCode.NOT_FOUND, 404);
}

export function calendarConflict(message: string, details?: Record<string, unknown>): AppError {
  return new AppError(message, ErrorCode.CONFLICT, 409, true, details);
}

/** Take the calendar catalog lock for the rest of `tx`. */
export async function lockCalendarCatalog(tx: DbQueryable): Promise<void> {
  await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [CALENDAR_CATALOG_LOCK]);
}

export function validCalendarTitle(value: unknown): string {
  if (typeof value !== 'string') throw calendarBadRequest('title must be text.');
  const title = value.trim();
  if (!title) throw calendarBadRequest('Give the calendar a name.');
  if (title.length > CALENDAR_TITLE_MAX_LENGTH)
    throw calendarBadRequest(`Calendar names are at most ${CALENDAR_TITLE_MAX_LENGTH} characters.`);
  return title;
}

/** A request's color, normalized (`#ABC` → `#aabbcc`), or a 400 naming the accepted forms. */
export function validCalendarColor(value: unknown): CalendarColor | null {
  if (value === null) return null;
  const color = normalizeCalendarColor(value);
  if (!color) throw calendarBadRequest(`color must be ${CALENDAR_COLOR_FORMATS}.`);
  return color;
}

export function validRevision(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1)
    throw calendarBadRequest('expectedRevision must be a positive integer.');
  return value;
}

/** An IANA zone PostgreSQL knows (the table's CHECK), or a 400. */
export async function assertTimeZone(value: unknown, tx: DbQueryable): Promise<string> {
  if (typeof value !== 'string' || !value.trim())
    throw calendarBadRequest('timeZone must be an IANA zone name.');
  const { rows } = await tx.query<{ ok: boolean }>(
    'SELECT public.calendar_valid_timezone($1) AS ok',
    [value]
  );
  if (!rows[0]?.ok) throw calendarBadRequest(`${value} is not a known time zone.`);
  return value;
}

export interface CreateCalendarInput {
  title: string;
  description: string;
  timeZone: string;
  color: CalendarColor | null;
  sortOrder?: number;
  isDefault?: boolean;
  createdBy?: string | null;
}

export interface UpdateCalendarInput {
  title?: string;
  description?: string;
  timeZone?: string;
  color?: CalendarColor | null;
  expectedRevision: number;
}

async function nextSortOrder(tx: DbQueryable): Promise<number> {
  const { rows } = await tx.query<{ next: number }>(
    'SELECT COALESCE(max(sort_order) + 1, 0)::int AS next FROM public.calendars'
  );
  return rows[0]?.next ?? 0;
}

function staleCalendar(current: CalendarRow): AppError {
  return calendarConflict('This calendar changed since you loaded it. Reload and try again.', {
    calendar: current,
  });
}

class CalendarModelClass {
  /** Calendars in sidebar order. Reading never creates one. */
  async list(runner: DbQueryable = getDb()): Promise<CalendarRow[]> {
    const { rows } = await runner.query<RawCalendar>(
      `SELECT ${COLUMNS} FROM public.calendars
        ORDER BY sort_order, created_at, id`
    );
    return rows.map(toCalendar);
  }

  async findById(id: string, runner: DbQueryable = getDb()): Promise<CalendarRow | null> {
    const { rows } = await runner.query<RawCalendar>(
      `SELECT ${COLUMNS} FROM public.calendars WHERE id = $1`,
      [id]
    );
    return rows[0] ? toCalendar(rows[0]) : null;
  }

  async lockById(id: string, tx: DbQueryable): Promise<CalendarRow> {
    const { rows } = await tx.query<RawCalendar>(
      `SELECT ${COLUMNS} FROM public.calendars WHERE id = $1 FOR UPDATE`,
      [id]
    );
    if (!rows[0]) throw calendarNotFound();
    return toCalendar(rows[0]);
  }

  /** Explicit writes may choose a default, creating one only in an empty catalog. */
  async ensureDefault(
    tx: DbQueryable,
    timeZone = 'UTC'
  ): Promise<{ calendar: CalendarRow; created: boolean }> {
    await lockCalendarCatalog(tx);
    const { rows: active } = await tx.query<RawCalendar>(
      `SELECT ${COLUMNS} FROM public.calendars
        ORDER BY is_default DESC, sort_order, created_at, id LIMIT 1`
    );
    if (active[0]) return { calendar: toCalendar(active[0]), created: false };
    const calendar = await this.insert(
      { title: DEFAULT_CALENDAR_TITLE, description: '', timeZone, color: null, isDefault: true },
      tx
    );
    return { calendar, created: true };
  }

  /** Insert; the caller holds the catalog lock. Appends when sortOrder is left out. */
  async insert(input: CreateCalendarInput, tx: DbQueryable): Promise<CalendarRow> {
    const append = await nextSortOrder(tx);
    const slot =
      input.sortOrder === undefined ? append : Math.max(0, Math.min(input.sortOrder, append));
    if (slot < append)
      await tx.query(
        'UPDATE public.calendars SET sort_order = sort_order + 1 WHERE sort_order >= $1',
        [slot]
      );
    const { rows } = await tx.query<RawCalendar>(
      `INSERT INTO public.calendars (title, description, time_zone, color, is_default, sort_order, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING ${COLUMNS}`,
      [
        input.title,
        input.description,
        input.timeZone,
        input.color,
        input.isDefault === true,
        slot,
        input.createdBy ?? null,
      ]
    );
    return toCalendar(rows[0]!);
  }

  async update(
    id: string,
    input: UpdateCalendarInput,
    tx: DbQueryable
  ): Promise<{ calendar: CalendarRow; changed: boolean }> {
    const current = await this.lockById(id, tx);
    if (current.revision !== input.expectedRevision) throw staleCalendar(current);
    const next = {
      title: input.title ?? current.title,
      description: input.description ?? current.description,
      timeZone: input.timeZone ?? current.timeZone,
      color: input.color === undefined ? current.color : input.color,
    };
    if (
      next.title === current.title &&
      next.description === current.description &&
      next.timeZone === current.timeZone &&
      next.color === current.color
    )
      return { calendar: current, changed: false };
    const { rows } = await tx.query<RawCalendar>(
      `UPDATE public.calendars SET title = $2, description = $3, time_zone = $4, color = $5,
              revision = revision + 1, updated_at = now()
        WHERE id = $1 RETURNING ${COLUMNS}`,
      [id, next.title, next.description, next.timeZone, next.color]
    );
    return { calendar: toCalendar(rows[0]!), changed: true };
  }

  /** Reorder from the full list of calendar ids; anything else is a 400. */
  async reorder(calendarIds: unknown, tx: DbQueryable): Promise<CalendarRow[]> {
    if (!Array.isArray(calendarIds) || !calendarIds.every((id) => typeof id === 'string'))
      throw calendarBadRequest('calendarIds must be a list of calendar ids.');
    await lockCalendarCatalog(tx);
    const active = await this.list(tx);
    const ids = new Set(active.map((row) => row.id));
    if (
      new Set(calendarIds).size !== calendarIds.length ||
      calendarIds.length !== active.length ||
      calendarIds.some((id) => !ids.has(id))
    )
      throw calendarBadRequest(
        'calendarIds must list every calendar exactly once. Reload the calendars and try again.'
      );
    await tx.query(
      `UPDATE public.calendars AS c SET sort_order = (o.n - 1)::int, updated_at = now()
         FROM unnest($1::text[]) WITH ORDINALITY AS o(id, n)
        WHERE c.id = o.id AND c.sort_order <> o.n - 1`,
      [calendarIds]
    );
    return this.list(tx);
  }
}

export const Calendars = new CalendarModelClass();
