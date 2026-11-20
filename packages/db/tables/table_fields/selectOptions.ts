/**
 * Select fields: a `text` column holding one option label, or a `text[] NOT
 * NULL` list of labels (`multiple`). The options live in
 * `table_fields.options`; a CHECK constraint named after the field id keeps
 * the column to their labels. Callers hold the field DDL locks and pass the
 * quoted physical table (`physicalTable(row)`).
 */
import type { DbQueryable } from '@snaglet/db/db';
import { quoteIdentifier } from '@snaglet/db/sql-utils';
import { ENTRY_POSITION_COLUMN } from '@snaglet/db/tables/table_catalog';
import {
  ErrorCode,
  TABLE_SELECT_MAX_OPTIONS,
  type TableField,
  type TableFieldDefinition,
  type TableFieldType,
  type TableSelectOption,
  type TableSelectOptionInput,
} from '@snaglet/shared/types';
import {
  AppError,
  generateId,
  resolveSelectOptions,
  selectOptionChanges,
  selectOptionLabelProblem,
  tableFieldDefinitionProblem,
} from '@snaglet/shared/utils';

type SelectShape = { type: TableFieldType; multiple?: boolean };
type SelectDefinition = TableFieldDefinition & { multiple: boolean };
/** A definition whose options are settled: the stored list for a select, null otherwise. */
export type SettledDefinition<T extends SelectDefinition> = Omit<T, 'options'> & {
  options: TableSelectOption[] | null;
};

function conflict(message: string): AppError {
  return new AppError(message, ErrorCode.CONFLICT, 409, true);
}

/** The CHECK limiting a select column to its labels, named after the field id like `fk_<id>`. */
export function selectCheckName(fieldId: string): string {
  return `ck_${fieldId.replace(/-/g, '_')}`;
}

/** `labels` as a PostgreSQL-quoted `text[]` literal. */
async function labelsLiteral(labels: readonly string[], tx: DbQueryable): Promise<string> {
  const { rows } = await tx.query<{ literal: string }>(
    'SELECT quote_literal($1::text[]::text) AS literal',
    [[...labels]]
  );
  const literal = rows[0]?.literal;
  if (!literal) throw new Error('Database did not quote the option labels');
  return `${literal}::text[]`;
}

/** A multi-select column's DEFAULT: its default labels, `'{}'` when none. */
export async function selectListDefaultSql(
  definition: TableFieldDefinition,
  tx: DbQueryable
): Promise<string> {
  const labels = Array.isArray(definition.defaultValue) ? definition.defaultValue : [];
  return labelsLiteral(labels, tx);
}

export async function addSelectCheck(
  table: string,
  columnName: string,
  fieldId: string,
  field: { multiple: boolean; options: readonly TableSelectOption[] | null },
  tx: DbQueryable
): Promise<void> {
  const allowed = await labelsLiteral(
    (field.options ?? []).map((option) => option.label),
    tx
  );
  const column = quoteIdentifier(columnName);
  // `x = ANY ('{}')` is false even when x is NULL, so an empty single select
  // must admit NULL explicitly. A list is never NULL, and `'{}' <@ '{}'` holds.
  const test = field.multiple
    ? `${column} <@ ${allowed}`
    : `${column} IS NULL OR ${column} = ANY (${allowed})`;
  await tx.query(
    `ALTER TABLE ${table} ADD CONSTRAINT ${quoteIdentifier(selectCheckName(fieldId))} CHECK (${test})`
  );
}

async function dropSelectCheck(table: string, fieldId: string, tx: DbQueryable): Promise<void> {
  await tx.query(
    `ALTER TABLE ${table} DROP CONSTRAINT IF EXISTS ${quoteIdentifier(selectCheckName(fieldId))}`
  );
}

/** The select's CHECK exists, is validated and covers only its column (schema drift otherwise). */
export async function hasSelectCheck(
  table: string,
  fieldId: string,
  attnum: number,
  tx: DbQueryable
): Promise<boolean> {
  const { rows } = await tx.query<{ ok: boolean }>(
    `SELECT c.convalidated AND c.conkey = ARRAY[$3::int2] AS ok
       FROM pg_constraint c
      WHERE c.conrelid = $1::regclass AND c.contype = 'c' AND c.conname = $2`,
    [table, selectCheckName(fieldId), attnum]
  );
  return rows[0]?.ok === true;
}

/** Entries holding each of `labels` (an element of a list counts once per entry). */
export async function countSelectUsage(
  table: string,
  field: { columnName: string; multiple: boolean },
  labels: readonly string[],
  tx: DbQueryable
): Promise<Map<string, number>> {
  const column = quoteIdentifier(field.columnName);
  const { rows } = await tx.query<{ label: string; count: number }>(
    field.multiple
      ? `SELECT value.label, count(DISTINCT entry.id)::int AS count
           FROM ONLY ${table} AS entry CROSS JOIN LATERAL unnest(entry.${column}) AS value(label)
          WHERE value.label = ANY($1::text[]) GROUP BY value.label`
      : `SELECT ${column} AS label, count(*)::int AS count FROM ONLY ${table}
          WHERE ${column} = ANY($1::text[]) GROUP BY ${column}`,
    [[...labels]]
  );
  return new Map(rows.map((row) => [row.label, row.count]));
}

