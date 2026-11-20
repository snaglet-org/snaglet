/**
 * Loads the visible window's occurrences.
 *
 * - Keeps the previous window's items on screen until the new ones arrive
 *   (no flash), and exposes `loading` for the thin progress bar.
 * - A small cache keyed by the query string serves a range instantly when it
 *   was prefetched (`adjacent`: the ranges before and after, and the
 *   enclosing month or week a view switch would show, are read after each
 *   load, one at a time so they never crowd the tables' few connections).
 * - Realtime: `calendar:changed` (raw workspace channel) and relevant table
 *   events trigger one coalesced (~250 ms trailing) refetch of the visible
 *   window only; the echo of our own write is skipped. A refetch while that
 *   same window is still being read lets the read land and then reads once
 *   more, so steady changes elsewhere can't keep a slow range from ever
 *   showing.
 */
import { useCallback, useContext, useEffect, useRef, useState } from 'react';
import type {
  Calendar,
  CalendarIntervalSpan,
  CalendarOccurrence,
  CalendarOccurrencesQuery,
  CalendarOccurrencesResponse,
  CalendarTruncatedRow,
} from '@snaglet/shared/types';
import { getErrorMessage } from '@snaglet/shared/utils';
import { WORKSPACE_EVENT_CHANNEL } from '@snaglet/shared/types/workspace-events';
import { WebSocketContext } from '@desktop/ws/WebSocketContext';
import { changedEntryIds, subscribeTableEvents } from '@desktop/features/database/tableEvents';
import { onLibraryEvent } from '@desktop/utils/workspaceEvents';
import { calendarApi, occurrencesSearch } from './calendarApi';
import {
  createCoalescer,
  isOwnEcho,
  isOwnEchoOfAll,
  parseCalendarChanged,
  relevantTableChange,
} from './calendarRealtime';
import { loadCalendars } from './calendarStore';

const CACHE_LIMIT = 8;

export interface OccurrencesState {
  occurrences: CalendarOccurrence[];
  /** Every automations: a span per day each is active (kept apart from the items). */
  intervals: CalendarIntervalSpan[];
  unavailable: CalendarOccurrencesResponse['unavailable'];
  /** Rows that repeat too often to show every time in the window (only their first ones are here). */
  truncated: CalendarTruncatedRow[];
  loading: boolean;
  error: string | null;
  /** Range the shown items belong to (may lag the requested one while loading). */
  shownKey: string | null;
  refetch: () => void;
  /** Apply a local change immediately (optimistic create/edit/delete). */
  patchLocal: (update: (list: CalendarOccurrence[]) => CalendarOccurrence[]) => void;
}

