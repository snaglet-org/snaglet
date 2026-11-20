import { useEffect, useRef } from 'react';
import { paneShortcutFor, type PaneShortcut } from '../chrome/PaneChrome/paneShortcuts';
import { focusPane, paneBoxes } from './paneFocus';
import { paneInDirection, paneInOrder, type PaneDirection } from './paneNeighbors';
import { leafIds, type LayoutNode } from './paneTree';

const DIRECTIONS: Partial<Record<PaneShortcut, PaneDirection>> = {
  focusLeft: 'left',
  focusRight: 'right',
  focusUp: 'up',
  focusDown: 'down',
};

/**
 * ⌘⌥ + arrow moves to the pane beside the active one, ⌃Tab / ⌃⇧Tab to the
 * next / previous pane in reading order. The pane becomes active, so the
 * history keys (⌘[, ⌘], ⌘Y) then act on its history, and keyboard focus
 * moves into it. They work while typing; with a single pane the keys are
 * left alone.
 */
export function usePaneFocusShortcuts(
  layout: LayoutNode,
  activeLeafId: string | null,
  onSelectLeaf: (leafId: string) => void
): void {
  const latest = useRef({ layout, activeLeafId, onSelectLeaf });
  latest.current = { layout, activeLeafId, onSelectLeaf };

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const shortcut = paneShortcutFor(event);
      const direction = shortcut ? DIRECTIONS[shortcut] : undefined;
      const cycle = shortcut === 'focusNext' ? 1 : shortcut === 'focusPrevious' ? -1 : null;
      if (!direction && cycle === null) return;
      const current = latest.current;
      const ids = leafIds(current.layout);
      if (ids.length < 2) return;
      event.preventDefault();
      const from =
        current.activeLeafId && ids.includes(current.activeLeafId) ? current.activeLeafId : null;
      const target =
        cycle !== null
          ? paneInOrder(ids, from, cycle)
          : from && direction
            ? paneInDirection(paneBoxes(ids), from, direction)
            : ids[0];
      if (!target || target === from) return;
      current.onSelectLeaf(target);
      focusPane(target);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
}
