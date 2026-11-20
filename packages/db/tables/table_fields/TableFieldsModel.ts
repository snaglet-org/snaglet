import { getDb, transaction, type DbQueryable } from '@snaglet/db/db';
import { quoteIdentifier } from '@snaglet/db/sql-utils';
import {
  CUSTOM_TABLES_SCHEMA,
  TableCatalog,
  type TableCatalogRow,
} from '@snaglet/db/tables/table_catalog';
import {
  CUSTOM_FIELD_ID_PATTERN,
  ErrorCode,
  type CreateTableFieldRequest,
  type SetTableFieldCalendarRequest,
  type TableField,
  type TableFieldDefinition,
  type UpdateTableFieldRequest,
  type UpdateTableFieldViewRequest,
} from '@snaglet/shared/types';
import {
  AppError,
  getErrorMessage,
  normalizeTableFieldDefinition,
  tableDateTimeToUtc,
  tableFieldDefinitionProblem,
  tableFieldWidthProblem,
  userTimeZone,
} from '@snaglet/shared/utils';
import {
  addRelation,
  assertFieldSchema,
  assertRelationTarget,
  columnType,
  conversionExpression,
  defaultSql,
  fieldConflict,
  hasRelationKey,
  isItemRelation,
  isMultipleRelation,
  linksIndex,
  physicalTable,
  rangeTextValues,
  readPhysicalField,
  relationConstraint,
  SQL_TYPES,
  writeRangeValues,
} from './fieldSchema';
import { itemValueConversion, writeItemValues } from './itemConversion';
import {
  addSelectCheck,
  beginSelectChange,
  countSelectUsage,
  finishSelectChange,
  sameRequestedOptions,
  settleSelectOptions,
} from './selectOptions';
import { findField, lockFieldOrder, toField, writeFieldOrder, type RawField } from './fieldRows';
import {
  assertRecurrenceTargets,
  assertStatusEdit,
  defaultRecurrence,
  sameRecurrence,
  storedRecurrence,
  takeFieldRepeats,
} from './recurrence';
import {
  definitionTouchesValues,
  readColumnValues,
  storedDefinition,
} from '../table_history/lifecycle';
import { newJournal, recordStep, stepLabels } from '../table_history/record';
import type { HistoryContext, HistoryJournal } from '../table_history/types';
import { Calendars } from '../calendars/CalendarModel';

// Calendar binding

/** {@link toField} plus the calendar binding key, present only when set. */
function boundField(raw: RawField): TableField {
  const field = toField(raw);
  return { ...field, ...(raw.calendar_id ? { calendarId: raw.calendar_id } : {}) };
}

/** The calendar a field shows on (null = none). A range field holds its own end. */
type Binding = string | null;

/**
 * The binding a write asks for: left out keeps `current`; a type that
 * cannot carry it (anything but date/datetime) clears it. `'default'` is
 * resolved later.
 */
function requestedBinding(input: TableFieldDefinition, type: string, current: Binding): Binding {
  if (type !== 'date' && type !== 'datetime') return null;
  return input.calendarId === undefined ? current : input.calendarId;
}

/** Readable checks before the database constraint (the backstop). */
async function resolveBinding(
  type: string,
  wanted: Binding,
  input: TableFieldDefinition,
  tx: DbQueryable
): Promise<Binding> {
  if (
    input.calendarId !== undefined &&
    input.calendarId !== null &&
    type !== 'date' &&
    type !== 'datetime'
  )
    throw badRequest('Only date and datetime fields can show on a calendar.');
  if (wanted === null || wanted === undefined) return null;
  return resolveCalendarId(wanted, tx);
}

/**
 * A calendar a binding names: `'default'` is the Default calendar (created
 * when missing); any other id must exist.
 */
async function resolveCalendarId(calendarId: string, tx: DbQueryable): Promise<string> {
  if (calendarId === 'default')
    return (await Calendars.ensureDefault(tx, userTimeZone())).calendar.id;
  if (typeof calendarId !== 'string') throw badRequest('calendarId must be a calendar id.');
  const calendar = await Calendars.findById(calendarId, tx);
  if (!calendar) throw badRequest('That calendar no longer exists. Choose another calendar.');
  return calendarId;
}

async function writeBinding(
  fieldId: string,
  calendarId: Binding,
  bumpRevision: boolean,
  tx: DbQueryable
): Promise<RawField> {
  const { rows } = await tx.query<RawField>(
    `UPDATE public.table_fields SET calendar_id = $2${
      bumpRevision ? ', revision = revision + 1, updated_at = now()' : ''
    } WHERE id = $1 RETURNING *`,
    [fieldId, calendarId]
  );
  if (!rows[0]) throw new Error('Bound field metadata is missing');
  return rows[0];
}

function sameDefinition(
  field: TableField,
  value: TableFieldDefinition & { multiple: boolean; range: boolean }
): boolean {
  return (
    field.name === value.name &&
    field.description === value.description &&
    field.type === value.type &&
    field.nullable === value.nullable &&
    // Defaults are scalars or the empty list.
    JSON.stringify(field.defaultValue) === JSON.stringify(value.defaultValue) &&
    field.referenceTableId === value.referenceTableId &&
    (field.referenceKind ?? null) === (value.referenceKind ?? null) &&
    field.multiple === value.multiple &&
    field.range === value.range &&
    JSON.stringify(field.options) === JSON.stringify(value.options ?? null) &&
    sameRecurrence(field.recurrence, value.recurrence)
  );
}

