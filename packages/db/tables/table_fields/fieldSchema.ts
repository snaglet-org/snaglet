import type { DbQueryable } from '@snaglet/db/db';
import { quoteIdentifier } from '@snaglet/db/sql-utils';
import { CUSTOM_TABLES_SCHEMA, type TableCatalogRow } from '@snaglet/db/tables/table_catalog';
import {
  ErrorCode,
  type TableField,
  type TableFieldDefinition,
  type TableFieldType,
  type TableReferenceKind,
} from '@snaglet/shared/types';
import {
  AppError,
  parseTableDateRange,
  userTimeZone,
  type TableDateRange,
  type TableDateRangeKind,
} from '@snaglet/shared/utils';
import { hasSelectCheck, selectConversion, selectListDefaultSql } from './selectOptions';

export const SQL_TYPES: Record<TableFieldType, string> = {
  text: 'text',
  number: 'numeric',
  date: 'date',
  checkbox: 'boolean',
  relation: 'uuid',
  select: 'text',
  uuid: 'uuid',
  datetime: 'timestamp with time zone',
};

/**
 * The ISO 8601 forms a datetime write accepts (`parseTableDateTime`), as
 * PostgreSQL regular expressions. Range checks are left to the cast, whose
 * failure is the conversion's 409.
 */
const ISO_TIME = '[T ][0-9]{2}:[0-9]{2}(:[0-9]{2}(\\.[0-9]{1,6})?)?';
const ISO_OFFSET = '(Z|[+-][0-9]{2}(:?[0-9]{2})?)';
const ISO_DATE_TIME = `^[0-9]{4}-[0-9]{2}-[0-9]{2}(${ISO_TIME}${ISO_OFFSET}?)?$`;
const ISO_WITH_OFFSET = `^[0-9]{4}-[0-9]{2}-[0-9]{2}${ISO_TIME}${ISO_OFFSET}$`;

export function fieldConflict(message: string, field?: TableField): AppError {
  return new AppError(message, ErrorCode.CONFLICT, 409, true, field ? { field } : undefined);
}

export function physicalTable(row: TableCatalogRow): string {
  return `${quoteIdentifier(CUSTOM_TABLES_SCHEMA)}.${quoteIdentifier(row.tableName)}`;
}

/** A relation's foreign key is named after its field id, so column renames keep it. */
export function relationConstraint(fieldId: string): string {
  return `fk_${fieldId.replace(/-/g, '_')}`;
}

/** A multiple relation's GIN index, named after its field id like the foreign key. */
export function linksIndex(fieldId: string): string {
  return `${fieldId.replace(/-/g, '_')}_links_idx`;
}

/** The default of every multiple relation column: the empty list. */
const MULTIPLE_RELATION_DEFAULT = "'{}'::uuid[]";

/** What decides a field's column type. */
export interface FieldShape {
  type: TableFieldType;
  multiple?: boolean;
  /** A relation to Snaglet items stores their text ids instead of entry UUIDs. */
  referenceKind?: TableReferenceKind | null;
  /** A date or datetime field holding a start and an end. */
  range?: boolean;
}

export function isMultipleRelation(field: FieldShape): boolean {
  return field.type === 'relation' && field.multiple === true;
}

/** A date (`daterange`) or datetime (`tstzrange`) field holding a start and an end. */
export function isRange(field: FieldShape): field is FieldShape & { type: TableDateRangeKind } {
  return field.range === true && (field.type === 'date' || field.type === 'datetime');
}

