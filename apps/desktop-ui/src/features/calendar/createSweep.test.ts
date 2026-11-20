import { describe, expect, it } from 'vitest';
import {
  columnAtX,
  sameSlot,
  sweepAllDay,
  sweepLabel,
  sweepTimed,
  timedPieces,
} from './createSweep';

const WEEK = [
  '2026-10-12',
  '2026-10-13',
  '2026-10-14',
  '2026-10-15',
  '2026-10-16',
  '2026-10-17',
  '2026-10-18',
];

describe('sweepTimed', () => {
  it('down: from the pressed 15-minute cell through the cell under the pointer', () => {
    expect(sweepTimed(WEEK, { dayIndex: 2, minutes: 540 }, { dayIndex: 2, minutes: 620 })).toEqual({
      kind: 'timed',
      day: '2026-10-14',
      start: 540,
      end: 630,
    });
  });

  it('up: the pressed cell stays inside (9:07 up to 8:20 → 8:15 – 9:15)', () => {
    expect(sweepTimed(WEEK, { dayIndex: 2, minutes: 547 }, { dayIndex: 2, minutes: 500 })).toEqual({
      kind: 'timed',
      day: '2026-10-14',
      start: 495,
      end: 555,
    });
  });

  it('counts cells of the zoom’s snap step (5 or 1 minutes zoomed in)', () => {
    expect(
      sweepTimed(WEEK, { dayIndex: 2, minutes: 547 }, { dayIndex: 2, minutes: 561 }, 5)
    ).toEqual({ kind: 'timed', day: '2026-10-14', start: 545, end: 565 });
    expect(
      sweepTimed(WEEK, { dayIndex: 2, minutes: 547.5 }, { dayIndex: 2, minutes: 549.2 }, 1)
    ).toEqual({ kind: 'timed', day: '2026-10-14', start: 547, end: 550 });
    // Across midnight at 5 minutes: ends on the next day's column.
    expect(
      sweepTimed(WEEK, { dayIndex: 2, minutes: 1432 }, { dayIndex: 3, minutes: 7 }, 5)
    ).toEqual({ kind: 'timed', day: '2026-10-14', start: 1430, end: 10, endDay: '2026-10-15' });
  });

  it('no travel is one 15-minute cell', () => {
    expect(sweepTimed(WEEK, { dayIndex: 0, minutes: 600 }, { dayIndex: 0, minutes: 610 })).toEqual({
      kind: 'timed',
      day: '2026-10-12',
      start: 600,
      end: 615,
    });
  });

  it('into another day column: the end is that day’s time', () => {
    expect(sweepTimed(WEEK, { dayIndex: 2, minutes: 1260 }, { dayIndex: 3, minutes: 50 })).toEqual({
      kind: 'timed',
      day: '2026-10-14',
      start: 1260,
      end: 60,
      endDay: '2026-10-15',
    });
    // Backwards into an earlier day: that day's time is the start.
    expect(sweepTimed(WEEK, { dayIndex: 2, minutes: 120 }, { dayIndex: 1, minutes: 1380 })).toEqual(
      { kind: 'timed', day: '2026-10-13', start: 1380, end: 135, endDay: '2026-10-14' }
    );
  });

  it('a range ending on midnight belongs to its day (24:00), and points clamp into the grid', () => {
    expect(
      sweepTimed(WEEK, { dayIndex: 4, minutes: 1380 }, { dayIndex: 4, minutes: 1440 })
    ).toEqual({ kind: 'timed', day: '2026-10-16', start: 1380, end: 1440 });
    expect(sweepTimed(WEEK, { dayIndex: 0, minutes: 30 }, { dayIndex: -3, minutes: -90 })).toEqual({
      kind: 'timed',
      day: '2026-10-12',
      start: 0,
      end: 45,
    });
  });
});

describe('sweepAllDay', () => {
  it('covers both ends in either order; endDate is exclusive', () => {
    expect(sweepAllDay(WEEK, 1, 3)).toEqual({
      kind: 'all_day',
      startDate: '2026-10-13',
      endDate: '2026-10-16',
    });
    expect(sweepAllDay(WEEK, 3, 1)).toEqual(sweepAllDay(WEEK, 1, 3));
    expect(sweepAllDay(WEEK, 6, 9)).toEqual({
      kind: 'all_day',
      startDate: '2026-10-18',
      endDate: '2026-10-19',
    });
  });
});

describe('columnAtX', () => {
  const rects = [0, 100, 200].map((left) => ({ left, right: left + 100 }));
  it('finds the column and clamps outside the grid', () => {
    expect(columnAtX(rects, 150)).toBe(1);
    expect(columnAtX(rects, -40)).toBe(0);
    expect(columnAtX(rects, 900)).toBe(2);
    expect(columnAtX([], 10)).toBe(0);
  });
});

describe('timedPieces', () => {
  it('one piece per day the slot covers; the label goes on the first', () => {
    const pieces = timedPieces(
      { kind: 'timed', day: '2026-10-14', start: 1260, end: 60, endDay: '2026-10-15' },
      WEEK
    );
    expect([...pieces.entries()]).toEqual([
      ['2026-10-14', { start: 1260, end: 1440, first: true }],
      ['2026-10-15', { start: 0, end: 60, first: false }],
    ]);
  });
});

describe('sweepLabel', () => {
  it('reads like the quick-add time line', () => {
    expect(sweepLabel({ kind: 'timed', day: WEEK[0]!, start: 540, end: 630 })).toBe(
      '9:00 – 10:30 AM'
    );
    expect(sweepLabel({ kind: 'timed', day: WEEK[0]!, start: 690, end: 750 })).toBe(
      '11:30 AM – 12:30 PM'
    );
    expect(sweepLabel({ kind: 'timed', day: WEEK[0]!, start: 1380, end: 1440 })).toBe(
      '11 PM – 12:00 AM'
    );
    expect(
      sweepLabel({ kind: 'timed', day: WEEK[2]!, start: 1260, end: 60, endDay: WEEK[3]! })
    ).toBe('Wed 9 PM – Thu 1 AM');
  });

  it('a morning sweep that ends at noon or midnight names both halves', () => {
    expect(sweepLabel({ kind: 'timed', day: WEEK[0]!, start: 690, end: 720 })).toBe(
      '11:30 AM – 12:00 PM'
    );
    expect(sweepLabel({ kind: 'timed', day: WEEK[0]!, start: 600, end: 1440 })).toBe(
      '10 AM – 12:00 AM'
    );
    expect(sweepLabel({ kind: 'timed', day: WEEK[0]!, start: 720, end: 780 })).toBe(
      '12:00 – 1:00 PM'
    );
  });
});

describe('sameSlot', () => {
  it('compares by value', () => {
    const a = { kind: 'timed', day: WEEK[0]!, start: 540, end: 600 } as const;
    expect(sameSlot(a, { ...a })).toBe(true);
    expect(sameSlot(a, { ...a, endDay: WEEK[1]! })).toBe(false);
    expect(sameSlot(sweepAllDay(WEEK, 0, 1), sweepAllDay(WEEK, 1, 0))).toBe(true);
    expect(sameSlot(a, sweepAllDay(WEEK, 0, 0))).toBe(false);
  });
});
