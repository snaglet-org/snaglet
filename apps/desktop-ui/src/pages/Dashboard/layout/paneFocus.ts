import type { PaneBox } from './paneNeighbors';

/**
 * Keyboard focus across panes. Each pane remembers the last element focused
 * inside it, so moving back to a pane from the keyboard puts the caret where
 * it was (the doc editor mid-sentence) rather than at the top of the pane.
 */
const lastFocused = new Map<string, HTMLElement>();

export function rememberPaneFocus(leafId: string, element: HTMLElement): void {
  lastFocused.set(leafId, element);
}

export function forgetPaneFocus(leafId: string): void {
  lastFocused.delete(leafId);
}

function paneElement(leafId: string): HTMLElement | null {
  for (const pane of document.querySelectorAll<HTMLElement>('[data-leaf-id]')) {
    if (pane.dataset.leafId === leafId) return pane;
  }
  return null;
}

/** The on-screen boxes of the given panes (those that are rendered). */
export function paneBoxes(leafIds: string[]): PaneBox[] {
  return leafIds.flatMap((id) => {
    const pane = paneElement(id);
    if (!pane) return [];
    const { left, top, right, bottom } = pane.getBoundingClientRect();
    return [{ id, left, top, right, bottom }];
  });
}

/**
 * Move keyboard focus into a pane: to where it last was there, else to the
 * pane's first enabled chrome control (back, forward, Recently visited, …).
 */
export function focusPane(leafId: string): void {
  const pane = paneElement(leafId);
  if (!pane) return;
  const last = lastFocused.get(leafId);
  const target =
    last && last.isConnected && pane.contains(last)
      ? last
      : pane.querySelector<HTMLElement>('[data-pane-chrome-zone] button:not(:disabled)');
  target?.focus({ preventScroll: true });
}
