/**
 * Minimal global "open this thread" bus for surfaces outside the Dashboard
 * navigation context. Prefer `useDashboardNavigation().openThread(...)` when
 * the caller is under `DashboardNavigationContext`. The Dashboard layout
 * mounts one listener that routes requests through `openThreadById`.
 */

const OPEN_THREAD_EVENT = 'snaglet:open-thread';

export interface OpenThreadRequest {
  threadId: string;
  /** Optional title, so the pane can paint its header before the fetch lands. */
  title?: string | null;
}

/** Ask the app to open a thread in the active pane. */
export function requestOpenThread(threadId: string, title?: string | null): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(
    new CustomEvent<OpenThreadRequest>(OPEN_THREAD_EVENT, { detail: { threadId, title } })
  );
}

/** Subscribe to open-thread requests. Returns an unsubscribe function. */
export function onOpenThread(handler: (request: OpenThreadRequest) => void): () => void {
  if (typeof window === 'undefined') return () => {};
  const listener = (event: Event): void => {
    const detail = (event as CustomEvent<OpenThreadRequest>).detail;
    if (detail?.threadId) handler(detail);
  };
  window.addEventListener(OPEN_THREAD_EVENT, listener);
  return () => window.removeEventListener(OPEN_THREAD_EVENT, listener);
}
