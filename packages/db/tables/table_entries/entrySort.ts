import { quoteIdentifier } from '@snaglet/db/sql-utils';
import { ENTRY_POSITION_COLUMN } from '@snaglet/db/tables/table_catalog';
import { TABLE_ENTRY_SORT_MAX, type TableEntrySort, type TableField } from '@snaglet/shared/types';
import { entryBadRequest } from './entrySchema';

const POSITION = quoteIdentifier(ENTRY_POSITION_COLUMN);

/** The table's own row order: every sort's final tie-break. */
const ROW_ORDER = `${POSITION} ASC, created_at ASC, id ASC`;

/** Whether a field can be a sort level: one value per entry, of an orderable type. */
function isSortableField(field: TableField): boolean {
  if (field.state || field.multiple) return false;
  return ['text', 'select', 'number', 'date', 'datetime', 'checkbox'].includes(field.type);
}

/**
 * Validates a `sort` query: at most TABLE_ENTRY_SORT_MAX levels, each a
 * sortable field of this table at most once, with a direction.
 */
export function parseEntrySort(input: unknown, fields: readonly TableField[]): TableEntrySort[] {
  if (input === undefined) return [];
  if (!Array.isArray(input) || input.length > TABLE_ENTRY_SORT_MAX)
    throw entryBadRequest(`sort must list at most ${TABLE_ENTRY_SORT_MAX} levels.`);
  const seen = new Set<string>();
  return input.map((level: unknown) => {
    const { fieldId, direction } = (level ?? {}) as Partial<TableEntrySort>;
    if (typeof fieldId !== 'string' || (direction !== 'asc' && direction !== 'desc'))
      throw entryBadRequest('Each sort level needs a fieldId and a direction of asc or desc.');
    const field = fields.find((candidate) => candidate.id === fieldId);
    if (!field || !isSortableField(field))
      throw entryBadRequest(`Field ${fieldId} cannot be sorted.`);
    if (seen.has(fieldId)) throw entryBadRequest(`Field ${fieldId} is sorted more than once.`);
    seen.add(fieldId);
    return { fieldId, direction };
  });
}

/**
 * ORDER BY terms for `sort`, ending with row order. Columns are unqualified,
 * so the terms work over the table itself or any CTE of its rows. Empty
 * values (null, or '' text) sort last in both directions; text compares
 * case-insensitively; a select compares by its option order (an unknown
 * label counts as empty).
 */
export function entrySortOrder(
  sort: readonly TableEntrySort[],
  fields: readonly TableField[],
  param: (value: unknown) => string
): string {
  const terms = sort.map(({ fieldId, direction }) => {
    const field = fields.find((candidate) => candidate.id === fieldId);
    if (!field) throw entryBadRequest(`Field ${fieldId} cannot be sorted.`);
    const column = quoteIdentifier(field.columnName);
    let key: string;
    switch (field.type) {
      case 'text':
        key = `lower(NULLIF(${column}, ''))`;
        break;
      case 'select':
        key = `array_position(${param((field.options ?? []).map((option) => option.label))}::text[], ${column})`;
        break;
      default:
        key = column;
    }
    return `${key} ${direction === 'desc' ? 'DESC' : 'ASC'} NULLS LAST`;
  });
  return [...terms, ROW_ORDER].join(', ');
}
