import type { DbQueryable } from '@snaglet/db/db';
import type {
  TableField,
  TableFieldDefault,
  TableFieldRecurrence,
  TableFieldType,
  TableLifecycleState,
  TableReferenceKind,
  TableSelectOption,
} from '@snaglet/shared/types';

export interface RawField {
  id: string;
  table_id: string;
  column_name: string;
  name: string;
  description: string | null;
  type: TableFieldType;
  nullable: boolean;
  default_value: TableFieldDefault;
  default_expression: string | null;
  reference_table_id: string | null;
  reference_kind: TableReferenceKind | null;
  position: number;
  managed: boolean;
  revision: number;
  collapsed: boolean;
  /** Grid column width in px; null = auto. */
  width: number | null;
  is_title: boolean;
  multiple: boolean;
  is_range: boolean;
  options: TableSelectOption[] | null;
  recurrence: TableFieldRecurrence | null;
  state: TableLifecycleState;
  state_changed_at: string | null;
  held_by: string | null;
  /** The calendar a date or datetime field shows on; see `boundField`. */
  calendar_id?: string | null;
}

/**
 * A repeat setting in stored form: keys in a fixed order, so equal settings
 * serialize equally. Only the keys the setting has are kept: a stored
 * `weekStart` is dropped on read and on write (repeats start weeks on Monday).
 */
export function storedRecurrence(
  value: TableFieldRecurrence | null | undefined
): TableFieldRecurrence | null {
  return value
    ? {
        statusFieldId: value.statusFieldId,
        doneOptionIds: [...value.doneOptionIds],
        resetOptionId: value.resetOptionId,
      }
    : null;
}

/** A field row as the API returns it; lifecycle keys appear only on a retired field. */
export function toField(raw: RawField): TableField {
  const field: TableField = {
    id: raw.id,
    tableId: raw.table_id,
    columnName: raw.column_name,
    name: raw.name,
    description: raw.description,
    type: raw.type,
    nullable: raw.nullable,
    defaultValue: raw.default_value,
    referenceTableId: raw.reference_table_id,
    referenceKind: raw.reference_kind ?? null,
    position: raw.position,
    managed: raw.managed,
    revision: raw.revision,
    collapsed: raw.collapsed,
    isTitle: raw.is_title,
    multiple: raw.multiple,
    range: raw.is_range,
    options: raw.options,
    // Only a repeating field carries the key, so every other payload (and
    // its schemaVersion hash) is unaffected by repeats.
    ...(raw.recurrence ? { recurrence: storedRecurrence(raw.recurrence)! } : {}),
    // Likewise a set column width (a view preference); absent means auto.
    ...(typeof raw.width === 'number' ? { width: raw.width } : {}),
  };
  if (raw.state === 'active') return field;
  // A retired field's column is its tombstone; its name is the one it had.
  return {
    ...field,
    state: raw.state,
    ...(raw.state_changed_at ? { archivedAt: raw.state_changed_at } : {}),
  };
}

/** One field row in any lifecycle state, or null. */
export async function findField(id: string, tx: DbQueryable): Promise<RawField | null> {
  return (
    (await tx.query<RawField>('SELECT * FROM public.table_fields WHERE id = $1', [id])).rows[0] ??
    null
  );
}

/** The table's active field ids in display order, row-locked for a renumber. */
export async function lockFieldOrder(tableId: string, tx: DbQueryable): Promise<string[]> {
  const { rows } = await tx.query<{ id: string }>(
    `SELECT id FROM public.table_fields WHERE table_id = $1 AND state = 'active'
      ORDER BY position, id FOR UPDATE`,
    [tableId]
  );
  return rows.map((row) => row.id);
}

/** Renumber active positions 0…n-1 from `fieldIds`, every active field of the table once. */
export async function writeFieldOrder(
  tableId: string,
  fieldIds: string[],
  tx: DbQueryable
): Promise<void> {
  // (table_id, position) is unique among active fields and not deferrable: move clear first.
  await tx.query(
    `UPDATE public.table_fields SET position = position + 100000
      WHERE table_id = $1 AND state = 'active'`,
    [tableId]
  );
  await tx.query(
    `UPDATE public.table_fields AS field SET position = ordered.ordinality - 1, updated_at = now()
       FROM unnest($2::text[]) WITH ORDINALITY AS ordered(id, ordinality)
      WHERE field.table_id = $1 AND field.id = ordered.id AND field.state = 'active'`,
    [tableId, fieldIds]
  );
}