function badRequest(message: string): AppError {
  return new AppError(message, ErrorCode.VALIDATION_ERROR, 400);
}

/** The Name field's column in a newly created table. */
const TITLE_COLUMN = 'name';

function validateDefinition(definition: TableFieldDefinition): void {
  const problem = tableFieldDefinitionProblem(definition);
  if (problem) throw badRequest(problem);
}

/**
 * `value` with `multiple`, `range` and its relation target decided, validated
 * strictly, in its stored form. `referenceKind` left out is null, or the
 * field's current kind while an update keeps it a relation without a table
 * target. A datetime default is saved as UTC, read in the user's time zone
 * when it has no offset, so replays and edits compare it exactly.
 */
function decided<T extends TableFieldDefinition>(
  value: T,
  multiple: boolean,
  range: boolean,
  currentKind: TableField['referenceKind'] = null
): T & { multiple: boolean; range: boolean } {
  const referenceTableId = value.referenceTableId ?? null;
  const referenceKind =
    value.referenceKind !== undefined
      ? value.referenceKind
      : value.type === 'relation' && referenceTableId === null
        ? (currentKind ?? null)
        : null;
  // A new date or datetime field can repeat; an explicit setting (or null) is kept.
  const recurrence =
    value.recurrence === undefined && (value.type === 'date' || value.type === 'datetime')
      ? defaultRecurrence()
      : value.recurrence;
  const definition = {
    ...value,
    referenceTableId,
    referenceKind,
    multiple,
    range,
    ...(recurrence !== undefined ? { recurrence } : {}),
  };
  validateDefinition(definition);
  if (definition.type === 'datetime' && typeof definition.defaultValue === 'string') {
    const utc = tableDateTimeToUtc(definition.defaultValue, userTimeZone());
    if (!utc) throw badRequest('Enter a default date and time within the years 1 to 9999.');
    definition.defaultValue = utc;
  }
  return normalizeTableFieldDefinition(definition);
}

/** Add a multiple relation's GIN index (named after the field id). */
async function addLinksIndex(
  source: TableCatalogRow,
  columnName: string,
  fieldId: string,
  tx: DbQueryable
): Promise<void> {
  await tx.query(
    `CREATE INDEX IF NOT EXISTS ${quoteIdentifier(linksIndex(fieldId))} ON ${physicalTable(source)} USING gin (${quoteIdentifier(columnName)})`
  );
}

function customTable(row: TableCatalogRow | null): TableCatalogRow {
  if (!row) throw new AppError('Table not found', ErrorCode.NOT_FOUND, 404);
  if (row.origin !== 'custom')
    throw new AppError('Snaglet table fields are read-only', ErrorCode.FORBIDDEN, 403);
  return row;
}

/**
 * Custom tables a schema change holds locked, by catalog id. A caller that
 * renames one inside the same transaction replaces its row here.
 */
export type LockedTables = Map<string, TableCatalogRow>;

/**
 * Lock custom tables for a schema change: catalog rows FOR UPDATE, then their
 * physical tables ACCESS EXCLUSIVE, both in id order so every schema writer
 * (self-relations included) locks in one order. Missing ids are a 404 and
 * built-in ones a 403.
 */
async function lockTableSet(ids: Array<string | null>, tx: DbQueryable): Promise<LockedTables> {
  await tx.query('SET LOCAL lock_timeout = 5000');
  await tx.query('SET LOCAL statement_timeout = 15000');
  await tx.query("SET LOCAL DateStyle = 'ISO, YMD'");
  // A datetime default's recorded expression is printed in the session zone;
  // UTC matches the entry editor's drift check (lockEntrySchema).
  await tx.query("SET LOCAL TIME ZONE 'UTC'");
  const sorted = [...new Set(ids.filter((id): id is string => id !== null))].sort();
  // Serialize schema edits before inspecting metadata.
  await tx.query(
    'SELECT id FROM public.table_catalog WHERE id = ANY($1::text[]) ORDER BY id FOR UPDATE',
    [sorted]
  );
  const tables: LockedTables = new Map();
  for (const id of sorted) {
    const row = customTable(await TableCatalog.findById(id, tx));
    tables.set(id, row);
  }
  if (tables.size)
    await tx.query(
      `LOCK TABLE ${[...tables.values()].map(physicalTable).join(', ')} IN ACCESS EXCLUSIVE MODE`
    );
  return tables;
}

/** A table the caller's lock set must already hold. */
function lockedTable(tables: LockedTables, id: string): TableCatalogRow {
  const row = tables.get(id);
  if (!row)
    throw fieldConflict(
      'The table fields changed while this change was prepared. No changes were saved; try again.'
    );
  return row;
}

/** The table being changed must be active: archived is a 409, deleted a 404. */
function changeableTable(tables: LockedTables, id: string): TableCatalogRow {
  const row = lockedTable(tables, id);
  if (row.state === 'deleted') throw new AppError('Table not found', ErrorCode.NOT_FOUND, 404);
  if (row.state === 'archived')
    throw new AppError(
      `${row.name} is archived. Restore it to change it.`,
      ErrorCode.CONFLICT,
      409
    );
  return row;
}

