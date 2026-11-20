/**
 * Loads a whole year's occurrences for the Year view. The server answers a
 * window of at most CALENDAR_OCCURRENCES_MAX_DAYS (62), so a year is read as
 * six two-month windows, one after another, and joined; an item that runs across
 * a window boundary comes back from both and is kept once, by key. One at a
 * time, not in parallel: each read takes database connections, and the role
 * has only a handful ("too many connections for role snaglet_tables_reader").
 *
 * Like `useCalendarOccurrences`, the previous year stays on screen until the
 * next one arrives, and the same realtime changes trigger one coalesced
 * refetch (the echo of our own write is skipped). A change heard while the
 * year is still being read lets that read finish and then reads once more:
 * six windows take a while, and steady changes would otherwise restart the
 * read forever.
 */
import { useCallback, useContext, useEffect, useRef, useState } from 'react';
import type { Calendar, CalendarOccurrence } from '@snaglet/shared/types';
import { getErrorMessage } from '@snaglet/shared/utils';
import { WORKSPACE_EVENT_CHANNEL } from '@snaglet/shared/types/workspace-events';
import { WebSocketContext } from '@desktop/ws/WebSocketContext';
import { changedEntryIds, subscribeTableEvents } from '@desktop/features/database/tableEvents';
import { onLibraryEvent } from '@desktop/utils/workspaceEvents';
import { calendarApi } from './calendarApi';
import {
  createCoalescer,
  isOwnEcho,
  isOwnEchoOfAll,
  parseCalendarChanged,
  relevantTableChange,
} from './calendarRealtime';

export interface YearQuery {
  year: number;
  tz: string;
  calendarIds?: string[];
  projectId?: string;
}

export interface YearOccurrencesState {
  occurrences: CalendarOccurrence[];
  loading: boolean;
  error: string | null;
  /** The year the shown items belong to (may lag the requested one while loading). */
  shownYear: number | null;
  refetch: () => void;
}

const pad = (n: number) => String(n).padStart(2, '0');

/**
 * Windows read at the same time. One: the database role that reads the
 * tables allows only a few connections, and even two windows together were
 * refused ("too many connections for role") while the pane's own reads ran.
 */
const PARALLEL_WINDOWS = 1;

/**
 * The six two-month windows of `year`: `from` inclusive, `to` exclusive. The
 * longest (Jul + Aug) is 62 days, the most one request may ask for.
 */
export function yearWindows(year: number): Array<{ from: string; to: string }> {
  return Array.from({ length: 6 }, (_, i) => ({
    from: `${year}-${pad(i * 2 + 1)}-01`,
    to: i === 5 ? `${year + 1}-01-01` : `${year}-${pad(i * 2 + 3)}-01`,
  }));
}

export function useYearOccurrences(
  query: YearQuery | null,
  options: { calendars: readonly Calendar[] }
): YearOccurrencesState {
  const key = query ? JSON.stringify(query) : null;
  const [data, setData] = useState<{ year: number | null; occurrences: CalendarOccurrence[] }>({
    year: null,
    occurrences: [],
  });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const seq = useRef(0);
  /** The query being read, else null. */
  const inflight = useRef<string | null>(null);
  /** A realtime change came in while that read was out: read again once it lands. */
  const readAgain = useRef(false);
  const queryRef = useRef(query);
  queryRef.current = query;
  const calendarsRef = useRef(options.calendars);
  calendarsRef.current = options.calendars;

  const fetchNow = useCallback((opts: { background?: boolean } = {}) => {
    const q = queryRef.current;
    if (!q) return;
    const k = JSON.stringify(q);
    if (opts.background && inflight.current === k) {
      readAgain.current = true;
      return;
    }
    readAgain.current = false;
    inflight.current = k;
    const id = ++seq.current;
    setLoading(true);
    const readWindow = (w: { from: string; to: string }) =>
      calendarApi.occurrences({
        from: w.from,
        to: w.to,
        tz: q.tz,
        ...(q.calendarIds ? { calendarIds: q.calendarIds } : {}),
        ...(q.projectId ? { projectId: q.projectId } : {}),
      });
    const readAll = async () => {
      const windows = yearWindows(q.year);
      const results: Awaited<ReturnType<typeof readWindow>>[] = [];
      for (let i = 0; i < windows.length; i += PARALLEL_WINDOWS) {
        // A reply for a year the pane has since left: stop asking for the rest.
        if (id !== seq.current) break;
        results.push(
          ...(await Promise.all(windows.slice(i, i + PARALLEL_WINDOWS).map(readWindow)))
        );
      }
      return results;
    };
    readAll()
      .then((results) => {
        // A reply for a year the pane has since left must not stand in for the new one.
        if (id !== seq.current) return;
        const byKey = new Map<string, CalendarOccurrence>();
        for (const res of results) for (const o of res.occurrences) byKey.set(o.key, o);
        setData({ year: q.year, occurrences: [...byKey.values()] });
        setError(null);
      })
      .catch((err: unknown) => {
        if (id !== seq.current) return;
        setError(getErrorMessage(err, "Couldn't load this year"));
      })
      .finally(() => {
        if (id !== seq.current) return;
        setLoading(false);
        inflight.current = null;
        if (readAgain.current) fetchAgain.current();
      });
  }, []);
  const fetchAgain = useRef(() => fetchNow());
  const refetch = useCallback(() => fetchNow(), [fetchNow]);

  useEffect(() => {
    if (key) fetchNow();
  }, [key, fetchNow]);

  const coalescer = useRef(createCoalescer(() => fetchNow({ background: true })));
  useEffect(() => () => coalescer.current.cancel(), []);

  useEffect(
    () =>
      subscribeTableEvents((event) => {
        if (!queryRef.current || !relevantTableChange(event, calendarsRef.current)) return;
        if (event.type === 'table.entries.changed') {
          const ids = changedEntryIds(event);
          if (ids && isOwnEchoOfAll(ids.map((id) => `entry:${event.tableId}:${id}`))) return;
        }
        coalescer.current.trigger();
      }),
    []
  );

  useEffect(
    () =>
      onLibraryEvent((event) => {
        if (!queryRef.current) return;
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
      if (!queryRef.current || message.channel !== WORKSPACE_EVENT_CHANNEL) return;
      const change = parseCalendarChanged(message as { type?: unknown; payload?: unknown });
      if (!change) return;
      if (change.kind !== 'event' || !change.eventId || !isOwnEcho(`event:${change.eventId}`)) {
        coalescer.current.trigger();
      }
    });
  }, [addMessageListener]);

  return {
    occurrences: data.occurrences,
    loading,
    error,
    shownYear: data.year,
    refetch,
  };
}
