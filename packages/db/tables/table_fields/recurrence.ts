/**
 * Repeating date fields: a date or datetime field's `recurrence`
 * setting names a single select of the same table (its status) by id and
 * some of that select's options by id. This module keeps those references
 * true. Callers hold the table's schema lock and run in its transaction.
 *
 * - Setting it: the status field must be an active single select of the
 *   same table, and every named option one of its options.
 * - The status field cannot be retyped, made a list, lose a named option or
 *   be archived or deleted while a repeating field (active or archived)
 *   names it: turn that field's repeat off first (409). Renaming the field
 *   or its options is fine; the setting holds ids.
 * - Turning a field's repeat off removes its rows' repeats
 *   (`table_entry_repeats`); the history step keeps them so undo puts them
 *   back.
 */
import type { DbQueryable } from '@snaglet/db/db';
import { ErrorCode, type TableFieldRecurrence, type TableFieldType } from '@snaglet/shared/types';
import { AppError } from '@snaglet/shared/utils';
import { findField, storedRecurrence } from './fieldRows';
import { fieldConflict } from './fieldSchema';
import type { EntryRepeats } from '../table_history/types';

function badRequest(message: string): AppError {
  return new AppError(message, ErrorCode.VALIDATION_ERROR, 400);
}

/**
 * The setting every date and datetime field starts with: rows can repeat,
 * done by the Done button. A field is repeat-capable by default; each row
 * decides whether it repeats.
 */
export function defaultRecurrence(): TableFieldRecurrence {
  return { statusFieldId: null, doneOptionIds: [], resetOptionId: null };
}

/** Whether two settings are the same (null = off). */
export function sameRecurrence(
  a: TableFieldRecurrence | null | undefined,
  b: TableFieldRecurrence | null | undefined
): boolean {
  if (!a || !b) return !a && !b;
  return (
    a.statusFieldId === b.statusFieldId &&
    a.resetOptionId === b.resetOptionId &&
    a.doneOptionIds.length === b.doneOptionIds.length &&
    a.doneOptionIds.every((id, index) => b.doneOptionIds[index] === id)
  );
}

export { storedRecurrence };

/**
 * Check a setting's references under the table lock. `kind` picks the error:
 * a request is a 400, putting a stored setting back (restore, undo) a 409.
 */
export async function assertRecurrenceTargets(
  tableId: string,
  type: TableFieldType,
  recurrence: TableFieldRecurrence | null | undefined,
  kind: 'request' | 'restore',
  tx: DbQueryable
): Promise<void> {
  if (!recurrence) return;
  const fail = (message: string) =>
    kind === 'request' ? badRequest(message) : fieldConflict(message);
  if (type !== 'date' && type !== 'datetime')
    throw fail('Only date and datetime fields can repeat.');
  // No status field: rows are completed with Done / Skip only.
  if (recurrence.statusFieldId === null) return;
  const status = await findField(recurrence.statusFieldId, tx);
  if (!status || status.table_id !== tableId || status.state !== 'active')
    throw fail('The status field this repeat uses is not a field of this table.');
  if (status.type !== 'select' || status.multiple)
    throw fail(`The status field ${status.name} must be a single select.`);
  const ids = new Set((status.options ?? []).map((option) => option.id));
  const named = [
    ...recurrence.doneOptionIds,
    ...(recurrence.resetOptionId ? [recurrence.resetOptionId] : []),
  ];
  if (!named.every((id) => ids.has(id)))
    throw fail(`Choose the done and reset statuses from the options of ${status.name}.`);
}

interface Dependent {
  id: string;
  name: string;
  recurrence: TableFieldRecurrence;
}

/** Repeating fields (active or archived) whose setting names `statusFieldId`. */
async function dependents(statusFieldId: string, tx: DbQueryable): Promise<Dependent[]> {
  const { rows } = await tx.query<Dependent>(
    `SELECT id, name, recurrence FROM public.table_fields
      WHERE recurrence->>'statusFieldId' = $1 AND state <> 'deleted'
      ORDER BY position, id`,
    [statusFieldId]
  );
  return rows;
}

function blocked(status: string, dependent: Dependent, what: string): AppError {
  return fieldConflict(
    `${status} is the status of the repeating field ${dependent.name}, so it cannot ${what}. Turn off that field's repeat first.`
  );
}

/**
 * Refuse an edit of a status field that would break a repeat naming it:
 * another type, a list, or dropping an option the repeat uses.
 */
export async function assertStatusEdit(
  field: { id: string; name: string },
  next: { type: TableFieldType; multiple: boolean; options: Array<{ id: string }> | null },
  tx: DbQueryable
): Promise<void> {
  const users = await dependents(field.id, tx);
  if (users.length === 0) return;
  const first = users[0]!;
  if (next.type !== 'select' || next.multiple)
    throw blocked(field.name, first, 'stop being a single select');
  const kept = new Set((next.options ?? []).map((option) => option.id));
  for (const user of users) {
    const named = [
      ...user.recurrence.doneOptionIds,
      ...(user.recurrence.resetOptionId ? [user.recurrence.resetOptionId] : []),
    ];
    if (!named.every((id) => kept.has(id)))
      throw blocked(field.name, user, 'lose an option that repeat uses');
  }
}

/** Refuse archiving or deleting a status field a repeat names. */
export async function assertNotStatusField(
  field: { id: string; name: string },
  tx: DbQueryable
): Promise<void> {
  const first = (await dependents(field.id, tx))[0];
  if (first) throw blocked(field.name, first, 'be archived or deleted');
}

/** Remove a field's per-entry repeats and return them (for the history step). */
export async function takeFieldRepeats(fieldId: string, tx: DbQueryable): Promise<EntryRepeats> {
  const { rows } = await tx.query<{ entry_id: string; value: unknown }>(
    `DELETE FROM public.table_entry_repeats WHERE field_id = $1 RETURNING entry_id, value`,
    [fieldId]
  );
  return rows
    .map((row): [string, unknown] => [row.entry_id, row.value])
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
}

/**
 * Put a field's repeats back (undo of turning repeat off). Entries deleted
 * since are skipped: a repeat never outlives its row.
 */
export async function putFieldRepeats(
  tableId: string,
  physical: string,
  fieldId: string,
  repeats: EntryRepeats,
  tx: DbQueryable
): Promise<void> {
  if (repeats.length === 0) return;
  await tx.query(
    `INSERT INTO public.table_entry_repeats (table_id, field_id, entry_id, value)
     SELECT $1, $2, kept.entry_id, kept.value
       FROM unnest($3::uuid[], $4::jsonb[]) AS kept(entry_id, value)
      WHERE EXISTS (SELECT 1 FROM ${physical} AS entry WHERE entry.id = kept.entry_id)
     ON CONFLICT (field_id, entry_id) DO NOTHING`,
    [tableId, fieldId, repeats.map(([id]) => id), repeats.map(([, value]) => JSON.stringify(value))]
  );
}
