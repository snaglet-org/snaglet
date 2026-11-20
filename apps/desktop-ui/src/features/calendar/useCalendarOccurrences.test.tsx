import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  Calendar,
  CalendarOccurrence,
  CalendarOccurrencesQuery,
  CalendarOccurrencesResponse,
} from '@snaglet/shared/types';
import { emitTableEvent, type TableEvent } from '@desktop/features/database/tableEvents';

const api = vi.hoisted(() => ({ occurrences: vi.fn(), listCalendars: vi.fn() }));
vi.mock('./calendarApi', async (orig) => ({
  ...(await orig<typeof import('./calendarApi')>()),
  calendarApi: api,
}));

import { occurrencesSearch } from './calendarApi';
import { __resetCalendarRealtimeForTests, markOwnWrite } from './calendarRealtime';
import { useCalendarOccurrences } from './useCalendarOccurrences';

const WEEK: CalendarOccurrencesQuery = { from: '2026-10-12', to: '2026-10-19', tz: 'UTC' };
const NEXT: CalendarOccurrencesQuery = { from: '2026-10-19', to: '2026-10-26', tz: 'UTC' };

function event(key: string, day: string): CalendarOccurrence {
  return {
    source: 'event',
    key: `event:${key}`,
    eventId: key,
    revision: 1,
    calendarId: 'cal-1',
    title: key,
    time: { kind: 'all_day', startDate: day, endDate: day },
    status: 'upcoming',
    canMove: true,
    canResize: false,
  };
}

