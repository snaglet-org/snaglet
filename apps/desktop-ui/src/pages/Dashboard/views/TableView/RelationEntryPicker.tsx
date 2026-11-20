import { useMemo } from 'react';
import type { TableEntry, TableField } from '@snaglet/shared/types';
import type { EntryCellEditorProps } from './cells/EntryCellEditor';
import { RelationPicker } from './RelationPicker';
import { entrySource, snagletItemSource } from './relationSources';

/** An entry's Name, else `untitled` (the grid passes its positional label). */
export function entryLabel(entry: TableEntry, fields: TableField[], untitled = 'Untitled'): string {
  const title = fields.find((field) => !field.managed && field.isTitle && field.type === 'text');
  const source = title ? [title] : fields;
  const named = source.find(
    (field) =>
      !field.managed &&
      field.type === 'text' &&
      typeof entry.values[field.id] === 'string' &&
      String(entry.values[field.id]).trim()
  );
  const value = named ? String(entry.values[named.id]).trim() : untitled;
  return value.length > 100 ? `${value.slice(0, 100)}…` : value;
}

/**
 * A relation cell's editor: entries of the related custom table, or Snaglet items
 * of the field's `referenceKind` (docs, agents, …). The search floats outside
 * the row; only the selected values occupy the cell.
 */
export function RelationEntryPicker({
  relatedEntries,
  relatedItems,
  ...props
}: EntryCellEditorProps) {
  const kind = props.field.referenceKind;
  const tableId = props.field.referenceTableId;
  const source = useMemo(
    () => (kind ? snagletItemSource(kind, relatedItems) : entrySource(tableId, relatedEntries)),
    [kind, tableId, relatedEntries, relatedItems]
  );
  return <RelationPicker {...props} source={source} />;
}
