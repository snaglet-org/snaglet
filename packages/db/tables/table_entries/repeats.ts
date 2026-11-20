/**
 * Per-row repeats on repeating date / datetime fields (completion
 * model A). Rows of
 * `table_entry_repeats` hold each row's {@link TableRepeat}; rows of
 * `table_entry_occurrences` log every done / skipped / moved occurrence.
 *
 * This module is the SQL layer for both tables: the calendar's read API
 * ({@link listRepeatsForFields}, {@link listOccurrenceLog}) and the small
 * writes the entry model and undo history compose. Callers run in their own
 * transaction and, for writes, hold the table's schema lock.
 */
import type { DbQueryable } from '@snaglet/db/db';
import { CUSTOM_TABLES_SCHEMA } from '@snaglet/db/runtime/postgres/readerRole';
import { tableRepeatProblem, tableRepeatWallTime, type TableRepeat } from '@snaglet/shared/utils';
import type { RepeatOp } from '../table_history/types';

export type OccurrenceKind = 'done' | 'skipped' | 'moved';

/** One logged occurrence, as stored. Wall times are in the repeat's `tz`. */
export interface OccurrenceLogRow {
  id: string;
  tableId: string;
  fieldId: string;
  entryId: string;
  /** The planned occurrence (wall time), as the engine expands it. */
  occurrence: string;
  kind: OccurrenceKind;
  /** Where a moved occurrence went (wall time); null for done / skipped. */
  movedTo: string | null;
  actorKind: string | null;
  actorId: string | null;
  /** ISO instant. */
  createdAt: string;
}

/** fieldId → entryId → repeat. */
export type RepeatsByField = Map<string, Map<string, TableRepeat>>;

interface RawOccurrence {
  id: string;
  table_id: string;
  field_id: string;
  entry_id: string;
  occurrence: string;
  kind: OccurrenceKind;
  moved_to: string | null;
  actor_kind: string | null;
  actor_id: string | null;
  created_at: string;
}

const OCCURRENCE_COLUMNS = `id, table_id, field_id, entry_id::text AS entry_id, occurrence, kind, moved_to,
  actor_kind, actor_id, to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at`;

function toOccurrence(raw: RawOccurrence): OccurrenceLogRow {
  return {
    id: raw.id,
    tableId: raw.table_id,
    fieldId: raw.field_id,
    entryId: raw.entry_id,
    occurrence: raw.occurrence,
    kind: raw.kind,
    movedTo: raw.moved_to,
    actorKind: raw.actor_kind,
    actorId: raw.actor_id,
    createdAt: raw.created_at,
  };
}

/**
 * A stored repeat value in canonical key order (so equal values compare
 * equal).
 */
function storedRepeat(value: TableRepeat): TableRepeat {
  return {
    rrule: value.rrule,
    dtstart: value.dtstart,
    current: value.current,
    tz: value.tz,
  };
}

/** Whether two repeat values (or null = none) are the same. */
export function sameRepeat(a: TableRepeat | null, b: TableRepeat | null): boolean {
  if (!a || !b) return !a && !b;
  return JSON.stringify(storedRepeat(a)) === JSON.stringify(storedRepeat(b));
}

// calendar read API

/**
 * Every row's repeat on `fieldIds`, by field then entry (entry ids lowercase).
 * Stored values that no longer validate are left out rather than thrown, so
 * one bad row never blanks a calendar. Rows are not checked against their
 * table (entry deletes clear repeats in the same transaction).
 */
export async function listRepeatsForFields(
  tx: DbQueryable,
  fieldIds: readonly string[]
): Promise<RepeatsByField> {
  const result: RepeatsByField = new Map();
  if (!fieldIds.length) return result;
  const { rows } = await tx.query<{ field_id: string; entry_id: string; value: unknown }>(
    `SELECT field_id, entry_id::text AS entry_id, value FROM public.table_entry_repeats
      WHERE field_id = ANY($1::text[]) ORDER BY field_id, entry_id`,
    [[...new Set(fieldIds)]]
  );
  for (const row of rows) {
    if (tableRepeatProblem(row.value)) continue;
    const byEntry = result.get(row.field_id) ?? new Map<string, TableRepeat>();
    byEntry.set(row.entry_id, storedRepeat(row.value as TableRepeat));
    result.set(row.field_id, byEntry);
  }
  return result;
}

