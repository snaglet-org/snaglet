import { NODE_CHIP_MIME, readChipDragData } from '@desktop/utils/nodeChip';
import { getActiveDragChip } from '@desktop/utils/nodeChip/payload';
import { canOpenChipInPane, selectionFromChip } from '../../selection/selectionFromChip';
import { useEffect, useRef, useState, type DragEvent } from 'react';
import { PANE_ITEM_MIME } from '@desktop/utils/paneDrag';
import { type DropZone } from '../../layout/paneTree';
import { type DetailSelection } from '../../selection/types';
import { safeJsonParse } from '@snaglet/shared/utils';

/**
 * Compute which of the 5 drop zones the cursor is over.
 *
 * The pane is cut at 30% and 70% on each axis. The left and right bands run
 * full height (so corners go left or right); the middle column splits into
 * top, center and bottom. Hit-test regions match the visual highlights
 * one-to-one, so the highlighted area always contains the cursor.
 */
function hitTestZone(rect: DOMRect, clientX: number, clientY: number): DropZone {
  const x = clientX - rect.left;
  const y = clientY - rect.top;
  const innerLeft = rect.width * 0.3;
  const innerRight = rect.width * 0.7;
  const innerTop = rect.height * 0.3;
  const innerBottom = rect.height * 0.7;

  if (x >= innerLeft && x <= innerRight && y >= innerTop && y <= innerBottom) {
    return 'center';
  }
  if (x < innerLeft) return 'left';
  if (x > innerRight) return 'right';
  if (y < innerTop) return 'top';
  return 'bottom';
}

function hasPaneDrag(e: DragEvent<HTMLDivElement>): boolean {
  if (e.dataTransfer.types.includes(PANE_ITEM_MIME)) return true;
  const active = getActiveDragChip();
  if (active) return canOpenChipInPane(active);
  if (!e.dataTransfer.types.includes(NODE_CHIP_MIME)) return false;
  const chip = readChipDragData(e.dataTransfer);
  // Browsers hide payload contents until drop; the MIME still identifies a node drag.
  return chip ? canOpenChipInPane(chip) : true;
}

function parsePayload(e: DragEvent<HTMLDivElement>): DetailSelection | Promise<DetailSelection> {
  const raw = e.dataTransfer.getData(PANE_ITEM_MIME);
  if (!raw) {
    const chip = readChipDragData(e.dataTransfer);
    return chip ? selectionFromChip(chip) : null;
  }
  return safeJsonParse<DetailSelection | null>(raw, null);
}

function isNestedChipDropTarget(e: DragEvent<HTMLDivElement>): boolean {
  const target = e.target;
  return (
    target instanceof Element && Boolean(target.closest('[data-pane-drop-target="node-chip"]'))
  );
}

/**
 * A container icon cell inside a ContainerView wants this drag — dropping a
 * node onto a container moves it into that container, which takes priority
 * over the pane's split-screen overlay. Detect it so we suppress the overlay
 * (and don't claim the drop) whenever the cursor is over a container cell.
 */
function isContainerCellDropTarget(e: DragEvent<HTMLDivElement>): boolean {
  const target = e.target;
  return (
    target instanceof Element && Boolean(target.closest('[data-pane-drop-target="container-cell"]'))
  );
}

interface PaneDropHandlers {
  onDragOverCapture: (e: DragEvent<HTMLDivElement>) => void;
  onDragOver: (e: DragEvent<HTMLDivElement>) => void;
  onDragLeave: (e: DragEvent<HTMLDivElement>) => void;
  onDrop: (e: DragEvent<HTMLDivElement>) => void;
}

export interface UsePaneDropZoneResult {
  hoverZone: DropZone | null;
  handlers: PaneDropHandlers;
}

/**
 * Owns the drop-zone state and the four DnD handlers that drive the
 * pane's split overlay.
 *
 * Shift modifier semantics: holding Shift means "drop a link-chip into
 * the doc body" — the textarea inside DocEditor wants the drop, not
 * the pane. So we suppress the zone overlay and short-circuit the
 * drop so the chrome doesn't swap the pane out from under the editor.
 */
