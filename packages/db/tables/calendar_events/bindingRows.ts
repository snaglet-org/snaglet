/**
 * Calendar row reads: the rows of one bound date/datetime field (a range
 * too) inside a window, read through the restricted tables reader
 * (`snaglet_tables_reader`, read-only, `user_tables` only), one query per visible
 * binding.
 *
 * The schema (fields, schemaVersion) comes from the entry model's schema
 * lock on the app pool; the values come from the reader. Each row's
 * `revision` is computed exactly as the entry API computes it, so a move
 * write can pass it as `expectedRevision`.
 */
import { getDb, getTablesReaderClient, transaction, type DbQueryable } from '@snaglet/db/db';
import { quoteIdentifier } from '@snaglet/db/sql-utils';
import type { TableField } from '@snaglet/shared/types';
import { physicalTable } from '../table_fields/fieldSchema';
import { lockEntrySchema } from '../table_entries/entrySchema';
// The entry API's own projection and row mapping, so an occurrence carries the
// exact revision GET /entries returns (a move or resize sends it back).
import { projection, toEntry, type RawEntry } from '../table_entries/TableEntriesModel';

/** A field bound to a calendar, with its table, as the calendar reads it. */
export interface BindingMeta {
  calendarId: string;
  tableId: string;
  tableName: string;
  projectId: string | null;
  tableState: string;
  fieldId: string;
  fieldName: string;
  fieldType: 'date' | 'datetime';
  fieldState: string;
  repeats: boolean;
  /** Snaglet's own column (`created_at`): shown like any date, but its rows are read-only there. */
  managed: boolean;
}

/** Every field bound to one of `calendarIds` (any lifecycle state), custom tables only. */
export async function listBindings(
  calendarIds: readonly string[],
  runner: DbQueryable = getDb()
): Promise<BindingMeta[]> {
  if (!calendarIds.length) return [];
  const { rows } = await runner.query<{
    calendar_id: string;
    table_id: string;
    table_name: string;
    project_id: string | null;
    table_state: string;
    field_id: string;
    field_name: string;
    field_type: 'date' | 'datetime';
    field_state: string;
    repeats: boolean;
    managed: boolean;
  }>(
    `SELECT f.calendar_id, t.id AS table_id, t.name AS table_name, t.project_id, t.state AS table_state,
            f.id AS field_id, f.name AS field_name, f.type AS field_type, f.state AS field_state,
            f.recurrence IS NOT NULL AS repeats, f.managed
       FROM public.table_fields f
       JOIN public.table_catalog t ON t.id = f.table_id AND t.origin = 'custom'
      WHERE f.calendar_id = ANY($1::text[]) AND t.state <> 'deleted' AND f.state <> 'deleted'
      ORDER BY t.name, t.id, f.position, f.id`,
    [[...calendarIds]]
  );
  return rows.map((row) => ({
    calendarId: row.calendar_id,
    tableId: row.table_id,
    tableName: row.table_name,
    projectId: row.project_id,
    tableState: row.table_state,
    fieldId: row.field_id,
    fieldName: row.field_name,
    fieldType: row.field_type,
    fieldState: row.field_state,
    repeats: row.repeats,
    managed: row.managed,
  }));
}