/**
 * Logged done / skipped / moved occurrences on `fieldIds` whose planned
 * occurrence or (for moved) new time falls in [`fromIso`, `toIso`). The
 * bounds are wall times or dates compared as text against the stored wall
 * times (`YYYY-MM-DD` sorts before `YYYY-MM-DDT…`), so a date bound means
 * the start of that day. Wall times are in each row's repeat `tz`: a caller
 * showing another zone should pad the window by a day and place each item
 * itself. Ordered by field, entry, occurrence, then log time.
 */
export async function listOccurrenceLog(
  tx: DbQueryable,
  fieldIds: readonly string[],
  fromIso: string,
  toIso: string
): Promise<OccurrenceLogRow[]> {
  if (!fieldIds.length) return [];
  const { rows } = await tx.query<RawOccurrence>(
    `SELECT ${OCCURRENCE_COLUMNS} FROM public.table_entry_occurrences o
      WHERE field_id = ANY($1::text[])
        AND ((occurrence >= $2 AND occurrence < $3)
          OR (moved_to IS NOT NULL AND moved_to >= $2 AND moved_to < $3)
          -- the done/skipped row of an occurrence that was moved into the window
          OR EXISTS (SELECT 1 FROM public.table_entry_occurrences m
                      WHERE m.field_id = o.field_id AND m.entry_id = o.entry_id
                        AND m.occurrence = o.occurrence AND m.kind = 'moved'
                        AND m.moved_to >= $2 AND m.moved_to < $3))
      ORDER BY field_id, entry_id, occurrence, created_at, id`,
    [[...new Set(fieldIds)], fromIso, toIso]
  );
  return rows.map(toOccurrence);
}

/**
 * The log rows of every repeat's current occurrence on `fieldIds`, oldest
 * first: what a table view needs to show each row's current occurrence state
 * without opening each row.
 */
export async function listCurrentOccurrenceLogs(
  tx: DbQueryable,
  fieldIds: readonly string[]
): Promise<OccurrenceLogRow[]> {
  if (!fieldIds.length) return [];
  const { rows } = await tx.query<RawOccurrence>(
    `SELECT ${OCCURRENCE_COLUMNS} FROM public.table_entry_occurrences o
      WHERE field_id = ANY($1::text[])
        AND EXISTS (SELECT 1 FROM public.table_entry_repeats r
                     WHERE r.field_id = o.field_id AND r.entry_id = o.entry_id
                       AND r.value->>'current' = o.occurrence)
      ORDER BY field_id, entry_id, created_at, id`,
    [[...new Set(fieldIds)]]
  );
  return rows.map(toOccurrence);
}

// per-row reads and writes (callers hold the schema lock)

/** One row's repeat on a field, or null. Locks it when `lock`. */
export async function readRepeat(
  tx: DbQueryable,
  fieldId: string,
  entryId: string,
  lock = false
): Promise<TableRepeat | null> {
  const { rows } = await tx.query<{ value: unknown }>(
    `SELECT value FROM public.table_entry_repeats WHERE field_id = $1 AND entry_id = $2::uuid${lock ? ' FOR UPDATE' : ''}`,
    [fieldId, entryId]
  );
  const value = rows[0]?.value;
  return value === undefined ? null : storedRepeat(value as TableRepeat);
}

/** Every repeat of one entry, by field id. */
export async function readEntryRepeats(
  tx: DbQueryable,
  tableId: string,
  entryId: string
): Promise<Map<string, TableRepeat>> {
  const { rows } = await tx.query<{ field_id: string; value: unknown }>(
    `SELECT field_id, value FROM public.table_entry_repeats WHERE table_id = $1 AND entry_id = $2::uuid`,
    [tableId, entryId]
  );
  return new Map(rows.map((row) => [row.field_id, storedRepeat(row.value as TableRepeat)]));
}

