import type { TableEntry, TableField, TableSelectOption } from '@snaglet/shared/types';

/**
 * One Board column. `option` is the select option it stands for; a column
 * for a label missing from the field's options keeps the rows visible under that
 * label, and the trailing `none` column holds rows with no value.
 */
export interface BoardGroup {
  /** Stable key: the option label, or '' for the no-value column. */
  key: string;
  /** The value a row takes when dropped here; null for the no-value column. */
  value: string | null;
  label: string;
  option: TableSelectOption | null;
  entries: TableEntry[];
}

export const NO_VALUE_KEY = '';

/** The label a row's single-select value reads as; null when it has none. */
function boardValueOf(entry: TableEntry, field: TableField): string | null {
  const value = entry.values[field.id];
  if (typeof value === 'string' && value) return value;
  if (Array.isArray(value) && typeof value[0] === 'string' && value[0]) return value[0];
  return null;
}

/**
 * Rows grouped by `field`: one column per option in the field's own order,
 * then one per stray label (an option removed while rows still used it),
 * then "No <field>". `overrides` are moves not yet confirmed by the server,
 * so a dragged card renders in its new column at once.
 */
export function groupBoardEntries(
  entries: readonly TableEntry[],
  field: TableField,
  overrides: ReadonlyMap<string, string | null> = new Map()
): BoardGroup[] {
  const options = field.options ?? [];
  const byKey = new Map<string, BoardGroup>();
  const groups: BoardGroup[] = options.map((option) => {
    const group: BoardGroup = {
      key: option.label,
      value: option.label,
      label: option.label,
      option,
      entries: [],
    };
    byKey.set(group.key, group);
    return group;
  });
  const strays: BoardGroup[] = [];
  const none: BoardGroup = {
    key: NO_VALUE_KEY,
    value: null,
    label: `No ${field.name}`,
    option: null,
    entries: [],
  };
  for (const entry of entries) {
    const value = overrides.has(entry.id) ? overrides.get(entry.id)! : boardValueOf(entry, field);
    if (value === null) {
      none.entries.push(entry);
      continue;
    }
    let group = byKey.get(value);
    if (!group) {
      group = { key: value, value, label: value, option: null, entries: [] };
      byKey.set(value, group);
      strays.push(group);
    }
    group.entries.push(entry);
  }
  return [...groups, ...strays, none];
}

/** Whether a value counts as filled in for a compact card line. */
export function hasCardValue(field: TableField, value: TableEntry['values'][string]): boolean {
  if (value === null || value === undefined) return false;
  if (typeof value === 'string') return value.trim() !== '';
  if (Array.isArray(value)) return value.length > 0;
  return field.type === 'checkbox' ? value === true : true;
}
