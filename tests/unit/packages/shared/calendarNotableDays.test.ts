import { describe, expect, it } from '@jest/globals';
import type { CalendarOccurrence } from '@snaglet/shared/types';
import { FEW_A_YEAR, notableByDay } from '@snaglet/shared/utils';

let seq = 0;
function event(
  over: Partial<CalendarOccurrence> & { eventId?: string; day?: string } = {}
): CalendarOccurrence {
  const { day = '2026-10-21', eventId = `event-${++seq}`, ...rest } = over;
  return {
    key: `${eventId}:${day}`,
    source: 'event',
    eventId,
    revision: 1,
    calendarId: 'cal-1',
    title: 'Test event',
    status: 'upcoming',
    canMove: true,
    canResize: true,
    time: { kind: 'all_day', startDate: day, endDate: addOne(day) },
    ...rest,
  } as CalendarOccurrence;
}
const addOne = (day: string) => {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
};

/** A series of `n` occurrences on successive days from Jan 1. */
function series(eventId: string, n: number): CalendarOccurrence[] {
  return Array.from({ length: n }, (_, i) => {
    const d = new Date(Date.UTC(2026, 0, 1 + i));
    return event({ eventId, day: d.toISOString().slice(0, 10), repeatSummary: 'Every day' });
  });
}

const utcDay = (instant: string) => instant.slice(0, 10);

describe('notableByDay', () => {
  it('lists a one-off item and a repeat that lands a few times a year', () => {
    const yearly = series('event-yearly', 3); // Jan 1–3 stand in for "a few times a year"
    const map = notableByDay([event({ day: '2026-10-21' }), ...yearly], utcDay);
    expect(map.get('2026-10-21')).toHaveLength(1);
    expect(map.get('2026-01-02')).toHaveLength(1);
  });

  it('leaves out a series that repeats more than a few times a year', () => {
    const often = series('event-often', FEW_A_YEAR + 1);
    expect(notableByDay(often, utcDay).size).toBe(0);
    expect(notableByDay(series('event-edge', FEW_A_YEAR), utcDay).size).toBe(FEW_A_YEAR);
  });

  it('marks every day of a short range and puts all-day before timed, done last', () => {
    const trip = event({
      day: '2026-10-21',
      time: { kind: 'all_day', startDate: '2026-10-21', endDate: '2026-10-24' },
    });
    const call = event({
      title: 'Call',
      time: { kind: 'timed', start: '2026-10-21T16:00:00.000Z', end: '2026-10-21T17:00:00.000Z' },
    });
    const done = event({ title: 'Old', status: 'done' });
    const map = notableByDay([done, call, trip], utcDay);
    expect(map.get('2026-10-23')).toHaveLength(1);
    expect(map.get('2026-10-24')).toBeUndefined();
    expect(map.get('2026-10-21')!.map((o) => o.title)).toEqual(['Test event', 'Call', 'Old']);
  });
});