/** Rows with no value in the field and no repeat on it (the sidebar's unscheduled count). */
export async function countUnscheduled(
  binding: Pick<BindingMeta, 'tableId' | 'fieldId'>,
  runner: DbQueryable = getDb()
): Promise<number> {
  const { rows: meta } = await runner.query<{ schema_table: string; column_name: string }>(
    `SELECT t.table_name AS schema_table, f.column_name FROM public.table_fields f
       JOIN public.table_catalog t ON t.id = f.table_id
      WHERE f.id = $1 AND t.id = $2 AND t.state = 'active' AND f.state = 'active'`,
    [binding.fieldId, binding.tableId]
  );
  const found = meta[0];
  if (!found) return 0;
  const { rows } = await runner.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM ONLY user_tables.${quoteIdentifier(found.schema_table)} r
      WHERE r.${quoteIdentifier(found.column_name)} IS NULL
        AND NOT EXISTS (SELECT 1 FROM public.table_entry_repeats p
                         WHERE p.field_id = $1 AND p.entry_id = r.id)`,
    [binding.fieldId]
  );
  return rows[0]?.n ?? 0;
}

/** One row of a bound table, as the calendar needs it. */
export interface BindingRow {
  entryId: string;
  /**
   * The bound field's value, or a range's start: `YYYY-MM-DD` (date) or an
   * ISO instant (datetime); null when empty.
   */
  start: string | null;
  /**
   * A range's end as the wire holds it: a date range's last day (inclusive),
   * a datetime range's end instant. Null for a plain field and for a range
   * holding only a start.
   */
  end: string | null;
  /** The row's Name, '' when unnamed. */
  title: string;
  /** Same value the entry API returns as `revision`. */
  revision: string;
}

export interface BindingRows {
  schemaVersion: string;
  /** The field holds ranges (End date on), read from the locked schema. */
  range: boolean;
  rows: BindingRow[];
}

/** Window for one binding read. */
export interface BindingWindow {
  /** Date fields: [fromDate, toDate), calendar dates in the viewer's zone. */
  fromDate: string;
  toDate: string;
  /** Datetime fields: rows overlapping [fromInstant, toInstant), the viewer's days. */
  fromInstant: string;
  toInstant: string;
  /** Rows to include whatever their value (repeating rows), as entry UUIDs. */
  alsoEntryIds: readonly string[];
  /** When set, only these rows (entry UUIDs) are read: one item's reminders. */
  onlyEntryIds?: readonly string[];
  /** Minutes a datetime row with no end (or a range holding only a start) lasts. */
  blockMinutes: number;
}

/**
 * The SQL test for "`column` of `field` overlaps the window". A NULL cell
 * never matches. A datetime with no end is drawn as `blockMinutes`, so it is
 * widened to that before the test (a range holding only a start, `[t,t]`,
 * the same way): plain `&&` on the point would miss a block that starts
 * just before the window.
 */
function windowTest(
  field: TableField,
  column: string,
  window: BindingWindow,
  param: (value: unknown, type: string) => string
): string {
  if (field.type === 'date') {
    const from = param(window.fromDate, 'date');
    const to = param(window.toDate, 'date');
    return field.range
      ? `${column} && daterange(${from}, ${to}, '[)')`
      : `(${column} >= ${from} AND ${column} < ${to})`;
  }
  const block = `make_interval(mins => ${param(window.blockMinutes, 'int')})`;
  const from = param(window.fromInstant, 'timestamptz');
  const to = param(window.toInstant, 'timestamptz');
  if (!field.range) return `(${column} < ${to} AND ${column} + ${block} > ${from})`;
  const start = `lower(${column})`;
  return `(${start} < ${to} AND GREATEST(upper(${column}), ${start} + ${block}) > ${from})`;
}

/** A range cell's wire text split into its start and end (null for a single value). */
function rangeParts(value: string | null): { start: string | null; end: string | null } {
  if (value === null) return { start: null, end: null };
  const slash = value.indexOf('/');
  return slash < 0
    ? { start: value, end: null }
    : { start: value.slice(0, slash), end: value.slice(slash + 1) };
}

export class CalendarReaderUnavailableError extends Error {
  constructor() {
    super(
      'Calendar rows need the restricted tables reader, which is not configured. Restart Snaglet or set SNAGLET_TABLES_READER_URL.'
    );
    this.name = 'CalendarReaderUnavailableError';
  }
}

/**
 * The rows of `binding` inside `window` (plus `alsoEntryIds`), one query
 * through the restricted reader. Throws {@link CalendarReaderUnavailableError}
 * when no reader is configured (never falls back to the app pool).
 */
export async function readBindingRows(
  binding: Pick<BindingMeta, 'tableId' | 'fieldId'>,
  window: BindingWindow
): Promise<BindingRows> {
  const schema = await transaction((tx) => lockEntrySchema(binding.tableId, tx));
  const field = schema.fields.find((f) => f.id === binding.fieldId);
  if (!field || (field.type !== 'date' && field.type !== 'datetime'))
    return { schemaVersion: schema.schemaVersion, range: false, rows: [] };
  const title = schema.fields.find((f) => f.isTitle);
  const reader = await getTablesReaderClient();
  if (!reader) throw new CalendarReaderUnavailableError();

  const params: unknown[] = [];
  const param = (value: unknown, type: string) => {
    params.push(value);
    return `$${params.length}::${type}`;
  };
  const inWindow = windowTest(field, quoteIdentifier(field.columnName), window, param);
  const also = window.alsoEntryIds.length
    ? ` OR id = ANY(${param([...window.alsoEntryIds], 'uuid[]')})`
    : '';
  const only = window.onlyEntryIds
    ? ` AND id = ANY(${param([...window.onlyEntryIds], 'uuid[]')})`
    : '';
  const sql = `SELECT ${projection(schema)} FROM ONLY ${physicalTable(schema.table)}
    WHERE (${inWindow}${also})${only}`;

  const raw = await reader.withConnection(async (connection) => {
    await connection.query('BEGIN READ ONLY');
    try {
      await connection.query("SET LOCAL DateStyle = 'ISO, YMD'");
      await connection.query("SET LOCAL TIME ZONE 'UTC'");
      const { rows } = await connection.query<Record<string, unknown>>(sql, params);
      return rows;
    } finally {
      await connection.query('ROLLBACK');
    }
  });

  const startIndex = schema.fields.indexOf(field);
  const titleIndex = title ? schema.fields.indexOf(title) : -1;
  return {
    schemaVersion: schema.schemaVersion,
    range: field.range,
    rows: raw.map((row) => {
      const { revision } = toEntry(schema, row as RawEntry);
      const text = (index: number) => {
        const value = index < 0 ? null : row[`entry_value_${index}`];
        return typeof value === 'string' ? value : null;
      };
      const value = text(startIndex);
      return {
        entryId: String(row.entry_id),
        ...(field.range ? rangeParts(value) : { start: value, end: null }),
        title: text(titleIndex) ?? '',
        revision,
      };
    }),
  };
}
