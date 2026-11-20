import type { TableEntrySort, TableField } from '@snaglet/shared/types';

/** Direction wording per field type: the user picks a meaning, not "asc". */
export function directionLabels(field: TableField | undefined): { asc: string; desc: string } {
  switch (field?.type) {
    case 'number':
      return { asc: '1 → 9', desc: '9 → 1' };
    case 'date':
    case 'datetime':
      return { asc: 'Oldest first', desc: 'Newest first' };
    case 'checkbox':
      return { asc: 'Unchecked first', desc: 'Checked first' };
    case 'select':
      return { asc: 'Option order', desc: 'Reverse order' };
    default:
      return { asc: 'A → Z', desc: 'Z → A' };
  }
}

type SortDirection = TableEntrySort['direction'];

/** The step after `direction` in a header toggle's cycle: ascending → descending → off. */
export function nextSortDirection(direction: SortDirection | undefined): SortDirection | null {
  if (!direction) return 'asc';
  return direction === 'asc' ? 'desc' : null;
}

/**
 * The sort after one click on a column header's sort toggle.
 *
 * A plain click steps the column through ascending → descending → off and
 * makes it the only level (off clears the sort). With `additive` (Shift) the
 * other levels stay: a new column joins as the last level, ascending, and a
 * column already sorted steps in place, leaving the sort once it passes
 * descending.
 */
export function cycleColumnSort(
  sort: readonly TableEntrySort[],
  fieldId: string,
  additive = false
): TableEntrySort[] {
  const current = sort.find((level) => level.fieldId === fieldId);
  const next = nextSortDirection(current?.direction);
  if (!additive) return next ? [{ fieldId, direction: next }] : [];
  if (!current) return [...sort, { fieldId, direction: 'asc' }];
  return next
    ? sort.map((level) => (level.fieldId === fieldId ? { fieldId, direction: next } : level))
    : sort.filter((level) => level.fieldId !== fieldId);
}
