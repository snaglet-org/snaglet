import type { TableEntrySort, TableEntryWhere, TableField } from '@snaglet/shared/types';
import { safeJsonParse } from '@snaglet/shared/utils';
import { isFilterableField, filterOperators } from './tableFilterRules';

/**
 * Per-table view preferences for a custom table's pane: Grid or Board, and
 * which select field the Board groups by. Both live in localStorage as a
 * per-viewer convenience only; every read and write tolerates a missing or
 * blocked store and falls back to Grid.
 */

export type TableViewMode = 'grid' | 'board';

const MODE_KEY = 'snaglet.database.table.view';
const FIELD_KEY = 'snaglet.database.table.boardField';

const key = (prefix: string, tableId: string) => `${prefix}:${tableId}`;

function read(prefix: string, tableId: string): string | null {
  try {
    return localStorage.getItem(key(prefix, tableId));
  } catch {
    return null;
  }
}

function write(prefix: string, tableId: string, value: string | null): void {
  try {
    if (value === null) localStorage.removeItem(key(prefix, tableId));
    else localStorage.setItem(key(prefix, tableId), value);
  } catch {
    /* Preferences are optional. */
  }
}

export function readTableViewMode(tableId: string): TableViewMode {
  return read(MODE_KEY, tableId) === 'board' ? 'board' : 'grid';
}

export function writeTableViewMode(tableId: string, mode: TableViewMode): void {
  write(MODE_KEY, tableId, mode === 'grid' ? null : mode);
}

/** The remembered Board field id, whether or not the table still has it. */
export function readBoardFieldId(tableId: string): string | null {
  return read(FIELD_KEY, tableId);
}

export function writeBoardFieldId(tableId: string, fieldId: string | null): void {
  write(FIELD_KEY, tableId, fieldId);
}

/**
 * The fields a Board can group by: single-choice selects. A multi-select
 * puts one row in several columns at once, so it is not offered.
 */
export function boardCandidateFields(fields: readonly TableField[]): TableField[] {
  return fields.filter(
    (field) => field.type === 'select' && !field.multiple && !field.managed && !field.state
  );
}

/**
 * Why the Board option is unavailable for these fields, or null when it is
 * available.
 */
export function boardUnavailableReason(fields: readonly TableField[]): string | null {
  if (boardCandidateFields(fields).length) return null;
  return fields.some((field) => field.type === 'select')
    ? 'Board needs a single-choice select field'
    : 'Add a select field to use Board';
}

/**
 * The field the Board groups by: the remembered one while the table still
 * has it, else the first candidate.
 */
export function resolveBoardField(
  fields: readonly TableField[],
  rememberedId: string | null
): TableField | null {
  const candidates = boardCandidateFields(fields);
  if (!candidates.length) return null;
  return candidates.find((field) => field.id === rememberedId) ?? candidates[0];
}

const SORT_KEY = 'snaglet.database.table.sort';

/** Whether a field can be a sort level (mirrors the server's rule). */
export function isSortableField(field: TableField): boolean {
  if (field.state || field.multiple) return false;
  return ['text', 'select', 'number', 'date', 'datetime', 'checkbox'].includes(field.type);
}

/** The remembered sort levels of one view of a table; Grid and Board each keep their own. */
export function readTableSort(tableId: string, view: TableViewMode): TableEntrySort[] {
  const parsed = safeJsonParse<unknown>(read(`${SORT_KEY}.${view}`, tableId) ?? '', null);
  if (!Array.isArray(parsed)) return [];
  return parsed.flatMap((level: unknown) => {
    const { fieldId, direction } = (level ?? {}) as Partial<TableEntrySort>;
    return typeof fieldId === 'string' && (direction === 'asc' || direction === 'desc')
      ? [{ fieldId, direction }]
      : [];
  });
}

export function writeTableSort(
  tableId: string,
  view: TableViewMode,
  sort: readonly TableEntrySort[]
): void {
  write(`${SORT_KEY}.${view}`, tableId, sort.length ? JSON.stringify(sort) : null);
}

/** Only levels whose field still exists and sorts, each field once. */
export function liveSort(
  sort: readonly TableEntrySort[],
  fields: readonly TableField[]
): TableEntrySort[] {
  const seen = new Set<string>();
  return sort.filter((level) => {
    const field = fields.find((candidate) => candidate.id === level.fieldId);
    if (!field || !isSortableField(field) || seen.has(level.fieldId)) return false;
    seen.add(level.fieldId);
    return true;
  });
}

const FILTER_KEY = 'snaglet.database.table.filter';

/** The remembered filters of one view of a table; Grid and Board each keep their own. */
export function readTableFilter(tableId: string, view: TableViewMode): TableEntryWhere[] {
  const parsed = safeJsonParse<unknown>(read(`${FILTER_KEY}.${view}`, tableId) ?? '', null);
  if (!Array.isArray(parsed)) return [];
  return parsed.flatMap((condition: unknown) => {
    const { fieldId, operator, value } = (condition ?? {}) as Partial<TableEntryWhere>;
    if (typeof fieldId !== 'string' || typeof operator !== 'string') return [];
    if (value !== undefined && typeof value !== 'string' && typeof value !== 'boolean') return [];
    return [{ fieldId, operator, ...(value !== undefined && { value }) }];
  });
}

export function writeTableFilter(
  tableId: string,
  view: TableViewMode,
  where: readonly TableEntryWhere[]
): void {
  write(`${FILTER_KEY}.${view}`, tableId, where.length ? JSON.stringify(where) : null);
}

/** Only conditions whose field still exists and accepts the operator. */
export function liveFilter(
  where: readonly TableEntryWhere[],
  fields: readonly TableField[]
): TableEntryWhere[] {
  return where.filter((condition) => {
    const field = fields.find((candidate) => candidate.id === condition.fieldId);
    return (
      !!field && isFilterableField(field) && filterOperators(field).includes(condition.operator)
    );
  });
}