/** A new relation target must be an active table. */
function linkableTable(tables: LockedTables, id: string): TableCatalogRow {
  const row = lockedTable(tables, id);
  if (row.state !== 'active') throw badRequest('Choose a table that is not archived to link to.');
  return row;
}

/** Map a schema write's driver error onto the field API's 409/400 errors. */
export function mapFieldDatabaseError(error: unknown): Error {
  if (error instanceof AppError) return error;
  const message = getErrorMessage(error);
  const code =
    typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined;
  switch (code) {
    case '23505':
    case '42701':
      return fieldConflict('A field with this name or id already exists.');
    case '23502':
      return fieldConflict(
        'Existing rows have empty values. Keep this field optional or fill those values first.'
      );
    case '23503':
      if ((error as { constraint?: string }).constraint === 'table_fields_calendar_id_fkey')
        return badRequest('That calendar no longer exists');
      return fieldConflict(
        'The relation cannot be created because its target no longer has a compatible id column.'
      );
    case '42830':
      return fieldConflict(
        'The relation cannot be created because its target no longer has a compatible id column.'
      );
    case '22P02':
    case '22003':
    case '22007':
    case '22008':
    case '22001':
      return fieldConflict(
        'Some values or the default cannot be converted to this field type. No changes were saved.'
      );
    case '55P03':
    case '57014':
    case '40P01':
      return fieldConflict('The table is busy. No changes were saved; try again.');
    case '0A000':
    case '42809':
    case '42P01':
    case '42703':
    case '42804':
    case '2BP01':
    case '23514':
      return fieldConflict(
        'The physical table has incompatible schema changes or constraints. No changes were saved.'
      );
    default:
      return new Error(message, { cause: error });
  }
}

/** Create a field whose definition is decided, under locks the caller holds. */
async function createDecidedField(
  tableId: string,
  input: CreateTableFieldRequest,
  definition: TableFieldDefinition & { multiple: boolean; range: boolean },
  tables: LockedTables,
  tx: DbQueryable,
  journal?: HistoryJournal
): Promise<{ field: TableField; created: boolean }> {
  const source = changeableTable(tables, tableId);
  const existing = await findField(input.id, tx);
  const target = definition.referenceTableId
    ? existing
      ? lockedTable(tables, definition.referenceTableId)
      : linkableTable(tables, definition.referenceTableId)
    : undefined;
  if (existing) {
    const field = boundField(existing);
    if (existing.state !== 'active')
      throw fieldConflict('This field id belongs to an archived or deleted field.');
    if (
      field.tableId !== tableId ||
      !sameDefinition(field, { ...definition, options: field.options }) ||
      !sameRequestedOptions(field.options, definition.options)
    )
      throw fieldConflict('This field id already exists with different settings.');
    await assertFieldSchema(source, field, existing.default_expression, target, tx);
    // Replays skip placement: the first attempt already committed it.
    return { field, created: false };
  }
  let order: string[] | null = null;
  if (input.beforeFieldId !== undefined) {
    order = await lockFieldOrder(tableId, tx);
    const slot = order.indexOf(input.beforeFieldId);
    if (slot < 0) throw badRequest('The field to insert before no longer exists.');
    order.splice(slot, 0, input.id);
  }
  const settled = await settleSelectOptions(definition, null, null, tx);
  await assertRecurrenceTargets(tableId, definition.type, definition.recurrence, 'request', tx);
  // The field's name is its real column name (validated snake_case).
  const columnName = definition.name;
  const column = quoteIdentifier(columnName);
  const defaultExpression = await defaultSql(definition, tx);
  const { rows } = await tx.query<{ position: number }>(
    "SELECT COALESCE(max(position) + 1, 0) AS position FROM public.table_fields WHERE table_id = $1 AND state = 'active'",
    [tableId]
  );
  const position = rows[0]?.position ?? 0;
  await tx.query(
    `ALTER TABLE ${physicalTable(source)} ADD COLUMN ${column} ${columnType(definition)}${defaultExpression === null ? '' : ` DEFAULT ${defaultExpression}`}${definition.nullable ? '' : ' NOT NULL'}`
  );
  if (target && definition.multiple) {
    await assertRelationTarget(target, tx);
    await addLinksIndex(source, columnName, input.id, tx);
  } else if (target) await addRelation(source, columnName, input.id, target, tx);
  else if (isItemRelation(definition) && definition.multiple)
    await addLinksIndex(source, columnName, input.id, tx);
  if (settled.options)
    await addSelectCheck(physicalTable(source), columnName, input.id, settled, tx);
  const physical = await readPhysicalField(source, columnName, tx);
  if (!physical) throw new Error('Created field column is missing');
  const result = await tx.query<RawField>(
    `INSERT INTO public.table_fields (id, table_id, column_name, name, description, type, nullable, default_value, default_expression, reference_table_id, position, multiple, options, reference_kind, recurrence, is_range)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10,$11,$12,$13::jsonb,$14,$15::jsonb,$16) RETURNING *`,
    [
      input.id,
      tableId,
      columnName,
      definition.name,
      definition.description,
      definition.type,
      definition.nullable,
      JSON.stringify(definition.defaultValue),
      physical.default_expression,
      definition.referenceTableId,
      position,
      definition.multiple,
      settled.options && JSON.stringify(settled.options),
      definition.referenceKind ?? null,
      definition.recurrence ? JSON.stringify(storedRecurrence(definition.recurrence)) : null,
      definition.range,
    ]
  );
  const inserted = result.rows[0];
  if (!inserted) throw new Error('Created field metadata is missing');
  // Undoing a create deletes the field (held by the step), so redo can restore it.
  journal?.ops.push({
    op: 'field.state',
    tableId,
    fieldId: input.id,
    name: definition.name,
    before: 'deleted',
    after: 'active',
    revision: inserted.revision,
    definition: storedDefinition(toField(inserted)),
  });
  const binding = await resolveBinding(
    definition.type,
    requestedBinding(definition, definition.type, null),
    definition,
    tx
  );
  if (binding !== null) await writeBinding(input.id, binding, false, tx);
  if (order) await writeFieldOrder(tableId, order, tx);
  const placed = await findField(input.id, tx);
  if (!placed) throw new Error('Created field metadata is missing');
  return { field: boundField(placed), created: true };
}

