/**
 * Archive, delete, restore and purge for custom fields and tables, plus the
 * exact field-definition restore undo uses. Callers hold the schema locks
 * (catalog rows FOR UPDATE, physical tables ACCESS EXCLUSIVE) and run inside
 * their transaction.
 *
 * Retiring (archive or delete) renames the column or table to a tombstone
 * named after its id, so the display name is free at once and agent SQL no
 * longer finds it by name; its data, constraints and indexes stay. A retired
 * non-list column drops NOT NULL so new entries never need it; restoring puts
 * it back (filling empty values with the default). A deleted item is kept
 * until the history step that holds it is gone; then {@link purgeField} or
 * {@link purgeTable} drops it for good. Every drop for good also removes the
 * history steps that needed the item (`forgetDropped`) and returns the
 * stacks that changed.
 */
import { isDeepStrictEqual } from 'node:util';
import type { DbQueryable } from '@snaglet/db/db';
import { quoteIdentifier } from '@snaglet/db/sql-utils';
import {
  CUSTOM_TABLES_SCHEMA,
  TableCatalog,
  tombstoneName,
  type TableCatalogRow,
} from '@snaglet/db/tables/table_catalog';
import {
  ErrorCode,
  type TableField,
  type TableFieldDefinition,
  type TableHistoryConflictDetails,
  type TableLifecycleState,
} from '@snaglet/shared/types';
import { AppError, tableNameProblem } from '@snaglet/shared/utils';
import { findField, lockFieldOrder, toField, writeFieldOrder } from '../table_fields/fieldRows';
import {
  addRelation,
  assertRelationTarget,
  columnType,
  defaultSql,
  fieldConflict,
  isItemRelation,
  linksIndex,
  physicalTable,
  readPhysicalField,
  relationConstraint,
} from '../table_fields/fieldSchema';
import {
  assertNotStatusField,
  assertRecurrenceTargets,
  assertStatusEdit,
  sameRecurrence,
  storedRecurrence,
} from '../table_fields/recurrence';
import { addSelectCheck, selectCheckName } from '../table_fields/selectOptions';
import { forgetDropped } from './forget';
import type { ColumnValues, HistoryActor, StoredFieldDefinition } from './types';

type NameRequest = NonNullable<TableHistoryConflictDetails['names']>[number];

/** 409 asking for new names; nothing was changed. */
export function nameTaken(names: NameRequest[]): AppError {
  const [first] = names;
  const what = first
    ? `The name "${first.name}" is taken by another ${first.kind === 'table' ? 'table' : 'field'}.`
    : 'A name is taken.';
  const details: TableHistoryConflictDetails = { reason: 'nameTaken', names };
  return new AppError(
    `${what} Choose a new name to restore it.`,
    ErrorCode.CONFLICT,
    409,
    true,
    details
  );
}

function badName(message: string): AppError {
  return new AppError(message, ErrorCode.VALIDATION_ERROR, 400);
}

function isListColumn(field: { type: string; multiple: boolean }): boolean {
  return field.multiple && (field.type === 'relation' || field.type === 'select');
}

async function fieldNameTaken(
  table: TableCatalogRow,
  name: string,
  exceptId: string,
  tx: DbQueryable
): Promise<boolean> {
  const { rows } = await tx.query<{ taken: boolean }>(
    `SELECT EXISTS (SELECT 1 FROM public.table_fields
                     WHERE table_id = $1 AND state = 'active' AND lower(name) = lower($2) AND id <> $3)
         OR EXISTS (SELECT 1 FROM pg_attribute a
                     WHERE a.attrelid = to_regclass($4) AND a.attname = $2 AND a.attnum > 0 AND NOT a.attisdropped)
         AS taken`,
    [table.id, name, exceptId, physicalTable(table)]
  );
  return rows[0]?.taken === true;
}

/** A stored definition as the field-definition helpers take it (unmanaged fields only). */
function asDefinition(
  definition: StoredFieldDefinition
): TableFieldDefinition & { multiple: boolean; range: boolean } {
  return {
    name: definition.name,
    description: definition.description,
    type: definition.type === 'uuid' ? 'text' : definition.type,
    nullable: definition.nullable,
    defaultValue: definition.defaultValue,
    referenceTableId: definition.referenceTableId,
    referenceKind: definition.referenceKind ?? null,
    multiple: definition.multiple,
    range: definition.range === true,
    options: definition.options,
  };
}

