import type { TableEntryValue } from '@snaglet/shared/types';

/** Relation ids or Select labels as one list, whether the field holds a single value or many. */
export function entryValueList(value: TableEntryValue): string[] {
  return Array.isArray(value) ? value : typeof value === 'string' && value ? [value] : [];
}
