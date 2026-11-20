import { describe, expect, it } from 'vitest';
import { dateRangeText, singleDateText } from './dateRangeText';

const now = new Date('2026-09-26T12:00:00Z');
const utc = { timeZone: 'UTC', now };

describe('dateRangeText — date ranges', () => {
  it('names the month once when both days share it', () => {
    expect(dateRangeText('2026-10-12/2026-10-15', 'date', utc)).toEqual({
      text: 'Oct 12 – 15',
      label: 'October 12 to October 15',
    });
  });

  it('names both months across a month end', () => {
    expect(dateRangeText('2026-10-30/2026-11-02', 'date', utc)).toEqual({
      text: 'Oct 30 – Nov 2',
      label: 'October 30 to November 2',
    });
  });

  it('shows both years across a year end', () => {
    expect(dateRangeText('2026-12-30/2027-01-02', 'date', utc)).toEqual({
      text: 'Dec 30, 2026 – Jan 2, 2027',
      label: 'December 30, 2026 to January 2, 2027',
    });
  });

  it('adds the year once for a range outside the current year', () => {
    expect(dateRangeText('2025-10-12/2025-10-15', 'date', utc)).toEqual({
      text: 'Oct 12 – 15, 2025',
      label: 'October 12, 2025 to October 15, 2025',
    });
    expect(dateRangeText('2025-10-30/2025-11-02', 'date', utc)?.text).toBe('Oct 30 – Nov 2, 2025');
    expect(
      dateRangeText('2026-10-12/2026-10-15', 'date', {
        timeZone: 'UTC',
        now: new Date('2027-01-05T12:00:00Z'),
      })?.text
    ).toBe('Oct 12 – 15, 2026');
  });

  it('leaves single days, invalid text and reversed ranges to the plain display', () => {
    expect(dateRangeText('2026-10-12', 'date', utc)).toBeNull();
    expect(dateRangeText('2026-10-12/2026-10-12', 'date', utc)).toBeNull();
    expect(dateRangeText('2026-10-15/2026-10-12', 'date', utc)).toBeNull();
    expect(dateRangeText('soon', 'date', utc)).toBeNull();
  });
});

