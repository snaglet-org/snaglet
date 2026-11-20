import type { CSSProperties } from 'react';
import {
  TABLE_FIELD_WIDTH_MAX,
  TABLE_FIELD_WIDTH_MIN,
  type TableField,
} from '@snaglet/shared/types';
import { getEffectiveZoom } from '@desktop/utils/cssZoom';

/** Pointer travel before a press on a column edge becomes a resize. */
const RESIZE_THRESHOLD_PX = 4;
/** One Alt+←/→ step on a focused resize handle. */
export const COLUMN_RESIZE_STEP_PX = 16;
/** Set on the dragged column's cells while it follows the pointer. */
const RESIZING_ATTR = 'data-column-resizing';
/** The live width those cells take, set on the table (see TableView.module.scss). */
const LIVE_WIDTH_PROPERTY = '--table-resize-width';

/** A width in the range a field may be set to, in whole px. */
export function clampColumnWidth(px: number): number {
  return Math.min(TABLE_FIELD_WIDTH_MAX, Math.max(TABLE_FIELD_WIDTH_MIN, Math.round(px)));
}

/**
 * The inline size of a field's header and cells: its set width, or nothing
 * (auto) when it has none or is collapsed (a collapsed strip ignores it).
 * The width is the whole column, padding included, as the handle measures
 * it: body cells have no side padding, and the header is border-box.
 */
export function columnWidthStyle(
  field: TableField | undefined,
  header = false
): CSSProperties | undefined {
  if (!field || field.collapsed || typeof field.width !== 'number') return undefined;
  const width = `${field.width}px`;
  return {
    ...(header ? { boxSizing: 'border-box' } : {}),
    width,
    minWidth: width,
    maxWidth: width,
  };
}

interface ColumnResizeOptions {
  table: HTMLTableElement;
  /** The resized column's `data-column`. */
  column: string;
  /** Its header cell; its rendered width is where the resize starts. */
  header: HTMLTableCellElement;
  startX: number;
  onStart?: () => void;
  /** Escape put the column back; the gesture still ends on release. */
  onCancel?: () => void;
  /**
   * Called on release with the new width (whole px, clamped). Must commit it
   * synchronously (flushSync) so the live preview can be cleared without a
   * frame at the previous width.
   */
  onCommit: (width: number) => void;
  /** Called once the gesture ends; `resized` is false for a plain click. */
  onEnd: (resized: boolean) => void;
}

/**
 * Column resize by pointer from a header's right edge. Past a 4 px threshold
 * the column's cells follow the pointer; the delta is divided by the table's
 * CSS zoom, since pane bodies are zoomed and pointer px are viewport px (see
 * utils/cssZoom). Release commits once; Escape cancels and puts the column
 * back. Like the column drag, the live width is applied imperatively (one
 * custom property on the table) so moving the pointer never re-renders React.
 */
export function startColumnResize({
  table,
  column,
  header,
  startX,
  onStart,
  onCancel: onEscape,
  onCommit,
  onEnd,
}: ColumnResizeOptions): () => void {
  let state: 'pending' | 'active' | 'canceled' | 'ended' = 'pending';
  let zoom = 1;
  let startWidth = 0;
  let width = 0;
  const bodyStyle = {
    cursor: document.body.style.cursor,
    userSelect: document.body.style.userSelect,
  };

  const columnCells = () =>
    Array.from(table.rows).flatMap((row) =>
      Array.from(row.cells).filter((cell) => cell.dataset.column === column)
    );

  const show = (px: number) => {
    width = clampColumnWidth(px);
    table.style.setProperty(LIVE_WIDTH_PROPERTY, `${width}px`);
  };

  const activate = () => {
    state = 'active';
    zoom = getEffectiveZoom(table) || 1;
    startWidth = header.offsetWidth;
    show(startWidth);
    for (const cell of columnCells()) cell.setAttribute(RESIZING_ATTR, '');
    window.getSelection()?.removeAllRanges();
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    onStart?.();
  };

  /** Drop the live preview; the column shows whatever React last rendered. */
  const clearPreview = () => {
    for (const cell of columnCells()) cell.removeAttribute(RESIZING_ATTR);
    table.style.removeProperty(LIVE_WIDTH_PROPERTY);
    document.body.style.cursor = bodyStyle.cursor;
    document.body.style.userSelect = bodyStyle.userSelect;
  };

  const removeListeners = () => {
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
    window.removeEventListener('pointercancel', onCancel);
    window.removeEventListener('keydown', onKeyDown, true);
  };

  const onMove = (event: PointerEvent) => {
    if (state === 'pending') {
      if (Math.abs(event.clientX - startX) < RESIZE_THRESHOLD_PX) return;
      activate();
    }
    if (state !== 'active') return;
    event.preventDefault();
    show(startWidth + (event.clientX - startX) / zoom);
  };

  const onUp = () => {
    if (state === 'ended') return;
    const resized = state !== 'pending';
    if (state === 'active') onCommit(width);
    state = 'ended';
    removeListeners();
    clearPreview();
    onEnd(resized);
  };

  /** A lost pointer or an unmount: no commit, nothing left behind. */
  const onCancel = () => {
    if (state === 'ended') return;
    const resized = state !== 'pending';
    state = 'ended';
    removeListeners();
    clearPreview();
    onEnd(resized);
  };

  // Escape puts the column back but keeps listening for the release, so the
  // click that follows it is still swallowed.
  const onKeyDown = (event: KeyboardEvent) => {
    if (state !== 'active' || event.key !== 'Escape') return;
    event.preventDefault();
    event.stopPropagation();
    state = 'canceled';
    clearPreview();
    onEscape?.();
  };

  window.addEventListener('pointermove', onMove);
  window.addEventListener('pointerup', onUp);
  window.addEventListener('pointercancel', onCancel);
  window.addEventListener('keydown', onKeyDown, true);
  return onCancel;
}
