import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CalendarOccurrence, CalendarOccurrencesResponse } from '@snaglet/shared/types';
import { CALENDAR_OCCURRENCES_MAX_DAYS } from '@snaglet/shared/types';

const api = vi.hoisted(() => ({ occurrences: vi.fn() }));
vi.mock('./calendarApi', async (orig) => ({
  ...(await orig<typeof import('./calendarApi')>()),
  calendarApi: api,
}));

import { emitLibraryEvent } from '@desktop/utils/workspaceEvents';
import { useYearOccurrences, yearWindows } from './useYearOccurrences';

const days = (from: string, to: string) =>
  Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);

function event(key: string): CalendarOccurrence {
  return {
    source: 'event',
    key,
    eventId: key,
    revision: 1,
    calendarId: 'cal-1',
    title: key,
    time: { kind: 'all_day', startDate: '2026-02-28', endDate: '2026-03-01' },
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

describe('yearWindows', () => {
  it('covers the year end to end, each window within what one request may ask for', () => {
    const windows = yearWindows(2026);
    expect(windows).toHaveLength(6);
    expect(windows[0]!.from).toBe('2026-01-01');
    expect(windows[5]!.to).toBe('2027-01-01');
    windows.forEach((w, i) => {
      expect(days(w.from, w.to)).toBeLessThanOrEqual(CALENDAR_OCCURRENCES_MAX_DAYS);
      if (i > 0) expect(w.from).toBe(windows[i - 1]!.to);
    });
  });
});

describe('useYearOccurrences', () => {
  beforeEach(() => api.occurrences.mockReset());

  it('reads the windows one after another, never together', async () => {
    let inFlight = 0;
    let peak = 0;
    api.occurrences.mockImplementation(async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight -= 1;
      return reply([]);
    });
    const { result } = renderHook(() =>
      useYearOccurrences({ year: 2026, tz: 'UTC' }, { calendars: [] })
    );
    await waitFor(() => expect(result.current.shownYear).toBe(2026));
    expect(api.occurrences).toHaveBeenCalledTimes(6);
    expect(peak).toBe(1);
  });

  it('keeps an item that came back from two windows once', async () => {
    api.occurrences.mockResolvedValue(reply([event('trip')]));
    const { result } = renderHook(() =>
      useYearOccurrences({ year: 2026, tz: 'UTC' }, { calendars: [] })
    );
    await waitFor(() => expect(result.current.shownYear).toBe(2026));
    expect(result.current.occurrences).toHaveLength(1);
  });

  it('says so when a window fails, and Retry reads again', async () => {
    api.occurrences.mockRejectedValueOnce(new Error('too many connections'));
    api.occurrences.mockResolvedValue(reply([]));
    const { result } = renderHook(() =>
      useYearOccurrences({ year: 2026, tz: 'UTC' }, { calendars: [] })
    );
    await waitFor(() => expect(result.current.error).toBe('too many connections'));
    act(() => result.current.refetch());
    await waitFor(() => expect(result.current.error).toBeNull());
    await waitFor(() => expect(result.current.shownYear).toBe(2026));
  });

  it('a change heard mid-read lets the year finish, then reads it once more', async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    let calls = 0;
    api.occurrences.mockImplementation(async () => {
      calls += 1;
      // The first read's third window is slow; everything else answers at once.
      if (calls === 3) await gate;
      return reply([event(calls <= 6 ? 'first' : 'second')]);
    });
    const { result } = renderHook(() =>
      useYearOccurrences({ year: 2026, tz: 'UTC' }, { calendars: [] })
    );
    await waitFor(() => expect(calls).toBe(3));
    // Changes keep coming while it reads: none restarts it.
    act(() => emitLibraryEvent({ type: 'tree-invalidated', ids: [] }));
    await act(() => new Promise((resolve) => setTimeout(resolve, 350)));
    expect(calls).toBe(3);
    await act(async () => release());
    await waitFor(() => expect(result.current.shownYear).toBe(2026));
    // Then once more, for the change heard meanwhile.
    await waitFor(() => expect(calls).toBe(12));
    await waitFor(() => expect(result.current.occurrences[0]!.key).toBe('second'));
  });

  it('does nothing without a query', () => {
    renderHook(() => useYearOccurrences(null, { calendars: [] }));
    expect(api.occurrences).not.toHaveBeenCalled();
  });
});
