import { useCallback, useEffect, useMemo, useState } from 'react';

/** The modifier keys of the click or key press that picks a row. */
export interface RowSelectionEvent {
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
}

/**
 * Multi-selection over rows drawn in `visibleOrder` — the gestures every
 * sidebar tree that selects several rows shares (the workspace tree, the
 * Database sidebar): a plain click selects one row, cmd/ctrl-click toggles a
 * row, shift-click selects the drawn range from the anchor, and Escape
 * (outside a text field) clears the selection. Each tree holds its own
 * selection; selecting in one never selects in another.
 */
export function useRowSelection(visibleOrder: readonly string[]) {
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set());
  const [selectionAnchorId, setSelectionAnchorId] = useState<string | null>(null);

  const visibleOrderIndex = useMemo(() => {
    const m = new Map<string, number>();
    visibleOrder.forEach((id, i) => m.set(id, i));
    return m;
  }, [visibleOrder]);

  /**
   * Apply a click to the selection: shift selects the visible range from the
   * anchor, cmd/ctrl toggles one row, a plain click selects just this row.
   * Returns true for a plain click, which also opens the row.
   */
  const selectRow = (id: string, e: RowSelectionEvent): boolean => {
    const meta = e.metaKey || e.ctrlKey;
    if (e.shiftKey && selectionAnchorId && visibleOrderIndex.has(selectionAnchorId)) {
      const a = visibleOrderIndex.get(selectionAnchorId)!;
      const b = visibleOrderIndex.get(id);
      if (b === undefined) return false;
      const lo = Math.min(a, b);
      const hi = Math.max(a, b);
      const next = new Set<string>();
      for (let i = lo; i <= hi; i++) {
        next.add(visibleOrder[i]);
      }
      setSelectedIds(next);
      return false;
    }
    if (meta) {
      setSelectedIds((prev) => {
        const next = new Set(prev);
        if (next.has(id)) next.delete(id);
        else next.add(id);
        return next;
      });
      setSelectionAnchorId(id);
      return false;
    }
    setSelectedIds(new Set([id]));
    setSelectionAnchorId(id);
    return true;
  };

  const clearSelection = useCallback(() => {
    setSelectedIds(new Set());
    setSelectionAnchorId(null);
  }, []);

  useEffect(() => {
    if (selectedIds.size === 0) return;
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA') return;
      clearSelection();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [selectedIds.size, clearSelection]);

  return {
    selectedIds,
    setSelectedIds,
    selectionAnchorId,
    setSelectionAnchorId,
    visibleOrderIndex,
    selectRow,
    clearSelection,
  };
}