/** A name for a restored field: `requested` (validated) or its own, free among active fields. */
async function freeFieldName(
  table: TableCatalogRow,
  field: TableField,
  requested: string | undefined,
  tx: DbQueryable
): Promise<string> {
  const name = requested?.trim() ?? field.name;
  if (requested !== undefined) {
    const problem = tableNameProblem(name, 'field');
    if (problem) throw badName(problem);
  }
  if (await fieldNameTaken(table, name, field.id, tx))
    throw nameTaken([{ kind: 'field', id: field.id, tableId: table.id, name }]);
  return name;
}

/**
 * Archive or delete an active field: its column takes its tombstone name and
 * drops NOT NULL (lists keep theirs), and the remaining active fields close
 * up the gap. `position` keeps the display index it had, for restore.
 * Managed fields are refused (403).
 */
export async function retireField(
  table: TableCatalogRow,
  fieldId: string,
  state: Exclude<TableLifecycleState, 'active'>,
  heldBy: string | null,
  tx: DbQueryable
): Promise<TableField> {
  const raw = await findField(fieldId, tx);
  if (!raw || raw.table_id !== table.id)
    throw new AppError('Field not found', ErrorCode.NOT_FOUND, 404);
  if (raw.managed)
    throw new AppError('Managed fields cannot be archived or deleted', ErrorCode.FORBIDDEN, 403);
  if (raw.state === 'active') await assertNotStatusField(raw, tx);
  if (raw.state !== 'active') {
    const { rows } = await tx.query<Parameters<typeof toField>[0]>(
      `UPDATE public.table_fields SET state = $2, held_by = $3, state_changed_at = now(), updated_at = now()
        WHERE id = $1 RETURNING *`,
      [fieldId, state, state === 'deleted' ? heldBy : null]
    );
    const updated = rows[0];
    if (!updated) throw new Error('Retired field is missing');
    return toField(updated);
  }
  const order = await lockFieldOrder(table.id, tx);
  const index = Math.max(0, order.indexOf(fieldId));
  const tombstone = tombstoneName(fieldId);
  const target = physicalTable(table);
  await tx.query(
    `ALTER TABLE ${target} RENAME COLUMN ${quoteIdentifier(raw.column_name)} TO ${quoteIdentifier(tombstone)}`
  );
  if (!isListColumn(raw) && !raw.nullable)
    await tx.query(
      `ALTER TABLE ${target} ALTER COLUMN ${quoteIdentifier(tombstone)} DROP NOT NULL`
    );
  const { rows } = await tx.query<Parameters<typeof toField>[0]>(
    `UPDATE public.table_fields
        SET state = $2, held_by = $3, state_changed_at = now(), column_name = $4, position = $5, updated_at = now()
      WHERE id = $1 RETURNING *`,
    [fieldId, state, state === 'deleted' ? heldBy : null, tombstone, index]
  );
  const retired = rows[0];
  if (!retired) throw new Error('Retired field is missing');
  await writeFieldOrder(
    table.id,
    order.filter((id) => id !== fieldId),
    tx
  );
  return toField(retired);
}

export interface RestoredField {
  field: TableField;
  /** It was required, had no default, and entries added meanwhile have no value. */
  madeOptional: boolean;
}

/**
 * Bring an archived or deleted field back under its name (or `name`, when
 * the old one is taken: 409 otherwise), at the display index it had. A
 * required field fills empty values with its default; without one it comes
 * back optional when entries added meanwhile have no value. It is the Name
 * field again only while the table has no other. Its relation target must
 * still exist (409).
 */
