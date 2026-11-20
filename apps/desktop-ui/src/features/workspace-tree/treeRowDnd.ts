import type { DragEvent as ReactDragEvent } from 'react';
import type { TableCatalogEntry } from '@snaglet/shared/types';
import type { LibraryTreeChild } from '../../utils/api';
import { PANE_ITEM_MIME } from '../../utils/paneDrag';
import { selectionFromWorkspaceNode } from '@desktop/pages/Dashboard/selection/types';
import {
  NODE_CHIP_MIME,
  chipDragListOf,
  setActiveDragChip,
  writeChipDragList,
  type NodeChipData,
} from '@desktop/utils/nodeChip';
import { labelOfNode, placementParentOf } from './treeUtils';
import type { DragPayload, DropZone } from './types';

/** Tree-internal drag mime — carries the full `DragPayload[]` for the drag. */
const TREE_NODE_MIME = 'application/x-snaglet-tree-node';

/** Full drag payload for one row — id/kind plus the pre-drag placement the
 *  undo capture in a receiving pane needs (see DragPayload). */
export function payloadOf(node: LibraryTreeChild): DragPayload {
  return {
    id: node.id,
    kind: node.kind,
    parentId: placementParentOf(node),
    sortOrder: node.sortOrder,
    label: labelOfNode(node),
  };
}

/** Drag payload for a Tables group row: its project is its placement parent. */
export function payloadOfTable(table: TableCatalogEntry): DragPayload {
  return {
    id: table.id,
    kind: 'table',
    parentId: table.projectId,
    sortOrder: table.sortOrder,
    label: table.name,
  };
}

/**
 * Rows carried by a drag that starts on the row `origin` describes. If the row
 * is part of the multi-selection, the drag carries every selected row — tree
 * nodes and Tables group rows alike — in visible order. Otherwise it's a plain
 * single-row drag — the selection is left alone, since the user may be dragging
 * "one thing" without intending to clear it.
 */
export function buildDragPayloads(
  origin: DragPayload,
  selectedIds: Set<string>,
  nodeIndex: Map<string, LibraryTreeChild>,
  tableIndex: Map<string, TableCatalogEntry>,
  visibleOrderIndex: Map<string, number>
): DragPayload[] {
  const isInSelection = selectedIds.has(origin.id) && selectedIds.size > 1;
  if (!isInSelection) return [origin];
  const payloads: DragPayload[] = [];
  for (const id of selectedIds) {
    const node = nodeIndex.get(id);
    if (node) {
      payloads.push(payloadOf(node));
      continue;
    }
    const table = tableIndex.get(id);
    if (table) {
      payloads.push(payloadOfTable(table));
      continue;
    }
  }
  return payloads.sort((a, b) => {
    const ai = visibleOrderIndex.get(a.id) ?? 0;
    const bi = visibleOrderIndex.get(b.id) ?? 0;
    return ai - bi;
  });
}

/**
 * A drag carrying several rows also carries their chip list, in the same
 * (visible) order, so a chip-capable input inserts one chip per row. A
 * one-row drag writes none: its single chip already says everything.
 */
function writeSelectionChipList(dt: DataTransfer, payloads: DragPayload[]): void {
  if (payloads.length < 2) return;
  writeChipDragList(
    dt,
    chipDragListOf(payloads.map((p) => ({ id: p.id, kind: p.kind, title: p.label ?? null })))
  );
}

/**
 * Attach the drag payloads to the DataTransfer. Four mimes on one drag:
 * tree-internal consumers (row-drop to reparent) read `TREE_NODE_MIME` — an
 * array. Pane drop reads `PANE_ITEM_MIME` with the full DetailSelection so it
 * doesn't need a re-fetch; it's only meaningful for one node at a time (a pane
 * shows one selection), so the actively-dragged row is always emitted there.
 * The node-chip mime names that row too, for single-item drop targets; a
 * multi-row drag adds the chip list every chip-capable input reads.
 *
 * Also flags the drag on <body> so the global stylesheet paints a
 * surface-wide `grabbing` cursor for the duration (cleared in onDragEnd).
 * Purely visual — no bearing on the drop pipeline.
 */
