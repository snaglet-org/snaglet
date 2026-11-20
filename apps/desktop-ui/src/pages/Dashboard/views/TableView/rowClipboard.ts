/**
 * Copying and pasting whole rows of a custom table (Cmd/Ctrl+C, Cmd/Ctrl+V
 * with rows checked in the grid).
 *
 * A copy keeps the rows' editable values in memory, keyed by the table they
 * came from, and writes the visible columns as tab-separated text to the
 * system clipboard, so the rows also paste into a spreadsheet or a doc.
 * A paste reads the memory copy, not a custom clipboard type: the desktop
 * app's WKWebView only offers custom types inside copy and paste events,
 * which do not fire while a row (nothing editable) has focus. The system
 * clipboard's text only tells a paste whether that copy is still the latest
 * thing copied. When the text can't be read (WebKit asks before reading
 * another app's copy), the memory copy is used, unless the window lost focus
 * since: another app may have copied something meanwhile.
 */

import { useEffect, type RefObject } from 'react';
import type {
  RelatedTableEntries,
  RelatedTableItems,
  TableEntry,
  TableEntryValue,
  TableEntryValues,
  TableField,
} from '@snaglet/shared/types';
import { userTimeZone } from '@snaglet/shared/utils';
import { tsvCell } from '@desktop/utils/tsv';
import { toDateTimeInput } from './dateTimeInput';
import { entryValueList } from './entryValueList';
import { isTextEditingTarget } from './tableUndo';

/** What a copied value was, so a paste skips fields retyped since. */
interface CopiedField {
  id: string;
  type: TableField['type'];
  multiple: boolean;
  range: boolean;
}

export interface CopiedRows {
  tableId: string;
  /** Each row's editable values, in the order the rows were shown. */
  rows: TableEntryValues[];
  /** The ids of the entries copied, in the same order. */
  sourceIds: string[];
  fields: CopiedField[];
  /** The tab-separated text written to the system clipboard. */
  text: string;
  /** False when the system clipboard refused the text, so it can't vouch for the copy. */
  onSystemClipboard: boolean;
  /** The window lost focus since the copy, so another app may have copied over it. */
  leftWindow: boolean;
}

export interface RowRelations {
  relatedEntries?: RelatedTableEntries;
  relatedItems?: RelatedTableItems;
}

let copied: CopiedRows | null = null;
let watching = false;

/**
 * Any other copy or cut in the app replaces ours on the clipboard; leaving
 * the window means another app might have.
 */
function watchOtherCopies(): void {
  if (watching || typeof document === 'undefined') return;
  watching = true;
  const drop = () => {
    copied = null;
  };
  document.addEventListener('copy', drop, true);
  document.addEventListener('cut', drop, true);
  window.addEventListener('blur', () => {
    if (copied) copied.leftWindow = true;
  });
}

/** Some rows are copied (from any table), so Cmd/Ctrl+V is ours to handle. */
export function hasCopiedRows(): boolean {
  return copied !== null;
}

/** @public Test isolation for the module-level copy. */
export function __clearCopiedRowsForTests(): void {
  copied = null;
}

function relationName(field: TableField, id: string, relations: RowRelations): string {
  if (field.referenceKind) return relations.relatedItems?.[field.referenceKind]?.[id]?.title || id;
  const name = field.referenceTableId
    ? relations.relatedEntries?.[field.referenceTableId]?.[id.toLowerCase()]?.name
    : undefined;
  return name === undefined ? id : name || 'Untitled';
}

/**
 * A cell as spreadsheets read it: TRUE/FALSE, select labels and linked names
 * joined with ", ", dates as `YYYY-MM-DD` and date & times as the viewer's
 * `YYYY-MM-DD HH:MM` (a range's two ends joined with " – "), text as stored.
 */
export function cellText(
  field: TableField,
  value: TableEntryValue | undefined,
  relations: RowRelations = {},
  timeZone = userTimeZone()
): string {
  if (field.type === 'checkbox') return value === true ? 'TRUE' : 'FALSE';
  if (value === null || value === undefined) return '';
  if (field.type === 'select') return entryValueList(value).join(', ');
  if (field.type === 'relation')
    return entryValueList(value)
      .map((id) => relationName(field, id, relations))
      .join(', ');
  if (typeof value !== 'string') return String(value);
  if (field.type === 'datetime')
    return value
      .split('/')
      .map((part) => toDateTimeInput(part, timeZone).replace('T', ' ') || part)
      .join(' – ');
  if (field.type === 'date') return value.split('/').join(' – ');
  return value;
}

/** One line per entry, one tab-separated cell per field, no header row. */
export function rowsAsText(
  entries: readonly TableEntry[],
  fields: readonly TableField[],
  relations: RowRelations = {},
  timeZone = userTimeZone()
): string {
  return entries
    .map((entry) =>
      fields
        .map((field) => tsvCell(cellText(field, entry.values[field.id], relations, timeZone)))
        .join('\t')
    )
    .join('\n');
}

/**
 * The values a copy carries: every editable field, shown or collapsed.
 * Managed fields (id, created_at) are the server's to set.
 */
export function copyableValues(entry: TableEntry, fields: readonly TableField[]): TableEntryValues {
  const values: TableEntryValues = {};
  for (const field of fields)
    if (!field.managed && field.id in entry.values)
      values[field.id] = entry.values[field.id] ?? null;
  return values;
}

const fieldShape = (field: TableField): CopiedField => ({
  id: field.id,
  type: field.type,
  multiple: field.multiple,
  range: field.range,
});

