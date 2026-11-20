import { createHash } from 'node:crypto';
import type { DbQueryable } from '@snaglet/db/db';
import {
  ENTRY_POSITION_COLUMN,
  TableCatalog,
  toTableCatalogEntry,
  type TableCatalogRow,
} from '@snaglet/db/tables/table_catalog';
import { TableFields } from '@snaglet/db/tables/table_fields';
import { ErrorCode, type TableField } from '@snaglet/shared/types';
import { AppError, getErrorMessage } from '@snaglet/shared/utils';
import { assertFieldSchema, physicalTable } from '../table_fields/fieldSchema';

export interface EntrySchema {
  table: TableCatalogRow;
  fields: TableField[];
  schemaVersion: string;
}

export function entryBadRequest(message: string): AppError {
  return new AppError(message, ErrorCode.VALIDATION_ERROR, 400);
}

export function entryConflict(message: string, details?: Record<string, unknown>): AppError {
  return new AppError(message, ErrorCode.CONFLICT, 409, true, details);
}

export function hashEntryVersion(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

/** Catalog ownership freezes editor DDL; the physical lock also excludes raw ALTER. */
export async function lockEntrySchema(
  tableId: string,
  tx: DbQueryable,
  writing = false
): Promise<EntrySchema> {
  await tx.query('SET LOCAL lock_timeout = 5000');
  await tx.query('SET LOCAL statement_timeout = 15000');
  await tx.query("SET LOCAL DateStyle = 'ISO, YMD'");
  await tx.query("SET LOCAL TIME ZONE 'UTC'");
  await tx.query('SELECT id FROM public.table_catalog WHERE id=$1 FOR SHARE', [tableId]);
  const table = await TableCatalog.findById(tableId, tx);
  if (!table || table.state === 'deleted')
    throw new AppError('Table not found', ErrorCode.NOT_FOUND, 404);
  if (table.origin !== 'custom')
    throw new AppError(
      'Snaglet table entries are not available through this editor',
      ErrorCode.FORBIDDEN,
      403
    );
  if (table.state === 'archived')
    throw entryConflict(`${table.name} is archived. Restore it to see or edit its entries.`, {
      table: toTableCatalogEntry(table),
    });
  // Take the eventual DML lock before introspection so CREATE TRIGGER cannot
  // change write behavior between validation and the statement's lock upgrade.
  await tx.query(
    `LOCK TABLE ONLY ${physicalTable(table)} IN ${writing ? 'ROW EXCLUSIVE' : 'ROW SHARE'} MODE`
  );
  const { rows: metadata } = await tx.query<{
    id: string;
    default_expression: string | null;
    state: string;
    column_name: string;
  }>(
    'SELECT id, default_expression, state, column_name FROM public.table_fields WHERE table_id=$1 ORDER BY position, id FOR SHARE',
    [tableId]
  );
  // Archived and deleted fields keep their data in tombstone columns until
  // restored or purged; they are no part of the entry schema.
  const active = metadata
    .filter((field) => field.state === 'active')
    .map(({ id, default_expression }) => ({ id, default_expression }));
  const retiredColumns = new Set(
    metadata.filter((field) => field.state !== 'active').map((field) => field.column_name)
  );
  const fields = await TableFields.listFields(tableId, tx);
  const defaults = new Map(active.map((field) => [field.id, field.default_expression]));
  const physical = await TableCatalog.physicalColumns(table, tx);
  // Every custom table carries the system row-order column besides its fields.
  const position = physical.find((column) => column.name === ENTRY_POSITION_COLUMN);
  const columns = physical.filter(
    (column) => column.name !== ENTRY_POSITION_COLUMN && !retiredColumns.has(column.name)
  );
  const managed = fields.filter((field) => field.managed);
  const drift = () =>
    entryConflict(
      'The physical table no longer matches its registered fields. Restore its schema before editing entries.'
    );
  if (
    managed.length !== 2 ||
    !managed.some(
      (field) => field.columnName === 'id' && field.type === 'uuid' && !field.nullable
    ) ||
    !managed.some(
      (field) => field.columnName === 'created_at' && field.type === 'datetime' && !field.nullable
    ) ||
    !position ||
    position.dataType !== 'double precision' ||
    position.nullable ||
    columns.length !== fields.length ||
    columns.some((column) => !fields.some((field) => field.columnName === column.name)) ||
    physical.filter((column) => retiredColumns.has(column.name)).length !== retiredColumns.size
  )
    throw drift();
  for (const field of fields) {
    const target = field.referenceTableId
      ? await TableCatalog.findById(field.referenceTableId, tx)
      : undefined;
    if (target && target.origin !== 'custom') throw drift();
    await assertFieldSchema(table, field, defaults.get(field.id) ?? null, target ?? undefined, tx);
  }
  const { rows } = await tx.query<{ safe: boolean }>(
    `SELECT NOT c.relrowsecurity AND NOT c.relforcerowsecurity
       AND EXISTS (SELECT 1 FROM pg_constraint p JOIN pg_attribute a ON a.attrelid=p.conrelid AND a.attnum=p.conkey[1]
                    WHERE p.conrelid=c.oid AND p.contype='p' AND cardinality(p.conkey)=1 AND a.attname='id')
       AND NOT EXISTS (SELECT 1 FROM pg_trigger t WHERE t.tgrelid=c.oid AND NOT t.tgisinternal)
       AS safe FROM pg_class c WHERE c.oid=$1::regclass AND c.relkind='r'`,
    [physicalTable(table)]
  );
  if (!rows[0]?.safe) throw drift();
  // Column order, collapsed columns and column widths are presentation: leave
  // `position`, `collapsed` and `width` out so reordering, collapsing or
  // resizing never invalidates an open entry edit. `isTitle` changes no
  // stored value either. `multiple`, `range`, a select's `options` and a
  // relation's `referenceKind` are schema (a value is a list, a start and an
  // end, must be an option, or names a Snaglet item), but they appear only when
  // set, so a field without them keeps a stable hash.
  const byId = (a: { id: string }, b: { id: string }) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  const shape = fields
    .map(
      ({
        collapsed: _collapsed,
        width: _width,
        isTitle: _isTitle,
        multiple,
        range,
        options,
        referenceKind,
        ...field
      }) => ({
        ...field,
        position: 0,
        ...(multiple ? { multiple } : {}),
        ...(range ? { range } : {}),
        ...(options ? { options } : {}),
        ...(referenceKind ? { referenceKind } : {}),
      })
    )
    .sort(byId);
  return {
    table,
    fields,
    schemaVersion: hashEntryVersion([table.id, table.tableName, shape, [...active].sort(byId)]),
  };
}

export function assertEntrySchemaVersion(schema: EntrySchema, version: string): void {
  if (typeof version !== 'string' || !/^[a-f0-9]{64}$/.test(version))
    throw entryBadRequest('schemaVersion must be the version returned by the server.');
  if (version !== schema.schemaVersion)
    throw entryConflict('The table fields changed. Reload the current fields before saving.', {
      schemaVersion: schema.schemaVersion,
    });
}

export function mapEntryDatabaseError(error: unknown): Error {
  if (error instanceof AppError) return error;
  const message = getErrorMessage(error);
  const code =
    typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined;
  switch (code) {
    case '23503':
      return entryBadRequest('The related entry does not exist in the selected table.');
    case '23502':
      return entryBadRequest('A required field is empty. Supply a value before saving.');
    case '22P02':
    case '22003':
    case '22007':
    case '22008':
    case '22001':
      return entryBadRequest('A value cannot be stored in its field type. No changes were saved.');
    case '23505':
      return entryConflict('An entry with these unique values already exists.');
    case '55P03':
    case '57014':
    case '40P01':
      return entryConflict('The table is busy. No changes were saved; try again.');
    case '0A000':
    case '42809':
    case '42P01':
    case '42703':
    case '42804':
    case '23514':
      return entryConflict(
        'The physical table has incompatible schema changes or constraints. No changes were saved.'
      );
    default:
      return new Error(message, { cause: error });
  }
}