/** A timestamptz expression as the wire's canonical UTC instant (`…T22:30:00.000000Z`). */
export function utcInstantText(expression: string): string {
  return `to_char(${expression} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
}

/**
 * A range column as its wire string,
 * the one form entries, calendar rows and conversions read: a date range
 * `start/end` with its end day included, `start` alone for one day; a
 * datetime range `start/end` in canonical UTC instants, `start` alone for a
 * single instant. Null (and an empty or unbounded range, which Snaglet never
 * writes) reads as null. Date text needs the ISO DateStyle every entry read
 * sets.
 */
export function rangeWireText(column: string, kind: TableDateRangeKind): string {
  const start = `lower(${column})`;
  const end = `upper(${column})`;
  return kind === 'date'
    ? `(${start}::text || CASE WHEN ${end} - ${start} > 1 THEN '/' || (${end} - 1)::text ELSE '' END)`
    : `(${utcInstantText(start)} || CASE WHEN ${end} > ${start} THEN '/' || ${utcInstantText(end)} ELSE '' END)`;
}

/**
 * A parsed range as the literal its column parses (bound as text, never
 * interpolated): days `[start,end]`, which PostgreSQL stores as
 * `[start,end+1)`; instants `[start,end)`, or `[t,t]` for a single instant
 * (`[t,t)` would be empty).
 */
export function rangeLiteral(range: TableDateRange, kind: TableDateRangeKind): string {
  if (kind === 'date') return `[${range.start},${range.end ?? range.start}]`;
  return range.end === null
    ? `["${range.start}","${range.start}"]`
    : `["${range.start}","${range.end}")`;
}

/** A relation to Snaglet items (docs, agents, …) rather than to a custom table. */
export function isItemRelation(field: FieldShape): boolean {
  return field.type === 'relation' && Boolean(field.referenceKind);
}

/** A single relation to a custom table: the only field with a foreign key. */
export function hasRelationKey(field: FieldShape): boolean {
  return field.type === 'relation' && field.multiple !== true && !isItemRelation(field);
}

/**
 * The column's PostgreSQL type, exactly as `format_type` prints it (the drift
 * checks compare the two): `uuid[]` for a multiple relation, `text` /
 * `text[]` for a relation to Snaglet items (their ids are text), `text[]` for a
 * multi-select, `daterange` / `tstzrange` for a date / datetime range.
 */
export function columnType(field: FieldShape): string {
  if (isRange(field)) return field.type === 'date' ? 'daterange' : 'tstzrange';
  if (field.type === 'select' && field.multiple === true) return 'text[]';
  if (isItemRelation(field)) return field.multiple === true ? 'text[]' : 'text';
  return isMultipleRelation(field) ? 'uuid[]' : SQL_TYPES[field.type];
}

/** The default of a multiple relation's column: the empty list of its element type. */
function listDefault(field: FieldShape): string {
  return isItemRelation(field) ? "'{}'::text[]" : MULTIPLE_RELATION_DEFAULT;
}

interface PhysicalField {
  type: string;
  nullable: boolean;
  default_expression: string | null;
  generated: string;
  identity: string;
  attnum: number;
}

export async function readPhysicalField(
  row: TableCatalogRow,
  columnName: string,
  tx: DbQueryable
): Promise<PhysicalField | null> {
  const { rows } = await tx.query<PhysicalField>(
    `SELECT format_type(a.atttypid, a.atttypmod) AS type, NOT a.attnotnull AS nullable,
            pg_get_expr(d.adbin, d.adrelid) AS default_expression,
            a.attgenerated AS generated, a.attidentity AS identity, a.attnum
       FROM pg_attribute a
       JOIN pg_class c ON c.oid = a.attrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
       LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
      WHERE n.nspname = 'user_tables' AND c.relname = $1 AND c.relkind = 'r'
        AND a.attname = $2 AND a.attnum > 0 AND NOT a.attisdropped`,
    [row.tableName, columnName]
  );
  return rows[0] ?? null;
}

export async function assertFieldSchema(
  row: TableCatalogRow,
  field: TableField,
  expectedDefault: string | null,
  target: TableCatalogRow | undefined,
  tx: DbQueryable
): Promise<void> {
  const physical = await readPhysicalField(row, field.columnName, tx);
  const drift = () =>
    fieldConflict(
      'This field was changed outside the field editor. Restore its database schema before editing it.'
    );
  if (
    !physical ||
    physical.type !== columnType(field) ||
    physical.nullable !== field.nullable ||
    physical.default_expression !== expectedDefault ||
    physical.generated ||
    physical.identity
  )
    throw drift();
  const { rows: constraints } = await tx.query<{
    name: string;
    target_matches: boolean;
    target_column: string;
    delete_action: string;
    update_action: string;
    validated: boolean;
    single_column: boolean;
  }>(
    `SELECT c.conname AS name, c.confrelid = to_regclass($3) AS target_matches,
            a.attname AS target_column, c.confdeltype AS delete_action,
            c.confupdtype AS update_action, c.convalidated AS validated,
            cardinality(c.conkey) = 1 AND cardinality(c.confkey) = 1 AS single_column
       FROM pg_constraint c
       JOIN pg_attribute a ON a.attrelid = c.confrelid AND a.attnum = c.confkey[1]
      WHERE c.conrelid = $1::regclass AND c.contype = 'f' AND $2 = ANY(c.conkey)`,
    [physicalTable(row), physical.attnum, target ? physicalTable(target) : null]
  );
  // Only a single relation to a table has a foreign key; array elements and
  // Snaglet item ids cannot have one.
  if (!hasRelationKey(field)) {
    if (constraints.length) throw drift();
    if (
      field.type === 'select' &&
      !(await hasSelectCheck(physicalTable(row), field.id, physical.attnum, tx))
    )
      throw drift();
    return;
  }
  const fk = constraints[0];
  if (
    !target ||
    constraints.length !== 1 ||
    !fk ||
    fk.name !== relationConstraint(field.id) ||
    !fk.target_matches ||
    fk.target_column !== 'id' ||
    fk.delete_action !== 'n' ||
    fk.update_action !== 'a' ||
    !fk.validated ||
    !fk.single_column
  )
    throw drift();
}

export async function defaultSql(
  definition: TableFieldDefinition,
  tx: DbQueryable
): Promise<string | null> {
  if (isMultipleRelation(definition)) return listDefault(definition);
  if (definition.type === 'select' && definition.multiple === true)
    return selectListDefaultSql(definition, tx);
  // Range fields have no default (validation and a DB check refuse one).
  if (isRange(definition)) return null;
  if (definition.defaultValue === null || Array.isArray(definition.defaultValue)) return null;
  // DDL cannot bind a default expression. Let PostgreSQL quote the literal;
  // the cast is selected exclusively from the closed logical-type map.
  const { rows } = await tx.query<{ literal: string }>(
    'SELECT quote_literal($1::text) AS literal',
    [String(definition.defaultValue)]
  );
  const literal = rows[0]?.literal;
  if (!literal) throw new Error('Database did not quote the field default');
  return `${literal}::${SQL_TYPES[definition.type]}`;
}

export async function addRelation(
  row: TableCatalogRow,
  columnName: string,
  fieldId: string,
  target: TableCatalogRow,
  tx: DbQueryable
): Promise<void> {
  await assertRelationTarget(target, tx);
  await tx.query(
    `ALTER TABLE ${physicalTable(row)} ADD CONSTRAINT ${quoteIdentifier(relationConstraint(fieldId))} FOREIGN KEY (${quoteIdentifier(columnName)}) REFERENCES ${physicalTable(target)} (id) ON DELETE SET NULL`
  );
}

/** The relation target keeps the managed `uuid` id every link points at. */
export async function assertRelationTarget(
  target: TableCatalogRow,
  tx: DbQueryable
): Promise<void> {
  const key = await readPhysicalField(target, 'id', tx);
  if (!key || key.type !== 'uuid' || key.nullable)
    throw fieldConflict('The relation target must have its managed UUID id column.');
}

/**
 * The USING expression that converts `field`'s column to `definition`'s type,
 * or a 409 when existing values cannot be kept. A relation keeping its target
 * converts between one link and a list: null ↔ [] and x ↔ [x]. A list becomes
 * a single link only when no entry has more than one link and every link still
 * exists in `target`, so the foreign key can be added. Dates and datetimes
 * convert through the user's time zone, and a datetime becomes ISO 8601 text
 * carrying that zone's offset.
 */
export async function conversionExpression(
  row: TableCatalogRow,
  field: TableField,
  definition: TableFieldDefinition,
  target: TableCatalogRow | undefined,
  tx: DbQueryable
): Promise<string> {
  const table = physicalTable(row);
  const column = quoteIdentifier(field.columnName);
  // Lists: multiple relations and multi-selects.
  const fromMultiple = field.multiple;
  const toMultiple = definition.multiple === true;
  const { rows } = await tx.query<{ populated: boolean }>(
    `SELECT EXISTS (SELECT 1 FROM ${table} WHERE ${fromMultiple ? `cardinality(${column}) > 0` : `${column} IS NOT NULL`}) AS populated`
  );
  if (!rows[0]?.populated) return `${toMultiple ? `'{}'` : 'NULL'}::${columnType(definition)}`;
  const range = await rangeConversion(row, column, field, definition, tx);
  if (range !== null) return range;
  const fromKind = field.type === 'relation' ? (field.referenceKind ?? null) : null;
  const toKind = definition.type === 'relation' ? (definition.referenceKind ?? null) : null;
  // Every project is a container, so a project relation may widen to containers.
  const sameTarget =
    field.type === 'relation' &&
    definition.type === 'relation' &&
    (fromKind || toKind
      ? fromKind === toKind || (fromKind === 'project' && toKind === 'container')
      : field.referenceTableId === definition.referenceTableId);
  if (sameTarget && !fromMultiple && toMultiple)
    return `CASE WHEN ${column} IS NULL THEN ${listDefault(definition)} ELSE ARRAY[${column}] END`;
  if (sameTarget && fromMultiple && !toMultiple && toKind) {
    const { rows: found } = await tx.query<{ several: boolean }>(
      `SELECT EXISTS (SELECT 1 FROM ${table} WHERE cardinality(${column}) > 1) AS several`
    );
    if (found[0]?.several)
      throw fieldConflict(
        'Some entries link to more than one item. Remove the extra links before making this a single relation.'
      );
    return `${column}[1]`;
  }
  if (sameTarget && fromKind && fromMultiple === toMultiple) return column;
  if (sameTarget && fromMultiple && !toMultiple && target) {
    const { rows: found } = await tx.query<{ several: boolean; dangling: boolean }>(
      `SELECT EXISTS (SELECT 1 FROM ${table} WHERE cardinality(${column}) > 1) AS several,
              EXISTS (SELECT 1 FROM ${table} AS entry CROSS JOIN LATERAL unnest(entry.${column}) AS link(id)
                       WHERE NOT EXISTS (SELECT 1 FROM ${physicalTable(target)} AS linked WHERE linked.id = link.id)) AS dangling`
    );
    if (found[0]?.several)
      throw fieldConflict(
        'Some entries link to more than one entry. Remove the extra links before making this a single relation.'
      );
    if (found[0]?.dangling)
      throw fieldConflict(
        'Some links point to entries that no longer exist in the related table. Remove those links before making this a single relation.'
      );
    return `${column}[1]`;
  }
  const select = await selectConversion(table, field.columnName, field, definition, tx);
  if (select !== null) return select;
  if (field.type === 'relation' || definition.type === 'relation')
    throw fieldConflict(
      'Clear the existing relation values before changing this field type or target.'
    );
  const zone = zoneLiteral();
  if (definition.type === 'text')
    return field.type === 'datetime' ? localIsoText(column, zone) : `${column}::text`;
  // A date becomes midnight in the user's time zone; the values stay within
  // the years a datetime write accepts.
  if (field.type === 'date' && definition.type === 'datetime') {
    await assertConvertible(
      row,
      `isfinite(${column}) AND ${column} BETWEEN '0001-01-01' AND '9999-12-31'`,
      column,
      tx
    );
    return `${column}::timestamp AT TIME ZONE ${zone}`;
  }
  // Keeps the calendar date in the user's time zone and drops the time.
  if (field.type === 'datetime' && definition.type === 'date')
    return `(${column} AT TIME ZONE ${zone})::date`;
  if (field.type !== 'text' || definition.type === 'select')
    throw fieldConflict(
      'This type change cannot preserve the existing values. Use an empty field or convert them to text first.'
    );
  let valid: string;
  switch (definition.type) {
    case 'number':
      valid = `${column} ~ '^[+-]?([0-9]+(\\.[0-9]*)?|\\.[0-9]+)$'`;
      break;
    case 'date':
      valid = `${column} ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'`;
      break;
    case 'datetime':
      valid = `${column} ~ '${ISO_DATE_TIME}'`;
      break;
    case 'checkbox':
      valid = `${column} IN ('true', 'false')`;
      break;
  }
  await assertConvertible(row, valid, column, tx);
  if (definition.type === 'datetime')
    return `CASE WHEN ${column} ~ '${ISO_WITH_OFFSET}' THEN ${column}::timestamp with time zone ELSE ${column}::timestamp AT TIME ZONE ${zone} END`;
  return `${column}::${SQL_TYPES[definition.type]}`;
}