/** Set (upsert) or clear (null) one row's repeat. */
export async function writeRepeat(
  tx: DbQueryable,
  tableId: string,
  fieldId: string,
  entryId: string,
  value: TableRepeat | null
): Promise<void> {
  if (value === null) {
    await tx.query(
      'DELETE FROM public.table_entry_repeats WHERE field_id = $1 AND entry_id = $2::uuid',
      [fieldId, entryId]
    );
    return;
  }
  await tx.query(
    `INSERT INTO public.table_entry_repeats (table_id, field_id, entry_id, value)
     VALUES ($1, $2, $3::uuid, $4::jsonb)
     ON CONFLICT (field_id, entry_id) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [tableId, fieldId, entryId, JSON.stringify(storedRepeat(value))]
  );
}

/** One entry's log on a field (or every field), newest first. */
export async function readOccurrenceLog(
  tx: DbQueryable,
  tableId: string,
  entryId: string,
  fieldId?: string
): Promise<OccurrenceLogRow[]> {
  const { rows } = await tx.query<RawOccurrence>(
    `SELECT ${OCCURRENCE_COLUMNS} FROM public.table_entry_occurrences
      WHERE table_id = $1 AND entry_id = $2::uuid${fieldId ? ' AND field_id = $3' : ''}
      ORDER BY created_at DESC, id DESC`,
    fieldId ? [tableId, entryId, fieldId] : [tableId, entryId]
  );
  return rows.map(toOccurrence);
}

/** Read log rows by id (missing ids are left out). */
export async function readOccurrences(
  tx: DbQueryable,
  ids: readonly string[],
  lock = false
): Promise<OccurrenceLogRow[]> {
  if (!ids.length) return [];
  const { rows } = await tx.query<RawOccurrence>(
    `SELECT ${OCCURRENCE_COLUMNS} FROM public.table_entry_occurrences WHERE id = ANY($1::text[])
      ORDER BY id${lock ? ' FOR UPDATE' : ''}`,
    [[...ids]]
  );
  return rows.map(toOccurrence);
}

/** Insert log rows exactly as given (ids and timestamps included). */
export async function insertOccurrences(
  tx: DbQueryable,
  rows: readonly JournaledOccurrence[]
): Promise<void> {
  for (const row of rows)
    await tx.query(
      `INSERT INTO public.table_entry_occurrences
         (id, table_id, field_id, entry_id, occurrence, kind, moved_to, actor_kind, actor_id, created_at)
       VALUES ($1, $2, $3, $4::uuid, $5, $6, $7, $8, $9, $10::timestamptz)`,
      [
        row.id,
        row.tableId,
        row.fieldId,
        row.entryId,
        row.occurrence,
        row.kind,
        row.movedTo,
        row.actorKind,
        row.actorId,
        row.createdAt,
      ]
    );
}

/** Log a new occurrence; returns the stored row. */
export async function logOccurrence(
  tx: DbQueryable,
  input: {
    tableId: string;
    fieldId: string;
    entryId: string;
    occurrence: string;
    kind: OccurrenceKind;
    movedTo?: string | null;
    actor?: { kind: string; id: string } | null;
  }
): Promise<OccurrenceLogRow> {
  const { rows } = await tx.query<RawOccurrence>(
    `INSERT INTO public.table_entry_occurrences
       (table_id, field_id, entry_id, occurrence, kind, moved_to, actor_kind, actor_id, created_at)
     VALUES ($1, $2, $3::uuid, $4, $5, $6, $7, $8, clock_timestamp())
     RETURNING ${OCCURRENCE_COLUMNS}`,
    [
      input.tableId,
      input.fieldId,
      input.entryId,
      input.occurrence,
      input.kind,
      input.movedTo ?? null,
      input.actor?.kind ?? null,
      input.actor?.id ?? null,
    ]
  );
  return toOccurrence(rows[0]!);
}

/** Delete log rows by id; returns the ids actually deleted. */
export async function deleteOccurrences(
  tx: DbQueryable,
  ids: readonly string[]
): Promise<string[]> {
  if (!ids.length) return [];
  const { rows } = await tx.query<{ id: string }>(
    'DELETE FROM public.table_entry_occurrences WHERE id = ANY($1::text[]) RETURNING id',
    [[...ids]]
  );
  return rows.map((row) => row.id);
}

/** A log row as a history step journaled it. */
export type JournaledOccurrence = OccurrenceLogRow;

/** Every repeat and log row of `entryIds`, for an entry delete's undo. */
export interface EntryRepeatState {
  repeats: Array<{ tableId: string; fieldId: string; entryId: string; value: TableRepeat }>;
  log: JournaledOccurrence[];
}

/**
 * Remove (and return) every repeat and log row of `entryIds` in `tableId`:
 * a repeat never outlives its row. The caller keeps the result so undo can
 * put it back with {@link restoreEntryRepeats}.
 */
export async function takeEntryRepeats(
  tx: DbQueryable,
  tableId: string,
  entryIds: readonly string[]
): Promise<EntryRepeatState> {
  if (!entryIds.length) return { repeats: [], log: [] };
  const { rows: repeats } = await tx.query<{
    field_id: string;
    entry_id: string;
    value: TableRepeat;
  }>(
    `DELETE FROM public.table_entry_repeats WHERE table_id = $1 AND entry_id = ANY($2::uuid[])
     RETURNING field_id, entry_id::text AS entry_id, value`,
    [tableId, [...entryIds]]
  );
  const { rows: log } = await tx.query<RawOccurrence>(
    `DELETE FROM public.table_entry_occurrences WHERE table_id = $1 AND entry_id = ANY($2::uuid[])
     RETURNING ${OCCURRENCE_COLUMNS}`,
    [tableId, [...entryIds]]
  );
  return {
    repeats: repeats
      .map((row) => ({
        tableId,
        fieldId: row.field_id,
        entryId: row.entry_id,
        value: storedRepeat(row.value),
      }))
      .sort((a, b) => (`${a.fieldId}/${a.entryId}` < `${b.fieldId}/${b.entryId}` ? -1 : 1)),
    log: log.map(toOccurrence).sort((a, b) => (a.id < b.id ? -1 : 1)),
  };
}

/** Put back what {@link takeEntryRepeats} removed (fields gone since are skipped). */
export async function restoreEntryRepeats(tx: DbQueryable, state: EntryRepeatState): Promise<void> {
  for (const row of state.repeats)
    await tx.query(
      `INSERT INTO public.table_entry_repeats (table_id, field_id, entry_id, value)
       SELECT $1, $2, $3::uuid, $4::jsonb WHERE EXISTS (SELECT 1 FROM public.table_fields WHERE id = $2)
       ON CONFLICT (field_id, entry_id) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
      [row.tableId, row.fieldId, row.entryId, JSON.stringify(row.value)]
    );
  for (const row of state.log)
    await tx.query(
      `INSERT INTO public.table_entry_occurrences
         (id, table_id, field_id, entry_id, occurrence, kind, moved_to, actor_kind, actor_id, created_at)
       SELECT $1, $2, $3, $4::uuid, $5, $6, $7, $8, $9, $10::timestamptz
        WHERE EXISTS (SELECT 1 FROM public.table_fields WHERE id = $3)
       ON CONFLICT (id) DO NOTHING`,
      [
        row.id,
        row.tableId,
        row.fieldId,
        row.entryId,
        row.occurrence,
        row.kind,
        row.movedTo,
        row.actorKind,
        row.actorId,
        row.createdAt,
      ]
    );
}