/** Update a field under locks the caller holds; `input` is already validated. */
async function updateLockedField(
  tableId: string,
  fieldId: string,
  input: UpdateTableFieldRequest,
  tables: LockedTables,
  tx: DbQueryable,
  journal?: HistoryJournal
): Promise<TableField> {
  const source = changeableTable(tables, tableId);
  const raw = await findField(fieldId, tx);
  if (!raw || raw.table_id !== tableId || raw.state !== 'active')
    throw new AppError('Field not found', ErrorCode.NOT_FOUND, 404);
  const field = boundField(raw);
  if (field.managed) throw new AppError('Managed fields are read-only', ErrorCode.FORBIDDEN, 403);
  if (field.isTitle && input.type !== field.type)
    throw badRequest('The Name field must stay a text field.');
  // Left out, `multiple` keeps the field's setting while it keeps its type
  // (relation or select), so callers that leave it out never turn a list
  // into a single value.
  // Left out, `range` keeps the field's setting while it stays a date or
  // datetime, so Include time and callers that leave it out never drop an end.
  const decidedInput = decided(
    input,
    input.multiple ?? (input.type === field.type && field.multiple),
    input.range ?? ((input.type === 'date' || input.type === 'datetime') && field.range),
    field.referenceKind
  );
  // Left out, the repeat setting stays. A date or datetime field repeats by
  // default (one made from another type starts so); a repeating field that
  // changes type loses its rows' repeats (they are wall times of the old
  // type; the step keeps them for undo). A field that is no longer a date
  // cannot repeat. End date on or off is not a type change: a repeat is on
  // the start, and a range keeps its length.
  const toDateType = decidedInput.type === 'date' || decidedInput.type === 'datetime';
  let recurrence =
    input.recurrence === undefined
      ? (field.recurrence ?? null)
      : storedRecurrence(input.recurrence);
  if (!toDateType) recurrence = null;
  else if (input.recurrence === undefined && !field.recurrence && field.type !== decidedInput.type)
    recurrence = storedRecurrence(defaultRecurrence());
  const requested = { ...decidedInput, recurrence };
  if (field.revision !== input.expectedRevision)
    throw fieldConflict(
      'This field changed while you were editing it. Review the latest version before saving.',
      field
    );
  await assertFieldSchema(
    source,
    field,
    raw.default_expression,
    field.referenceTableId ? tables.get(field.referenceTableId) : undefined,
    tx
  );
  const next = await settleSelectOptions(requested, field, physicalTable(source), tx);
  const currentBinding: Binding = field.calendarId ?? null;
  const binding = await resolveBinding(
    next.type,
    requestedBinding(input, next.type, currentBinding),
    input,
    tx
  );
  if (sameDefinition(field, next)) {
    // A binding-only edit: one revision bump, no schema change, no undo step
    // (field history does not carry the binding).
    if (currentBinding === binding) return field;
    return boundField(await writeBinding(fieldId, binding, true, tx));
  }
  // Clear a binding the new type cannot carry before the retype (a DB check refuses it).
  if (currentBinding !== null && next.type !== 'date' && next.type !== 'datetime')
    await writeBinding(fieldId, null, false, tx);
  await assertRecurrenceTargets(tableId, next.type, next.recurrence, 'request', tx);
  await assertStatusEdit(field, next, tx);
  const nextStored = {
    name: next.name,
    description: next.description,
    type: next.type,
    nullable: next.nullable,
    defaultValue: next.defaultValue,
    referenceTableId: next.referenceTableId,
    referenceKind: next.referenceKind ?? null,
    multiple: next.multiple,
    range: next.range,
    options: next.options,
    recurrence: next.recurrence,
  };
  // Turning repeat off, or changing the type, removes the rows' repeats; the
  // step keeps them for undo.
  const repeats =
    field.recurrence && (!next.recurrence || next.type !== field.type)
      ? await takeFieldRepeats(field.id, tx)
      : null;
  // An edit that can rewrite stored values keeps the whole column for undo.
  const valuesBefore =
    journal && definitionTouchesValues(storedDefinition(field), nextStored)
      ? await readColumnValues(source, field.columnName, tx)
      : null;
  const table = physicalTable(source);
  // A rename is a real column rename; every later statement uses the new name.
  const renamed = { ...field, columnName: next.name };
  if (next.name !== field.name) {
    await tx.query(
      `ALTER TABLE ${table} RENAME COLUMN ${quoteIdentifier(field.columnName)} TO ${quoteIdentifier(renamed.columnName)}`
    );
  }
  const column = quoteIdentifier(renamed.columnName);
  const select = await beginSelectChange(table, renamed, next, tx);
  const shapeChanged =
    field.type !== next.type ||
    field.multiple !== next.multiple ||
    columnType(field) !== columnType(next);
  const referenceChanged =
    field.referenceTableId !== next.referenceTableId ||
    (field.referenceKind ?? null) !== (next.referenceKind ?? null);
  if (shapeChanged || referenceChanged) {
    const target = next.referenceTableId
      ? referenceChanged
        ? linkableTable(tables, next.referenceTableId)
        : lockedTable(tables, next.referenceTableId)
      : undefined;
    // Text ↔ Snaglet item relations and text → range are computed row by row,
    // after a USING NULL retype.
    const itemValues = shapeChanged ? await itemValueConversion(source, renamed, next, tx) : null;
    const rangeValues = shapeChanged ? await rangeTextValues(source, renamed, next, tx) : null;
    const conversion =
      itemValues || rangeValues
        ? `NULL::${columnType(next)}`
        : await conversionExpression(source, renamed, next, target, tx);
    if (hasRelationKey(field))
      await tx.query(
        `ALTER TABLE ${table} DROP CONSTRAINT ${quoteIdentifier(relationConstraint(field.id))}`
      );
    if (isMultipleRelation(field) && !isMultipleRelation(next))
      await tx.query(
        `DROP INDEX IF EXISTS ${quoteIdentifier(CUSTOM_TABLES_SCHEMA)}.${quoteIdentifier(linksIndex(field.id))}`
      );
    await tx.query(`ALTER TABLE ${table} ALTER COLUMN ${column} DROP DEFAULT`);
    // A list column is NOT NULL, and converting it can yield nulls; a USING
    // NULL retype empties the column until its values are written back.
    if (field.multiple || rangeValues)
      await tx.query(`ALTER TABLE ${table} ALTER COLUMN ${column} DROP NOT NULL`);
    if (shapeChanged)
      await tx.query(
        `ALTER TABLE ${table} ALTER COLUMN ${column} TYPE ${columnType(next)} USING ${conversion}`
      );
    if (itemValues)
      await writeItemValues(
        source,
        renamed.columnName,
        columnType(next) === 'text[]',
        itemValues,
        tx
      );
    if (rangeValues)
      await writeRangeValues(source, renamed.columnName, columnType(next), rangeValues, tx);
    if (target && next.multiple) {
      await assertRelationTarget(target, tx);
      await addLinksIndex(source, renamed.columnName, field.id, tx);
    } else if (target) await addRelation(source, renamed.columnName, field.id, target, tx);
    else if (isItemRelation(next) && next.multiple)
      await addLinksIndex(source, renamed.columnName, field.id, tx);
  }
  const expression = await defaultSql(next, tx);
  await tx.query(
    `ALTER TABLE ${table} ALTER COLUMN ${column} ${expression === null ? 'DROP DEFAULT' : `SET DEFAULT ${expression}`}`
  );
  // Becoming required fills empty values with the new default, after any type
  // change so it writes the converted column. Without a default, SET NOT NULL
  // refuses them (409). Converting a list away leaves its empty entries null;
  // a list itself is never null and keeps its `'{}'` default.
  if (
    !next.nullable &&
    expression !== null &&
    !isMultipleRelation(next) &&
    (field.nullable || field.multiple || select.emptied)
  )
    await tx.query(`UPDATE ${table} SET ${column} = ${expression} WHERE ${column} IS NULL`);
  await tx.query(
    `ALTER TABLE ${table} ALTER COLUMN ${column} ${next.nullable ? 'DROP' : 'SET'} NOT NULL`
  );
  await finishSelectChange(table, renamed.columnName, field.id, next, select, tx);
  const physical = await readPhysicalField(source, renamed.columnName, tx);
  if (!physical) throw new Error('Updated field column is missing');
  const { rows } = await tx.query<RawField>(
    `UPDATE public.table_fields SET name=$2, column_name=$2, description=$3, type=$4, nullable=$5, default_value=$6::jsonb, default_expression=$7,
     reference_table_id=$8, multiple=$9, options=$10::jsonb, reference_kind=$11, recurrence=$12::jsonb, is_range=$13, revision=revision+1, updated_at=now() WHERE id=$1 RETURNING *`,
    [
      fieldId,
      next.name,
      next.description,
      next.type,
      next.nullable,
      JSON.stringify(next.defaultValue),
      physical.default_expression,
      next.referenceTableId,
      next.multiple,
      next.options && JSON.stringify(next.options),
      next.referenceKind ?? null,
      next.recurrence && JSON.stringify(next.recurrence),
      next.range,
    ]
  );
  const updated = rows[0];
  if (!updated) throw new Error('Updated field metadata is missing');
  journal?.ops.push({
    op: 'field.definition',
    tableId,
    fieldId,
    before: storedDefinition(field),
    after: nextStored,
    revision: updated.revision,
    values: valuesBefore && {
      before: valuesBefore,
      after: await readColumnValues(source, renamed.columnName, tx),
    },
    ...(repeats ? { repeats } : {}),
  });
  if (currentBinding !== binding)
    return boundField(await writeBinding(fieldId, binding, false, tx));
  return boundField(updated);
}

