import { describe, expect, it } from 'vitest';
import type { CalendarOccurrence } from '@snaglet/shared/types';
import { zonedToInstant } from '@desktop/features/calendar/calendarDates';
import { daysWithItems } from './MiniMonth';

const Z = 'America/Los_Angeles';
const visible = new Set(['cal-1']);

function item(key: string, time: CalendarOccurrence['time']): CalendarOccurrence {
  return {
    source: 'event',
    key,
    eventId: key,
    revision: 1,
    calendarId: 'cal-1',
    title: 'Item',
    time,
    status: 'upcoming',
    canMove: true,
    canResize: true,
  };
}

describe('daysWithItems', () => {
  it('dots every day a span touches, all-day or timed (an end at midnight closes its day)', () => {
    const days = daysWithItems(
      [
        item('a', { kind: 'all_day', startDate: '2026-10-12', endDate: '2026-10-14' }),
        item('b', {
          kind: 'timed',
          start: zonedToInstant('2026-10-16', 21 * 60, Z),
          end: zonedToInstant('2026-10-18', 9 * 60, Z),
        }),
        item('c', {
          kind: 'timed',
          start: zonedToInstant('2026-10-20', 22 * 60, Z),
          end: zonedToInstant('2026-10-21', 0, Z),
        }),
      ],
      Z,
      visible
    );
    expect([...days].sort()).toEqual([
      '2026-10-12',
      '2026-10-13',
      '2026-10-16',
      '2026-10-17',
      '2026-10-18',
      '2026-10-20',
    ]);
  });

  it('skips hidden calendars', () => {
    const o = item('a', { kind: 'all_day', startDate: '2026-10-12', endDate: '2026-10-13' });
    expect(daysWithItems([o], Z, new Set()).size).toBe(0);
  });
});