/** Delete repeats / log rows whose entry no longer exists in `physical` (orphan sweep). */
async function sweepOrphanRepeats(
  tx: DbQueryable,
  tableId: string,
  physical: string
): Promise<number> {
  const a = await tx.query(
    `DELETE FROM public.table_entry_repeats AS r WHERE r.table_id = $1
       AND NOT EXISTS (SELECT 1 FROM ${physical} AS entry WHERE entry.id = r.entry_id)`,
    [tableId]
  );
  const b = await tx.query(
    `DELETE FROM public.table_entry_occurrences AS o WHERE o.table_id = $1
       AND NOT EXISTS (SELECT 1 FROM ${physical} AS entry WHERE entry.id = o.entry_id)`,
    [tableId]
  );
  return (a.rowCount ?? 0) + (b.rowCount ?? 0);
}

/**
 * {@link sweepOrphanRepeats} over every custom table that has repeats or log
 * rows and whose physical table still exists (a hard-deleted table's rows go
 * by FK cascade). Returns the rows removed. Each table locks its own repeat
 * rows only; entry writes keep their own schema lock.
 */
export async function sweepAllOrphanRepeats(tx: DbQueryable): Promise<number> {
  const { rows } = await tx.query<{ id: string; physical: string }>(
    `SELECT c.id, format('%I.%I', $1::text, c.table_name) AS physical
       FROM public.table_catalog AS c
      WHERE c.origin = 'custom'
        AND to_regclass(format('%I.%I', $1::text, c.table_name)) IS NOT NULL
        AND (EXISTS (SELECT 1 FROM public.table_entry_repeats r WHERE r.table_id = c.id)
          OR EXISTS (SELECT 1 FROM public.table_entry_occurrences o WHERE o.table_id = c.id))
      ORDER BY c.id`,
    [CUSTOM_TABLES_SCHEMA]
  );
  let removed = 0;
  for (const row of rows) removed += await sweepOrphanRepeats(tx, row.id, row.physical);
  return removed;
}