export async function restoreRetiredField(
  table: TableCatalogRow,
  fieldId: string,
  name: string | undefined,
  tx: DbQueryable
): Promise<RestoredField> {
  const raw = await findField(fieldId, tx);
  if (!raw || raw.table_id !== table.id)
    throw new AppError('Field not found', ErrorCode.NOT_FOUND, 404);
  const retired = toField(raw);
  if (raw.state === 'active') return { field: retired, madeOptional: false };
  await assertRecurrenceTargets(table.id, raw.type, raw.recurrence, 'restore', tx);
  // A relation to Snaglet items has no table to lose; its links are read as they are.
  if (raw.type === 'relation' && raw.reference_kind === null) {
    const target =
      raw.reference_table_id === null
        ? null
        : await TableCatalog.findById(raw.reference_table_id, tx);
    if (!target || target.state === 'deleted')
      throw fieldConflict(
        `The table ${raw.name} links to is deleted, so this field cannot be restored. Restore that table first.`
      );
  }
  const physical = await readPhysicalField(table, raw.column_name, tx);
  if (!physical)
    throw fieldConflict('This field’s kept column is missing, so it cannot be restored.');
  const restoredName = await freeFieldName(table, retired, name, tx);
  const target = physicalTable(table);
  const column = quoteIdentifier(restoredName);
  await tx.query(
    `ALTER TABLE ${target} RENAME COLUMN ${quoteIdentifier(raw.column_name)} TO ${column}`
  );
  let nullable = raw.nullable;
  let madeOptional = false;
  if (!isListColumn(raw) && !raw.nullable) {
    const expression = await defaultSql(asDefinition(storedDefinition(retired)), tx);
    if (expression !== null)
      await tx.query(`UPDATE ONLY ${target} SET ${column} = ${expression} WHERE ${column} IS NULL`);
    const { rows: empty } = await tx.query<{ found: boolean }>(
      `SELECT EXISTS (SELECT 1 FROM ONLY ${target} WHERE ${column} IS NULL) AS found`
    );
    if (empty[0]?.found) {
      nullable = true;
      madeOptional = true;
    } else await tx.query(`ALTER TABLE ${target} ALTER COLUMN ${column} SET NOT NULL`);
  }
  const { rows: titles } = await tx.query<{ id: string }>(
    `SELECT id FROM public.table_fields WHERE table_id = $1 AND state = 'active' AND is_title`,
    [table.id]
  );
  const order = await lockFieldOrder(table.id, tx);
  const { rows } = await tx.query<Parameters<typeof toField>[0]>(
    `UPDATE public.table_fields
        SET state = 'active', held_by = NULL, state_changed_at = NULL, name = $2, column_name = $2,
            nullable = $3, is_title = is_title AND $4, position = position + 200000,
            revision = revision + 1, updated_at = now()
      WHERE id = $1 RETURNING *`,
    [fieldId, restoredName, nullable, titles.length === 0]
  );
  if (!rows[0]) throw new Error('Restored field is missing');
  order.splice(Math.min(raw.position, order.length), 0, fieldId);
  await writeFieldOrder(table.id, order, tx);
  const restored = await findField(fieldId, tx);
  if (!restored) throw new Error('Restored field is missing');
  return { field: toField(restored), madeOptional };
}

/** Drop a deleted field's kept column and metadata for good. */
export async function purgeField(
  table: TableCatalogRow,
  fieldId: string,
  tx: DbQueryable
): Promise<HistoryActor[]> {
  const raw = await findField(fieldId, tx);
  if (!raw || raw.table_id !== table.id || raw.state !== 'deleted') return [];
  await tx.query(
    `ALTER TABLE ${physicalTable(table)} DROP COLUMN IF EXISTS ${quoteIdentifier(raw.column_name)}`
  );
  await tx.query('DELETE FROM public.table_fields WHERE id = $1', [fieldId]);
  return forgetDropped({ fields: [{ tableId: table.id, fieldId }] }, tx);
}

/**
 * Drop a field for good right now, in any state: its column (under whatever
 * name it has), its metadata, and its slot in the display order.
 */
export async function dropFieldNow(
  table: TableCatalogRow,
  fieldId: string,
  tx: DbQueryable
): Promise<HistoryActor[]> {
  const raw = await findField(fieldId, tx);
  if (!raw || raw.table_id !== table.id) return [];
  if (raw.managed) throw new AppError('Managed fields cannot be deleted', ErrorCode.FORBIDDEN, 403);
  const order = raw.state === 'active' ? await lockFieldOrder(table.id, tx) : null;
  await tx.query(
    `ALTER TABLE ${physicalTable(table)} DROP COLUMN IF EXISTS ${quoteIdentifier(raw.column_name)}`
  );
  await tx.query('DELETE FROM public.table_fields WHERE id = $1', [fieldId]);
  if (order)
    await writeFieldOrder(
      table.id,
      order.filter((id) => id !== fieldId),
      tx
    );
  return forgetDropped({ fields: [{ tableId: table.id, fieldId }] }, tx);
}