/** Distinct trimmed non-empty values of a text column, first appearance in row order. */
async function distinctTextValues(
  table: string,
  columnName: string,
  tx: DbQueryable
): Promise<string[]> {
  const column = quoteIdentifier(columnName);
  const { rows } = await tx.query<{ label: string }>(
    `SELECT label FROM (SELECT btrim(${column}) AS label, ${quoteIdentifier(ENTRY_POSITION_COLUMN)} AS position
                          FROM ONLY ${table}) AS value
      WHERE label <> '' GROUP BY label ORDER BY min(position), label LIMIT $1`,
    [TABLE_SELECT_MAX_OPTIONS + 1]
  );
  return rows.map((row) => row.label);
}

function quoted(value: string): string {
  return JSON.stringify(value.length > 60 ? `${value.slice(0, 59)}…` : value);
}

/**
 * `given` followed by one new option per distinct existing value it does not
 * cover, so converting text to a select keeps every value. A value that
 * cannot be a label, values differing only by case, or more than
 * TABLE_SELECT_MAX_OPTIONS in all are a 409; nothing is cleared to convert.
 */
async function withTextValues(
  table: string,
  columnName: string,
  given: readonly TableSelectOptionInput[],
  tx: DbQueryable
): Promise<TableSelectOptionInput[]> {
  const labels = new Map(given.map((option) => [option.label.toLowerCase(), option.label]));
  const added: TableSelectOptionInput[] = [];
  for (const value of await distinctTextValues(table, columnName, tx)) {
    const problem = selectOptionLabelProblem(value);
    if (problem)
      throw conflict(
        `The value ${quoted(value)} cannot become an option: ${problem} Edit it first, or keep this field text.`
      );
    const known = labels.get(value.toLowerCase());
    if (known === value) continue;
    if (known !== undefined)
      throw conflict(
        `The values ${quoted(known)} and ${quoted(value)} differ only by capitalization. Make them match before converting.`
      );
    labels.set(value.toLowerCase(), value);
    added.push({ label: value });
  }
  if (given.length + added.length > TABLE_SELECT_MAX_OPTIONS)
    throw conflict(
      `This field has more than ${TABLE_SELECT_MAX_OPTIONS} distinct values, too many to become options. Keep it text, or tidy the values first.`
    );
  return [...given, ...added];
}

/**
 * `definition` with its options settled: for a select, the request's options
 * (or, left out, the field's current ones) resolved to stored options with
 * ids and colors; converting a text field also adds its existing values. The
 * default is then checked against the settled labels (400). Other types get
 * null. `field` is null on create.
 */
export async function settleSelectOptions<T extends SelectDefinition>(
  definition: T,
  field: TableField | null,
  table: string | null,
  tx: DbQueryable
): Promise<SettledDefinition<T>> {
  if (definition.type !== 'select') return { ...definition, options: null };
  const current = field?.type === 'select' ? field.options : null;
  let given: readonly TableSelectOptionInput[] = definition.options ?? current ?? [];
  if (field?.type === 'text' && table)
    given = await withTextValues(table, field.columnName, given, tx);
  const options = resolveSelectOptions(current, given, () => generateId('opt'));
  const problem = tableFieldDefinitionProblem({ ...definition, options });
  if (problem) throw new AppError(problem, ErrorCode.VALIDATION_ERROR, 400);
  return { ...definition, options };
}

/** A create replay matches when every option the request pinned (id, color) and every label agree. */
export function sameRequestedOptions(
  stored: readonly TableSelectOption[] | null,
  requested: readonly TableSelectOptionInput[] | null | undefined
): boolean {
  const wanted = requested ?? [];
  if (stored === null) return wanted.length === 0;
  return (
    stored.length === wanted.length &&
    stored.every((option, index) => {
      const input = wanted[index];
      return (
        input !== undefined &&
        input.label === option.label &&
        (input.id === undefined || input.id === option.id) &&
        (input.color === undefined || input.color === option.color)
      );
    })
  );
}

/**
 * The USING expression for a conversion into, out of or between select
 * shapes, or null when the generic rules apply (select → number/date/checkbox,
 * other types → select, both refused while populated). Only called for a
 * populated column; renamed/removed options were rewritten beforehand.
 */
