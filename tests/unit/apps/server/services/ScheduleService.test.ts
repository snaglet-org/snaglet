import { describe, expect, it } from '@jest/globals';
import { calculateNextRun, intervalWindowClosed } from '@server/services/ScheduleService';

describe('calculateNextRun', () => {
  it('keeps a one-shot instant exactly', () => {
    const at = '2026-08-05T18:30:00.000Z';
    expect(
      calculateNextRun({ scheduleKind: 'once', schedule: { at }, timezone: 'UTC' })?.toISOString()
    ).toBe(at);
  });

  it('anchors intervals and advances past missed occurrences without replaying them', () => {
    const next = calculateNextRun(
      {
        scheduleKind: 'interval',
        schedule: { every: 15, unit: 'minute', anchor: '2026-08-05T18:00:00.000Z' },
        timezone: 'UTC',
      },
      new Date('2026-08-05T18:52:00.000Z')
    );
    expect(next?.toISOString()).toBe('2026-08-05T19:00:00.000Z');
  });

  it('calculates wall-clock calendar runs in the selected timezone', () => {
    const next = calculateNextRun(
      {
        scheduleKind: 'calendar',
        schedule: { time: '09:00', weekdays: [1, 2, 3, 4, 5] },
        timezone: 'America/Los_Angeles',
      },
      new Date('2026-07-20T17:00:00.000Z') // Monday 10:00 PDT
    );
    expect(next?.toISOString()).toBe('2026-07-21T16:00:00.000Z');
  });

  it('expands the rrule kind with the shared engine in wall-clock time', () => {
    const weekdays = {
      scheduleKind: 'rrule' as const,
      schedule: {
        rrule: 'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR',
        time: '09:00',
        startsOn: '2026-10-13',
      },
      timezone: 'America/Los_Angeles',
    };
    // Fri 2026-10-30 09:00 PDT → Mon 2026-11-02 09:00 PST, after DST ends.
    expect(calculateNextRun(weekdays, new Date('2026-10-30T16:00:00.000Z'))?.toISOString()).toBe(
      '2026-11-02T17:00:00.000Z'
    );
    const once = {
      scheduleKind: 'rrule' as const,
      schedule: { rrule: 'FREQ=DAILY;COUNT=1', time: '09:00', startsOn: '2026-10-14' },
      timezone: 'UTC',
    };
    expect(calculateNextRun(once, new Date('2026-10-14T09:00:00.000Z'))).toBeNull();
  });

  it('makes a first-open schedule due from its next `after` in wall-clock time', () => {
    const firstOpen = {
      scheduleKind: 'first_open' as const,
      schedule: { after: '05:00' },
      timezone: 'America/Los_Angeles',
    };
    // Tue 04:00 PDT: today's 05:00. Tue 10:00 PDT: Wed 05:00.
    expect(calculateNextRun(firstOpen, new Date('2026-10-13T11:00:00.000Z'))?.toISOString()).toBe(
      '2026-10-13T12:00:00.000Z'
    );
    expect(calculateNextRun(firstOpen, new Date('2026-10-13T17:00:00.000Z'))?.toISOString()).toBe(
      '2026-10-14T12:00:00.000Z'
    );
  });

  it('rejects sub-minute and malformed schedules', () => {
    expect(() =>
      calculateNextRun({
        scheduleKind: 'interval',
        schedule: { every: 0, unit: 'minute' },
        timezone: 'UTC',
      })
    ).toThrow(/positive whole number/i);
    expect(() =>
      calculateNextRun({
        scheduleKind: 'calendar',
        schedule: { time: '25:99' },
        timezone: 'UTC',
      })
    ).toThrow(/HH:mm/i);
  });
});

describe('calculateNextRun with a daily window', () => {
  const LA = 'America/Los_Angeles';
  // 05:05 to 06:00 PDT is 12:05Z to 13:00Z in August.
  const windowed = {
    scheduleKind: 'interval' as const,
    schedule: {
      every: 5,
      unit: 'minute' as const,
      anchor: '2026-08-05T00:03:00.000Z',
      windowStart: '05:05',
      windowEnd: '06:00',
    },
    timezone: LA,
  };
  const next = (after: string) => calculateNextRun(windowed, new Date(after))?.toISOString();

  it('fires on the window grid inside the window, not on the anchor', () => {
    expect(next('2026-08-05T12:12:00.000Z')).toBe('2026-08-05T12:15:00.000Z');
    expect(next('2026-08-05T12:55:00.000Z')).toBe('2026-08-05T13:00:00.000Z');
  });

  it('skips from outside the window to the next window start', () => {
    expect(next('2026-08-05T11:00:00.000Z')).toBe('2026-08-05T12:05:00.000Z');
    expect(next('2026-08-05T13:00:00.000Z')).toBe('2026-08-06T12:05:00.000Z');
    expect(next('2026-08-05T20:00:00.000Z')).toBe('2026-08-06T12:05:00.000Z');
  });

  it('crosses the day boundary in the schedule’s zone', () => {
    // 23:59 PDT on Aug 5 is already Aug 6 in UTC; the next run is Aug 6 05:05 PDT.
    expect(next('2026-08-06T06:59:00.000Z')).toBe('2026-08-06T12:05:00.000Z');
    const night = {
      scheduleKind: 'interval' as const,
      schedule: { every: 30, unit: 'minute' as const, windowStart: '23:00', windowEnd: '01:00' },
      timezone: 'UTC',
    };
    expect(calculateNextRun(night, new Date('2026-08-06T00:40:00.000Z'))?.toISOString()).toBe(
      '2026-08-06T01:00:00.000Z'
    );
    expect(calculateNextRun(night, new Date('2026-08-06T01:00:00.000Z'))?.toISOString()).toBe(
      '2026-08-06T23:00:00.000Z'
    );
  });

  it('leaves an interval without a window on its anchor, all day (unchanged)', () => {
    const { windowStart: _start, windowEnd: _end, ...plain } = windowed.schedule;
    const at = (after: string) =>
      calculateNextRun({ ...windowed, schedule: plain }, new Date(after))?.toISOString();
    expect(at('2026-08-05T13:00:00.000Z')).toBe('2026-08-05T13:03:00.000Z');
    expect(at('2026-08-05T20:00:00.000Z')).toBe('2026-08-05T20:03:00.000Z');
  });

  it('refuses a window whose ends are the same', () => {
    expect(() =>
      calculateNextRun({
        ...windowed,
        schedule: { ...windowed.schedule, windowEnd: '05:05' },
      })
    ).toThrow('An interval window needs two different times (HH:mm).');
  });

  it('intervalWindowClosed says when a late wake would land outside its window', () => {
    expect(intervalWindowClosed(windowed, new Date('2026-08-05T12:30:00.000Z'))).toBe(false);
    expect(intervalWindowClosed(windowed, new Date('2026-08-05T13:00:00.000Z'))).toBe(false);
    expect(intervalWindowClosed(windowed, new Date('2026-08-05T13:00:30.000Z'))).toBe(true);
    const { windowStart: _start, windowEnd: _end, ...plain } = windowed.schedule;
    expect(
      intervalWindowClosed({ ...windowed, schedule: plain }, new Date('2026-08-05T20:00:00.000Z'))
    ).toBe(false);
    expect(
      intervalWindowClosed(
        { scheduleKind: 'calendar', schedule: { time: '09:00' }, timezone: LA },
        new Date('2026-08-05T20:00:00.000Z')
      )
    ).toBe(false);
  });
});