/**
 * Drop a custom table for good right now, in any state: its physical table
 * (with the foreign keys other tables' relation columns had to it) and its
 * catalog row and fields. The caller has dropped or cleared active relation
 * fields that point at it; retired ones elsewhere lose their target.
 */
export async function dropTableNow(row: TableCatalogRow, tx: DbQueryable): Promise<HistoryActor[]> {
  if (row.origin !== 'custom')
    throw new AppError('Snaglet tables cannot be deleted', ErrorCode.FORBIDDEN, 403);
  await tx.query(`DROP TABLE IF EXISTS ${tableRef(row.tableName)} CASCADE`);
  await tx.query('DELETE FROM public.table_catalog WHERE id = $1', [row.id]);
  return forgetDropped({ tables: [row.id] }, tx);
}

function tableRef(schemaTableName: string): string {
  return `${quoteIdentifier(CUSTOM_TABLES_SCHEMA)}.${quoteIdentifier(schemaTableName)}`;
}

/**
 * Archive or delete a custom table: its physical table takes its tombstone
 * name (freeing the name) and the catalog row keeps the display name.
 * Moving between archived and deleted only changes the state.
 */
export async function retireTable(
  row: TableCatalogRow,
  state: Exclude<TableLifecycleState, 'active'>,
  heldBy: string | null,
  tx: DbQueryable
): Promise<TableCatalogRow> {
  if (row.origin !== 'custom')
    throw new AppError('Snaglet tables cannot be archived or deleted', ErrorCode.FORBIDDEN, 403);
  const tombstone = tombstoneName(row.id);
  if (row.state === 'active')
    await tx.query(
      `ALTER TABLE ${tableRef(row.tableName)} RENAME TO ${quoteIdentifier(tombstone)}`
    );
  await tx.query(
    `UPDATE public.table_catalog
        SET state = $2, held_by = $3, state_changed_at = now(), table_name = $4
      WHERE id = $1`,
    [
      row.id,
      state,
      state === 'deleted' ? heldBy : null,
      row.state === 'active' ? tombstone : row.tableName,
    ]
  );
  const updated = await TableCatalog.findById(row.id, tx);
  if (!updated) throw new Error('Retired table is missing');
  return updated;
}

/**
 * Bring an archived or deleted table back under its name, or `name` when
 * that is taken now (409 otherwise). Its id, fields, entries and relations
 * are unchanged.
 */
export async function restoreRetiredTable(
  row: TableCatalogRow,
  name: string | undefined,
  tx: DbQueryable
): Promise<TableCatalogRow> {
  if (row.state === 'active') return row;
  const next = name?.trim() ?? row.name;
  if (name !== undefined) {
    const problem = tableNameProblem(next, 'table');
    if (problem) throw badName(problem);
  }
  const { rows: taken } = await tx.query<{ taken: boolean }>(
    `SELECT EXISTS (SELECT 1 FROM public.table_catalog
                     WHERE state = 'active' AND lower(name) = lower($1) AND id <> $2)
         OR to_regclass(format('%I.%I', $3::text, $1::text)) IS NOT NULL AS taken`,
    [next, row.id, CUSTOM_TABLES_SCHEMA]
  );
  if (taken[0]?.taken)
    throw nameTaken([{ kind: 'table', id: row.id, tableId: row.id, name: next }]);
  await tx.query(`ALTER TABLE ${tableRef(row.tableName)} RENAME TO ${quoteIdentifier(next)}`);
  await tx.query(
    `UPDATE public.table_catalog
        SET state = 'active', held_by = NULL, state_changed_at = NULL, name = $2, table_name = $2
      WHERE id = $1`,
    [row.id, next]
  );
  const restored = await TableCatalog.findById(row.id, tx);
  if (!restored) throw new Error('Restored table is missing');
  return restored;
}