export function usePaneDropZone(
  onDropSelection: (zone: DropZone, selection: DetailSelection) => void
): UsePaneDropZoneResult {
  const request = useRef(0);
  useEffect(
    () => () => {
      request.current += 1;
    },
    []
  );
  const [hoverZone, setHoverZone] = useState<DropZone | null>(null);

  // A drag that ends without a dragleave or drop reaching this pane — the
  // user pressed Escape, released outside the window, or a nested target
  // claimed the drop and stopped it — must not leave the overlay behind.
  const hovering = hoverZone !== null;
  useEffect(() => {
    if (!hovering) return;
    const clear = () => setHoverZone(null);
    window.addEventListener('dragend', clear, true);
    window.addEventListener('drop', clear, true);
    return () => {
      window.removeEventListener('dragend', clear, true);
      window.removeEventListener('drop', clear, true);
    };
  }, [hovering]);

  /**
   * Capture-phase watcher for the shift+chip mode. Runs before any
   * descendant (notably the DocEditor textarea, which stops propagation
   * in bubble) so the Pane's split-zone overlay clears even when the
   * cursor is *inside* the textarea — otherwise a `hoverZone` set while
   * the cursor was over the chrome would linger as soon as it moved
   * down into the editor body.
   */
  const onDragOverCapture = (e: DragEvent<HTMLDivElement>) => {
    if (!hasPaneDrag(e)) return;
    if (isNestedChipDropTarget(e) || isContainerCellDropTarget(e)) {
      if (hoverZone) setHoverZone(null);
      return;
    }
    if (e.shiftKey && hoverZone) setHoverZone(null);
  };

  const onDragOver = (e: DragEvent<HTMLDivElement>) => {
    // Only react if the payload type we recognize is present. Otherwise
    // let the event bubble (don't preventDefault → drop won't fire here).
    if (!hasPaneDrag(e)) return;
    // An inner chip-aware drop target wants this drag (TipTap chip input,
    // DocEditor body, …). Don't show the split overlay or claim the
    // drop — fall through so the nested target owns it. Mirrors the
    // capture-phase check above; without this branch the bubble path
    // would still call preventDefault and `hoverZone` would flash on
    // every dragover that bubbles past us.
    // A container cell (ContainerView) or chip-aware target wants this drag —
    // both outrank the split overlay, so defer and clear any lingering zone.
    if (isNestedChipDropTarget(e) || isContainerCellDropTarget(e)) {
      if (hoverZone) setHoverZone(null);
      return;
    }
    // Shift = "insert link chip into the doc" intent (handled by DocEditor's
    // textarea). Suppress the split-zone overlay so the user doesn't see a
    // conflicting "swap pane content" affordance while they're trying to
    // land a chip inside the editor body.
    if (e.shiftKey) {
      if (hoverZone) setHoverZone(null);
      return;
    }
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = 'copy';
    const rect = (e.currentTarget as HTMLDivElement).getBoundingClientRect();
    const zone = hitTestZone(rect, e.clientX, e.clientY);
    if (zone !== hoverZone) setHoverZone(zone);
  };

  const onDragLeave = (e: DragEvent<HTMLDivElement>) => {
    // Only clear when actually leaving the pane (not when crossing an
    // inner child boundary).
    const related = e.relatedTarget as Node | null;
    if (!related || !e.currentTarget.contains(related)) {
      setHoverZone(null);
    }
  };

  const onDrop = (e: DragEvent<HTMLDivElement>) => {
    if (!hasPaneDrag(e)) return;
    if (isNestedChipDropTarget(e) || isContainerCellDropTarget(e)) {
      setHoverZone(null);
      return;
    }
    // Shift = chip drop, owned by the textarea. If the drop lands on the
    // pane chrome instead of the editor body, no-op — don't swap the pane.
    if (e.shiftKey) {
      setHoverZone(null);
      return;
    }
    e.preventDefault();
    e.stopPropagation();
    const generation = ++request.current;
    const payload = parsePayload(e);
    const rect = (e.currentTarget as HTMLDivElement).getBoundingClientRect();
    const zone = hitTestZone(rect, e.clientX, e.clientY);
    setHoverZone(null);
    if (!payload) return;
    if (payload instanceof Promise) {
      void payload
        .then((selection) => {
          if (generation === request.current && selection) onDropSelection(zone, selection);
        })
        .catch((error) => console.error('Unable to open dropped node', error));
    } else onDropSelection(zone, payload);
  };

  return {
    hoverZone,
    handlers: { onDragOverCapture, onDragOver, onDragLeave, onDrop },
  };
}
