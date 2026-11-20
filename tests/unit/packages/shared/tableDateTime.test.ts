import { afterEach, describe, expect, it, jest } from '@jest/globals';
import {
  parseTableDateTime,
  tableDateTimeLocalDate,
  tableDateTimeToUtc,
  userTimeZone,
} from '@snaglet/shared/utils';

describe('tableDateTimeToUtc', () => {
  it.each([
    ['2026-10-01T22:30:00Z', 'UTC', '2026-10-01T22:30:00.000000Z'],
    ['2026-10-01T15:30:00-07:00', 'Pacific/Auckland', '2026-10-01T22:30:00.000000Z'],
    ['2026-10-01T15:30-0700', 'UTC', '2026-10-01T22:30:00.000000Z'],
    ['2026-10-02T04:00+05:30', 'UTC', '2026-10-01T22:30:00.000000Z'],
    ['2026-10-01T23:30+01', 'UTC', '2026-10-01T22:30:00.000000Z'],
    ['2026-10-01 22:30:00.5Z', 'UTC', '2026-10-01T22:30:00.500000Z'],
    ['2026-10-01T22:30:00.123456Z', 'UTC', '2026-10-01T22:30:00.123456Z'],
  ])('keeps the instant of %s whatever the zone', (value, zone, utc) => {
    expect(tableDateTimeToUtc(value, zone)).toBe(utc);
  });

  it.each([
    // No offset: wall-clock time in the user's zone.
    ['2026-10-01T15:30', 'America/Los_Angeles', '2026-10-01T22:30:00.000000Z'],
    ['2026-10-01T15:30', 'Pacific/Auckland', '2026-10-01T02:30:00.000000Z'],
    ['2026-07-01T15:30', 'Pacific/Auckland', '2026-07-01T03:30:00.000000Z'],
    ['2026-10-01T15:30', 'Asia/Kolkata', '2026-10-01T10:00:00.000000Z'],
    // A bare date is midnight there.
    ['2026-10-01', 'Pacific/Auckland', '2026-09-30T11:00:00.000000Z'],
    ['2026-10-01', 'UTC', '2026-10-01T00:00:00.000000Z'],
  ])('reads %s in %s', (value, zone, utc) => {
    expect(tableDateTimeToUtc(value, zone)).toBe(utc);
  });

  it('resolves DST transitions as PostgreSQL does', () => {
    // Spring forward (02:00 → 03:00): a skipped 02:30 lands at 03:30.
    expect(tableDateTimeToUtc('2026-03-08T02:30', 'America/Los_Angeles')).toBe(
      '2026-03-08T10:30:00.000000Z'
    );
    expect(tableDateTimeToUtc('2026-09-27T02:30', 'Pacific/Auckland')).toBe(
      '2026-09-26T14:30:00.000000Z'
    );
    // Fall back (02:00 → 01:00): a repeated 01:30 takes the later, standard-time offset.
    expect(tableDateTimeToUtc('2026-11-01T01:30', 'America/Los_Angeles')).toBe(
      '2026-11-01T09:30:00.000000Z'
    );
  });

  it('keeps years 1–9999 and refuses what falls outside them', () => {
    expect(tableDateTimeToUtc('0001-01-01T12:00Z', 'UTC')).toBe('0001-01-01T12:00:00.000000Z');
    expect(tableDateTimeToUtc('0099-06-15T00:00Z', 'UTC')).toBe('0099-06-15T00:00:00.000000Z');
    expect(tableDateTimeToUtc('9999-12-31T23:59:59.999999Z', 'UTC')).toBe(
      '9999-12-31T23:59:59.999999Z'
    );
    expect(tableDateTimeToUtc('0001-01-01T00:00+05:00', 'UTC')).toBeNull();
    expect(tableDateTimeToUtc('9999-12-31T23:00-05:00', 'UTC')).toBeNull();
    expect(tableDateTimeToUtc('not a date', 'UTC')).toBeNull();
  });
});

describe('parseTableDateTime', () => {
  it('returns parts, the fraction as six digits and the offset in minutes', () => {
    expect(parseTableDateTime('2026-10-01T15:30:05.25-03:30')).toEqual({
      year: 2026,
      month: 10,
      day: 1,
      hour: 15,
      minute: 30,
      second: 5,
      micros: '250000',
      offsetMinutes: -210,
    });
    expect(parseTableDateTime('2026-10-01')).toMatchObject({ hour: 0, offsetMinutes: null });
  });

  it.each([
    '2026-13-01',
    '2026-02-30T10:00',
    '0000-01-01',
    '2026-10-01T23:59:60Z',
    '2026-10-01T10:00+15:60',
    '2026-10-01T10',
    '2026-10-01T10:00:00.Z',
    ' 2026-10-01',
  ])('refuses %s', (value) => {
    expect(parseTableDateTime(value)).toBeNull();
  });
});

describe('tableDateTimeLocalDate', () => {
  it('is the calendar date the instant falls on in the zone', () => {
    expect(tableDateTimeLocalDate('2026-10-01T20:00:00Z', 'Pacific/Auckland')).toBe('2026-10-02');
    expect(tableDateTimeLocalDate('2026-10-01T20:00:00Z', 'America/Los_Angeles')).toBe(
      '2026-10-01'
    );
    expect(tableDateTimeLocalDate('2026-10-02T03:00:00Z', 'America/Los_Angeles')).toBe(
      '2026-10-01'
    );
    expect(tableDateTimeLocalDate('nope', 'UTC')).toBeNull();
  });
});

describe('userTimeZone', () => {
  afterEach(() => jest.restoreAllMocks());

  it('is the process zone get_current_datetime reports', () => {
    expect(userTimeZone()).toBe(Intl.DateTimeFormat().resolvedOptions().timeZone);
  });

  it('falls back to UTC for a zone name that could not be embedded in SQL', () => {
    const resolved = Intl.DateTimeFormat.prototype.resolvedOptions;
    jest.spyOn(Intl.DateTimeFormat.prototype, 'resolvedOptions').mockImplementation(function (
      this: Intl.DateTimeFormat
    ) {
      return { ...resolved.call(this), timeZone: "Bad'Zone" };
    });
    expect(userTimeZone()).toBe('UTC');
  });
});