/**
 * Drop a deleted table for good: its physical table (and the foreign keys
 * other tables' retired relation columns still had to it) and its catalog
 * row with its fields. Retired relation fields elsewhere lose their target.
 */
export async function purgeTable(row: TableCatalogRow, tx: DbQueryable): Promise<HistoryActor[]> {
  if (row.state !== 'deleted' || row.origin !== 'custom') return [];
  await tx.query(`DROP TABLE IF EXISTS ${tableRef(row.tableName)} CASCADE`);
  await tx.query("DELETE FROM public.table_catalog WHERE id = $1 AND state = 'deleted'", [row.id]);
  return forgetDropped({ tables: [row.id] }, tx);
}

/**
 * Relation fields of other tables (active or archived fields, in tables of
 * any state) that point at `tableId`: deleting the table must take them too.
 */
export async function linkedFields(
  tableId: string,
  tx: DbQueryable
): Promise<
  Array<{
    tableId: string;
    tableName: string;
    fieldId: string;
    fieldName: string;
    state: 'active' | 'archived';
  }>
> {
  const { rows } = await tx.query<{
    table_id: string;
    table_name: string;
    field_id: string;
    field_name: string;
    state: 'active' | 'archived';
  }>(
    `SELECT field.table_id, catalog.name AS table_name, field.id AS field_id, field.name AS field_name, field.state
       FROM public.table_fields AS field
       JOIN public.table_catalog AS catalog ON catalog.id = field.table_id
      WHERE field.type = 'relation' AND field.reference_table_id = $1 AND field.table_id <> $1
        AND field.state IN ('active', 'archived')
      ORDER BY catalog.name, field.name, field.id`,
    [tableId]
  );
  return rows.map((row) => ({
    tableId: row.table_id,
    tableName: row.table_name,
    fieldId: row.field_id,
    fieldName: row.field_name,
    state: row.state,
  }));
}

/** The table's active Name field id, or null. */
export async function currentTitleField(tableId: string, tx: DbQueryable): Promise<string | null> {
  const { rows } = await tx.query<{ id: string }>(
    `SELECT id FROM public.table_fields WHERE table_id = $1 AND state = 'active' AND is_title`,
    [tableId]
  );
  return rows[0]?.id ?? null;
}

/**
 * Make `fieldId` (an active, unmanaged text field) the Name field, or clear it
 * with null. Changes no stored value, revision or schemaVersion.
 */
export async function setTitleField(
  tableId: string,
  fieldId: string | null,
  tx: DbQueryable
): Promise<void> {
  if (fieldId !== null) {
    const raw = await findField(fieldId, tx);
    if (!raw || raw.table_id !== tableId || raw.state !== 'active')
      throw new AppError('Field not found', ErrorCode.NOT_FOUND, 404);
    if (raw.managed || raw.type !== 'text')
      throw badName('Only a text field can be the Name field.');
  }
  await tx.query(
    `UPDATE public.table_fields SET is_title = false, updated_at = now()
      WHERE table_id = $1 AND is_title AND state = 'active' AND id IS DISTINCT FROM $2`,
    [tableId, fieldId]
  );
  if (fieldId !== null)
    await tx.query(
      'UPDATE public.table_fields SET is_title = true, updated_at = now() WHERE id = $1',
      [fieldId]
    );
}

export function storedDefinition(field: TableField): StoredFieldDefinition {
  return {
    name: field.name,
    description: field.description,
    type: field.type,
    nullable: field.nullable,
    defaultValue: field.defaultValue,
    referenceTableId: field.referenceTableId,
    referenceKind: field.referenceKind ?? null,
    multiple: field.multiple,
    range: field.range,
    options: field.options,
    recurrence: field.recurrence ?? null,
  };
}

/** Every key of a stored definition, absent ones (older steps) as their stored value. */
function comparable(definition: StoredFieldDefinition): Required<StoredFieldDefinition> {
  return {
    name: definition.name,
    description: definition.description ?? null,
    type: definition.type,
    nullable: definition.nullable,
    defaultValue: definition.defaultValue ?? null,
    referenceTableId: definition.referenceTableId ?? null,
    referenceKind: definition.referenceKind ?? null,
    multiple: definition.multiple,
    range: definition.range === true,
    options: definition.options ?? null,
    recurrence: storedRecurrence(definition.recurrence),
  };
}

