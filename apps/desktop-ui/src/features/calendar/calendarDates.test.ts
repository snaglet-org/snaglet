import { describe, expect, it } from 'vitest';
import {
  addDays,
  addMonths,
  clampZoom,
  dayOfWeek,
  formatTimedRange,
  instantToZoned,
  monthGridDays,
  navigate,
  rangeFor,
  rangeLabel,
  startOfWeek,
  zonedToInstant,
} from './calendarDates';

describe('calendar date math (pure YYYY-MM-DD, never through UTC midnight)', () => {
  it('adds days across month, year and DST boundaries', () => {
    expect(addDays('2026-10-31', 1)).toBe('2026-11-01');
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDays('2026-03-08', 1)).toBe('2026-03-09');
    expect(addDays('2026-11-01', -1)).toBe('2026-10-31');
  });

  it('adds months clamping the day', () => {
    expect(addMonths('2026-01-31', 1)).toBe('2026-02-28');
    expect(addMonths('2026-10-12', -10)).toBe('2025-12-12');
  });

  it('knows weekdays and week starts', () => {
    expect(dayOfWeek('2026-10-12')).toBe(1); // Monday
    expect(startOfWeek('2026-10-14', 1)).toBe('2026-10-12');
    expect(startOfWeek('2026-10-14', 0)).toBe('2026-10-11');
    expect(startOfWeek('2026-10-12', 1)).toBe('2026-10-12');
  });

  it('builds a month grid of whole weeks', () => {
    const days = monthGridDays('2026-10-12', 1);
    expect(days[0]).toBe('2026-09-28');
    expect(days.length % 7).toBe(0);
    expect(days[days.length - 1]).toBe('2026-11-01');
  });

  it('computes ranges per zoom with exclusive end', () => {
    expect(rangeFor('week', '2026-10-14', 1)).toMatchObject({
      from: '2026-10-12',
      to: '2026-10-19',
    });
    expect(rangeFor('3day', '2026-10-14', 1)).toMatchObject({
      from: '2026-10-14',
      to: '2026-10-17',
    });
    expect(rangeFor('day', '2026-10-14', 1)).toMatchObject({
      from: '2026-10-14',
      to: '2026-10-15',
    });
    const month = rangeFor('month', '2026-10-14', 1);
    expect(month.from).toBe('2026-09-28');
    expect(month.to).toBe('2026-11-02');
    expect(month.days).toHaveLength(35);
  });

  it('navigates by the zoom unit', () => {
    expect(navigate('week', '2026-10-14', 1)).toBe('2026-10-21');
    expect(navigate('3day', '2026-10-14', -1)).toBe('2026-10-11');
    expect(navigate('month', '2026-10-31', 1)).toBe('2026-11-30');
    expect(navigate('day', '2026-10-14', -1)).toBe('2026-10-13');
  });

  it('labels ranges as the spec shows', () => {
    expect(rangeLabel('month', '2026-10-12', 1)).toBe('October 2026');
    expect(rangeLabel('week', '2026-10-14', 1)).toBe('Oct 12 – 18, 2026');
    expect(rangeLabel('week', '2026-09-30', 1)).toBe('Sep 28 – Oct 4, 2026');
    expect(rangeLabel('week', '2026-12-30', 1)).toBe('Dec 28, 2026 – Jan 3, 2027');
    expect(rangeLabel('day', '2026-10-12', 1)).toBe('Monday, October 12');
  });

  it('round-trips wall time and instants in a zone (DST-safe)', () => {
    const instant = zonedToInstant('2026-10-12', 9 * 60, 'America/Los_Angeles');
    expect(instant).toBe('2026-10-12T16:00:00.000Z');
    expect(instantToZoned(instant, 'America/Los_Angeles')).toEqual({
      date: '2026-10-12',
      minutes: 540,
    });
    // After the November fall-back, PST is UTC-8.
    expect(zonedToInstant('2026-11-02', 9 * 60, 'America/Los_Angeles')).toBe(
      '2026-11-02T17:00:00.000Z'
    );
  });

  it('a wall time in a DST gap moves on by the gap; a repeated one is its first instant', () => {
    // Los Angeles springs forward at 2:00 AM on 2026-03-08: 2:30 is 3:30 PDT.
    expect(zonedToInstant('2026-03-08', 150, 'America/Los_Angeles')).toBe(
      '2026-03-08T10:30:00.000Z'
    );
    expect(zonedToInstant('2026-03-08', 120, 'America/Los_Angeles')).toBe(
      '2026-03-08T10:00:00.000Z'
    );
    // Falling back on 2026-11-01, 1:30 AM happens twice: the first (PDT) one.
    expect(zonedToInstant('2026-11-01', 90, 'America/Los_Angeles')).toBe(
      '2026-11-01T08:30:00.000Z'
    );
    // Santiago jumps from midnight to 1:00 AM on 2026-09-06: that day starts
    // at 1:00, not at 11 PM the evening before.
    expect(zonedToInstant('2026-09-06', 0, 'America/Santiago')).toBe('2026-09-06T04:00:00.000Z');
    expect(zonedToInstant('2026-09-05', 23 * 60, 'America/Santiago')).toBe(
      '2026-09-06T03:00:00.000Z'
    );
  });

  it('time lines share a suffix only within one half of the day', () => {
    expect(formatTimedRange('2026-10-12', 540, 630)).toBe('Mon Oct 12, 9:00 – 10:30 AM');
    expect(formatTimedRange('2026-10-12', 690, 750)).toBe('Mon Oct 12, 11:30 AM – 12:30 PM');
    // A midnight end keeps both suffixes, never "10:00 – 12:00 AM".
    expect(formatTimedRange('2026-10-12', 600, 1440)).toBe('Mon Oct 12, 10 AM – 12:00 AM');
    expect(formatTimedRange('2026-10-12', 1380, 1440)).toBe('Mon Oct 12, 11 PM – 12:00 AM');
  });

  it('falls back from week/3-day by pane width', () => {
    expect(clampZoom('week', 900)).toBe('week');
    expect(clampZoom('week', 700)).toBe('week');
    // Seven columns would be under 90 px each: 3 days.
    expect(clampZoom('week', 699)).toBe('3day');
    expect(clampZoom('week', 620)).toBe('3day');
    expect(clampZoom('week', 500)).toBe('3day');
    expect(clampZoom('3day', 900)).toBe('week');
    expect(clampZoom('week', 360)).toBe('day');
    expect(clampZoom('3day', 360)).toBe('day');
    expect(clampZoom('month', 360)).toBe('month');
    expect(clampZoom('year', 360)).toBe('year');
  });

  it('a year is its whole calendar year, labeled and navigated by years', () => {
    const range = rangeFor('year', '2026-10-21', 0);
    expect(range.from).toBe('2026-01-01');
    expect(range.to).toBe('2027-01-01');
    expect(range.days).toHaveLength(365);
    expect(rangeFor('year', '2028-02-29', 1).days).toHaveLength(366);
    expect(rangeLabel('year', '2026-10-21', 0)).toBe('2026');
    expect(navigate('year', '2026-10-21', 1)).toBe('2027-10-21');
    expect(navigate('year', '2028-02-29', -1)).toBe('2027-02-28');
  });
});