describe('dateRangeText — datetime ranges', () => {
  it('shares one day and one suffix within a morning', () => {
    expect(
      dateRangeText('2026-10-12T09:00:00.000000Z/2026-10-12T10:30:00.000000Z', 'datetime', utc)
    ).toEqual({
      text: 'Oct 12, 9:00 – 10:30 AM',
      label: 'October 12, 9:00 AM to 10:30 AM',
    });
  });

  it('keeps both suffixes across noon', () => {
    expect(
      dateRangeText('2026-10-12T11:00:00.000000Z/2026-10-12T13:15:00.000000Z', 'datetime', utc)
        ?.text
    ).toBe('Oct 12, 11:00 AM – 1:15 PM');
  });

  it('names both days when the range spans them', () => {
    expect(
      dateRangeText('2026-10-12T09:00:00.000000Z/2026-10-13T17:00:00.000000Z', 'datetime', utc)
    ).toEqual({
      text: 'Oct 12, 9:00 AM – Oct 13, 5:00 PM',
      label: 'October 12, 9:00 AM to October 13, 5:00 PM',
    });
  });

  it('reads instants in the viewer zone', () => {
    const value = '2026-10-12T16:00:00.000000Z/2026-10-12T17:30:00.000000Z';
    expect(dateRangeText(value, 'datetime', { timeZone: 'America/Los_Angeles', now })?.text).toBe(
      'Oct 12, 9:00 – 10:30 AM'
    );
    expect(dateRangeText(value, 'datetime', { timeZone: 'Asia/Tokyo', now })?.text).toBe(
      'Oct 13, 1:00 – 2:30 AM'
    );
    // Wall times without an offset are that zone's clock.
    expect(
      dateRangeText('2026-10-12T09:00/2026-10-12T10:30', 'datetime', {
        timeZone: 'America/New_York',
        now,
      })?.text
    ).toBe('Oct 12, 9:00 – 10:30 AM');
  });

  it('shows years across a year end in the viewer zone', () => {
    expect(
      dateRangeText('2026-12-31T23:00:00.000000Z/2027-01-01T01:00:00.000000Z', 'datetime', utc)
        ?.text
    ).toBe('Dec 31, 2026, 11:00 PM – Jan 1, 2027, 1:00 AM');
    expect(
      dateRangeText('2025-10-12T09:00:00.000000Z/2025-10-12T10:30:00.000000Z', 'datetime', utc)
        ?.text
    ).toBe('Oct 12, 2025, 9:00 – 10:30 AM');
  });

  it('shows midnight-to-midnight ranges as whole days', () => {
    const zone = { timeZone: 'America/Los_Angeles', now };
    expect(
      dateRangeText('2026-10-12T07:00:00.000000Z/2026-10-16T07:00:00.000000Z', 'datetime', zone)
    ).toEqual({ text: 'Oct 12 – 15', label: 'October 12 to October 15' });
    expect(
      dateRangeText('2026-10-12T07:00:00.000000Z/2026-10-13T07:00:00.000000Z', 'datetime', zone)
    ).toEqual({ text: 'Oct 12, all day', label: 'October 12, all day' });
  });

  it('ends at midnight on the day it closes, not 12:00 AM the next day', () => {
    expect(
      dateRangeText('2026-10-12T21:00:00.000000Z/2026-10-13T00:00:00.000000Z', 'datetime', utc)
    ).toEqual({
      text: 'Oct 12, 9:00 PM – 12:00 AM',
      label: 'October 12, 9:00 PM to midnight',
    });
    expect(
      dateRangeText('2026-10-12T09:00:00.000000Z/2026-10-13T00:00:00.000000Z', 'datetime', utc)
        ?.text
    ).toBe('Oct 12, 9:00 AM – 12:00 AM');
    expect(
      dateRangeText('2026-10-12T09:00:00.000000Z/2026-10-14T00:00:00.000000Z', 'datetime', utc)
    ).toEqual({
      text: 'Oct 12, 9:00 AM – Oct 13, end of day',
      label: 'October 12, 9:00 AM to the end of October 13',
    });
  });

  it('leaves single instants to the plain display', () => {
    expect(dateRangeText('2026-10-12T09:00:00.000000Z', 'datetime', utc)).toBeNull();
  });
});

describe('singleDateText — one date or time, as the date field reads it', () => {
  const en = { ...utc, locale: 'en-US' };

  it('a date: weekday, month and day, the year only outside the current one', () => {
    expect(singleDateText('2026-10-13', 'date', en)).toEqual({
      text: 'Tue, Oct 13',
      label: 'Tuesday, October 13, 2026',
    });
    expect(singleDateText('2027-01-04', 'date', en)?.text).toBe('Mon, Jan 4, 2027');
  });

  it('follows the viewer’s locale', () => {
    expect(singleDateText('2026-10-13', 'date', { ...utc, locale: 'en-GB' })?.text).toBe(
      'Tue 13 Oct'
    );
  });

  it('a date and time: on the viewer’s wall clock, without seconds', () => {
    const value = '2026-10-12T16:00:42.123456Z';
    expect(singleDateText(value, 'datetime', { ...en, timeZone: 'America/Los_Angeles' })).toEqual({
      text: 'Oct 12, 9:00 AM',
      label: 'Monday, October 12, 2026, 9:00 AM',
    });
    expect(singleDateText('2026-01-01T07:00:00Z', 'datetime', en)?.text).toBe('Jan 1, 7:00 AM');
    // 7 AM UTC on Jan 1, 2027 is still this year in Los Angeles: no year.
    expect(
      singleDateText('2027-01-01T07:00:00Z', 'datetime', { ...en, timeZone: 'America/Los_Angeles' })
        ?.text
    ).toBe('Dec 31, 11:00 PM');
  });

  it('null for text that is not a value', () => {
    expect(singleDateText('2026-02-30', 'date', en)).toBeNull();
    expect(singleDateText('soon', 'date', en)).toBeNull();
    expect(singleDateText('2026-02-30T12:30', 'datetime', en)).toBeNull();
  });
});
