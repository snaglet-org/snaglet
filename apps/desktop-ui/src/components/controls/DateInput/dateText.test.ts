import { describe, expect, it } from 'vitest';
import {
  formatTimeLabel,
  formatValue,
  isWireValue,
  parseDateText,
  parseDateTimeText,
  parseTimeText,
  parseTyped,
  rangeProblem,
} from './dateText';

const today = '2026-10-13';
const us = 'en-US';

describe('parseDateText', () => {
  it.each([
    ['2026-10-13', '2026-10-13'],
    ['2026/10/13', '2026-10-13'],
    ['2026-1-5', '2026-01-05'],
    ['10/13', '2026-10-13'],
    ['10/13/2026', '2026-10-13'],
    ['10/13/27', '2027-10-13'],
    ['10-13-2026', '2026-10-13'],
    ['oct 13', '2026-10-13'],
    ['Oct 13, 2027', '2027-10-13'],
    ['october 13th', '2026-10-13'],
    ['13 oct', '2026-10-13'],
    ['13 October 2027', '2027-10-13'],
    ['the 13th of october', '2026-10-13'],
    ['sept 3', '2026-09-03'],
    ['Tue, Oct 13', '2026-10-13'],
    ['Tue, Oct 13, 2026', '2026-10-13'],
    ['today', '2026-10-13'],
    ['Tomorrow', '2026-10-14'],
    ['yesterday', '2026-10-12'],
    ['  TODAY  ', '2026-10-13'],
  ])('reads %j as %s', (text, day) => {
    expect(parseDateText(text, today, us)).toBe(day);
  });

  it('crosses month and year ends for the relative words', () => {
    expect(parseDateText('tomorrow', '2026-12-31', us)).toBe('2027-01-01');
    expect(parseDateText('yesterday', '2026-03-01', us)).toBe('2026-02-28');
  });

  it('reads numeric days in the locale order, and the only reading of an impossible one', () => {
    expect(parseDateText('10/12', today, 'en-GB')).toBe('2026-12-10');
    expect(parseDateText('13.10.2026', today, 'de-DE')).toBe('2026-10-13');
    expect(parseDateText('13/10', today, us)).toBe('2026-10-13');
  });

  it.each([
    '',
    'banana',
    '2026-02-30',
    '13/13',
    '2/30',
    'oct',
    'oct 32',
    'oct 13 12',
    'feb 29 2026',
    'ma 3',
    '10/13/123',
  ])('refuses %j', (text) => {
    expect(parseDateText(text, today, us)).toBeNull();
  });

  it('knows leap days', () => {
    expect(parseDateText('feb 29 2028', today, us)).toBe('2028-02-29');
  });
});

describe('parseTimeText', () => {
  it.each([
    ['9', '09:00'],
    ['09', '09:00'],
    ['930', '09:30'],
    ['0930', '09:30'],
    ['1230', '12:30'],
    ['2130', '21:30'],
    ['9:30', '09:30'],
    ['9.30', '09:30'],
    ['9:30p', '21:30'],
    ['9:30pm', '21:30'],
    ['9:30 pm', '21:30'],
    ['9:30 P.M.', '21:30'],
    ['9a', '09:00'],
    ['12am', '00:00'],
    ['12 pm', '12:00'],
    ['21:30', '21:30'],
    ['21:30:15', '21:30:15'],
    ['0:05', '00:05'],
    ['noon', '12:00'],
    ['Midnight', '00:00'],
  ])('reads %j as %s', (text, time) => {
    expect(parseTimeText(text)).toBe(time);
  });

  it.each(['', 'lunch', '24', '25:00', '9:75', '13pm', '0am', '12345', '9:3', '21:30:75'])(
    'refuses %j',
    (text) => {
      expect(parseTimeText(text)).toBeNull();
    }
  );
});

describe('parseDateTimeText', () => {
  const context = { today, locale: us };

  it.each([
    ['2026-10-13T09:30', '2026-10-13T09:30'],
    ['2026-10-13 9:30', '2026-10-13T09:30'],
    ['2026-10-13T21:30:15.5', '2026-10-13T21:30:15.5'],
    ['tomorrow 9am', '2026-10-14T09:00'],
    ['tomorrow at 9', '2026-10-14T09:00'],
    ['oct 13 9:30 pm', '2026-10-13T21:30'],
    ['Oct 13, 2027, 9:00 AM', '2027-10-13T09:00'],
    ['10/13 930', '2026-10-13T09:30'],
    ['13 oct noon', '2026-10-13T12:00'],
    ['oct 13 12', '2026-10-13T12:00'],
  ])('reads %j as %s', (text, value) => {
    expect(parseDateTimeText(text, context)).toBe(value);
  });

  it('keeps the current time for a typed day, and the current day for a typed time', () => {
    const current = '2026-10-20T14:45';
    expect(parseDateTimeText('oct 22', { ...context, current })).toBe('2026-10-22T14:45');
    expect(parseDateTimeText('9:15a', { ...context, current })).toBe('2026-10-20T09:15');
    // With nothing to keep: 9:00 AM, and today.
    expect(parseDateTimeText('oct 22', context)).toBe('2026-10-22T09:00');
    expect(parseDateTimeText('3pm', context)).toBe('2026-10-13T15:00');
  });

  it.each(['', 'soon', '2026-02-30T09:00', 'oct 13 25:00', 'tomorrow lunch'])(
    'refuses %j',
    (text) => {
      expect(parseDateTimeText(text, context)).toBeNull();
    }
  );
});