class TableFieldsModelClass {
  async listFields(tableId: string, runner: DbQueryable = getDb()): Promise<TableField[]> {
    const { rows } = await runner.query<RawField>(
      "SELECT * FROM public.table_fields WHERE table_id = $1 AND state = 'active' ORDER BY position, id",
      [tableId]
    );
    return rows.map(boundField);
  }

  /** Fields of several tables in one query, each list in display order. */
  async listFieldsByTable(
    tableIds: readonly string[],
    runner: DbQueryable = getDb()
  ): Promise<Map<string, TableField[]>> {
    const byTable = new Map<string, TableField[]>(tableIds.map((id) => [id, []]));
    if (!tableIds.length) return byTable;
    const { rows } = await runner.query<RawField>(
      "SELECT * FROM public.table_fields WHERE table_id = ANY($1::text[]) AND state = 'active' ORDER BY table_id, position, id",
      [[...tableIds]]
    );
    for (const raw of rows) byTable.get(raw.table_id)?.push(boundField(raw));
    return byTable;
  }

  /**
   * Lock custom tables for schema changes made with the `*InTx` methods, once
   * and up front: the table being changed, every relation target it will
   * point at and every current target of a field being changed. Missing ids
   * are a 404, built-in ones a 403.
   */
  async lockTables(tableIds: ReadonlyArray<string | null>, tx: DbQueryable): Promise<LockedTables> {
    return lockTableSet([...tableIds], tx);
  }

