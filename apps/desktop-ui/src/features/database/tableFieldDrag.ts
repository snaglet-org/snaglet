/**
 * Drag payload for a custom table's column, dragged from its header's trash
 * handle to the sidebar trash (`ArchiveDropZone`), which archives it.
 *
 * Column headers already reorder with a pointer-based drag, so the HTML5
 * drag starts from the small trash handle instead of the header itself.
 * Like chip drags (`utils/nodeChip`), the payload is written under its own
 * MIME type and kept in a module-level store for the gesture: the
 * DataTransfer hides its data during dragover, and the desktop webview
 * drops custom MIME types altogether.
 */

import type { DragEvent as ReactDragEvent } from 'react';
import { safeJsonParse } from '@snaglet/shared/utils';

export const TABLE_FIELD_MIME = 'application/x-snaglet-table-field';

export interface TableFieldDragPayload {
  tableId: string;
  fieldId: string;
  /** The column's display name, for the drag image and the drop's toast. */
  name: string;
}

let active: TableFieldDragPayload | null = null;

function isPayload(value: unknown): value is TableFieldDragPayload {
  return (
    typeof value === 'object' &&
    value !== null &&
    'tableId' in value &&
    typeof value.tableId === 'string' &&
    'fieldId' in value &&
    typeof value.fieldId === 'string' &&
    'name' in value &&
    typeof value.name === 'string'
  );
}

/** Start a column drag: writes the payload and shows a small labeled drag image. */
export function setTableFieldDragPayload(
  e: ReactDragEvent<HTMLElement>,
  payload: TableFieldDragPayload
): void {
  e.stopPropagation();
  active = payload;
  try {
    e.dataTransfer.setData(TABLE_FIELD_MIME, JSON.stringify(payload));
  } catch {
    // Some webviews refuse custom types; the in-memory store still answers.
  }
  e.dataTransfer.effectAllowed = 'move';
  if (typeof document === 'undefined' || typeof e.dataTransfer.setDragImage !== 'function') return;
  const ghost = document.createElement('div');
  ghost.textContent = `column: ${payload.name}`;
  ghost.style.position = 'fixed';
  ghost.style.top = '-9999px';
  ghost.style.left = '-9999px';
  ghost.style.padding = '4px 8px';
  ghost.style.background = 'var(--color-foreground, #fff)';
  ghost.style.border = '1px solid var(--color-primary)';
  ghost.style.font = '11px var(--font-mono, monospace)';
  ghost.style.color = 'var(--color-text, #000)';
  ghost.style.maxWidth = '240px';
  ghost.style.whiteSpace = 'nowrap';
  ghost.style.overflow = 'hidden';
  ghost.style.textOverflow = 'ellipsis';
  document.body.appendChild(ghost);
  e.dataTransfer.setDragImage(ghost, 0, 0);
  setTimeout(() => ghost.remove(), 0);
}

/** Wire to `onDragEnd` on the drag source so the store never outlives a gesture. */
export function clearTableFieldDragPayload(): void {
  active = null;
}

/**
 * The column this drag carries, if any. The in-memory store answers first
 * (dragover, and webviews that drop custom types); the DataTransfer is the
 * fallback for a drop whose source has already ended.
 */
export function readTableFieldDragPayload(
  dataTransfer: DataTransfer
): TableFieldDragPayload | null {
  if (active) return active;
  if (!dataTransfer.types.includes(TABLE_FIELD_MIME)) return null;
  const parsed = safeJsonParse<unknown>(dataTransfer.getData(TABLE_FIELD_MIME), null);
  return isPayload(parsed) ? parsed : null;
}

/** @public Test isolation for the module-level store. */
export function __setActiveTableFieldDragForTests(payload: TableFieldDragPayload | null): void {
  active = payload;
}
