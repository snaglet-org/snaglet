import { containersApi, type LibraryTreeChild } from '@desktop/utils/api';
import { createCoalescedRefetch, type CoalescedRefetch } from './coalescedRefetch';

/** Minimum spacing of full-tree fetches, so the events of one burst share a fetch. */
const WORKSPACE_TREE_GAP_MS = 120;
/** A tree request still pending after this is aborted and settles as a failure. */
const WORKSPACE_TREE_TIMEOUT_MS = 30_000;

interface WorkspaceTreeListener {
  /** A fetch is starting. Called before its `onTree` / `onError`. */
  onStart?: () => void;
  /** A fetch landed. The array is shared by every listener: read it, never mutate it. */
  onTree: (tree: LibraryTreeChild[]) => void;
  /** A fetch failed. */
  onError: (err: unknown) => void;
}

export interface WorkspaceTreeSubscription {
  /** Ask for a fresh full tree. Cheap to call once per event. */
  request: () => void;
  /** Stop listening. The last subscriber to close cancels pending work. */
  close: () => void;
}

interface Feed {
  listeners: Set<WorkspaceTreeListener>;
  refetch: CoalescedRefetch;
  stop: () => void;
}

let feed: Feed | null = null;

/**
 * One tree request that cannot hang the feed: it settles as a failure once
 * `abort` is called, by the timeout or by the feed stopping, whether or not
 * the transport honors the signal.
 */
async function fetchTree(
  onAbortable: (abort: (reason: Error) => void) => void
): Promise<LibraryTreeChild[]> {
  const controller = new AbortController();
  let reason = new Error('The workspace tree request was canceled');
  const aborted = new Promise<never>((_, reject) => {
    controller.signal.addEventListener('abort', () => reject(reason), { once: true });
  });
  const abort = (why: Error) => {
    reason = why;
    controller.abort();
  };
  onAbortable(abort);
  const timer = setTimeout(
    () => abort(new Error('The workspace tree request timed out')),
    WORKSPACE_TREE_TIMEOUT_MS
  );
  try {
    const tree = await Promise.race([
      containersApi.listTree(null, { signal: controller.signal }),
      aborted,
    ]);
    return tree ?? [];
  } finally {
    clearTimeout(timer);
  }
}

function createFeed(): Feed {
  const listeners = new Set<WorkspaceTreeListener>();
  let live = true;
  let abortInFlight: ((reason: Error) => void) | null = null;
  const refetch = createCoalescedRefetch(async () => {
    for (const listener of [...listeners]) listener.onStart?.();
    try {
      const tree = await fetchTree((abort) => {
        abortInFlight = abort;
      });
      if (!live) return;
      for (const listener of [...listeners]) listener.onTree(tree);
    } catch (err) {
      if (!live) return;
      for (const listener of [...listeners]) listener.onError(err);
    } finally {
      abortInFlight = null;
    }
  }, WORKSPACE_TREE_GAP_MS);
  return {
    listeners,
    refetch,
    stop: () => {
      live = false;
      refetch.dispose();
      abortInFlight?.(new Error('The workspace tree request was canceled'));
    },
  };
}

/**
 * The one full workspace tree request (`GET /api/containers/tree`) shared by
 * the sidebar tree and every pane's path header, so a burst of realtime
 * events costs a handful of fetches in total rather than a handful per
 * reader, and every reader gets the same response instead of its own copy.
 *
 * Requests from all subscribers go through one `createCoalescedRefetch`: at
 * most one fetch in flight, starts at least `WORKSPACE_TREE_GAP_MS` apart
 * (a request after a quiet spell starts at once), and every request is
 * followed by a fetch that starts after it. Each landed fetch reaches every
 * current subscriber, including fetches another subscriber asked for. When
 * the last subscriber closes, a pending start is canceled and a request
 * still in flight is aborted and dropped; the next subscriber starts afresh.
 * A request that hangs is aborted after `WORKSPACE_TREE_TIMEOUT_MS` and
 * reaches subscribers as a failure, so later requests fetch again.
 */
export function subscribeWorkspaceTree(listener: WorkspaceTreeListener): WorkspaceTreeSubscription {
  if (!feed) feed = createFeed();
  const own = feed;
  own.listeners.add(listener);
  let open = true;
  return {
    request: () => {
      if (open) own.refetch.request();
    },
    close: () => {
      if (!open) return;
      open = false;
      own.listeners.delete(listener);
      if (own.listeners.size > 0) return;
      own.stop();
      if (feed === own) feed = null;
    },
  };
}