  /**
   * Register a new custom table's fields, inside its create transaction: the
   * Name field (`name text NOT NULL DEFAULT ''`, added here, at position 0)
   * and the managed `id` and `created_at` columns at 1 and 2.
   */
  async registerInitialFields(tableId: string, runner: DbQueryable): Promise<void> {
    const row = customTable(await TableCatalog.findById(tableId, runner));
    await runner.query(
      `ALTER TABLE ${physicalTable(row)} ADD COLUMN ${quoteIdentifier(TITLE_COLUMN)} text NOT NULL DEFAULT ''`
    );
    const title = await readPhysicalField(row, TITLE_COLUMN, runner);
    if (!title) throw new Error('Created Name column is missing');
    await runner.query(
      `INSERT INTO public.table_fields (id, table_id, column_name, name, type, nullable, default_value, default_expression, position, is_title)
       VALUES ($1, $2, $3, $3, 'text', false, '""'::jsonb, $4, 0, true)`,
      [`field-title-${tableId}`, tableId, TITLE_COLUMN, title.default_expression]
    );
    for (const [position, columnName, type] of [
      [1, 'id', 'uuid'],
      [2, 'created_at', 'datetime'],
    ] as const) {
      const physical = await readPhysicalField(row, columnName, runner);
      if (!physical || physical.type !== SQL_TYPES[type])
        throw fieldConflict('The custom table is missing a compatible managed column.');
      await runner.query(
        `INSERT INTO public.table_fields (id, table_id, column_name, name, type, nullable, default_expression, position, managed)
         VALUES ($1, $2, $3, $3, $4, $5, $6, $7, true)
         ON CONFLICT (table_id, column_name) DO NOTHING`,
        [
          `field-managed-${tableId}-${columnName}`,
          tableId,
          columnName,
          type,
          physical.nullable,
          physical.default_expression,
          position,
        ]
      );
    }
  }

  /** Create a field; with `history`, a new field is one undoable step. */
  async createField(
    tableId: string,
    input: CreateTableFieldRequest,
    history?: HistoryContext
  ): Promise<{ field: TableField; created: boolean }> {
    if (!CUSTOM_FIELD_ID_PATTERN.test(input.id)) throw badRequest('Invalid field id');
    const definition = decided(input, input.multiple === true, input.range === true);
    try {
      return await transaction(async (tx) => {
        const journal = newJournal();
        const tables = await lockTableSet([tableId, definition.referenceTableId ?? null], tx);
        const result = await createDecidedField(tableId, input, definition, tables, tx, journal);
        if (history && result.created)
          await recordStep(
            tx,
            history.actor,
            journal,
            stepLabels.fieldCreate(lockedTable(tables, tableId).name, result.field.name)
          );
        return result;
      });
    } catch (error) {
      throw mapFieldDatabaseError(error);
    }
  }

  /**
   * {@link createField} inside the caller's transaction, which already holds
   * {@link lockTables} on the table and its relation target. Driver errors
   * are left for the caller ({@link mapFieldDatabaseError}).
   */
  async createFieldInTx(
    tableId: string,
    input: CreateTableFieldRequest,
    tables: LockedTables,
    tx: DbQueryable,
    journal?: HistoryJournal
  ): Promise<{ field: TableField; created: boolean }> {
    if (!CUSTOM_FIELD_ID_PATTERN.test(input.id)) throw badRequest('Invalid field id');
    return createDecidedField(
      tableId,
      input,
      decided(input, input.multiple === true, input.range === true),
      tables,
      tx,
      journal
    );
  }

