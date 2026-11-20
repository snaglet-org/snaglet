/**
 * Exact row snapshots for undo history. A row is recorded as the PostgreSQL
 * text cast of every tracked column — each field's column in any lifecycle
 * state (so an archived field's data survives a row delete and restore) and
 * the system `position` — keyed by field id. Text casts round-trip exactly
 * when read and written in the canonical session settings below: numeric
 * scale, microsecond UTC instants, ISO dates and array literals included.
 */
import type { DbQueryable } from '@snaglet/db/db';
import { quoteIdentifier } from '@snaglet/db/sql-utils';
import {
  CUSTOM_TABLES_SCHEMA,
  ENTRY_POSITION_COLUMN,
  type TableCatalogRow,
} from '@snaglet/db/tables/table_catalog';
import type { TableFieldType, TableLifecycleState } from '@snaglet/shared/types';
import { physicalTable } from '../table_fields/fieldSchema';
import { POSITION_KEY, type Cells, type EntriesOp, type HistoryJournal } from './types';

/** Column types a snapshot may cast through; anything else is schema drift. */
const SNAPSHOT_TYPES: ReadonlySet<string> = new Set([
  'text',
  'numeric',
  'date',
  'boolean',
  'uuid',
  'timestamp with time zone',
  'double precision',
  'uuid[]',
  'text[]',
  // Date and datetime ranges: canonical too (ISO dates, UTC instants).
  'daterange',
  'tstzrange',
]);

export interface TrackedColumn {
  /** Field id, or {@link POSITION_KEY}. */
  key: string;
  column: string;
  /** `format_type` of the physical column. */
  sqlType: string;
  fieldType: TableFieldType | null;
  multiple: boolean;
  referenceTableId: string | null;
  state: TableLifecycleState | null;
}

/** Session settings every snapshot read and write uses, so text casts are canonical. */
export async function useCanonicalText(tx: DbQueryable): Promise<void> {
  await tx.query("SET LOCAL DateStyle = 'ISO, YMD'");
  await tx.query("SET LOCAL TIME ZONE 'UTC'");
  await tx.query('SET LOCAL extra_float_digits = 1');
}

/**
 * The table's snapshot columns: every registered field's column except the
 * managed `id` (the row key), in any state, plus `position`. Columns Snaglet does
 * not register are left out.
 */
export async function trackedColumns(
  table: TableCatalogRow,
  tx: DbQueryable
): Promise<TrackedColumn[]> {
  const { rows } = await tx.query<{
    column_name: string;
    sql_type: string;
    field_id: string | null;
    field_type: TableFieldType | null;
    multiple: boolean | null;
    reference_table_id: string | null;
    state: TableLifecycleState | null;
    managed: boolean | null;
  }>(
    `SELECT a.attname AS column_name, format_type(a.atttypid, a.atttypmod) AS sql_type,
            f.id AS field_id, f.type AS field_type, f.multiple, f.reference_table_id, f.state, f.managed
       FROM pg_attribute a
       LEFT JOIN public.table_fields f ON f.table_id = $2 AND f.column_name = a.attname
      WHERE a.attrelid = to_regclass($1) AND a.attnum > 0 AND NOT a.attisdropped
      ORDER BY a.attnum`,
    [physicalTable(table), table.id]
  );
  const columns: TrackedColumn[] = [];
  for (const row of rows) {
    const isPosition = row.field_id === null && row.column_name === ENTRY_POSITION_COLUMN;
    if (!isPosition && (row.field_id === null || (row.managed && row.column_name === 'id')))
      continue;
    if (!SNAPSHOT_TYPES.has(row.sql_type)) continue;
    columns.push({
      key: isPosition ? POSITION_KEY : (row.field_id ?? ''),
      column: row.column_name,
      sqlType: row.sql_type,
      fieldType: row.field_type,
      multiple: row.multiple === true,
      referenceTableId: row.reference_table_id,
      state: row.state,
    });
  }
  return columns;
}

export function columnTypes(columns: readonly TrackedColumn[]): Record<string, string> {
  return Object.fromEntries(columns.map((column) => [column.key, column.sqlType]));
}

/** Snapshot rows by id (lowercase). `lock` takes them FOR UPDATE. */
export async function readRows(
  table: TableCatalogRow,
  columns: readonly TrackedColumn[],
  ids: readonly string[],
  tx: DbQueryable,
  lock = false
): Promise<Map<string, Cells>> {
  const result = new Map<string, Cells>();
  if (!ids.length) return result;
  await useCanonicalText(tx);
  const casts = columns.map((column) => `${quoteIdentifier(column.column)}::text`);
  const { rows } = await tx.query<{ id: string; cells: Array<string | null> }>(
    `SELECT id::text AS id, ARRAY[${casts.length ? casts.join(', ') : ''}]::text[] AS cells
       FROM ONLY ${physicalTable(table)} WHERE id = ANY($1::uuid[]) ORDER BY id${lock ? ' FOR UPDATE' : ''}`,
    [[...ids]]
  );
  for (const row of rows) {
    const cells: Cells = {};
    columns.forEach((column, index) => {
      cells[column.key] = row.cells[index] ?? null;
    });
    result.set(row.id, cells);
  }
  return result;
}