export async function selectConversion(
  table: string,
  columnName: string,
  field: SelectShape,
  definition: SelectShape,
  tx: DbQueryable
): Promise<string | null> {
  const column = quoteIdentifier(columnName);
  const empty = `'{}'::text[]`;
  if (field.type === 'select' && definition.type === 'relation')
    throw conflict('Clear the existing values before making this field a relation.');
  if (field.type === 'select' && definition.type === 'select') {
    if (!field.multiple && definition.multiple)
      return `CASE WHEN ${column} IS NULL THEN ${empty} ELSE ARRAY[${column}] END`;
    const { rows } = await tx.query<{ several: boolean }>(
      `SELECT EXISTS (SELECT 1 FROM ONLY ${table} WHERE cardinality(${column}) > 1) AS several`
    );
    if (rows[0]?.several)
      throw conflict(
        'Some entries have more than one option. Remove the extra options before making this a single select.'
      );
    return `${column}[1]`;
  }
  if (field.type === 'select' && definition.type === 'text')
    return field.multiple ? `NULLIF(array_to_string(${column}, ', '), '')` : column;
  if (field.type === 'text' && definition.type === 'select') {
    const label = `NULLIF(btrim(${column}), '')`;
    return definition.multiple
      ? `CASE WHEN ${label} IS NULL THEN ${empty} ELSE ARRAY[btrim(${column})] END`
      : label;
  }
  return null;
}

export interface SelectChange {
  /** The CHECK was dropped (or never existed) and must be added for the new labels. */
  rebuild: boolean;
  /** Values may have become null: a required field fills them with its default. */
  emptied: boolean;
}

/**
 * The first half of a field edit touching a select, before any type change,
 * with `field` in its current shape (after a column rename): drop the CHECK
 * when the labels or shape change, rewrite renamed options and clear removed
 * ones (a required single select takes its default instead, else 409 while in
 * use), and drop NOT NULL where values may become empty. Reorders and
 * recolors touch no data. {@link finishSelectChange} re-adds the CHECK.
 */
export async function beginSelectChange(
  table: string,
  field: TableField,
  next: SettledDefinition<SelectDefinition>,
  tx: DbQueryable
): Promise<SelectChange> {
  const wasSelect = field.type === 'select';
  const isSelect = next.type === 'select';
  if (!wasSelect && !isSelect) return { rebuild: false, emptied: false };
  const changes =
    wasSelect && isSelect ? selectOptionChanges(field.options ?? [], next.options ?? []) : null;
  const rebuild =
    !wasSelect || !isSelect || field.multiple !== next.multiple || changes?.labelsChanged === true;
  if (wasSelect && rebuild) await dropSelectCheck(table, field.id, tx);
  const column = quoteIdentifier(field.columnName);
  const dropNotNull = async () => {
    if (!field.nullable && !field.multiple)
      await tx.query(`ALTER TABLE ${table} ALTER COLUMN ${column} DROP NOT NULL`);
  };
  if (!changes) {
    // Text becoming a select turns blank values into empty ones.
    if (field.type === 'text') await dropNotNull();
    return { rebuild, emptied: field.type === 'text' };
  }
  if (!changes.renames.length && !changes.removed.length) return { rebuild, emptied: false };
  const fill =
    !next.multiple && !next.nullable && typeof next.defaultValue === 'string'
      ? next.defaultValue
      : null;
  let emptied = false;
  if (changes.removed.length && fill === null && !field.multiple) {
    if (!next.multiple && !next.nullable) {
      const usage = await countSelectUsage(table, field, changes.removed, tx);
      const count = [...usage.values()].reduce((sum, used) => sum + used, 0);
      if (count)
        throw conflict(
          `${count === 1 ? '1 entry uses' : `${count} entries use`} a removed option. Give this field a default to replace it, or make it optional first.`
        );
    }
    await dropNotNull();
    emptied = true;
  }
  const mapping = [
    ...changes.renames,
    ...changes.removed.map((label) => ({ from: label, to: field.multiple ? null : fill })),
  ];
  // One statement per column, so swapped labels (a → b, b → a) map correctly.
  await tx.query(
    field.multiple
      ? `UPDATE ONLY ${table} AS entry SET ${column} = COALESCE(
           (SELECT array_agg(COALESCE(map.next, value.label) ORDER BY value.ord)
              FROM unnest(entry.${column}) WITH ORDINALITY AS value(label, ord)
              LEFT JOIN unnest($1::text[], $2::text[]) AS map(prev, next) ON map.prev = value.label
             WHERE map.prev IS NULL OR map.next IS NOT NULL),
           '{}'::text[])
         WHERE entry.${column} && $1::text[]`
      : `UPDATE ONLY ${table} AS entry SET ${column} = map.next
           FROM unnest($1::text[], $2::text[]) AS map(prev, next)
          WHERE entry.${column} = map.prev`,
    [mapping.map((entry) => entry.from), mapping.map((entry) => entry.to)]
  );
  return { rebuild, emptied };
}

/** Re-add the select's CHECK for its settled labels after the column has its final shape. */
export async function finishSelectChange(
  table: string,
  columnName: string,
  fieldId: string,
  next: SettledDefinition<SelectDefinition>,
  change: SelectChange,
  tx: DbQueryable
): Promise<void> {
  if (next.type === 'select' && change.rebuild)
    await addSelectCheck(table, columnName, fieldId, next, tx);
}