  /** Edit a field; with `history`, a real change is one undoable step. */
  async updateField(
    tableId: string,
    fieldId: string,
    input: UpdateTableFieldRequest,
    history?: HistoryContext
  ): Promise<TableField> {
    validateDefinition(input);
    if (!Number.isInteger(input.expectedRevision) || input.expectedRevision < 1)
      throw badRequest('Invalid field revision');
    try {
      return await transaction(async (tx) => {
        const before = await findField(fieldId, tx);
        const tables = await lockTableSet(
          [tableId, input.referenceTableId ?? null, before?.reference_table_id ?? null],
          tx
        );
        const journal = newJournal();
        const field = await updateLockedField(
          tableId,
          fieldId,
          input,
          tables,
          tx,
          history ? journal : undefined
        );
        if (history)
          await recordStep(
            tx,
            history.actor,
            journal,
            stepLabels.fieldUpdate(lockedTable(tables, tableId).name, field.name)
          );
        return field;
      });
    } catch (error) {
      throw mapFieldDatabaseError(error);
    }
  }

  /**
   * {@link updateField} inside the caller's transaction, which already holds
   * {@link lockTables} on the table, the new relation target and the field's
   * current one. Driver errors are left for the caller.
   */
  async updateFieldInTx(
    tableId: string,
    fieldId: string,
    input: UpdateTableFieldRequest,
    tables: LockedTables,
    tx: DbQueryable,
    journal?: HistoryJournal
  ): Promise<TableField> {
    validateDefinition(input);
    if (!Number.isInteger(input.expectedRevision) || input.expectedRevision < 1)
      throw badRequest('Invalid field revision');
    return updateLockedField(tableId, fieldId, input, tables, tx, journal);
  }

  /**
   * Set display order from a full permutation of the table's field ids,
   * managed fields included. Order is presentation only, so revisions stay put.
   */
  async reorderFields(
    tableId: string,
    fieldIds: string[],
    history?: HistoryContext
  ): Promise<TableField[]> {
    if (new Set(fieldIds).size !== fieldIds.length)
      throw badRequest('fieldIds must not repeat a field.');
    try {
      return await transaction(async (tx) => {
        await tx.query('SET LOCAL lock_timeout = 5000');
        await tx.query('SET LOCAL statement_timeout = 15000');
        await tx.query('SELECT id FROM public.table_catalog WHERE id = $1 FOR UPDATE', [tableId]);
        const journal = newJournal();
        const fields = await this.reorderFieldsInTx(tableId, fieldIds, tx, journal);
        const table = await TableCatalog.findById(tableId, tx);
        if (history && table)
          await recordStep(tx, history.actor, journal, stepLabels.fieldReorder(table.name));
        return fields;
      });
    } catch (error) {
      throw mapFieldDatabaseError(error);
    }
  }

  /**
   * {@link reorderFields} inside the caller's transaction, which already holds
   * the table's catalog row FOR UPDATE (as {@link lockTables} does).
   */
  async reorderFieldsInTx(
    tableId: string,
    fieldIds: string[],
    tx: DbQueryable,
    journal?: HistoryJournal
  ): Promise<TableField[]> {
    if (new Set(fieldIds).size !== fieldIds.length)
      throw badRequest('fieldIds must not repeat a field.');
    const table = customTable(await TableCatalog.findById(tableId, tx));
    changeableTable(new Map([[tableId, table]]), tableId);
    const before = await lockFieldOrder(tableId, tx);
    const current = new Set(before);
    if (current.size !== fieldIds.length || fieldIds.some((id) => !current.has(id)))
      throw fieldConflict('The table fields changed. Reload the current fields before reordering.');
    await writeFieldOrder(tableId, fieldIds, tx);
    if (before.some((id, index) => id !== fieldIds[index]))
      journal?.ops.push({ op: 'field.order', tableId, before, after: [...fieldIds] });
    return this.listFields(tableId, tx);
  }

  /** Collapse or expand a field's grid column; see {@link setFieldView}. */
  async setFieldCollapsed(
    tableId: string,
    fieldId: string,
    collapsed: boolean
  ): Promise<{ field: TableField; changed: boolean }> {
    if (typeof collapsed !== 'boolean') throw badRequest('collapsed must be a boolean.');
    return this.setFieldView(tableId, fieldId, { collapsed });
  }

