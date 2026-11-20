import { describe, expect, it } from 'vitest';
import type { CalendarOccurrenceTime } from '@snaglet/shared/types';
import { zonedToInstant } from './calendarDates';
import {
  describeSpan,
  describeTime,
  minutesAtY,
  moveAllDayTo,
  moveTimedTo,
  resizeAllDayEnd,
  resizeTimed,
  shiftTime,
  stretchAllDayEnd,
} from './occurrenceMoves';

const TZ = 'America/Los_Angeles';
const at = (day: string, minutes: number) => zonedToInstant(day, minutes, TZ);
const timed = (
  day: string,
  start: number,
  end: number
): Extract<CalendarOccurrenceTime, { kind: 'timed' }> => ({
  kind: 'timed',
  start: at(day, start),
  end: at(day, end),
});

describe('minutesAtY', () => {
  it('maps a viewport y to day minutes by ratio (CSS zoom cancels out)', () => {
    // A column 960 viewport px tall (zoomed), top at 100.
    expect(minutesAtY(100 + 480, { top: 100, height: 960 })).toBe(720);
    expect(minutesAtY(50, { top: 100, height: 960 })).toBe(0);
    expect(minutesAtY(5000, { top: 100, height: 960 })).toBe(1440);
  });
});

describe('moveTimedTo', () => {
  it('keeps the duration and snaps the start', () => {
    const out = moveTimedTo(timed('2026-10-12', 600, 630), '2026-10-13', 615, TZ);
    expect(out).toEqual(timed('2026-10-13', 615, 645));
  });
  it('keeps the start inside the day', () => {
    const out = moveTimedTo(timed('2026-10-12', 600, 660), '2026-10-13', 1435, TZ);
    expect(out).toEqual(timed('2026-10-13', 1425, 1485));
  });
  it('snaps to the zoom’s step and keeps a short item’s real length', () => {
    expect(moveTimedTo(timed('2026-10-12', 600, 630), '2026-10-13', 622, TZ, 5)).toEqual(
      timed('2026-10-13', 620, 650)
    );
    expect(moveTimedTo(timed('2026-10-12', 600, 605), '2026-10-13', 622.4, TZ, 1)).toEqual(
      timed('2026-10-13', 622, 627)
    );
  });
  it('keeps wall time across a DST change', () => {
    // Nov 1 2026 is the fall-back day in Los Angeles.
    const out = moveTimedTo(timed('2026-10-30', 540, 600), '2026-11-02', 540, TZ);
    expect(out).toEqual(timed('2026-11-02', 540, 600));
  });
});

describe('moveAllDayTo', () => {
  it('moves both dates and keeps the span', () => {
    expect(
      moveAllDayTo(
        { kind: 'all_day', startDate: '2026-10-12', endDate: '2026-10-15' },
        '2026-10-20'
      )
    ).toEqual({ kind: 'all_day', startDate: '2026-10-20', endDate: '2026-10-23' });
  });
});

describe('resizeTimed', () => {
  it('moves the end, minimum 15 minutes', () => {
    const t = timed('2026-10-12', 600, 630);
    expect(resizeTimed(t, 'end', 690, TZ)).toEqual(timed('2026-10-12', 600, 690));
    expect(resizeTimed(t, 'end', 560, TZ)).toEqual(timed('2026-10-12', 600, 615));
  });
  it('moves the start, minimum 15 minutes', () => {
    const t = timed('2026-10-12', 600, 660);
    expect(resizeTimed(t, 'start', 540, TZ)).toEqual(timed('2026-10-12', 540, 660));
    expect(resizeTimed(t, 'start', 700, TZ)).toEqual(timed('2026-10-12', 645, 660));
  });
  it('snaps to a finer step zoomed in, minimum 5 minutes', () => {
    const t = timed('2026-10-12', 600, 630);
    expect(resizeTimed(t, 'end', 642, TZ, '2026-10-12', 5)).toEqual(timed('2026-10-12', 600, 640));
    expect(resizeTimed(t, 'end', 642, TZ, '2026-10-12', 1)).toEqual(timed('2026-10-12', 600, 642));
    expect(resizeTimed(t, 'end', 590, TZ, '2026-10-12', 1)).toEqual(timed('2026-10-12', 600, 605));
    expect(resizeTimed(t, 'start', 629, TZ, '2026-10-12', 1)).toEqual(
      timed('2026-10-12', 625, 630)
    );
  });
});