/**
 * Whether two stored definitions are the same field. Options, defaults and
 * the repeat setting compare by value, since jsonb reorders object keys.
 */
export function sameStoredDefinition(a: StoredFieldDefinition, b: StoredFieldDefinition): boolean {
  return isDeepStrictEqual(comparable(a), comparable(b));
}

/** Whether an edit from `from` to `to` can change stored values (so the column is recorded). */
export function definitionTouchesValues(
  from: StoredFieldDefinition,
  to: StoredFieldDefinition
): boolean {
  return (
    from.type !== to.type ||
    from.multiple !== to.multiple ||
    (from.range === true) !== (to.range === true) ||
    from.referenceTableId !== to.referenceTableId ||
    (from.referenceKind ?? null) !== (to.referenceKind ?? null) ||
    JSON.stringify(from.options) !== JSON.stringify(to.options) ||
    (from.nullable && !to.nullable)
  );
}

/** A column's values by entry id (text casts, canonical session settings). */
export async function readColumnValues(
  table: TableCatalogRow,
  columnName: string,
  tx: DbQueryable
): Promise<ColumnValues> {
  await tx.query("SET LOCAL DateStyle = 'ISO, YMD'");
  await tx.query("SET LOCAL TIME ZONE 'UTC'");
  const { rows } = await tx.query<{ id: string; value: string | null }>(
    `SELECT id::text AS id, ${quoteIdentifier(columnName)}::text AS value
       FROM ONLY ${physicalTable(table)} ORDER BY id`
  );
  return rows.map((row) => [row.id, row.value]);
}