  /**
   * Set a field's grid view, managed fields included: whether its column is
   * collapsed, and its width (null = auto). View preferences, not schema: last
   * write wins, the revision stays put, it takes no schema lock and it is not
   * in table history. A key left out keeps its value. `changed` is false when
   * every given value already matched.
   */
  async setFieldView(
    tableId: string,
    fieldId: string,
    view: UpdateTableFieldViewRequest
  ): Promise<{ field: TableField; changed: boolean }> {
    const { collapsed, width } = view;
    if (collapsed !== undefined && typeof collapsed !== 'boolean')
      throw badRequest('collapsed must be a boolean.');
    const widthProblem = width === undefined ? null : tableFieldWidthProblem(width);
    if (widthProblem) throw badRequest(widthProblem);
    if (collapsed === undefined && width === undefined)
      throw badRequest('Give collapsed, width or both.');
    try {
      return await transaction(async (tx) => {
        await tx.query('SET LOCAL lock_timeout = 5000');
        await tx.query('SET LOCAL statement_timeout = 15000');
        customTable(await TableCatalog.findById(tableId, tx));
        const { rows } = await tx.query<RawField>(
          `UPDATE public.table_fields
              SET collapsed = COALESCE($3::boolean, collapsed),
                  width = CASE WHEN $4::boolean THEN $5::integer ELSE width END,
                  updated_at = now()
            WHERE table_id = $1 AND id = $2 AND state = 'active'
              AND (collapsed IS DISTINCT FROM COALESCE($3::boolean, collapsed)
                   OR ($4::boolean AND width IS DISTINCT FROM $5::integer))
            RETURNING *`,
          [tableId, fieldId, collapsed ?? null, width !== undefined, width ?? null]
        );
        const updated = rows[0];
        if (updated) return { field: boundField(updated), changed: true };
        const raw = await findField(fieldId, tx);
        if (!raw || raw.table_id !== tableId || raw.state !== 'active')
          throw new AppError('Field not found', ErrorCode.NOT_FOUND, 404);
        return { field: boundField(raw), changed: false };
      });
    } catch (error) {
      throw mapFieldDatabaseError(error);
    }
  }

  /**
   * Show a date or datetime field on a calendar, or take it off (null),
   * managed fields included: a binding is not schema, so a custom table's
   * `created_at` can show too, and its rows stay read-only there. No DDL and
   * no physical lock; the catalog row FOR UPDATE orders it with schema edits.
   * Like a binding-only field PATCH it is revision-checked, bumps the
   * revision (an open field editor or a stale calendar undo is refused rather
   * than overwritten) and records no table history step: the calendar's undo
   * stack reverses it. `previous` is the binding it replaced; `changed` is
   * false when the field already showed there.
   */
  async setFieldCalendar(
    tableId: string,
    fieldId: string,
    input: SetTableFieldCalendarRequest
  ): Promise<{ field: TableField; previous: string | null; changed: boolean }> {
    const { calendarId, expectedRevision } = input;
    if (calendarId !== null && (typeof calendarId !== 'string' || !calendarId.trim()))
      throw badRequest("calendarId must be a calendar id, 'default', or null.");
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1)
      throw badRequest('Invalid field revision');
    try {
      return await transaction(async (tx) => {
        await tx.query('SET LOCAL lock_timeout = 5000');
        await tx.query('SET LOCAL statement_timeout = 15000');
        await tx.query('SELECT id FROM public.table_catalog WHERE id = $1 FOR UPDATE', [tableId]);
        const table = customTable(await TableCatalog.findById(tableId, tx));
        changeableTable(new Map([[tableId, table]]), tableId);
        const raw = (
          await tx.query<RawField>('SELECT * FROM public.table_fields WHERE id = $1 FOR UPDATE', [
            fieldId,
          ])
        ).rows[0];
        if (!raw || raw.table_id !== tableId || raw.state !== 'active')
          throw new AppError('Field not found', ErrorCode.NOT_FOUND, 404);
        const field = boundField(raw);
        if (field.type !== 'date' && field.type !== 'datetime')
          throw badRequest('Only date and datetime fields can show on a calendar.');
        if (field.revision !== expectedRevision)
          throw fieldConflict(
            'This field changed since the calendar loaded it. Reload and try again.',
            field
          );
        const previous = field.calendarId ?? null;
        const next = calendarId === null ? null : await resolveCalendarId(calendarId, tx);
        if (next === previous) return { field, previous, changed: false };
        return {
          field: boundField(await writeBinding(fieldId, next, true, tx)),
          previous,
          changed: true,
        };
      });
    } catch (error) {
      throw mapFieldDatabaseError(error);
    }
  }

  /**
   * How many entries hold each option of a select field, by option id, so a
   * removal can say what it clears. Holds the catalog row FOR SHARE, which
   * field DDL waits for.
   */
  async selectOptionUsage(tableId: string, fieldId: string): Promise<Record<string, number>> {
    try {
      return await transaction(async (tx) => {
        await tx.query('SET LOCAL lock_timeout = 5000');
        await tx.query('SET LOCAL statement_timeout = 15000');
        await tx.query('SELECT id FROM public.table_catalog WHERE id = $1 FOR SHARE', [tableId]);
        const source = customTable(await TableCatalog.findById(tableId, tx));
        const raw = await findField(fieldId, tx);
        if (!raw || raw.table_id !== tableId || raw.state !== 'active')
          throw new AppError('Field not found', ErrorCode.NOT_FOUND, 404);
        const field = boundField(raw);
        if (field.type !== 'select' || !field.options)
          throw badRequest('Only select fields have options.');
        const usage = await countSelectUsage(
          physicalTable(source),
          field,
          field.options.map((option) => option.label),
          tx
        );
        return Object.fromEntries(
          field.options.map((option) => [option.id, usage.get(option.label) ?? 0])
        );
      });
    } catch (error) {
      throw mapFieldDatabaseError(error);
    }
  }
}

export const TableFields = new TableFieldsModelClass();