const reply = (occurrences: CalendarOccurrence[]): CalendarOccurrencesResponse => ({
  from: '',
  to: '',
  tz: 'UTC',
  occurrences,
  intervals: [],
  unavailable: [],
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

describe('useCalendarOccurrences', () => {
  beforeEach(() => {
    api.occurrences.mockReset();
  });

  it('a prefetch that lands after the cache was cleared is not served later', async () => {
    const prefetch = deferred<CalendarOccurrencesResponse>();
    api.occurrences.mockImplementation((q: CalendarOccurrencesQuery) =>
      q.from === NEXT.from ? prefetch.promise : Promise.resolve(reply([event('a', '2026-10-14')]))
    );
    const { result, rerender } = renderHook(
      ({ query }) => useCalendarOccurrences(query, { calendars: [], adjacent: [NEXT] }),
      { initialProps: { query: WEEK } }
    );
    await waitFor(() => expect(result.current.shownKey).toBe(occurrencesSearch(WEEK)));
    expect(api.occurrences).toHaveBeenCalledWith(NEXT);

    // A local change clears the cache while next week's prefetch is out…
    act(() => result.current.patchLocal((list) => list));
    // …and the reply, read before that change, comes back afterward.
    await act(async () => prefetch.resolve(reply([event('stale', '2026-10-20')])));

    const fresh = deferred<CalendarOccurrencesResponse>();
    api.occurrences.mockImplementation(() => fresh.promise);
    rerender({ query: NEXT });
    // Not shown from the stale prefetch: the week waits for its own read.
    expect(result.current.occurrences.map((o) => o.key)).toEqual(['event:a']);
    await act(async () => fresh.resolve(reply([event('b', '2026-10-21')])));
    expect(result.current.occurrences.map((o) => o.key)).toEqual(['event:b']);
  });

  it('a prefetched range is served at once when nothing changed', async () => {
    api.occurrences.mockImplementation((q: CalendarOccurrencesQuery) =>
      Promise.resolve(reply([event(q.from, q.from)]))
    );
    const { result, rerender } = renderHook(
      ({ query }) => useCalendarOccurrences(query, { calendars: [], adjacent: [NEXT] }),
      { initialProps: { query: WEEK } }
    );
    await waitFor(() => expect(result.current.shownKey).toBe(occurrencesSearch(WEEK)));
    await waitFor(() => expect(api.occurrences).toHaveBeenCalledWith(NEXT));
    await act(async () => {
      await Promise.resolve();
    });
    api.occurrences.mockImplementation(() => new Promise(() => {}));
    rerender({ query: NEXT });
    expect(result.current.occurrences.map((o) => o.key)).toEqual([`event:${NEXT.from}`]);
  });
});

describe('useCalendarOccurrences under steady realtime changes', () => {
  const TABLE = 'table-1111111111111-aaaaaaaaa';
  const calendars = [
    { id: 'cal-1', boundFields: [{ tableId: TABLE, fieldId: 'field-due' }] },
  ] as unknown as Calendar[];
  /** Past the ~250 ms refetch coalescing. */
  const settle = () => act(() => new Promise((resolve) => setTimeout(resolve, 350)));
  const change = () =>
    act(() =>
      emitTableEvent({
        type: 'table.entries.changed',
        tableId: TABLE,
        entryId: 'entry-1',
        allEntries: true,
      })
    );

  beforeEach(() => {
    __resetCalendarRealtimeForTests();
    api.occurrences.mockReset();
  });

  it('a change while the range is still loading lets that read land, then reads once more', async () => {
    const reads: Array<ReturnType<typeof deferred<CalendarOccurrencesResponse>>> = [];
    api.occurrences.mockImplementation(() => {
      const read = deferred<CalendarOccurrencesResponse>();
      reads.push(read);
      return read.promise;
    });
    const { result } = renderHook(() => useCalendarOccurrences(WEEK, { calendars }));
    expect(reads).toHaveLength(1);
    // Changes keep coming while the slow first read is out: no new read cancels it.
    change();
    await settle();
    change();
    await settle();
    expect(reads).toHaveLength(1);
    await act(async () => reads[0]!.resolve(reply([event('first', '2026-10-14')])));
    expect(result.current.shownKey).toBe(occurrencesSearch(WEEK));
    expect(result.current.occurrences.map((o) => o.key)).toEqual(['event:first']);
    // One more read, for the changes heard meanwhile.
    expect(reads).toHaveLength(2);
    await act(async () => reads[1]!.resolve(reply([event('second', '2026-10-14')])));
    expect(result.current.occurrences.map((o) => o.key)).toEqual(['event:second']);
    expect(reads).toHaveLength(2);
  });
});

describe('useCalendarOccurrences, the echo of our own row writes', () => {
  const TABLE = 'table-1111111111111-aaaaaaaaa';
  const X = '00000000-0000-4000-8000-000000000001';
  const Y = '00000000-0000-4000-8000-000000000002';
  const calendars = [
    { id: 'cal-1', boundFields: [{ tableId: TABLE, fieldId: 'field-due' }] },
  ] as unknown as Calendar[];
  /** Past the ~250 ms refetch coalescing. */
  const settle = () => act(() => new Promise((resolve) => setTimeout(resolve, 350)));
  const hear = (event: TableEvent) => act(() => emitTableEvent(event));

  beforeEach(async () => {
    __resetCalendarRealtimeForTests();
    api.occurrences.mockReset();
    api.occurrences.mockResolvedValue(reply([]));
    const { result } = renderHook(() => useCalendarOccurrences(WEEK, { calendars }));
    await waitFor(() => expect(result.current.shownKey).toBe(occurrencesSearch(WEEK)));
    api.occurrences.mockClear();
  });

  it('skips a batch only when every entry it names is our own write', async () => {
    markOwnWrite(`entry:${TABLE}:${X}`);
    markOwnWrite(`entry:${TABLE}:${Y}`);
    hear({ type: 'table.entries.changed', tableId: TABLE, entryId: X, entryIds: [X, Y] });
    await settle();
    expect(api.occurrences).not.toHaveBeenCalled();
  });

  it('refetches a batch naming our write on X and another on Y, and keeps X’s mark', async () => {
    markOwnWrite(`entry:${TABLE}:${X}`);
    hear({ type: 'table.entries.changed', tableId: TABLE, entryId: X, entryIds: [X, Y] });
    await waitFor(() => expect(api.occurrences).toHaveBeenCalledTimes(1));
    // X's own echo, still to come, is skipped.
    hear({ type: 'table.entries.changed', tableId: TABLE, entryId: X, entryIds: [X] });
    await settle();
    expect(api.occurrences).toHaveBeenCalledTimes(1);
  });

  it('refetches a batch too big to list, even over our own write', async () => {
    markOwnWrite(`entry:${TABLE}:${X}`);
    hear({ type: 'table.entries.changed', tableId: TABLE, entryId: X, allEntries: true });
    await waitFor(() => expect(api.occurrences).toHaveBeenCalledTimes(1));
  });
});
