import { describe, expect, it } from 'vitest';
import { fromDateTimeInput, toDateTimeInput } from './dateTimeInput';

describe('datetime-local table values', () => {
  it.each([
    ['2026-01-01T01:30:00.000000Z', 'America/Los_Angeles', '2025-12-31T17:30'],
    ['2026-06-01T23:30:00-04:00', 'Asia/Tokyo', '2026-06-02T12:30'],
    ['2026-09-26T17:02:16.832699Z', 'America/Los_Angeles', '2026-09-26T10:02:16.832'],
    ['2026-09-26T17:02:00.000001Z', 'America/Los_Angeles', '2026-09-26T10:02'],
    ['2026-01-01', 'America/Los_Angeles', '2026-01-01T00:00'],
  ])('shows %s in %s as local wall time', (value, zone, expected) => {
    expect(toDateTimeInput(value, zone)).toBe(expected);
  });

  it.each([
    ['2025-12-31T17:30', 'America/Los_Angeles', '2026-01-01T01:30:00.000000Z'],
    ['2026-06-02T12:30', 'Asia/Tokyo', '2026-06-02T03:30:00.000000Z'],
    ['2026-09-26T10:02:16.832', 'America/Los_Angeles', '2026-09-26T17:02:16.832000Z'],
    ['2026-03-08T02:30', 'America/Los_Angeles', '2026-03-08T10:30:00.000000Z'],
    ['2026-11-01T01:30', 'America/Los_Angeles', '2026-11-01T09:30:00.000000Z'],
  ])('converts a changed %s in %s to UTC', (value, zone, expected) => {
    expect(fromDateTimeInput(value, null, zone)).toBe(expected);
  });

  it('retains original seconds, all microseconds, and offset when the visible value is unchanged', () => {
    const value = '2026-09-26T10:02:16.832699-07:00';
    expect(
      fromDateTimeInput(toDateTimeInput(value, 'America/Los_Angeles'), value, 'America/Los_Angeles')
    ).toBe(value);
    const tiny = '2026-09-26T17:02:00.000001Z';
    expect(fromDateTimeInput('2026-09-26T10:02', tiny, 'America/Los_Angeles')).toBe(tiny);
  });

  it('preserves the earlier repeated-hour instant until the user actually changes its time', () => {
    const value = '2026-11-01T08:30:00.000000Z';
    expect(toDateTimeInput(value, 'America/Los_Angeles')).toBe('2026-11-01T01:30');
    expect(fromDateTimeInput('2026-11-01T01:30', value, 'America/Los_Angeles')).toBe(value);
    expect(fromDateTimeInput('2026-11-01T01:31', value, 'America/Los_Angeles')).toBe(
      '2026-11-01T09:31:00.000000Z'
    );
  });

  it.each([null, undefined, '', 'not a date', '2026-02-30T12:30', '2026-01-01T24:00'])(
    'does not throw while displaying invalid or empty %s',
    (value) => {
      expect(toDateTimeInput(value, 'UTC')).toBe('');
    }
  );

  it('keeps invalid edits available to validation and treats explicit empty input as null', () => {
    expect(fromDateTimeInput('not a date', null, 'UTC')).toBe('not a date');
    expect(fromDateTimeInput('2026-02-30T12:30', null, 'UTC')).toBe('2026-02-30T12:30');
    expect(fromDateTimeInput('', '2026-01-01T00:00:00Z', 'UTC')).toBeNull();
    expect(fromDateTimeInput('  ', null, 'UTC')).toBeNull();
  });
});