/** The days a datetime write accepts, so converted dates stay readable and writable. */
function inDateYears(expression: string): string {
  return `isfinite(${expression}) AND ${expression} BETWEEN '0001-01-01' AND '9999-12-31'`;
}

/**
 * The USING expression for a change into or out of a range, or null when
 * neither side is one. Every expression that builds a
 * range keeps an empty cell empty: `daterange(NULL, NULL)` would be an
 * unbounded range covering all time. Text becomes a range through
 * {@link rangeTextValues} instead.
 */
async function rangeConversion(
  row: TableCatalogRow,
  column: string,
  field: TableField,
  definition: FieldShape,
  tx: DbQueryable
): Promise<string | null> {
  const from = isRange(field);
  const to = isRange(definition);
  if (!from && !to) return null;
  const zone = zoneLiteral();
  const kept = (expression: string) =>
    `CASE WHEN ${column} IS NULL THEN NULL ELSE ${expression} END`;
  const start = `lower(${column})`;
  const end = `upper(${column})`;
  if (from && to) {
    if (field.type === definition.type) return column;
    // Include time on: each day becomes local midnight, the end the midnight after its last day.
    if (field.type === 'date') {
      await assertConvertible(
        row,
        `COALESCE(${inDateYears(start)} AND ${inDateYears(`(${end} - 1)`)}, false)`,
        column,
        tx
      );
      return kept(
        `tstzrange(${start}::timestamp AT TIME ZONE ${zone}, ${end}::timestamp AT TIME ZONE ${zone}, '[)')`
      );
    }
    // Include time off: the local days the range touches; a single instant is its own day.
    const first = `(${start} AT TIME ZONE ${zone})::date`;
    return kept(
      `daterange(${first}, GREATEST(((${end} - interval '1 microsecond') AT TIME ZONE ${zone})::date + 1, ${first} + 1), '[)')`
    );
  }
  if (to) {
    if (field.type === 'text') throw new Error('Text becomes a range through rangeTextValues');
    if (field.type !== 'date' && field.type !== 'datetime')
      throw fieldConflict(
        'Only a date, a date and time, or text can get an end date. Convert this field to a date first.'
      );
    // End date on: each value is a range of one day or one instant.
    if (field.type === 'date') {
      await assertConvertible(
        row,
        definition.type === 'date' ? `isfinite(${column})` : inDateYears(column),
        column,
        tx
      );
      return definition.type === 'date'
        ? kept(`daterange(${column}, ${column}, '[]')`)
        : kept(
            `tstzrange(${column}::timestamp AT TIME ZONE ${zone}, ${column}::timestamp AT TIME ZONE ${zone}, '[]')`
          );
    }
    await assertConvertible(row, `isfinite(${column})`, column, tx);
    return definition.type === 'datetime'
      ? kept(`tstzrange(${column}, ${column}, '[]')`)
      : kept(
          `daterange((${column} AT TIME ZONE ${zone})::date, (${column} AT TIME ZONE ${zone})::date, '[]')`
        );
  }
  // End date off keeps each start.
  if (definition.type === field.type) return start;
  if (field.type === 'date' && definition.type === 'datetime') {
    await assertConvertible(row, `COALESCE(${inDateYears(start)}, false)`, column, tx);
    return `${start}::timestamp AT TIME ZONE ${zone}`;
  }
  if (field.type === 'datetime' && definition.type === 'date')
    return `(${start} AT TIME ZONE ${zone})::date`;
  if (definition.type === 'text')
    return field.type === 'date'
      ? rangeWireText(column, 'date')
      : `(${localIsoText(start, zone)} || CASE WHEN ${end} > ${start} THEN '/' || ${localIsoText(end, zone)} ELSE '' END)`;
  throw fieldConflict(
    'A field with end dates can only become a date, a date and time, or text. Clear its values or convert it to text first.'
  );
}