export function applyRowDragData(
  e: ReactDragEvent<HTMLElement>,
  node: LibraryTreeChild,
  payloads: DragPayload[]
): void {
  e.dataTransfer.setData(TREE_NODE_MIME, JSON.stringify(payloads));
  e.dataTransfer.setData(PANE_ITEM_MIME, JSON.stringify(selectionFromWorkspaceNode(node)));
  const chipData: NodeChipData = {
    id: node.id,
    kind: node.kind as NodeChipData['kind'],
    title: labelOfNode(node),
  };
  e.dataTransfer.setData(NODE_CHIP_MIME, JSON.stringify(chipData));
  setActiveDragChip(chipData); // Tauri/WKWebView in-memory fallback
  writeSelectionChipList(e.dataTransfer, payloads);
  e.dataTransfer.effectAllowed = 'all';
  document.body.setAttribute('data-dragging', 'true');
}

/**
 * A Tables group row drags as its `table` chip (set by the caller through
 * `setChipDragPayload`, so chat and pane drops keep working) and, on top,
 * as tree rows: the tree reorders and moves it, and the sidebar trash
 * archives it, alongside any selected nodes in the same drag.
 */
export function applyTableRowDragData(
  e: ReactDragEvent<HTMLElement>,
  payloads: DragPayload[]
): void {
  e.dataTransfer.setData(TREE_NODE_MIME, JSON.stringify(payloads));
  writeSelectionChipList(e.dataTransfer, payloads);
  e.dataTransfer.effectAllowed = 'all';
  document.body.setAttribute('data-dragging', 'true');
}

/**
 * Multi-row drag image: a small badge with the count so the user sees what
 * they're moving instead of just the single-row chrome. Built as a detached
 * node positioned offscreen so it doesn't pollute the document — the browser
 * snapshots it and discards.
 */
export function showMultiDragGhost(e: ReactDragEvent<HTMLElement>, count: number): void {
  const ghost = document.createElement('div');
  ghost.textContent = `${count} items`;
  ghost.style.cssText = [
    'position:absolute',
    'top:-1000px',
    'left:-1000px',
    'padding:4px 10px',
    'background:var(--color-primary)',
    'color:var(--color-on-primary,#fff)',
    'font:600 12px/1.2 var(--font-mono, monospace)',
    'border-radius:0',
    'letter-spacing:0.04em',
  ].join(';');
  document.body.appendChild(ghost);
  e.dataTransfer.setDragImage(ghost, 16, 12);
  // Defer cleanup until after the browser has snapshotted.
  setTimeout(() => ghost.remove(), 0);
}

/**
 * True when every dragged row is already a direct child of the container
 * (for a thread: already scoped to this project). In that case the only
 * useful gesture is "drop me out into the parent level" — callers strip
 * `inside` and let above/below carry the drop up one level. Without this,
 * the dominant middle 50% of the parent's row resolves to a no-op move
 * (source ends up in the bucket it's already in), which reads as "drag-out
 * doesn't work."
 */
export function areSourcesOwnChildren(
  sources: DragPayload[],
  containerId: string,
  nodeIndex: Map<string, LibraryTreeChild>
): boolean {
  return sources.every((s) => {
    const n = nodeIndex.get(s.id);
    return n !== undefined && placementParentOf(n) === containerId;
  });
}

/**
 * Zone detection from the pointer's vertical position over the row.
 * With `allowInside` the row splits into [above 25%, inside 50%, below 25%];
 * without it, [above 50%, below 50%] — `inside` has no meaning for leaves.
 */
export function dropZoneForPointer(e: ReactDragEvent<HTMLElement>, allowInside: boolean): DropZone {
  const rect = e.currentTarget.getBoundingClientRect();
  const ratio = (e.clientY - rect.top) / rect.height;
  if (allowInside) {
    return ratio < 0.25 ? 'above' : ratio > 0.75 ? 'below' : 'inside';
  }
  return ratio < 0.5 ? 'above' : 'below';
}