/** Only the cells that differ between two snapshots of one row. */
export function changedCells(before: Cells, after: Cells): { before: Cells; after: Cells } | null {
  const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])].filter(
    (key) => (before[key] ?? null) !== (after[key] ?? null)
  );
  if (!keys.length) return null;
  return {
    before: Object.fromEntries(keys.map((key) => [key, before[key] ?? null])),
    after: Object.fromEntries(keys.map((key) => [key, after[key] ?? null])),
  };
}

/** The journal's entries op for the step, created on first use; recorded column types merge in. */
export function entriesOp(
  journal: HistoryJournal,
  tableId: string,
  types: Record<string, string>
): EntriesOp {
  let op = journal.ops.find((candidate): candidate is EntriesOp => candidate.op === 'entries');
  if (!op) {
    op = { op: 'entries', columns: {}, rows: [] };
    journal.ops.push(op);
  }
  op.columns[tableId] = { ...(op.columns[tableId] ?? {}), ...types };
  return op;
}

/** `cells` limited to columns that still exist, each cast to its current type. */
function assignments(
  columns: ReadonlyMap<string, TrackedColumn>,
  cells: Cells,
  params: unknown[],
  filter: (column: TrackedColumn) => boolean = () => true
): Array<{ column: TrackedColumn; value: string }> {
  const out: Array<{ column: TrackedColumn; value: string }> = [];
  for (const [key, value] of Object.entries(cells)) {
    const column = columns.get(key);
    if (!column || !filter(column)) continue;
    params.push(value);
    out.push({ column, value: `$${params.length}::text::${column.sqlType}` });
  }
  return out;
}

export function columnsByKey(columns: readonly TrackedColumn[]): Map<string, TrackedColumn> {
  return new Map(columns.map((column) => [column.key, column]));
}

const isSingleRelation = (column: TrackedColumn) =>
  column.fieldType === 'relation' && !column.multiple;

/**
 * Insert rows with their recorded ids and cells. Single-relation cells are
 * written after every row exists, so rows may link to each other.
 */
export async function insertRows(
  table: TableCatalogRow,
  columns: ReadonlyMap<string, TrackedColumn>,
  rows: ReadonlyArray<{ id: string; cells: Cells }>,
  tx: DbQueryable
): Promise<void> {
  await useCanonicalText(tx);
  for (const row of rows) {
    const params: unknown[] = [row.id];
    const set = assignments(columns, row.cells, params, (column) => !isSingleRelation(column));
    await tx.query(
      `INSERT INTO ${physicalTable(table)} (id${set.map(({ column }) => `, ${quoteIdentifier(column.column)}`).join('')})
       VALUES ($1::uuid${set.map(({ value }) => `, ${value}`).join('')})`,
      params
    );
  }
  for (const row of rows) {
    const links = Object.fromEntries(
      Object.entries(row.cells).filter(([key, value]) => {
        const column = columns.get(key);
        return value !== null && column !== undefined && isSingleRelation(column);
      })
    );
    if (Object.keys(links).length) await updateCells(table, columns, row.id, links, tx);
  }
}

export async function updateCells(
  table: TableCatalogRow,
  columns: ReadonlyMap<string, TrackedColumn>,
  id: string,
  cells: Cells,
  tx: DbQueryable
): Promise<void> {
  await useCanonicalText(tx);
  const params: unknown[] = [id];
  const set = assignments(columns, cells, params);
  if (!set.length) return;
  await tx.query(
    `UPDATE ONLY ${physicalTable(table)} SET ${set
      .map(({ column, value }) => `${quoteIdentifier(column.column)} = ${value}`)
      .join(', ')} WHERE id = $1::uuid`,
    params
  );
}

/** Whether the row exists and every recorded cell (of columns that still exist) matches. */
export async function rowMatches(
  table: TableCatalogRow,
  columns: ReadonlyMap<string, TrackedColumn>,
  id: string,
  cells: Cells,
  tx: DbQueryable
): Promise<boolean> {
  await useCanonicalText(tx);
  const params: unknown[] = [id];
  const checks = assignments(columns, cells, params).map(
    ({ column, value }) => `${quoteIdentifier(column.column)} IS NOT DISTINCT FROM ${value}`
  );
  const { rows } = await tx.query<{ matches: boolean }>(
    `SELECT EXISTS (SELECT 1 FROM ONLY ${physicalTable(table)} WHERE id = $1::uuid${
      checks.length ? ` AND ${checks.join(' AND ')}` : ''
    }) AS matches`,
    params
  );
  return rows[0]?.matches === true;
}