/**
 * Text becoming a date or datetime range, parsed row by row with the one
 * wire parser (offset-less instants in the user's zone): each entry's range
 * literal, or a 409 naming the form when a value is not a range. Null when
 * the change is not text → range. The caller retypes with `USING NULL` and
 * writes them with {@link writeRangeValues}.
 */
export async function rangeTextValues(
  row: TableCatalogRow,
  field: TableField,
  definition: FieldShape,
  tx: DbQueryable
): Promise<Array<[string, string]> | null> {
  if (field.type !== 'text' || !isRange(definition)) return null;
  const kind = definition.type;
  const { rows } = await tx.query<{ id: string; value: string }>(
    `SELECT id::text AS id, ${quoteIdentifier(field.columnName)} AS value FROM ONLY ${physicalTable(row)}
      WHERE ${quoteIdentifier(field.columnName)} IS NOT NULL ORDER BY id`
  );
  const zone = userTimeZone();
  const values: Array<[string, string]> = [];
  for (const entry of rows) {
    const parsed = parseTableDateRange(entry.value, kind, zone);
    if (!parsed.ok)
      throw fieldConflict(
        kind === 'date'
          ? 'Some existing values are not dates or date ranges like 2026-10-12/2026-10-15. Edit those values before changing this field.'
          : 'Some existing values are not dates and times or ranges like 2026-10-12T09:00/2026-10-12T10:30. Edit those values before changing this field.'
      );
    values.push([entry.id, rangeLiteral(parsed.range, kind)]);
  }
  return values;
}

