// chipDragSource — drag-source wiring for any surface that emits chips
// (sidebar rows, etc.). One call in `onDragStart` writes the chip payload
// (node-chip MIME + text/plain), optionally the pane-item MIME so pane chrome
// can open the item in a split, and a small pill-shaped drag image.

import type { DragEvent as ReactDragEvent } from 'react';
import {
  writeChipDragData,
  setActiveDragChip,
  setActiveDragChipList,
  type NodeChipData,
} from './payload';
import { PANE_ITEM_MIME } from '../paneDrag';

interface SetChipDragPayloadOptions {
  /** Required — the chip payload (kind + id + title). */
  chip: NodeChipData;
  /** Short label shown in the custom drag image. Defaults to
   *  `<kind>: <title>`. */
  dragLabel?: string;
  /** When set, the drag also writes `PANE_ITEM_MIME` (a JSON-serialized
   *  `DetailSelection`) so dropping on pane chrome (outside a chip-aware
   *  text input) opens the item as a pane. Omit if the source shouldn't
   *  open in a split. Typed as `unknown` to avoid an upward import from
   *  `utils/` into `pages/Dashboard/selection/`. */
  paneSelection?: unknown;
}

export function setChipDragPayload(
  e: ReactDragEvent<HTMLElement>,
  options: SetChipDragPayloadOptions
): void {
  e.stopPropagation();
  writeChipDragPayload(e.dataTransfer, options);
}

/**
 * The same payload written straight onto a DataTransfer, for drag sources
 * that see the native event rather than a React one (the editor's
 * ProseMirror dragstart handler).
 */
export function writeChipDragPayload(
  dataTransfer: DataTransfer,
  { chip, dragLabel, paneSelection }: SetChipDragPayloadOptions
): void {
  try {
    writeChipDragData(dataTransfer, chip);
  } catch {
    // setData can throw in obscure edge cases (Safari + protected MIME);
    // failing silently degrades to text-only drag, which the editors
    // already handle.
  }

  if (paneSelection) {
    try {
      dataTransfer.setData(PANE_ITEM_MIME, JSON.stringify(paneSelection));
    } catch {
      /* same Safari edge case — degrade to chip-only drag */
    }
  }

  // Don't overwrite text/plain here: writeChipDragData already wrote it with
  // the __snaglet_chip__: prefix, and readChipDragData's WKWebView fallback relies
  // on it. For a different external-drop format, add a second MIME type.

  // 'all' so the receiver's chosen dropEffect (pane chrome uses 'copy',
  // composer uses 'link') is whatever it wants — narrowing this would
  // silently invalidate some drop targets.
  dataTransfer.effectAllowed = 'all';

  // Tiny pill drag image. Setting any image stops Tauri's webview from
  // rendering the entire row as a translucent ghost.
  if (typeof document !== 'undefined') {
    const label = dragLabel ?? `${chip.kind}: ${chip.title ?? chip.name ?? chip.id}`;
    const ghost = document.createElement('div');
    ghost.textContent = label;
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
    dataTransfer.setDragImage(ghost, 0, 0);
    setTimeout(() => ghost.remove(), 0);
  }
}

/**
 * Clear the in-memory drag chip store. Wire to onDragEnd on every drag source
 * so the store does not leak across gestures.
 *
 * Example:
 *   <div draggable onDragStart={e => setChipDragPayload(e, chip)}
 *                  onDragEnd={clearChipDragPayload} />
 */
export const clearChipDragPayload = (): void => {
  setActiveDragChip(null);
  setActiveDragChipList(null);
};
