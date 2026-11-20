import { useCallback, useEffect, useRef, useState } from 'react';
import { getErrorMessage } from '@snaglet/shared/utils';
import { threadsApi, type ThreadMessage } from '@desktop/utils/api';
import { byCreatedAt, compareInstants } from '@desktop/utils/chronology';
import {
  doneBubbleId,
  errorBubbleId,
  groupActivityRows,
  isProvisionalId,
  mergeActivitySnapshot,
} from './chatStreamHelpers';
import type { RunActivity } from './types';

const MESSAGE_PAGE_SIZE = 50;

type MessagePage = Awaited<ReturnType<typeof threadsApi.getMessages>>;

/** A page of older or newer messages that could not be loaded. */
export interface PageError {
  edge: 'older' | 'newer';
  message: string;
}

/**
 * A pagination cursor must name a row the server has. `preferred` is the edge
 * of the last REST page; when it has gone missing (the thread was cleared) the
 * edge of the loaded window is the best remaining guess, skipping the
 * client-only provisional bubbles, which the server has never seen.
 */
function resolveCursor(
  preferred: string | null,
  loaded: ThreadMessage[],
  edge: 'oldest' | 'newest'
): string | null {
  if (preferred && loaded.some((m) => m.id === preferred)) return preferred;
  const ordered = edge === 'oldest' ? loaded : [...loaded].reverse();
  return ordered.find((m) => !isProvisionalId(m.id))?.id ?? null;
}

/**
 * Stitch the thread's latest page onto the loaded window. Server rows win over
 * local copies (they may carry fields the client missed while disconnected),
 * and a persisted assistant row retires the provisional bubbles for its run.
 * When the page does not reach back to the loaded window, older local rows are
 * dropped rather than left on the far side of an invisible gap.
 */
function mergeLatestPage(
  prev: ThreadMessage[],
  page: ThreadMessage[],
  keepFrom: string | null
): ThreadMessage[] {
  const pageIds = new Set(page.map((m) => m.id));
  const superseded = new Set<string>();
  for (const m of page) {
    if (m.role === 'assistant' && m.agentId && m.runId) {
      superseded.add(doneBubbleId(m.agentId, m.runId));
      superseded.add(errorBubbleId(m.agentId, m.runId));
    }
  }
  const kept = prev.filter(
    (m) =>
      !pageIds.has(m.id) &&
      !superseded.has(m.id) &&
      (keepFrom === null || compareInstants(m.createdAt, keepFrom) >= 0)
  );
  return [...page, ...kept].sort(byCreatedAt);
}

