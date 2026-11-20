import { renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const calendar = vi.hoisted(() => ({ getEvent: vi.fn() }));
vi.mock('@desktop/features/calendar/calendarApi', () => ({ calendarApi: calendar }));
vi.mock('@desktop/features/calendar/calendarDates', async (orig) => ({
  ...(await orig<typeof import('@desktop/features/calendar/calendarDates')>()),
  viewerTimeZone: () => 'UTC',
}));

import {
  __resetCalendarViewForTests,
  useCalendarView,
} from '@desktop/features/calendar/calendarViewStore';
import { revealCalendarEvent } from './revealCalendarItem';

const EVENT_ID = 'event-1111111111111-aaaaaaaaa';

function item(key: string, inSurface = false) {
  const el = document.createElement('button');
  el.dataset.key = key;
  el.setAttribute('data-calendar-item', '');
  const click = vi.fn();
  el.addEventListener('click', click);
  if (inSurface) {
    const surface = document.createElement('div');
    surface.setAttribute('data-calendar-surface', '');
    surface.appendChild(el);
    document.body.appendChild(surface);
  } else {
    document.body.appendChild(el);
  }
  return click;
}

describe('revealCalendarEvent', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout'] });
    __resetCalendarViewForTests({ zoom: 'month' });
    calendar.getEvent.mockReset();
    document.body.innerHTML = '';
  });
  afterEach(() => vi.useRealTimers());

  it("moves the calendar to the event's day and clicks the grid's item once drawn", async () => {
    const view = renderHook(() => useCalendarView());
    const done = revealCalendarEvent(EVENT_ID, '2026-10-16T09:00:00.000Z');
    await vi.advanceTimersByTimeAsync(0);
    expect(view.result.current).toMatchObject({ anchor: '2026-10-16', zoom: 'day' });

    const copy = item(`event:${EVENT_ID}`, true);
    await vi.advanceTimersByTimeAsync(200);
    const grid = item(`event:${EVENT_ID}`);
    await vi.advanceTimersByTimeAsync(200);
    await done;
    expect(grid).toHaveBeenCalledTimes(1);
    expect(copy).not.toHaveBeenCalled();
  });

  it("reads the event's day when the reminder carries no start", async () => {
    calendar.getEvent.mockResolvedValue({
      event: { time: { kind: 'all_day', startDate: '2026-10-20', endDate: '2026-10-21' } },
    });
    const view = renderHook(() => useCalendarView());
    const done = revealCalendarEvent(EVENT_ID, null);
    await vi.advanceTimersByTimeAsync(5000);
    await done;
    expect(calendar.getEvent).toHaveBeenCalledWith(EVENT_ID);
    expect(view.result.current.anchor).toBe('2026-10-20');
  });
});