describe('parseTyped with min and max', () => {
  it('reads empty text as cleared', () => {
    expect(parseTyped('date', '   ', { today })).toEqual({ ok: true, value: '' });
  });

  it('refuses days outside the range and says which side', () => {
    const range = { today, locale: us, min: '2026-10-10', max: '2026-10-20' };
    expect(parseTyped('date', 'oct 9', range)).toEqual({ ok: false, reason: 'before-min' });
    expect(parseTyped('date', 'oct 21', range)).toEqual({ ok: false, reason: 'after-max' });
    expect(parseTyped('date', 'oct 10', range)).toEqual({ ok: true, value: '2026-10-10' });
    expect(parseTyped('date', 'oct 20', range)).toEqual({ ok: true, value: '2026-10-20' });
    expect(parseTyped('date', 'nope', range)).toEqual({ ok: false, reason: 'unreadable' });
  });

  it('compares times and date-times whatever their precision', () => {
    expect(rangeProblem('time', '08:59', '09:00')).toBe('before-min');
    expect(rangeProblem('time', '09:00:00', '09:00')).toBeNull();
    expect(rangeProblem('datetime-local', '2026-10-13T09:00', '2026-10-13T09:00:00')).toBeNull();
    expect(rangeProblem('datetime-local', '2026-10-13T23:30', undefined, '2026-10-13')).toBeNull();
    expect(rangeProblem('datetime-local', '2026-10-14T00:00', undefined, '2026-10-13')).toBe(
      'after-max'
    );
  });
});

describe('isWireValue', () => {
  it('accepts only complete native values', () => {
    expect(isWireValue('date', '2026-10-13')).toBe(true);
    expect(isWireValue('date', '2026-10-1')).toBe(false);
    expect(isWireValue('datetime-local', '2026-10-13T09:30')).toBe(true);
    expect(isWireValue('datetime-local', '2026-10-13T09:30:16.832')).toBe(true);
    expect(isWireValue('datetime-local', '2026-10-13')).toBe(false);
    expect(isWireValue('time', '09:30')).toBe(true);
    expect(isWireValue('time', '9:30')).toBe(false);
  });
});

describe('formatValue', () => {
  const at = { today, locale: us };

  it('shows dates with the weekday, and the year only when it is not this one', () => {
    expect(formatValue('date', '2026-10-13', at)).toBe('Tue, Oct 13');
    expect(formatValue('date', '2027-01-02', at)).toBe('Sat, Jan 2, 2027');
  });

  it('shows date-times and times in the locale clock, seconds only when set', () => {
    expect(formatValue('datetime-local', '2026-10-13T09:00', at)).toBe('Oct 13, 9:00 AM');
    expect(formatValue('datetime-local', '2025-10-13T21:05', at)).toBe('Oct 13, 2025, 9:05 PM');
    expect(formatValue('datetime-local', '2026-09-30T19:30:16.832', at)).toBe('Sep 30, 7:30:16 PM');
    expect(formatValue('time', '09:00', at)).toBe('9:00 AM');
    expect(formatValue('time', '21:30', { today, locale: 'en-GB' })).toBe('21:30');
    expect(formatTimeLabel(13 * 60 + 15, us)).toBe('1:15 PM');
  });

  it('round-trips its own text through the parser', () => {
    for (const [kind, value] of [
      ['date', '2026-10-13'],
      ['date', '2027-01-02'],
      ['datetime-local', '2026-10-13T09:00'],
      ['datetime-local', '2025-10-13T21:05'],
      ['time', '21:30'],
    ] as const) {
      expect(parseTyped(kind, formatValue(kind, value, at), at)).toEqual({ ok: true, value });
    }
  });

  it('shows a value it cannot read as it is', () => {
    expect(formatValue('date', 'not a date', at)).toBe('not a date');
    expect(formatValue('date', '', at)).toBe('');
  });
});
