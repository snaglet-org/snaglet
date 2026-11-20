import { describe, expect, it } from 'vitest';
import type { TableRepeat } from '@snaglet/shared/utils';
import {
  canShiftAllUpcoming,
  formatWallDate,
  repeatDaysInMonth,
  wallParts,
} from './repeatWallDates';

describe('canShiftAllUpcoming', () => {
  it('mirrors the server’s shiftRuleByDays', () => {
    expect(canShiftAllUpcoming('FREQ=WEEKLY;BYDAY=MO,TH')).toEqual({ ok: true });
    expect(canShiftAllUpcoming('FREQ=MONTHLY')).toEqual({ ok: true });
    for (const rule of [
      'FREQ=MONTHLY;BYMONTHDAY=12',
      'FREQ=MONTHLY;BYDAY=2MO',
      'FREQ=YEARLY;BYMONTH=10',
    ]) {
      const r = canShiftAllUpcoming(rule);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).toMatch(/can’t move by days/);
    }
  });
});

describe('formatWallDate', () => {
  it('formats without passing through UTC midnight', () => {
    expect(formatWallDate('2026-10-12')).toBe('Mon, Oct 12, 2026');
    expect(formatWallDate('2026-10-12T09:05:00')).toBe('Mon, Oct 12, 2026, 9:05 AM');
    expect(formatWallDate('2026-10-12T21:00:00')).toBe('Mon, Oct 12, 2026, 9:00 PM');
    expect(formatWallDate('2026-10-12T00:15:00')).toBe('Mon, Oct 12, 2026, 12:15 AM');
    expect(formatWallDate('2026-10-12', { weekday: false, year: false })).toBe('Oct 12');
  });

  it('rejects dates that don’t exist', () => {
    expect(wallParts('2027-02-29')).toBeNull();
    expect(wallParts('2028-02-29')?.weekday).toBe('TU');
  });
});

describe('repeatDaysInMonth', () => {
  // Mon Oct 12, 2026.
  const weekly: TableRepeat = {
    rrule: 'FREQ=WEEKLY;BYDAY=MO',
    dtstart: '2026-10-12',
    current: '2026-10-12',
    tz: 'UTC',
  };
  const days = (repeat: TableRepeat, month: string, log = []) =>
    [...repeatDaysInMonth(repeat, month, log)].sort();

  it('weekly: the days after the current one, in the month asked for only', () => {
    expect(days(weekly, '2026-10-01')).toEqual(['2026-10-19', '2026-10-26']);
    expect(days(weekly, '2026-11-01')).toEqual([
      '2026-11-02',
      '2026-11-09',
      '2026-11-16',
      '2026-11-23',
      '2026-11-30',
    ]);
    expect(days(weekly, '2026-09-01')).toEqual([]);
    // A date with a time keeps the start's time of day.
    const timed = { ...weekly, dtstart: '2026-10-12T09:00:00', current: '2026-10-12T09:00:00' };
    expect(days(timed, '2026-10-01')).toEqual(['2026-10-19', '2026-10-26']);
  });

  it('monthly: the engine’s days, a month without one has none', () => {
    const monthly = {
      ...weekly,
      rrule: 'FREQ=MONTHLY',
      dtstart: '2026-10-15',
      current: '2026-10-15',
    };
    expect(days(monthly, '2026-10-01')).toEqual([]);
    expect(days(monthly, '2026-11-01')).toEqual(['2026-11-15']);
    const on31 = {
      ...weekly,
      rrule: 'FREQ=MONTHLY;BYMONTHDAY=31',
      dtstart: '2026-10-31',
      current: '2026-10-31',
    };
    expect(days(on31, '2026-11-01')).toEqual([]);
    expect(days(on31, '2026-12-01')).toEqual(['2026-12-31']);
  });

  it('an interval: every day with one of its times, in the repeat’s zone', () => {
    const every36h: TableRepeat = {
      rrule: 'FREQ=HOURLY;INTERVAL=36',
      dtstart: '2026-10-12T09:00:00',
      current: '2026-10-12T09:00:00',
      tz: 'UTC',
    };
    const october = days(every36h, '2026-10-01');
    expect(october.slice(0, 5)).toEqual([
      '2026-10-13',
      '2026-10-15',
      '2026-10-16',
      '2026-10-18',
      '2026-10-19',
    ]);
    expect(october).not.toContain('2026-10-14');
    expect(october).toHaveLength(13);
    // Every minute: each day from the current one on, cheaply.
    const everyMinute = { ...every36h, rrule: 'FREQ=MINUTELY;INTERVAL=1' };
    expect(days(everyMinute, '2026-10-01')).toHaveLength(20);
    expect(days(everyMinute, '2027-06-01')).toHaveLength(30);
    // 11:30 PM in New York is the next day in UTC: the days are New York's.
    const nightly = {
      ...every36h,
      rrule: 'FREQ=HOURLY;INTERVAL=24',
      dtstart: '2026-10-12T23:30:00',
      current: '2026-10-12T23:30:00',
      tz: 'America/New_York',
    };
    const nights = days(nightly, '2026-10-01');
    expect(nights[0]).toBe('2026-10-13');
    expect(nights[nights.length - 1]).toBe('2026-10-31');
  });

  it('an ended series stops its dots: after a number of times, or on its end date', () => {
    const threeTimes = { ...weekly, rrule: 'FREQ=WEEKLY;BYDAY=MO;COUNT=3' };
    expect(days(threeTimes, '2026-10-01')).toEqual(['2026-10-19', '2026-10-26']);
    expect(days(threeTimes, '2026-11-01')).toEqual([]);
    const until = { ...weekly, rrule: 'FREQ=WEEKLY;BYDAY=MO;UNTIL=20261020' };
    expect(days(until, '2026-10-01')).toEqual(['2026-10-19']);
    const hourly = {
      ...weekly,
      rrule: 'FREQ=HOURLY;INTERVAL=12;COUNT=4',
      dtstart: '2026-10-12T09:00:00',
      current: '2026-10-12T09:00:00',
    };
    expect(days(hourly, '2026-10-01')).toEqual(['2026-10-12', '2026-10-13']);
  });

  it('a current one behind still dots the ones after it', () => {
    const daily = { ...weekly, rrule: 'FREQ=DAILY', dtstart: '2026-10-01', current: '2026-10-29' };
    expect(days(daily, '2026-10-01')).toEqual(['2026-10-30', '2026-10-31']);
  });

  it('an upcoming one moved by hand dots where it went', () => {
    const moved = [{ kind: 'moved' as const, occurrence: '2026-10-19', movedTo: '2026-10-21' }];
    expect([...repeatDaysInMonth(weekly, '2026-10-01', moved)].sort()).toEqual([
      '2026-10-21',
      '2026-10-26',
    ]);
    // A move of the current one is the cell's own date, not a dot.
    const current = [{ kind: 'moved' as const, occurrence: '2026-10-12', movedTo: '2026-10-14' }];
    expect([...repeatDaysInMonth(weekly, '2026-10-01', current)].sort()).toEqual([
      '2026-10-19',
      '2026-10-26',
    ]);
  });
});
