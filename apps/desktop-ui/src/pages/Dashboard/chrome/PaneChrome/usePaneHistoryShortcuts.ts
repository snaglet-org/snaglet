import { useEffect, useRef } from 'react';
import { paneShortcutFor } from './paneShortcuts';

interface PaneHistoryShortcutTargets {
  canGoBack: boolean;
  canGoForward: boolean;
  onGoBack: () => void;
  onGoForward: () => void;
  /** Opens the Recently visited menu with keyboard focus in it. */
  onOpenHistory: () => void;
  /** Opens the parent of what the pane shows; null when nothing is above it. */
  onGoUp: (() => void) | null;
}

/**
 * The active pane's navigation shortcuts (see paneShortcuts.ts): ⌘[ / ⌘]
 * back and forward, as in Safari, Chrome and Notion; ⌘Y for Recently
 * visited, as in Safari; ⌘↑ for the enclosing folder, as in Finder. Scoped to the active
 * pane so a split layout does not move every pane at once.
 *
 * Latest targets live in a ref so the listener doesn't re-bind on every
 * history step.
 */
export function usePaneHistoryShortcuts(
  isActive: boolean,
  targets: PaneHistoryShortcutTargets
): void {
  const targetsRef = useRef(targets);
  targetsRef.current = targets;

  useEffect(() => {
    if (!isActive) return;
    const onKey = (e: KeyboardEvent) => {
      const shortcut = paneShortcutFor(e);
      const current = targetsRef.current;
      switch (shortcut) {
        case 'back':
          e.preventDefault();
          if (current.canGoBack) current.onGoBack();
          return;
        case 'forward':
          e.preventDefault();
          if (current.canGoForward) current.onGoForward();
          return;
        case 'history':
          e.preventDefault();
          // A held combo would toggle the menu open and shut.
          if (!e.repeat) current.onOpenHistory();
          return;
        case 'up':
          // Without a parent, ⌘↑ keeps its page meaning (scroll to the top).
          if (!current.onGoUp) return;
          e.preventDefault();
          current.onGoUp();
          return;
        default:
          return;
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [isActive]);
}
