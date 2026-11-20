/**
 * Custom table archive, restore and delete: the client side of the generic
 * archive routes' table branch (`/api/archive/:id` with a catalog id).
 *
 * Only the user's own tables archive; Snaglet's built-ins are seed-managed. The
 * server answers two conflicts with a 409 and changes nothing:
 * - restore, when another table has taken its name. `details`
 *   carries `{ reason: 'nameTaken', names }`; retrying with `name` restores it
 *   under a new one.
 * - delete forever, when relation fields in other tables link to it.
 *   `details.linkedFields` lists them; `?clearReferences=true` deletes them
 *   with the table.
 * The readers below take the thrown API error by shape (`status`, `message`,
 * `details`) and fall back to the message when `details` is missing, so a
 * reworded or detail-less conflict still reaches the right prompt.
 */

import {
  CUSTOM_TABLE_ID_PATTERN,
  TABLE_NAME_MAX_LENGTH,
  TABLE_ORIGINS,
  type TableCatalogEntry,
  type TableLifecycleState,
} from '@snaglet/shared/types';
import { getErrorMessage } from '@snaglet/shared/utils';

/** Only custom tables archive; `table-builtin-…` ids never do. */
export function isArchivableTableId(id: string): boolean {
  return CUSTOM_TABLE_ID_PATTERN.test(id);
}

export function isTableCatalogEntry(value: unknown): value is TableCatalogEntry {
  return (
    typeof value === 'object' &&
    value !== null &&
    'id' in value &&
    typeof value.id === 'string' &&
    'name' in value &&
    typeof value.name === 'string' &&
    'origin' in value &&
    TABLE_ORIGINS.some((origin) => origin === value.origin) &&
    'createdAt' in value &&
    typeof value.createdAt === 'string'
  );
}

/**
 * A catalog entry's lifecycle. The server adds `state` only to a table that
 * is not active (an archived one still answers `GET /api/tables/:id`).
 */
export function tableEntryState(entry: TableCatalogEntry): TableLifecycleState {
  return entry.state ?? 'active';
}

/**
 * The catalog entry a restored table's archive row describes, for the
 * `table.restored` bus event: under its project when the row names one.
 * `null` when the row has no name to show.
 */
export function restoredTableEntry(row: {
  id: string;
  title: string | null;
  created_at: string;
  project_id?: string | null;
}): TableCatalogEntry | null {
  const name = row.title?.trim();
  return name
    ? {
        id: row.id,
        name,
        origin: 'custom',
        projectId: row.project_id ?? null,
        sortOrder: 0,
        createdAt: row.created_at,
      }
    : null;
}

const RESTORED_SUFFIX = '_restored';

/**
 * A starting point for a new name when the original is taken. Tables and
 * fields share the name policy and length bound.
 */
export function suggestRestoredTableName(name: string): string {
  const base = name.trim().slice(0, TABLE_NAME_MAX_LENGTH - RESTORED_SUFFIX.length);
  return `${base}${RESTORED_SUFFIX}`;
}

interface ApiErrorShape {
  status: number;
  message: string;
  details: unknown;
}

function conflictError(err: unknown): ApiErrorShape | null {
  if (!(err instanceof Error) || !('status' in err) || err.status !== 409) return null;
  return {
    status: 409,
    message: getErrorMessage(err),
    details: 'details' in err ? err.details : undefined,
  };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

interface RestoreNameConflict {
  /** The server's explanation, e.g. `The name "x" is taken by another table.` */
  message: string;
  /** The name that is taken, when the server said which. */
  takenName: string | null;
}

/** A restore refused because another table holds the table's name. */
export function restoreNameConflict(err: unknown): RestoreNameConflict | null {
  const conflict = conflictError(err);
  if (!conflict) return null;
  const details = asRecord(conflict.details);
  const names = details && Array.isArray(details.names) ? details.names : null;
  const nameTaken =
    details?.reason === 'nameTaken' || names !== null || /\bname\b/i.test(conflict.message);
  if (!nameTaken) return null;
  const first = asRecord(names?.[0]);
  return {
    message: conflict.message,
    takenName: typeof first?.name === 'string' ? first.name : null,
  };
}

interface LinkedFieldRef {
  tableId: string | null;
  tableName: string;
  fieldName: string;
}

export interface LinkedFieldsConflict {
  message: string;
  /** Relation fields that would be deleted too; empty when the server did not list them. */
  fields: LinkedFieldRef[];
}

function linkedFieldRef(value: unknown): LinkedFieldRef[] {
  const field = asRecord(value);
  if (!field || typeof field.tableName !== 'string' || typeof field.fieldName !== 'string') {
    return [];
  }
  return [
    {
      tableId: typeof field.tableId === 'string' ? field.tableId : null,
      tableName: field.tableName,
      fieldName: field.fieldName,
    },
  ];
}

/** A delete-forever refused because other tables' relation fields link to it. */
export function linkedFieldsConflict(err: unknown): LinkedFieldsConflict | null {
  const conflict = conflictError(err);
  if (!conflict) return null;
  const details = asRecord(conflict.details);
  const listed = details && Array.isArray(details.linkedFields) ? details.linkedFields : null;
  if (!listed && !/\b(links?|linked|referenc\w*)\b/i.test(conflict.message)) return null;
  return { message: conflict.message, fields: (listed ?? []).flatMap(linkedFieldRef) };
}
