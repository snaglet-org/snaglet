/**
 * Bind / unbind a date field from the calendar side.
 * Uses the field's own binding write (`PUT …/fields/:fieldId/calendar`),
 * which takes any date / datetime field, managed `created_at` included, and
 * re-reads the field first for its current revision.
 *
 * Undo is the reverse binding write carrying the revision our write
 * returned, recorded on the calendar undo stack. Table history does not
 * record bindings, so it never goes through `tableHistory`. A field edited
 * since (revision moved on) is refused by the server instead of being
 * overwritten.
 */
import type { TableField } from '@snaglet/shared/types';
import { tablesApi } from '@desktop/utils/api';
import { emitTableEvent } from '@desktop/features/database/tableEvents';
import type { UndoableStep } from './calendarUndo';

/** The calendar a field shows on (null = none). A range field holds its own end. */
export interface Binding {
  calendarId: string | 'default' | null;
}

export function bindingOf(field: TableField): Binding {
  return { calendarId: field.calendarId ?? null };
}

async function writeBinding(
  tableId: string,
  field: TableField,
  binding: Binding
): Promise<TableField> {
  const result = await tablesApi.setFieldCalendar(tableId, field.id, {
    calendarId: binding.calendarId,
    expectedRevision: field.revision,
  });
  emitTableEvent({ type: 'table.fields.changed', tableId });
  return result.field;
}

async function readField(tableId: string, fieldId: string): Promise<TableField> {
  const { fields } = await tablesApi.fields(tableId);
  const field = fields.find((f) => f.id === fieldId);
  if (!field) throw new Error('That field is gone. Reload and try again.');
  if (field.type !== 'date' && field.type !== 'datetime') {
    throw new Error('Only date and date & time fields can show on a calendar.');
  }
  return field;
}

/**
 * Set a field's binding (`calendarId` null = unbind). Returns the updated
 * field and an undo step (reverse write with revision, plus redo) for the calendar stack.
 */
export async function setFieldBinding(
  tableId: string,
  fieldId: string,
  calendarId: string | 'default' | null,
  label: string
): Promise<{ field: TableField; step: UndoableStep }> {
  const before = await readField(tableId, fieldId);
  const previous = bindingOf(before);
  const current = await writeBinding(tableId, before, { calendarId });
  return { field: current, step: bindingUndoStep(tableId, current, previous, label) };
}

/**
 * The undo step for a binding change already saved elsewhere (the field
 * editor's own PATCH): `saved` is the field the write returned (its revision
 * guards the reverse write), `previous` the binding before it.
 */
export function bindingUndoStep(
  tableId: string,
  saved: TableField,
  previous: Binding,
  label: string
): UndoableStep {
  let current = saved;
  const applied = bindingOf(saved); // 'default' resolved to the real id
  return {
    label,
    undo: async () => {
      current = await writeBinding(tableId, current, previous);
    },
    redo: async () => {
      current = await writeBinding(tableId, current, applied);
    },
  };
}

export function bindFieldToCalendar(
  tableId: string,
  fieldId: string,
  calendarId: string | 'default',
  label = 'Show field on calendar'
): Promise<{ field: TableField; step: UndoableStep }> {
  return setFieldBinding(tableId, fieldId, calendarId, label);
}