export interface ThreadHistory {
  /** Persisted messages from REST, merged with any WS frames that arrived first. */
  messages: ThreadMessage[];
  /** setMessages so the socket handler can append + dedup new persisted rows. */
  setMessages: React.Dispatch<React.SetStateAction<ThreadMessage[]>>;
  /** Per-run activity bubbles seeded from agent_activity_log. */
  activities: Map<string, RunActivity>;
  /** setActivities so the socket handler can apply live updates. */
  setActivities: React.Dispatch<React.SetStateAction<Map<string, RunActivity>>>;
  /** Agents currently on the thread. */
  participantAgentIds: string[];
  /** True while the initial REST fetch is in flight. */
  loading: boolean;
  /**
   * Why the thread's messages or participants could not be loaded; null when
   * the last load succeeded. While set, an empty message list or roster is a
   * failure, not a real empty thread.
   */
  error: string | null;
  /** Re-run the failed load on the same thread and focus. */
  retry: () => void;
  /** Manually re-pull participants — called after add/remove. */
  refetchParticipants: () => Promise<void>;
  /** True when there are messages older than the loaded window. */
  hasMoreOlder: boolean;
  /** True when there are messages newer than the loaded window (i.e. the
   *  user opened to an old chunk and hasn't caught up to the live tail). */
  hasMoreNewer: boolean;
  /** True while a paginate-older or -newer fetch is in flight. */
  paginating: boolean;
  /**
   * Why the last older or newer page could not be loaded; null once a page
   * loads or the thread reloads. The loaded window is still valid.
   */
  pageError: PageError | null;
  /** Prepend an older page. No-op when `hasMoreOlder` is false. */
  loadOlder: () => Promise<void>;
  /** Append a newer page. No-op when `hasMoreNewer` is false. */
  loadNewer: () => Promise<void>;
  /**
   * When the hook initialized in `around` mode (because the caller passed
   * a `focusMessageId`), this is that id — surfaces back to the chat view
   * so it can land on and highlight the matching row once per request. Null
   * on a regular open.
   */
  initialFocusMessageId: string | null;
  /**
   * The navigation request whose load produced `initialFocusMessageId`, set
   * in the same state update as the anchor (null while a load is in flight).
   * The chat view forwards this to the message list, so the list never sees a
   * new request next to a stale anchor.
   */
  initialFocusRequestId: number | null;
  /**
   * True when `initialFocusMessageId` came from a navigation (a message chip,
   * a search hit), which the list holds in view and highlights; false when a
   * `reload()` re-centered on a surviving message after a trim. Set in the same
   * state update as the anchor.
   */
  initialFocusIsNavigation: boolean;
  /**
   * Drop everything and re-pull messages, activity and participants, for when
   * the server deleted history under the open view (a trim) and no
   * incremental frame can describe it. `focusMessageId` re-centers the window
   * on a surviving message; omit it to load the latest page.
   */
  reload: (focusMessageId?: string | null) => void;
  /**
   * Catch up after frames may have been missed (a reconnect or a new WS
   * session): merge the latest page and activity log into what is loaded,
   * without clearing the view. Resolves with the rows that were new to the
   * client, so the caller can retire optimistic echoes the server already
   * persisted. Skips the message merge while the view is parked on an older
   * window — the gap is filled by `loadNewer` — and defers to a full retry
   * when the last load failed.
   */
  refreshLatest: () => Promise<ThreadMessage[]>;
}

export interface UseThreadHistoryOpts {
  /**
   * When set, the hook fetches a window of messages centered on this id
   * instead of the most recent page. Used by the chat view when opened
   * from a message search result.
   */
  focusMessageId?: string | null;
  /**
   * Identifies the navigation request that supplied `focusMessageId`. A new
   * value on an already-mounted thread re-centers on the (possibly same)
   * message; an unchanged value is an ordinary rerender and does nothing.
   */
  focusRequestId?: number | null;
}

/**
 * The REST side of a chat thread: message history, the activity log, and the
 * participant list, refetched on threadId change. The message fetch merges
 * with any WS frames that arrived first. Returns the setters too, so
 * useChatStream's frame handlers update the same state.
 */