// history ops

/** History ops for what {@link takeEntryRepeats} removed (undo of an entry delete puts it back). */
export function cleanupOps(state: EntryRepeatState): RepeatOp[] {
  const ops = new Map<string, RepeatOp>();
  const key = (fieldId: string, entryId: string) => `${fieldId}/${entryId}`;
  const opFor = (tableId: string, fieldId: string, entryId: string): RepeatOp => {
    const found = ops.get(key(fieldId, entryId));
    if (found) return found;
    const op: RepeatOp = {
      op: 'repeat',
      tableId,
      fieldId,
      entryId,
      before: null,
      after: null,
      added: [],
      removed: [],
      cleanup: true,
    };
    ops.set(key(fieldId, entryId), op);
    return op;
  };
  for (const row of state.repeats) opFor(row.tableId, row.fieldId, row.entryId).before = row.value;
  for (const row of state.log) opFor(row.tableId, row.fieldId, row.entryId).removed.push(row);
  return [...ops.values()];
}

// wall-clock arithmetic

const WALL = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}):(\d{2}))?$/;
const DAY_MS = 86_400_000;

/** A wall time as milliseconds of a UTC clock, or null when malformed. */
export function wallMs(wall: string): number | null {
  const m = WALL.exec(wall);
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const [h, mi, s] = m[4] ? [Number(m[4]), Number(m[5]), Number(m[6])] : [0, 0, 0];
  const date = new Date(0);
  date.setUTCFullYear(y, mo - 1, d);
  date.setUTCHours(h, mi, s, 0);
  if (date.getUTCMonth() !== mo - 1 || date.getUTCDate() !== d || h > 23 || mi > 59 || s > 59)
    return null;
  return date.getTime();
}

export function wallKindOf(wall: string): 'date' | 'datetime' | null {
  const m = WALL.exec(wall);
  return m ? (m[4] ? 'datetime' : 'date') : null;
}

const pad = (n: number, width = 2) => String(n).padStart(width, '0');

export function msToWall(ms: number, kind: 'date' | 'datetime'): string {
  const d = new Date(ms);
  const day = `${pad(d.getUTCFullYear(), 4)}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
  return kind === 'date'
    ? day
    : `${day}T${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
}

/** The wall time `instant` (ISO) shows in `timeZone`, to the second, or null. */
export function instantToWall(instant: string, timeZone: string): string | null {
  const at = new Date(instant);
  if (Number.isNaN(at.getTime())) return null;
  try {
    const parts: Record<string, string> = {};
    for (const part of new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    }).formatToParts(at))
      parts[part.type] = part.value;
    return `${pad(Number(parts.year), 4)}-${parts.month}-${parts.day}T${pad(Number(parts.hour) % 24)}:${parts.minute}:${parts.second}`;
  } catch {
    return null;
  }
}

