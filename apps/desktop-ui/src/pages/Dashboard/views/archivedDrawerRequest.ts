/**
 * Ask the Dashboard to open its Archived drawer from inside a pane. Panes sit
 * deep in the recursive layout, so a window event avoids threading a callback
 * through every split. `archivedDrawerReachable` tells a caller whether any
 * host is listening, so it never offers a button that does nothing.
 */

const OPEN_ARCHIVED_DRAWER_EVENT = 'snaglet:open-archived-drawer';

let hosts = 0;

export function requestArchivedDrawer(): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new Event(OPEN_ARCHIVED_DRAWER_EVENT));
}

export function archivedDrawerReachable(): boolean {
  return hosts > 0;
}

/** Register the drawer host; returns the unsubscribe. */
export function onArchivedDrawerRequest(open: () => void): () => void {
  if (typeof window === 'undefined') return () => undefined;
  const listener = () => open();
  window.addEventListener(OPEN_ARCHIVED_DRAWER_EVENT, listener);
  hosts += 1;
  return () => {
    window.removeEventListener(OPEN_ARCHIVED_DRAWER_EVENT, listener);
    hosts -= 1;
  };
}
