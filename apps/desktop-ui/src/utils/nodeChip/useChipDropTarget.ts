// useChipDropTarget — bind chip-drop handling to any DOM element. Spread
// `dropTargetProps` onto the target: capture-phase handlers so the chip drop
// beats PaneChrome's split overlay, plus `data-pane-drop-target="node-chip"`,
// which tells PaneChrome to skip its own drop UI. `isDragOver` is true while a
// chip drag hovers inside. Caret placement and what to do on drop
// (`onAccept`) stay with the caller.

import { useCallback, useEffect, useRef, useState, type DragEvent } from 'react';
import {
  hasChipDragData,
  readChipDragData,
  readChipDragList,
  type ChipDragList,
  type NodeChipData,
} from './payload';

type ChipDropTriggerMode =
  | 'always' // every chip drag is accepted as a chip drop
  | 'shift'; // only accept when Shift is held (lets PaneChrome handle plain drags)

interface UseChipDropTargetOptions {
  /** Invoked once per accepted drop. Synchronous side effects only — the
   *  DragEvent is the React synthetic event and won't be valid past return. */
  onAccept?: (chip: NodeChipData, e: DragEvent<HTMLElement>) => void;
  /** Takes every item the drop carries instead — a multi-row sidebar drag
   *  carries the whole selection, in selection order (see
   *  `readChipDragList`; `acceptDroppedChips` filters it and reports skipped
   *  items). Wins over `onAccept` when both are set. */
  onAcceptList?: (list: ChipDragList, e: DragEvent<HTMLElement>) => void;
  /** Default 'shift' (matches DocEditor). 'always' for surfaces where the
   *  target is the only meaningful drop zone in its pane. */
  triggerMode?: ChipDropTriggerMode;
  /** Default 'copy'. Use 'link' for surfaces where the chip is a reference
   *  rather than an insertion (e.g. chat composer chip row). */
  dropEffect?: 'copy' | 'link';
  /** Set false to skip wiring. Useful for conditionally-enabled surfaces. */
  enabled?: boolean;
}

interface ChipDropTargetProps {
  onDragOver: (e: DragEvent<HTMLElement>) => void;
  onDragOverCapture: (e: DragEvent<HTMLElement>) => void;
  onDragLeave: (e: DragEvent<HTMLElement>) => void;
  onDrop: (e: DragEvent<HTMLElement>) => void;
  onDropCapture: (e: DragEvent<HTMLElement>) => void;
  'data-pane-drop-target': 'node-chip';
}

interface UseChipDropTargetResult {
  dropTargetProps: ChipDropTargetProps;
  isDragOver: boolean;
}

export const useChipDropTarget = ({
  onAccept,
  onAcceptList,
  triggerMode = 'shift',
  dropEffect = 'copy',
  enabled = true,
}: UseChipDropTargetOptions): UseChipDropTargetResult => {
  const [isDragOver, setIsDragOver] = useState(false);

  // Sticky: once we've accepted chip mode during a drag, stay in chip
  // mode through the drop even if the user releases Shift a few ms
  // before mouseup (otherwise the drop fires on the Pane below us).
  const stickyRef = useRef(false);

  // Latest callbacks captured by ref so the bound handlers don't churn
  // identity every render — callers can pass inline arrows safely.
  const onAcceptRef = useRef(onAccept);
  onAcceptRef.current = onAccept;
  const onAcceptListRef = useRef(onAcceptList);
  onAcceptListRef.current = onAcceptList;
  const triggerModeRef = useRef(triggerMode);
  triggerModeRef.current = triggerMode;
  const dropEffectRef = useRef(dropEffect);
  dropEffectRef.current = dropEffect;

  const isChipDrag = useCallback((e: DragEvent<HTMLElement>): boolean => {
    if (!hasChipDragData(e.dataTransfer)) return false;
    if (triggerModeRef.current === 'always') return true;
    return e.shiftKey || stickyRef.current;
  }, []);

  const handleDragOver = useCallback(
    (e: DragEvent<HTMLElement>) => {
      if (!enabled) return;
      if (!isChipDrag(e)) {
        // Shift released (or not a chip drag): drop affordances and let
        // the event keep bubbling so a parent (PaneChrome) can take over.
        if (isDragOver) setIsDragOver(false);
        return;
      }
      e.preventDefault();
      e.stopPropagation();
      e.dataTransfer.dropEffect = dropEffectRef.current;
      stickyRef.current = true;
      if (!isDragOver) setIsDragOver(true);
    },
    [enabled, isChipDrag, isDragOver]
  );

  const handleDragLeave = useCallback((e: DragEvent<HTMLElement>) => {
    // dragleave fires on every child enter; only clear when the cursor
    // truly leaves the target element.
    const related = e.relatedTarget as Node | null;
    if (related && e.currentTarget.contains(related)) return;
    setIsDragOver(false);
  }, []);

  const handleDrop = useCallback(
    (e: DragEvent<HTMLElement>) => {
      if (!enabled) return;
      if (!isChipDrag(e)) {
        setIsDragOver(false);
        stickyRef.current = false;
        return;
      }
      e.preventDefault();
      e.stopPropagation();
      setIsDragOver(false);
      stickyRef.current = false;
      const acceptList = onAcceptListRef.current;
      if (acceptList) {
        const list = readChipDragList(e.dataTransfer);
        if (list) acceptList(list, e);
        return;
      }
      const node = readChipDragData(e.dataTransfer);
      if (!node) return;
      onAcceptRef.current?.(node, e);
    },
    [enabled, isChipDrag]
  );

  // Safety net: clear sticky + highlight on any drag-end, including Escape
  // cancel and drops on chrome outside our element.
  useEffect(() => {
    const reset = () => {
      stickyRef.current = false;
      setIsDragOver(false);
    };
    window.addEventListener('dragend', reset);
    window.addEventListener('drop', reset);
    return () => {
      window.removeEventListener('dragend', reset);
      window.removeEventListener('drop', reset);
    };
  }, []);

  return {
    dropTargetProps: {
      onDragOver: handleDragOver,
      onDragOverCapture: handleDragOver,
      onDragLeave: handleDragLeave,
      onDrop: handleDrop,
      onDropCapture: handleDrop,
      'data-pane-drop-target': 'node-chip',
    },
    isDragOver,
  };
};