describe('resizeTimed on another day (range rows)', () => {
  it('puts the edge on that day, across a DST change in wall time', () => {
    // Fri 9:00 → drag the end to Mon (after the 2026-11-01 change) at 17:00.
    const t = timed('2026-10-30', 540, 600);
    expect(resizeTimed(t, 'end', 1020, TZ, '2026-11-02')).toEqual({
      kind: 'timed',
      start: t.start,
      end: at('2026-11-02', 1020),
    });
    expect(resizeTimed(t, 'start', 1200, TZ, '2026-10-29').start).toBe(at('2026-10-29', 1200));
  });
});

describe('all-day resize', () => {
  const span = { kind: 'all_day' as const, startDate: '2026-10-12', endDate: '2026-10-15' };
  it('ends on the dropped day, at least one day long', () => {
    expect(resizeAllDayEnd(span, '2026-10-20')).toEqual({ ...span, endDate: '2026-10-21' });
    expect(resizeAllDayEnd(span, '2026-10-01')).toEqual({ ...span, endDate: '2026-10-13' });
  });
  it('Alt+Shift+←/→ stretches the end by a day', () => {
    expect(stretchAllDayEnd(span, 1)).toEqual({ ...span, endDate: '2026-10-16' });
    expect(stretchAllDayEnd(span, -1)).toEqual({ ...span, endDate: '2026-10-14' });
    const one = { ...span, endDate: '2026-10-13' };
    expect(stretchAllDayEnd(one, -1)).toEqual(one);
  });
});

describe('shiftTime', () => {
  it('moves timed items by minutes, across midnight', () => {
    expect(shiftTime(timed('2026-10-12', 1425, 1440), { minutes: 15 }, TZ)).toEqual(
      timed('2026-10-13', 0, 15)
    );
    expect(shiftTime(timed('2026-10-12', 600, 630), { days: -1 }, TZ)).toEqual(
      timed('2026-10-11', 600, 630)
    );
  });
  it('moves all-day items by days only', () => {
    expect(
      shiftTime(
        { kind: 'all_day', startDate: '2026-10-12', endDate: '2026-10-13' },
        { days: 2 },
        TZ
      )
    ).toEqual({ kind: 'all_day', startDate: '2026-10-14', endDate: '2026-10-15' });
  });
});

describe('describeTime', () => {
  it('says the day, and the start for timed items', () => {
    expect(describeTime(timed('2026-10-13', 615, 645), TZ)).toBe('Tue Oct 13, 10:15 AM');
    expect(
      describeTime({ kind: 'all_day', startDate: '2026-10-13', endDate: '2026-10-14' }, TZ)
    ).toBe('Tue Oct 13');
  });
  it('ghost label: weekday and the range', () => {
    expect(describeTime(timed('2026-10-13', 615, 645), TZ, 'range')).toBe('Tue 10:15 – 10:45 AM');
    expect(
      describeTime(
        { kind: 'timed', start: at('2026-10-16', 540), end: at('2026-10-19', 1020) },
        TZ,
        'range'
      )
    ).toBe('Fri 9 AM – Mon 5 PM');
    // Ending at the next midnight is still one day.
    expect(
      describeTime(
        { kind: 'timed', start: at('2026-10-13', 1320), end: at('2026-10-14', 0) },
        TZ,
        'range'
      )
    ).toBe('Tue 10 PM – 12:00 AM');
    // A morning start keeps its own suffix before a midnight end.
    expect(
      describeTime(
        { kind: 'timed', start: at('2026-10-13', 600), end: at('2026-10-14', 0) },
        TZ,
        'range'
      )
    ).toBe('Tue 10 AM – 12:00 AM');
  });
});

describe('describeSpan', () => {
  it('reads all-day days and same-day times like the quick add line', () => {
    expect(
      describeSpan({ kind: 'all_day', startDate: '2026-10-13', endDate: '2026-10-14' }, TZ)
    ).toBe('Tuesday, October 13 · All day');
    expect(
      describeSpan({ kind: 'all_day', startDate: '2026-10-13', endDate: '2026-10-16' }, TZ)
    ).toBe('Tue Oct 13 – Thu Oct 15 · All day');
    expect(describeSpan(timed('2026-10-13', 540, 570), TZ)).toBe('Tue Oct 13, 9:00 – 9:30 AM');
  });
  it('an end at the next midnight stays on the start day, in 12-hour time', () => {
    expect(
      describeSpan({ kind: 'timed', start: at('2026-10-13', 600), end: at('2026-10-14', 0) }, TZ)
    ).toBe('Tue Oct 13, 10 AM – 12:00 AM');
  });
  it('over several days names both days, in 12-hour time', () => {
    expect(
      describeSpan({ kind: 'timed', start: at('2026-10-16', 1260), end: at('2026-10-17', 90) }, TZ)
    ).toBe('Fri Oct 16, 9 PM – Sat Oct 17, 1:30 AM');
  });
});