export function useCalendarOccurrences(
  query: CalendarOccurrencesQuery | null,
  options: { calendars: readonly Calendar[]; adjacent?: CalendarOccurrencesQuery[] }
): OccurrencesState {
  const key = query ? occurrencesSearch(query) : null;
  const [data, setData] = useState<{
    key: string | null;
    occurrences: CalendarOccurrence[];
    intervals: CalendarIntervalSpan[];
    unavailable: CalendarOccurrencesResponse['unavailable'];
    truncated: CalendarTruncatedRow[];
  }>({ key: null, occurrences: [], intervals: [], unavailable: [], truncated: [] });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const cache = useRef(new Map<string, CalendarOccurrencesResponse>());
  /** Bumped when the cache is cleared: a reply requested before that is stale. */
  const cacheGen = useRef(0);
  const seq = useRef(0);
  /** Key of the newest request (the one whose reply may be shown). */
  const requested = useRef<string | null>(null);
  /** Key of the read in flight, else null. */
  const inflight = useRef<string | null>(null);
  /** A realtime change came in while that read was out: read again once it lands. */
  const readAgain = useRef(false);
  const queryRef = useRef(query);
  queryRef.current = query;
  const calendarsRef = useRef(options.calendars);
  calendarsRef.current = options.calendars;
  const adjacentRef = useRef(options.adjacent);
  adjacentRef.current = options.adjacent;

  const clearCache = () => {
    cache.current.clear();
    cacheGen.current += 1;
  };
  /** Cache a reply, unless the cache was cleared since it was requested (`gen`). */
  const remember = (k: string, res: CalendarOccurrencesResponse, gen: number) => {
    if (gen !== cacheGen.current) return;
    cache.current.delete(k);
    cache.current.set(k, res);
    while (cache.current.size > CACHE_LIMIT) {
      cache.current.delete(cache.current.keys().next().value!);
    }
  };

  const prefetch = useCallback(() => {
    const queue = [...(adjacentRef.current ?? [])];
    const next = (): void => {
      const q = queue.shift();
      if (!q) return;
      const k = occurrencesSearch(q);
      if (cache.current.has(k)) return next();
      const gen = cacheGen.current;
      calendarApi
        .occurrences(q)
        .then((res) => remember(k, res, gen))
        .catch((err: unknown) => {
          // Prefetch is best-effort; the real load reports its own errors.
          console.debug('[calendar] prefetch failed', getErrorMessage(err, 'unknown'));
        })
        .finally(next);
    };
    next();
  }, []);

  const fetchNow = useCallback(
    (opts: { invalidate?: boolean; background?: boolean } = {}) => {
      const q = queryRef.current;
      if (!q) return;
      const k = occurrencesSearch(q);
      if (opts.invalidate) clearCache();
      // A realtime refresh of the window already being read: let that read
      // land (its reply isn't cached, the cache was just cleared), then read again.
      if (opts.background && inflight.current === k) {
        readAgain.current = true;
        return;
      }
      readAgain.current = false;
      inflight.current = k;
      const gen = cacheGen.current;
      requested.current = k;
      const id = ++seq.current;
      setLoading(true);
      calendarApi
        .occurrences(q)
        .then((res) => {
          remember(k, res, gen);
          if (id !== seq.current) return;
          // Only the window being rendered may replace what's shown (a reply
          // for a range the pane has since resized or navigated away from
          // must not stand in for the new one).
          const current = queryRef.current;
          if (!current || occurrencesSearch(current) !== k) return;
          setData({
            key: k,
            occurrences: res.occurrences,
            intervals: res.intervals ?? [],
            unavailable: res.unavailable,
            truncated: res.truncated ?? [],
          });
          setError(null);
          prefetch();
        })
        .catch((err: unknown) => {
          if (id !== seq.current) return;
          setError(getErrorMessage(err, "Couldn't load this range"));
        })
        .finally(() => {
          if (id !== seq.current) return;
          setLoading(false);
          inflight.current = null;
          if (readAgain.current) fetchAgain.current();
        });
    },
    [prefetch]
  );
  const fetchAgain = useRef(() => fetchNow({ invalidate: true }));

  // Range / filter change: serve from cache at once, then revalidate.
  useEffect(() => {
    if (!key) return;
    const cached = cache.current.get(key);
    if (cached) {
      setData({
        key,
        occurrences: cached.occurrences,
        intervals: cached.intervals ?? [],
        unavailable: cached.unavailable,
        truncated: cached.truncated ?? [],
      });
    }
    fetchNow();
  }, [key, fetchNow]);

  // Coverage: whatever changed the rendered range (navigation, a view change,
  // or the pane resizing Day → Week), once nothing is loading the shown items
  // must be for that range; if they aren't, fetch it.
  useEffect(() => {
    if (!key || loading || error !== null || data.key === key || requested.current === key) {
      return;
    }
    fetchNow();
  }, [key, loading, error, data.key, fetchNow]);

  // Realtime, coalesced.
  const coalescer = useRef(createCoalescer(() => fetchNow({ invalidate: true, background: true })));
  useEffect(() => () => coalescer.current.cancel(), []);
  const calendarsCoalescer = useRef(createCoalescer(() => void loadCalendars()));
  useEffect(() => () => calendarsCoalescer.current.cancel(), []);

  useEffect(
    () =>
      subscribeTableEvents((event) => {
        if (!relevantTableChange(event, calendarsRef.current)) return;
        if (event.type === 'table.entries.changed') {
          // Our own write's echo only when every entry it names is ours; a
          // batch too big to list (`allEntries`) always refetches.
          const ids = changedEntryIds(event);
          if (ids && isOwnEchoOfAll(ids.map((id) => `entry:${event.tableId}:${id}`))) return;
        }
        if (event.type !== 'table.entries.changed') calendarsCoalescer.current.trigger();
        coalescer.current.trigger();
      }),
    []
  );

  useEffect(
    () =>
      onLibraryEvent((event) => {
        // A deleted event is an archived node; restoring it brings it back.
        if (event.type === 'archive-changed' || event.type === 'tree-invalidated') {
          coalescer.current.trigger();
        }
      }),
    []
  );

  const ws = useContext(WebSocketContext);
  const addMessageListener = ws?.addMessageListener;
  useEffect(() => {
    if (!addMessageListener) return;
    return addMessageListener((message) => {
      if (message.channel !== WORKSPACE_EVENT_CHANNEL) return;
      const change = parseCalendarChanged(message as { type?: unknown; payload?: unknown });
      if (!change) return;
      if (change.kind !== 'event' || !change.eventId || !isOwnEcho(`event:${change.eventId}`)) {
        coalescer.current.trigger();
      }
      // Event and automation changes never touch the calendar list.
      if (change.kind !== 'event' && change.kind !== 'automation')
        calendarsCoalescer.current.trigger();
    });
  }, [addMessageListener]);

  const refetch = useCallback(() => fetchNow({ invalidate: true }), [fetchNow]);
  const patchLocal = useCallback((update: (list: CalendarOccurrence[]) => CalendarOccurrence[]) => {
    clearCache();
    setData((prev) => ({ ...prev, occurrences: update(prev.occurrences) }));
  }, []);

  return {
    occurrences: data.occurrences,
    intervals: data.intervals,
    unavailable: data.unavailable,
    truncated: data.truncated,
    loading,
    error,
    shownKey: data.key,
    refetch,
    patchLocal,
  };
}
