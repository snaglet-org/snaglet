import { useSyncExternalStore } from 'react';

/**
 * Which threads currently have a chat pane mounted (ChatView / DmView). An ask
 * for one of these is already answerable in that pane's composer, so the
 * agent-popup stack only shows asks for threads that are NOT in this set.
 * Counted, because the same thread can be open in two panes.
 */
const counts = new Map<string, number>();
let snapshot: ReadonlySet<string> = new Set();
const listeners = new Set<() => void>();

const publish = (): void => {
  snapshot = new Set(counts.keys());
  listeners.forEach((fn) => fn());
};

/** Mark a thread's chat as in view; returns the function that releases it. */
export function registerViewedThread(threadId: string): () => void {
  counts.set(threadId, (counts.get(threadId) ?? 0) + 1);
  publish();
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const next = (counts.get(threadId) ?? 1) - 1;
    if (next <= 0) counts.delete(threadId);
    else counts.set(threadId, next);
    publish();
  };
}

export function useViewedThreads(): ReadonlySet<string> {
  return useSyncExternalStore(
    (fn) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    () => snapshot
  );
}