export async function rowExists(
  table: TableCatalogRow,
  id: string,
  tx: DbQueryable
): Promise<boolean> {
  const { rows } = await tx.query<{ found: boolean }>(
    `SELECT EXISTS (SELECT 1 FROM ONLY ${physicalTable(table)} WHERE id = $1::uuid) AS found`,
    [id]
  );
  return rows[0]?.found === true;
}

/**
 * Links from visible entries (active relation fields of active tables) to
 * `ids` of `tableId`, ignoring rows in `excluded` (`tableId/id`). Hidden
 * links follow the key rules on delete, as a normal delete leaves them.
 */
export async function visibleLinksTo(
  tableId: string,
  ids: readonly string[],
  excluded: ReadonlySet<string>,
  tx: DbQueryable
): Promise<Array<{ tableId: string; fieldId: string; entryId: string }>> {
  if (!ids.length) return [];
  const { rows: fields } = await tx.query<{
    field_id: string;
    column_name: string;
    multiple: boolean;
    table_id: string;
    table_name: string;
  }>(
    `SELECT field.id AS field_id, field.column_name, field.multiple, catalog.id AS table_id, catalog.table_name
       FROM public.table_fields AS field
       JOIN public.table_catalog AS catalog ON catalog.id = field.table_id
      WHERE field.type = 'relation' AND field.reference_table_id = $1 AND field.state = 'active'
        AND catalog.origin = 'custom' AND catalog.state = 'active'
      ORDER BY catalog.id, field.id`,
    [tableId]
  );
  const found: Array<{ tableId: string; fieldId: string; entryId: string }> = [];
  for (const field of fields) {
    const table = `${quoteIdentifier(CUSTOM_TABLES_SCHEMA)}.${quoteIdentifier(field.table_name)}`;
    const column = quoteIdentifier(field.column_name);
    const { rows } = await tx.query<{ id: string }>(
      field.multiple
        ? `SELECT id::text AS id FROM ONLY ${table} WHERE ${column} && $1::uuid[]`
        : `SELECT id::text AS id FROM ONLY ${table} WHERE ${column} = ANY($1::uuid[])`,
      [[...ids]]
    );
    for (const row of rows)
      if (!excluded.has(`${field.table_id}/${row.id}`))
        found.push({ tableId: field.table_id, fieldId: field.field_id, entryId: row.id });
  }
  return found;
}

/**
 * Single-relation links that hidden columns (retired fields, or fields of
 * retired tables) hold to `ids`: a delete's foreign keys clear them, so the
 * step records them to put back on undo.
 */
export async function hiddenSingleLinksTo(
  tableId: string,
  ids: readonly string[],
  tx: DbQueryable
): Promise<Array<{ tableId: string; fieldId: string; entryId: string; value: string }>> {
  if (!ids.length) return [];
  const { rows: fields } = await tx.query<{
    field_id: string;
    column_name: string;
    table_id: string;
    table_name: string;
  }>(
    `SELECT field.id AS field_id, field.column_name, field.table_id, catalog.table_name
       FROM public.table_fields AS field
       JOIN public.table_catalog AS catalog ON catalog.id = field.table_id
      WHERE field.type = 'relation' AND NOT field.multiple AND field.reference_table_id = $1
        AND (field.state <> 'active' OR catalog.state <> 'active')
        AND to_regclass(format('%I.%I', $2::text, catalog.table_name)) IS NOT NULL
      ORDER BY field.table_id, field.id`,
    [tableId, CUSTOM_TABLES_SCHEMA]
  );
  const found: Array<{ tableId: string; fieldId: string; entryId: string; value: string }> = [];
  for (const field of fields) {
    const table = `${quoteIdentifier(CUSTOM_TABLES_SCHEMA)}.${quoteIdentifier(field.table_name)}`;
    const column = quoteIdentifier(field.column_name);
    const { rows } = await tx.query<{ id: string; value: string }>(
      `SELECT id::text AS id, ${column}::text AS value FROM ONLY ${table} WHERE ${column} = ANY($1::uuid[])`,
      [[...ids]]
    );
    for (const row of rows)
      found.push({
        tableId: field.table_id,
        fieldId: field.field_id,
        entryId: row.id,
        value: row.value,
      });
  }
  return found;
}