/** Whether the column holds exactly `values`: the same entries, each with the same value. */
export async function columnMatches(
  table: TableCatalogRow,
  columnName: string,
  sqlType: string,
  values: ColumnValues,
  tx: DbQueryable
): Promise<boolean> {
  await tx.query("SET LOCAL DateStyle = 'ISO, YMD'");
  await tx.query("SET LOCAL TIME ZONE 'UTC'");
  const column = quoteIdentifier(columnName);
  const { rows } = await tx.query<{ differs: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM ONLY ${physicalTable(table)} AS entry
       FULL JOIN unnest($1::uuid[], $2::text[]) AS kept(id, value) ON kept.id = entry.id
        WHERE entry.id IS NULL OR kept.id IS NULL
           OR entry.${column} IS DISTINCT FROM kept.value::${sqlType}) AS differs`,
    [values.map(([id]) => id), values.map(([, value]) => value)]
  );
  return rows[0]?.differs === false;
}

/**
 * Put an active field back to exactly `target`, with `values` (every entry's
 * value) when the step recorded them: the column is renamed, retyped,
 * refilled, given its default, nullability, key, index and CHECK, and the
 * metadata follows with a new revision. The target's relation table must
 * still exist, and its name must be free (409).
 */
export async function restoreFieldDefinition(
  table: TableCatalogRow,
  fieldId: string,
  target: StoredFieldDefinition,
  values: ColumnValues | null,
  tx: DbQueryable
): Promise<TableField> {
  const raw = await findField(fieldId, tx);
  if (!raw || raw.table_id !== table.id || raw.state !== 'active')
    throw new AppError('Field not found', ErrorCode.NOT_FOUND, 404);
  const field = toField(raw);
  const recurrence = storedRecurrence(target.recurrence);
  if (!sameRecurrence(field.recurrence, recurrence))
    await assertRecurrenceTargets(table.id, target.type, recurrence, 'restore', tx);
  await assertStatusEdit(field, target, tx);
  const source = physicalTable(table);
  let columnName = field.columnName;
  if (target.name !== field.name) {
    if (await fieldNameTaken(table, target.name, field.id, tx))
      throw nameTaken([{ kind: 'field', id: field.id, tableId: table.id, name: target.name }]);
    await tx.query(
      `ALTER TABLE ${source} RENAME COLUMN ${quoteIdentifier(columnName)} TO ${quoteIdentifier(target.name)}`
    );
    columnName = target.name;
  }
  const column = quoteIdentifier(columnName);
  const reshaped =
    values !== null ||
    field.type !== target.type ||
    field.multiple !== target.multiple ||
    field.range !== (target.range === true) ||
    field.referenceTableId !== target.referenceTableId ||
    (field.referenceKind ?? null) !== (target.referenceKind ?? null) ||
    JSON.stringify(field.options) !== JSON.stringify(target.options);
  let relationTarget: TableCatalogRow | null = null;
  if (target.referenceTableId) {
    relationTarget = await TableCatalog.findById(target.referenceTableId, tx);
    if (!relationTarget) throw fieldConflict('The table this field linked to no longer exists.');
  }
  if (reshaped) {
    await tx.query(
      `ALTER TABLE ${source} DROP CONSTRAINT IF EXISTS ${quoteIdentifier(relationConstraint(field.id))}`
    );
    await tx.query(
      `ALTER TABLE ${source} DROP CONSTRAINT IF EXISTS ${quoteIdentifier(selectCheckName(field.id))}`
    );
    await tx.query(
      `DROP INDEX IF EXISTS ${quoteIdentifier(CUSTOM_TABLES_SCHEMA)}.${quoteIdentifier(linksIndex(field.id))}`
    );
  }
  await tx.query(`ALTER TABLE ${source} ALTER COLUMN ${column} DROP DEFAULT`);
  await tx.query(`ALTER TABLE ${source} ALTER COLUMN ${column} DROP NOT NULL`);
  const nextType = columnType(target);
  if (columnType(field) !== nextType) {
    if (values === null) throw new Error('A type change must restore the recorded values');
    await tx.query(
      `ALTER TABLE ${source} ALTER COLUMN ${column} TYPE ${nextType} USING NULL::${nextType}`
    );
  }
  if (values !== null) {
    await tx.query("SET LOCAL DateStyle = 'ISO, YMD'");
    await tx.query("SET LOCAL TIME ZONE 'UTC'");
    await tx.query(
      `UPDATE ONLY ${source} AS entry SET ${column} = kept.value::${nextType}
         FROM unnest($1::uuid[], $2::text[]) AS kept(id, value)
        WHERE entry.id = kept.id`,
      [values.map(([id]) => id), values.map(([, value]) => value)]
    );
  }
  const expression = await defaultSql(asDefinition(target), tx);
  if (expression !== null)
    await tx.query(`ALTER TABLE ${source} ALTER COLUMN ${column} SET DEFAULT ${expression}`);
  if (!target.nullable) await tx.query(`ALTER TABLE ${source} ALTER COLUMN ${column} SET NOT NULL`);
  if (reshaped) {
    if (relationTarget && target.multiple) {
      await assertRelationTarget(relationTarget, tx);
      await tx.query(
        `CREATE INDEX IF NOT EXISTS ${quoteIdentifier(linksIndex(field.id))} ON ${source} USING gin (${column})`
      );
    } else if (relationTarget) await addRelation(table, columnName, field.id, relationTarget, tx);
    else if (isItemRelation(target) && target.multiple)
      await tx.query(
        `CREATE INDEX IF NOT EXISTS ${quoteIdentifier(linksIndex(field.id))} ON ${source} USING gin (${column})`
      );
    if (target.type === 'select') await addSelectCheck(source, columnName, field.id, target, tx);
  }
  const physical = await readPhysicalField(table, columnName, tx);
  if (!physical) throw new Error('Restored field column is missing');
  const { rows } = await tx.query<Parameters<typeof toField>[0]>(
    `UPDATE public.table_fields SET name = $2, column_name = $2, description = $3, type = $4, nullable = $5,
            default_value = $6::jsonb, default_expression = $7, reference_table_id = $8, multiple = $9,
            options = $10::jsonb, reference_kind = $11, recurrence = $12::jsonb, is_range = $13,
            revision = revision + 1, updated_at = now()
      WHERE id = $1 RETURNING *`,
    [
      field.id,
      target.name,
      target.description,
      target.type,
      target.nullable,
      JSON.stringify(target.defaultValue),
      physical.default_expression,
      target.referenceTableId,
      target.multiple,
      target.options && JSON.stringify(target.options),
      target.referenceKind ?? null,
      recurrence && JSON.stringify(recurrence),
      target.range === true,
    ]
  );
  const updated = rows[0];
  if (!updated) throw new Error('Restored field metadata is missing');
  return toField(updated);
}