export function useThreadHistory(threadId: string, opts: UseThreadHistoryOpts = {}): ThreadHistory {
  const { focusMessageId = null, focusRequestId = null } = opts;
  const [messages, setMessagesState] = useState<ThreadMessage[]>([]);
  /**
   * Mirror of `messages`, written as the update is applied rather than a commit
   * later, so the pagination cursors can be read at call time. `loadOlder` and
   * `loadNewer` also run from effects, where a `setMessages` updater is not
   * evaluated eagerly and could not supply the cursor.
   */
  const messagesRef = useRef<ThreadMessage[]>([]);
  const setMessages = useCallback<React.Dispatch<React.SetStateAction<ThreadMessage[]>>>(
    (action) => {
      setMessagesState((prev) => {
        const next =
          typeof action === 'function'
            ? (action as (p: ThreadMessage[]) => ThreadMessage[])(prev)
            : action;
        messagesRef.current = next;
        return next;
      });
    },
    []
  );
  const [activities, setActivities] = useState<Map<string, RunActivity>>(new Map());
  const [participantAgentIds, setParticipantAgentIds] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [hasMoreOlder, setHasMoreOlder] = useState(false);
  const [hasMoreNewer, setHasMoreNewer] = useState(false);
  const [paginating, setPaginating] = useState(false);
  const [pageError, setPageError] = useState<PageError | null>(null);
  const [initialFocusMessageId, setInitialFocusMessageId] = useState<string | null>(null);
  const [initialFocusRequestId, setInitialFocusRequestId] = useState<number | null>(null);
  const [initialFocusIsNavigation, setInitialFocusIsNavigation] = useState(false);
  // Track whether a paginate fetch is in flight so a fast double-click on
  // Load More doesn't fire two overlapping requests.
  const paginatingRef = useRef(false);
  /**
   * The edges of what REST has returned, tracked apart from the message list.
   * Live frames append at the tail, so in an `around` window the list's last
   * row can be a live message far past the loaded chunk; paging newer from it
   * would skip everything between the chunk and the live tail.
   */
  const olderCursorRef = useRef<string | null>(null);
  const newerCursorRef = useRef<string | null>(null);
  /** Bumped by every full load, so a late page or refresh from an earlier one is dropped. */
  const loadGenRef = useRef(0);
  const loadingRef = useRef(true);
  const errorRef = useRef<string | null>(null);
  const hasMoreNewerRef = useRef(false);
  useEffect(() => {
    hasMoreNewerRef.current = hasMoreNewer;
  }, [hasMoreNewer]);

  // Capture focusMessageId once per threadId: it's a one-shot scroll hint and
  // stays out of the effect deps, or a parent passing it on every render would
  // wipe and re-fetch the messages each time.
  const initialFocusRef = useRef<string | null>(null);
  const focusThreadRef = useRef<string | null>(null);
  const focusRequestRef = useRef<number | null>(null);
  // Whether the cursor above came from a navigation or from `reload()`.
  const focusFromNavigationRef = useRef(true);
  if (focusThreadRef.current !== threadId) {
    // New thread mounted — capture the focus hint exactly once.
    focusThreadRef.current = threadId;
    initialFocusRef.current = focusMessageId;
    focusRequestRef.current = focusRequestId;
    focusFromNavigationRef.current = true;
  }
  const focusCursor = initialFocusRef.current;
  // Bumped by `reload()` to re-run the load effect on the same thread.
  const [reloadNonce, setReloadNonce] = useState(0);

  // Same thread, new navigation request (a Cmd+K message hit while this
  // conversation is already open): re-capture the focus hint and re-run the
  // load so the `around` window and the one-shot scroll happen again — even
  // when the message id is the one already centered. Ordinary rerenders keep
  // the same request id and fall through untouched.
  useEffect(() => {
    if (focusRequestId === null || focusRequestRef.current === focusRequestId) return;
    focusRequestRef.current = focusRequestId;
    initialFocusRef.current = focusMessageId;
    focusFromNavigationRef.current = true;
    setReloadNonce((n) => n + 1);
  }, [focusRequestId, focusMessageId]);

  useEffect(() => {
    let canceled = false;
    loadGenRef.current += 1;
    loadingRef.current = true;
    errorRef.current = null;
    olderCursorRef.current = null;
    newerCursorRef.current = null;
    setMessages([]);
    setActivities(new Map());
    setParticipantAgentIds([]);
    setLoading(true);
    setError(null);
    setHasMoreOlder(false);
    setHasMoreNewer(false);
    setPageError(null);
    setInitialFocusMessageId(null);
    setInitialFocusRequestId(null);
    setInitialFocusIsNavigation(false);
    // Read once per load: the request effect below updates the ref before it
    // bumps `reloadNonce`, so this is the request this load belongs to.
    const loadRequestId = focusRequestRef.current;
    const loadIsNavigation = focusFromNavigationRef.current;

    const fail = (err: unknown) => {
      if (canceled || errorRef.current) return;
      const message = getErrorMessage(err);
      errorRef.current = message;
      setError(message);
    };

    const applyPage = (page: MessagePage) => {
      setMessages((prev) => {
        // Merge: keep any WS frames that arrived before REST resolved.
        const seen = new Set(page.messages.map((m) => m.id));
        const extras = prev.filter((m) => !seen.has(m.id));
        // Sort the union by createdAt to be safe — WS extras might be
        // newer than the loaded window.
        return [...page.messages, ...extras].sort(byCreatedAt);
      });
      olderCursorRef.current = page.messages[0]?.id ?? null;
      newerCursorRef.current = page.messages[page.messages.length - 1]?.id ?? null;
      setHasMoreOlder(page.hasMoreOlder);
      setHasMoreNewer(page.hasMoreNewer);
    };

    threadsApi
      .getActivityLog(threadId, { limit: 300 })
      .then((rows) => {
        if (canceled) return;
        setActivities(groupActivityRows(rows));
      })
      .catch((err: unknown) => {
        // Best-effort — the activity rail just stays empty.
        console.error('useThreadHistory: failed to load activity log', err);
      });

    const loadMessages = async () => {
      try {
        const page = await threadsApi.getMessages(threadId, {
          limit: MESSAGE_PAGE_SIZE,
          ...(focusCursor ? { around: focusCursor } : {}),
        });
        if (canceled) return;
        applyPage(page);
        if (page.anchorId) {
          setInitialFocusMessageId(page.anchorId);
          setInitialFocusRequestId(loadRequestId);
          setInitialFocusIsNavigation(loadIsNavigation);
        }
      } catch (err: unknown) {
        if (canceled) return;
        if (!focusCursor) {
          fail(err);
          return;
        }
        // An `around` fetch can fail because the focus message was deleted;
        // fall back to the latest page so the thread isn't left blank.
        try {
          const page = await threadsApi.getMessages(threadId, { limit: MESSAGE_PAGE_SIZE });
          if (canceled) return;
          applyPage(page);
        } catch (fallbackErr: unknown) {
          fail(fallbackErr);
        }
      } finally {
        if (!canceled) {
          loadingRef.current = false;
          setLoading(false);
        }
      }
    };
    void loadMessages();

    // Participants — separate fetch so the "no agents" empty state
    // resolves even when the thread has zero messages.
    threadsApi
      .listParticipants(threadId)
      .then((parts) => {
        if (!canceled) {
          setParticipantAgentIds(
            parts.map((p) => p.agentId).filter((id): id is string => Boolean(id))
          );
        }
      })
      // An empty roster would read as "no agents in this thread" and block
      // sending, so a failed fetch must surface as a failure, not as empty.
      .catch(fail);

    return () => {
      canceled = true;
    };
  }, [threadId, focusCursor, reloadNonce, setMessages]);

  const reload = useCallback((focusMessageId: string | null = null) => {
    // Setting the ref before the bump means the re-run reads this cursor. Pass
    // a surviving message id to land the user back at the cut; pass nothing and
    // the re-run fetches the latest page rather than `around` a deleted message.
    initialFocusRef.current = focusMessageId;
    focusFromNavigationRef.current = false;
    setReloadNonce((n) => n + 1);
  }, []);

  const retry = useCallback(() => {
    setReloadNonce((n) => n + 1);
  }, []);

  const refreshLatest = useCallback(async (): Promise<ThreadMessage[]> => {
    // A full load in flight lands the same state; merging now would race it.
    if (loadingRef.current) return [];
    if (errorRef.current) {
      retry();
      return [];
    }
    const gen = loadGenRef.current;
    const activityPromise = threadsApi
      .getActivityLog(threadId, { limit: 300 })
      .catch((err: unknown) => {
        console.error('useThreadHistory: failed to refresh activity log', err);
        return null;
      });
    let added: ThreadMessage[] = [];
    if (!hasMoreNewerRef.current) {
      const heldBefore = new Set(messagesRef.current.map((m) => m.id));
      let page: MessagePage;
      try {
        page = await threadsApi.getMessages(threadId, { limit: MESSAGE_PAGE_SIZE });
      } catch (err: unknown) {
        // Best-effort: the loaded view is still valid, just possibly stale.
        console.error('useThreadHistory: failed to refresh messages', err);
        return [];
      }
      if (gen !== loadGenRef.current || hasMoreNewerRef.current) return [];
      const loadedIds = new Set(messagesRef.current.map((m) => m.id));
      // Rows older than the window are history the view never held, not
      // frames it missed — they must not be mistaken for a persisted send.
      const windowStart = messagesRef.current.find((m) => m.id === olderCursorRef.current);
      added = page.messages.filter(
        (m) =>
          !loadedIds.has(m.id) &&
          (!windowStart || compareInstants(m.createdAt, windowStart.createdAt) >= 0)
      );
      // The page stitches onto the window when it shares a row the client held
      // before this refresh began; rows that stream in during the fetch are
      // past the gap, so overlap with them would prove nothing.
      const pageOldest = page.messages[0];
      const reachesLoaded =
        !pageOldest ||
        !page.hasMoreOlder ||
        heldBefore.size === 0 ||
        page.messages.some((m) => heldBefore.has(m.id));
      const keepFrom = reachesLoaded || !pageOldest ? null : pageOldest.createdAt;
      setMessages((prev) => mergeLatestPage(prev, page.messages, keepFrom));
      if (pageOldest && (!reachesLoaded || olderCursorRef.current === null)) {
        olderCursorRef.current = pageOldest.id;
        setHasMoreOlder(page.hasMoreOlder);
      }
      const pageNewest = page.messages[page.messages.length - 1];
      if (pageNewest) newerCursorRef.current = pageNewest.id;
    }
    const rows = await activityPromise;
    if (rows && gen === loadGenRef.current) {
      const snapshot = groupActivityRows(rows);
      setActivities((prev) => mergeActivitySnapshot(prev, snapshot));
    }
    return added;
  }, [threadId, retry, setMessages]);

  const refetchParticipants = useCallback(async () => {
    // A roster that lands after the view moved to another thread (or
    // reloaded) belongs to that earlier load and must not replace this one.
    const gen = loadGenRef.current;
    try {
      const parts = await threadsApi.listParticipants(threadId);
      if (gen !== loadGenRef.current) return;
      setParticipantAgentIds(parts.map((p) => p.agentId).filter((id): id is string => Boolean(id)));
    } catch (err: unknown) {
      // Best-effort: the roster from the last load stays in place.
      console.error('useThreadHistory: failed to refresh participants', err);
    }
  }, [threadId]);

  const loadOlder = useCallback(async () => {
    if (paginatingRef.current) return;
    // Bail when the window is empty (still loading the initial page).
    const cursorId = resolveCursor(olderCursorRef.current, messagesRef.current, 'oldest');
    if (!cursorId) return;
    const gen = loadGenRef.current;
    paginatingRef.current = true;
    setPaginating(true);
    try {
      const page = await threadsApi.getMessages(threadId, {
        before: cursorId,
        limit: MESSAGE_PAGE_SIZE,
      });
      if (gen !== loadGenRef.current) return;
      setMessages((prev) => {
        const seen = new Set(prev.map((m) => m.id));
        const additions = page.messages.filter((m) => !seen.has(m.id));
        return [...additions, ...prev];
      });
      olderCursorRef.current = page.messages[0]?.id ?? cursorId;
      setHasMoreOlder(page.hasMoreOlder);
      setPageError(null);
    } catch (err: unknown) {
      // The button stays, so the user can retry.
      if (gen === loadGenRef.current) {
        setPageError({ edge: 'older', message: getErrorMessage(err) });
      }
    } finally {
      paginatingRef.current = false;
      setPaginating(false);
    }
  }, [threadId, setMessages]);

  const loadNewer = useCallback(async () => {
    if (paginatingRef.current) return;
    const cursorId = resolveCursor(newerCursorRef.current, messagesRef.current, 'newest');
    if (!cursorId) return;
    const gen = loadGenRef.current;
    paginatingRef.current = true;
    setPaginating(true);
    try {
      const page = await threadsApi.getMessages(threadId, {
        after: cursorId,
        limit: MESSAGE_PAGE_SIZE,
      });
      if (gen !== loadGenRef.current) return;
      setMessages((prev) => {
        const seen = new Set(prev.map((m) => m.id));
        const additions = page.messages.filter((m) => !seen.has(m.id));
        // Live rows may already sit past this page; keep the union in order.
        return [...prev, ...additions].sort(byCreatedAt);
      });
      newerCursorRef.current = page.messages[page.messages.length - 1]?.id ?? cursorId;
      setHasMoreNewer(page.hasMoreNewer);
      setPageError(null);
    } catch (err: unknown) {
      // Scrolling to the end again retries.
      if (gen === loadGenRef.current) {
        setPageError({ edge: 'newer', message: getErrorMessage(err) });
      }
    } finally {
      paginatingRef.current = false;
      setPaginating(false);
    }
  }, [threadId, setMessages]);

  return {
    messages,
    setMessages,
    activities,
    setActivities,
    participantAgentIds,
    loading,
    error,
    retry,
    refetchParticipants,
    hasMoreOlder,
    hasMoreNewer,
    paginating,
    pageError,
    loadOlder,
    loadNewer,
    initialFocusMessageId,
    initialFocusRequestId,
    initialFocusIsNavigation,
    reload,
    refreshLatest,
  };
}