/**
 * Copy `entries` (in the order shown): their values in memory, synchronously,
 * and the `visibleFields` as text on the system clipboard, best effort.
 */
export async function copyRows(input: {
  tableId: string;
  entries: readonly TableEntry[];
  /** Every field of the table, for the values. */
  fields: readonly TableField[];
  /** The grid's shown columns, in order, for the text. */
  visibleFields: readonly TableField[];
  relations?: RowRelations;
}): Promise<void> {
  watchOtherCopies();
  const text = rowsAsText(input.entries, input.visibleFields, input.relations);
  const copy: CopiedRows = {
    tableId: input.tableId,
    rows: input.entries.map((entry) => copyableValues(entry, input.fields)),
    sourceIds: input.entries.map((entry) => entry.id),
    fields: input.fields.filter((field) => !field.managed).map(fieldShape),
    text,
    onSystemClipboard: false,
    leftWindow: false,
  };
  copied = copy;
  try {
    if (!navigator.clipboard?.writeText) return;
    await navigator.clipboard.writeText(text);
    copy.onSystemClipboard = true;
  } catch {
    // The memory copy still pastes inside Snaglet.
  }
}

const sameLines = (a: string, b: string) => a.replace(/\r\n?/g, '\n') === b.replace(/\r\n?/g, '\n');

/** The system clipboard's text, or null when it can't be read. */
async function systemClipboardText(): Promise<string | null> {
  try {
    if (!navigator.clipboard?.readText) return null;
    return await navigator.clipboard.readText();
  } catch {
    return null;
  }
}

export type CopiedRowsLookup =
  | { kind: 'rows'; copy: CopiedRows }
  | { kind: 'otherTable' }
  | { kind: 'unverified' }
  | null;

/**
 * The rows a paste into `tableId` would make: null when nothing is copied or
 * something else was copied since (the copy is dropped), `otherTable` when
 * they came from another table, `unverified` when the clipboard can't be
 * read after the window lost focus, so they may not be the latest copy.
 */
export async function readCopiedRows(tableId: string): Promise<CopiedRowsLookup> {
  const copy = copied;
  if (!copy) return null;
  if (copy.onSystemClipboard) {
    const current = await systemClipboardText();
    if (current !== null && !sameLines(current, copy.text)) {
      if (copied === copy) copied = null;
      return null;
    }
    if (current === null && copy.leftWindow) return { kind: 'unverified' };
  }
  return copy.tableId === tableId ? { kind: 'rows', copy } : { kind: 'otherTable' };
}

/**
 * The copied rows' values for the table's current fields: a value whose
 * field is gone, now managed, or of another type or shape is left out, so
 * that field takes its default.
 */
export function pasteValues(copy: CopiedRows, fields: readonly TableField[]): TableEntryValues[] {
  const current = new Map(fields.filter((field) => !field.managed).map((f) => [f.id, f]));
  const kept = new Set(
    copy.fields
      .filter((was) => {
        const now = current.get(was.id);
        return (
          !!now && now.type === was.type && now.multiple === was.multiple && now.range === was.range
        );
      })
      .map((was) => was.id)
  );
  return copy.rows.map((row) =>
    Object.fromEntries(Object.entries(row).filter(([fieldId]) => kept.has(fieldId)))
  );
}

/**
 * Which row shortcut a key press is, or null to leave it to the browser:
 * Cmd/Ctrl+C or +V with no other modifier, outside text editing, an open
 * dialog, the Dashboard sidebar and any text selection.
 */
export function rowShortcut(event: KeyboardEvent): 'copy' | 'paste' | null {
  if (!(event.metaKey || event.ctrlKey) || event.altKey || event.shiftKey) return null;
  const key = event.key.toLowerCase();
  if (key !== 'c' && key !== 'v') return null;
  if (event.defaultPrevented || document.querySelector('[role="dialog"]')) return null;
  const focused = document.activeElement;
  if (isTextEditingTarget(event.target) || isTextEditingTarget(focused)) return null;
  if (focused instanceof Element && focused.closest('#dashboard-sidebar')) return null;
  const selection = window.getSelection();
  if (selection && !selection.isCollapsed && selection.toString().length > 0) return null;
  return key === 'c' ? 'copy' : 'paste';
}

export interface RowClipboardHandlers {
  /** Start a copy; false when there is nothing to copy, leaving the key alone. */
  copy: () => boolean;
  /** Start a paste; false when there is nothing to paste, leaving the key alone. */
  paste: () => boolean;
}

/**
 * Cmd/Ctrl+C and Cmd/Ctrl+V for the active table pane's grid. A handled key
 * stops there, so the workspace tree's window listener does not copy or
 * paste its own selection too.
 */
export function useRowClipboardShortcuts(
  enabled: boolean,
  handlers: RefObject<RowClipboardHandlers>
): void {
  useEffect(() => {
    if (!enabled) return;
    const onKeyDown = (event: KeyboardEvent) => {
      const shortcut = rowShortcut(event);
      if (!shortcut || !handlers.current?.[shortcut]()) return;
      event.preventDefault();
      event.stopPropagation();
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [enabled, handlers]);
}

/** Clear a text selection left elsewhere, so the next Cmd/Ctrl+C copies the checked rows. */
export function clearTextSelection(): void {
  const selection = typeof window === 'undefined' ? null : window.getSelection();
  if (selection && !selection.isCollapsed) selection.removeAllRanges();
}