/** Write {@link rangeTextValues}' literals into the retyped range column. */
export async function writeRangeValues(
  row: TableCatalogRow,
  columnName: string,
  sqlType: string,
  values: ReadonlyArray<[string, string]>,
  tx: DbQueryable
): Promise<void> {
  if (!values.length) return;
  await tx.query(
    `UPDATE ONLY ${physicalTable(row)} AS entry SET ${quoteIdentifier(columnName)} = kept.value::${sqlType}
       FROM unnest($1::uuid[], $2::text[]) AS kept(id, value) WHERE entry.id = kept.id`,
    [values.map(([id]) => id), values.map(([, value]) => value)]
  );
}

/** 409 unless every non-null value of `column` satisfies `valid`. */
async function assertConvertible(
  row: TableCatalogRow,
  valid: string,
  column: string,
  tx: DbQueryable
): Promise<void> {
  const { rows } = await tx.query<{ invalid: boolean }>(
    `SELECT EXISTS (SELECT 1 FROM ${physicalTable(row)} WHERE ${column} IS NOT NULL AND NOT (${valid})) AS invalid`
  );
  if (rows[0]?.invalid)
    throw fieldConflict(
      'Some existing values do not match the selected type. Edit those values before changing this field.'
    );
}

/** The user's time zone as a SQL literal; `userTimeZone` returns only IANA-name characters. */
export function zoneLiteral(): string {
  return `'${userTimeZone()}'`;
}

/**
 * A timestamptz column as ISO 8601 text in the user's time zone with its UTC
 * offset, e.g. `2026-10-01T15:30:00-07:00` (fractional seconds only when set).
 */
function localIsoText(column: string, zone: string): string {
  const local = `(${column} AT TIME ZONE ${zone})`;
  const utc = `(${column} AT TIME ZONE 'UTC')`;
  return `(to_json(${local}) #>> '{}') || CASE WHEN ${local} < ${utc} THEN '-' || to_char(${utc} - ${local}, 'HH24:MI') ELSE '+' || to_char(${local} - ${utc}, 'HH24:MI') END`;
}