/**
 * Now as a wall time of `kind` in `timeZone`, read by
 * {@link tableRepeatWallTime} (UTC's for a zone the runtime doesn't know).
 */
export function nowWall(timeZone: string, kind: 'date' | 'datetime'): string {
  const wall = tableRepeatWallTime(new Date(), timeZone);
  return kind === 'date' ? wall.slice(0, 10) : wall;
}

const WEEKDAY_CODES = ['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU'];
const FIXED_DAY_PARTS = ['BYMONTHDAY', 'BYYEARDAY', 'BYWEEKNO', 'BYSETPOS', 'BYMONTH'];

/**
 * `rrule` moved by `days` whole days: plain BYDAY weekdays rotate with it
 * (Weekly on Mon, Thu → Tue, Fri). Rules pinned to fixed days (numbered
 * BYDAY, BYMONTHDAY, BYMONTH, …) can't follow a day shift: error.
 * Everything else derives from dtstart, which the caller shifts.
 */
export function shiftRuleByDays(
  rrule: string,
  days: number
): { ok: true; value: string } | { ok: false; error: string } {
  if (days === 0) return { ok: true, value: rrule };
  const parts = rrule.split(';').map((part) => part.split('=') as [string, string]);
  if (parts.some(([key]) => FIXED_DAY_PARTS.includes(key)))
    return {
      ok: false,
      error:
        'This repeat is pinned to fixed days, so it can’t move by days. Edit the repeat instead.',
    };
  const rotate = ((days % 7) + 7) % 7;
  const out: string[] = [];
  for (const [key, value] of parts) {
    if (key !== 'BYDAY') {
      out.push(`${key}=${value}`);
      continue;
    }
    const items = value.split(',');
    if (items.some((item) => !WEEKDAY_CODES.includes(item)))
      return {
        ok: false,
        error:
          'This repeat is pinned to a numbered weekday, so it can’t move by days. Edit the repeat instead.',
      };
    const shifted = items.map((item) => WEEKDAY_CODES[(WEEKDAY_CODES.indexOf(item) + rotate) % 7]!);
    out.push(`BYDAY=${WEEKDAY_CODES.filter((code) => shifted.includes(code)).join(',')}`);
  }
  return { ok: true, value: out.join(';') };
}

/** Whole calendar days from the date of `from` to the date of `to` (wall times). */
export function dayOffset(from: string, to: string): number {
  return Math.round((wallMs(to.slice(0, 10))! - wallMs(from.slice(0, 10))!) / DAY_MS);
}

/** Logged moves of one row's field, optionally only for `occurrence`. */
export async function readMoves(
  tx: DbQueryable,
  fieldId: string,
  entryId: string,
  occurrence?: string
): Promise<OccurrenceLogRow[]> {
  const { rows } = await tx.query<RawOccurrence>(
    `SELECT ${OCCURRENCE_COLUMNS} FROM public.table_entry_occurrences
      WHERE field_id = $1 AND entry_id = $2::uuid AND kind = 'moved'${occurrence ? ' AND occurrence = $3' : ''}
      ORDER BY occurrence, created_at, id FOR UPDATE`,
    occurrence ? [fieldId, entryId, occurrence] : [fieldId, entryId]
  );
  return rows.map(toOccurrence);
}

/** Whether `occurrence` of a row's field is finished: logged done or skipped. */
export async function isFinished(
  tx: DbQueryable,
  fieldId: string,
  entryId: string,
  occurrence: string,
  _repeat?: TableRepeat | null
): Promise<boolean> {
  const { rows } = await tx.query<{ found: boolean }>(
    `SELECT EXISTS (SELECT 1 FROM public.table_entry_occurrences
      WHERE field_id = $1 AND entry_id = $2::uuid AND occurrence = $3 AND kind IN ('done', 'skipped')) AS found`,
    [fieldId, entryId, occurrence]
  );
  return rows[0]?.found ?? false;
}
