import { describe, expect, it } from '@jest/globals';
import {
  automationFloorError,
  describeAutomationWhen,
  firstOpenTick,
  formatAutomationInstant,
  formatTimeOfDay,
  intervalWindowMs,
  isWithinIntervalWindow,
  localDayBounds,
  matchQuickRepeat,
  nextAutomationRun,
  nextFirstOpenRun,
  nextRepeatRun,
  nextWindowedIntervalRun,
  normalizeAutomationWhen,
  quickRepeatRule,
  repeatRunsBetween,
  type NormalizeWhenOptions,
} from '@snaglet/shared/utils';

const LA = 'America/Los_Angeles';
// Tuesday 2026-10-13 10:00 PDT.
const NOW = new Date('2026-10-13T17:00:00.000Z');
const AGENT: NormalizeWhenOptions = {
  now: NOW,
  defaultTz: LA,
  minEveryMs: 15 * 60_000,
  agentMinEveryMs: 15 * 60_000,
};
const PERSON: NormalizeWhenOptions = { ...AGENT, minEveryMs: 60_000 };
const AGENT_FLOOR =
  'every must be at least 15m for agents (1m for people). Down to 5m works with a window of at most 2h: add window_start and window_end, e.g. "05:05" and "06:00".';

function ok(input: unknown, options: NormalizeWhenOptions = AGENT) {
  const result = normalizeAutomationWhen(input, options);
  if (!result.ok) throw new Error(`expected ok, got: ${result.error}`);
  return result.value;
}

function error(input: unknown, options: NormalizeWhenOptions = AGENT): string {
  const result = normalizeAutomationWhen(input, options);
  if (result.ok) throw new Error('expected an error');
  return result.error;
}

describe('normalizeAutomationWhen', () => {
  it('turns `in` into a once at an absolute instant', () => {
    expect(ok({ in: '2h' })).toEqual({ kind: 'once', at: '2026-10-13T19:00:00.000Z', tz: LA });
    expect(ok({ in: '30m' })).toMatchObject({ at: '2026-10-13T17:30:00.000Z' });
    expect(ok({ in: '1d', tz: 'UTC' })).toEqual({
      kind: 'once',
      at: '2026-10-14T17:00:00.000Z',
      tz: 'UTC',
    });
  });

  it('reads `at` as local wall time in tz', () => {
    expect(ok({ at: '2026-10-14T09:00' })).toEqual({
      kind: 'once',
      at: '2026-10-14T16:00:00.000Z',
      tz: LA,
    });
    expect(ok({ at: '2026-10-14T09:00', tz: 'Europe/London' })).toMatchObject({
      at: '2026-10-14T08:00:00.000Z',
    });
  });

  it('moves a wall time skipped by spring-forward an hour on (02:30 → 03:30)', () => {
    const when = ok({ at: '2027-03-14T02:30' }, { ...AGENT, now: new Date('2027-01-01T00:00Z') });
    expect(when).toMatchObject({ at: '2027-03-14T10:30:00.000Z' }); // 03:30 PDT
  });

  it('keeps a repeat as its normalized rule, time and start day', () => {
    expect(ok({ repeat: 'rrule:freq=weekly;byday=mo,tu,we,th,fr', at: '09:00' })).toEqual({
      kind: 'repeat',
      rrule: 'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR',
      timeOfDay: '09:00',
      startsOn: '2026-10-13',
      tz: LA,
    });
    expect(ok({ repeat: 'FREQ=DAILY;COUNT=3', at: '07:30', starts: '2026-11-01' })).toMatchObject({
      startsOn: '2026-11-01',
      rrule: 'FREQ=DAILY;COUNT=3',
    });
  });

  it('keeps an interval as milliseconds, with the agent and person floors', () => {
    expect(ok({ every: '15m' })).toEqual({ kind: 'interval', everyMs: 900_000, tz: LA });
    expect(ok({ every: '7d' })).toMatchObject({ everyMs: 7 * 86_400_000 });
    expect(error({ every: '5m' })).toBe(AGENT_FLOOR);
    expect(ok({ every: '5m' }, PERSON)).toMatchObject({ everyMs: 300_000 });
    expect(ok({ every: '1m' }, PERSON)).toMatchObject({ everyMs: 60_000 });
    expect(error({ every: '8d' }, PERSON)).toBe('every must be at most 7d.');
  });

  it('anchors an interval with `at` (past or future), read in tz', () => {
    // 2026-10-13 10:00 PDT now; 19:07 PDT is 02:07Z the next day.
    expect(ok({ every: '15m', at: '2026-10-13T19:07' })).toEqual({
      kind: 'interval',
      everyMs: 900_000,
      tz: LA,
      anchor: '2026-10-14T02:07:00.000Z',
    });
    expect(ok({ every: '15m', at: '2026-10-01T00:07', tz: 'UTC' })).toMatchObject({
      anchor: '2026-10-01T00:07:00.000Z',
      tz: 'UTC',
    });
    expect(ok({ every: '15m' })).not.toHaveProperty('anchor');
    expect(error({ every: '15m', at: 'soon' })).toBe(
      'at must be a local date-time like "2026-10-14T09:00".'
    );
    expect(error({ every: '15m', at: '09:00' })).toBe(
      'at must be a local date-time like "2026-10-14T09:00".'
    );
    expect(error({ every: '5m', at: '2026-10-13T19:07' })).toBe(AGENT_FLOOR);
    expect(error({ every: '15m', at: '2026-10-13T19:07', tz: 'Mars/Base' })).toMatch(
      /^Unknown time zone/
    );
  });

  it('still rejects every with in or repeat, and at with in', () => {
    const one = 'when must have exactly one of in, at, repeat, every, first_open.';
    expect(error({ every: '15m', in: '1h', at: '2026-10-13T19:07' })).toBe(one);
    expect(error({ every: '15m', repeat: 'FREQ=DAILY', at: '09:00' })).toBe(one);
    expect(error({ at: '2026-10-14T09:00', in: '1h' })).toBe(one);
    expect(error({ every: '15m', starts: '2026-10-14' })).toBe(one);
  });

  it('returns the exact error texts', () => {
    expect(error({})).toBe('when must have exactly one of in, at, repeat, every, first_open.');
    expect(error({ in: '2h', every: '15m' })).toBe(
      'when must have exactly one of in, at, repeat, every, first_open.'
    );
    expect(error({ in: '2h', at: '2026-10-14T09:00' })).toBe(
      'when must have exactly one of in, at, repeat, every, first_open.'
    );
    expect(error('2h')).toBe('when must have exactly one of in, at, repeat, every, first_open.');
    expect(error({ in: 'soon' })).toBe('in must look like "30m", "2h" or "1d".');
    expect(error({ in: '2w' })).toBe('in must look like "30m", "2h" or "1d".');
    expect(error({ at: 'tomorrow 9am' })).toBe(
      'at must be a local date-time like "2026-10-14T09:00".'
    );
    expect(error({ at: '2026-02-30T09:00' })).toBe(
      'at must be a local date-time like "2026-10-14T09:00".'
    );
    expect(error({ at: '2026-10-13T09:00' })).toBe('That time is in the past.');
    expect(error({ repeat: 'FREQ=HOURLY', at: '09:00' })).toBe(
      'repeat: FREQ must be DAILY, WEEKLY, MONTHLY or YEARLY (got HOURLY).'
    );
    expect(error({ repeat: 'FREQ=DAILY' })).toBe(
      'repeat needs at, e.g. {repeat:"FREQ=DAILY", at:"09:00"}.'
    );
    expect(error({ repeat: 'FREQ=DAILY', at: '9am' })).toBe(
      'repeat needs at, e.g. {repeat:"FREQ=DAILY", at:"09:00"}.'
    );
    expect(error({ repeat: 'FREQ=DAILY;UNTIL=20261001', at: '09:00' })).toBe(
      'That repeat has no runs left.'
    );
    expect(error({ in: '2h', tz: 'Mars/Olympus' })).toBe('Unknown time zone "Mars/Olympus".');
    expect(error({ every: 'often' })).toBe('every must look like "15m", "2h" or "1d".');
  });
});

describe('repeat expansion', () => {
  const weekdays = {
    rrule: 'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR',
    timeOfDay: '09:00',
    startsOn: '2026-10-13',
  };

  it('stays at 09:00 wall time across the DST change (America/Los_Angeles)', () => {
    // Fri 2026-10-30 09:00 PDT → next Mon 2026-11-02 09:00 PST (DST ended Nov 1).
    expect(nextRepeatRun(weekdays, LA, new Date('2026-10-30T17:00:00Z'))?.toISOString()).toBe(
      '2026-11-02T17:00:00.000Z'
    );
    const runs = repeatRunsBetween(
      weekdays,
      LA,
      new Date('2026-10-29T00:00:00Z'),
      new Date('2026-11-04T00:00:00Z'),
      50
    ).map((d) => d.toISOString());
    expect(runs).toEqual([
      '2026-10-29T16:00:00.000Z', // Thu 09:00 PDT
      '2026-10-30T16:00:00.000Z', // Fri 09:00 PDT
      '2026-11-02T17:00:00.000Z', // Mon 09:00 PST
      '2026-11-03T17:00:00.000Z', // Tue 09:00 PST
    ]);
  });

  it('does not fire on a start day the rule does not match', () => {
    // Created Tuesday 08:00 for "every Monday 09:00": first run is next Monday.
    const mondays = { rrule: 'FREQ=WEEKLY;BYDAY=MO', timeOfDay: '09:00', startsOn: '2026-10-13' };
    expect(nextRepeatRun(mondays, LA, new Date('2026-10-13T15:00:00Z'))?.toISOString()).toBe(
      '2026-10-19T16:00:00.000Z'
    );
  });

  it('runs a spring-forward wall time an hour on and still on that day', () => {
    const daily = { rrule: 'FREQ=DAILY', timeOfDay: '02:30', startsOn: '2027-03-13' };
    // 03:00 PDT on 2027-03-14: 02:30 does not exist, so it runs at 03:30.
    expect(nextRepeatRun(daily, LA, new Date('2027-03-14T10:00:00Z'))?.toISOString()).toBe(
      '2027-03-14T10:30:00.000Z'
    );
  });

  it('ends when COUNT is used up (counted from the first match)', () => {
    const three = {
      rrule: 'FREQ=WEEKLY;BYDAY=MO;COUNT=3',
      timeOfDay: '09:00',
      startsOn: '2026-10-13',
    };
    const all = repeatRunsBetween(
      three,
      LA,
      new Date('2026-10-01T00:00:00Z'),
      new Date('2027-01-01T00:00:00Z'),
      50
    ).map((d) => d.toISOString());
    expect(all).toEqual([
      '2026-10-19T16:00:00.000Z',
      '2026-10-26T16:00:00.000Z',
      '2026-11-02T17:00:00.000Z',
    ]);
    expect(nextRepeatRun(three, LA, new Date('2026-11-02T17:00:00Z'))).toBeNull();
  });

  it('covers the whole UNTIL day', () => {
    const until = {
      rrule: 'FREQ=DAILY;UNTIL=20261015',
      timeOfDay: '21:00',
      startsOn: '2026-10-14',
    };
    expect(nextRepeatRun(until, 'UTC', new Date('2026-10-15T00:00:00Z'))?.toISOString()).toBe(
      '2026-10-15T21:00:00.000Z'
    );
    expect(nextRepeatRun(until, 'UTC', new Date('2026-10-15T21:00:00Z'))).toBeNull();
  });

  it('nextAutomationRun handles once and interval', () => {
    const once = { kind: 'once' as const, at: '2026-10-14T16:00:00.000Z', tz: LA };
    expect(nextAutomationRun(once, NOW)?.toISOString()).toBe(once.at);
    expect(nextAutomationRun(once, new Date('2026-10-15T00:00:00Z'))).toBeNull();
    const every = { kind: 'interval' as const, everyMs: 900_000, tz: LA };
    expect(nextAutomationRun(every, new Date('2026-10-13T17:20:00Z'), NOW)?.toISOString()).toBe(
      '2026-10-13T17:30:00.000Z'
    );
    // An anchored interval: a past anchor aligns to the next slot, a future one is the first run.
    const anchored = {
      kind: 'interval' as const,
      everyMs: 900_000,
      tz: 'UTC',
      anchor: '2026-10-13T16:07:00.000Z',
    };
    expect(nextAutomationRun(anchored, NOW)?.toISOString()).toBe('2026-10-13T17:07:00.000Z');
    // A year-old anchor is plain arithmetic: the next slot on the lattice.
    const old = { ...anchored, anchor: '2025-10-13T16:07:00.000Z' };
    const next = nextAutomationRun(old, NOW)!;
    expect(next.getTime()).toBeGreaterThan(NOW.getTime());
    expect(next.getTime() - NOW.getTime()).toBeLessThanOrEqual(900_000);
    expect((next.getTime() - Date.parse(old.anchor)) % 900_000).toBe(0);
    const future = { ...anchored, anchor: '2026-10-13T19:07:00.000Z' };
    expect(nextAutomationRun(future, NOW)?.toISOString()).toBe(future.anchor);
  });
});

describe('describeAutomationWhen and quick choices', () => {
  it('says the timing in words', () => {
    expect(describeAutomationWhen({ kind: 'interval', everyMs: 900_000, tz: LA })).toBe(
      'every 15 minutes'
    );
    expect(describeAutomationWhen({ kind: 'interval', everyMs: 3_600_000, tz: LA })).toBe(
      'every hour'
    );
    expect(
      describeAutomationWhen({
        kind: 'repeat',
        rrule: 'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR',
        timeOfDay: '09:00',
        startsOn: '2026-10-13',
        tz: LA,
      })
    ).toBe('every weekday at 9:00 AM');
    expect(
      describeAutomationWhen({ kind: 'once', at: '2026-10-14T16:00:00.000Z', tz: LA }, 'UTC')
    ).toBe('once on Wed, Oct 14, 9:00 AM (America/Los_Angeles)');
  });

  it('puts every time of day on the 12-hour clock, like a once and the next run', () => {
    expect(formatTimeOfDay('05:05')).toBe('5:05 AM');
    expect(formatTimeOfDay('00:30')).toBe('12:30 AM');
    expect(formatTimeOfDay('12:00')).toBe('12:00 PM');
    expect(formatTimeOfDay('23:59')).toBe('11:59 PM');
    // A time still being typed is left as it is.
    expect(formatTimeOfDay('9:0')).toBe('9:0');
    expect(formatTimeOfDay('')).toBe('');
    expect(
      describeAutomationWhen({
        kind: 'repeat',
        rrule: 'FREQ=DAILY',
        timeOfDay: '16:30',
        startsOn: '2026-10-13',
        tz: LA,
      })
    ).toBe('every day at 4:30 PM');
  });

  it('names the zone on request: a short name for a once, the IANA zone for a repeat', () => {
    const named = { namedZone: true };
    expect(
      describeAutomationWhen({ kind: 'once', at: '2026-10-13T20:50:12.894Z', tz: LA }, LA, named)
    ).toBe('once on Tue, Oct 13, 1:50 PM PDT');
    expect(
      describeAutomationWhen(
        { kind: 'once', at: '2026-12-01T17:00:00.000Z', tz: LA },
        undefined,
        named
      )
    ).toBe('once on Tue, Dec 1, 9:00 AM PST');
    expect(
      describeAutomationWhen(
        {
          kind: 'repeat',
          rrule: 'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR',
          timeOfDay: '09:00',
          startsOn: '2026-10-13',
          tz: LA,
        },
        LA,
        named
      )
    ).toBe('every weekday at 9:00 AM (America/Los_Angeles)');
    expect(
      describeAutomationWhen({ kind: 'interval', everyMs: 3_600_000, tz: LA }, LA, named)
    ).toBe('every hour');
  });

  it('formats an instant in the automation’s zone with its short name', () => {
    expect(formatAutomationInstant('2026-10-13T20:50:12.894Z', LA)).toBe(
      'Tue, Oct 13, 1:50 PM PDT'
    );
    expect(formatAutomationInstant(new Date('2026-10-13T20:50:12.894Z'), 'UTC')).toBe(
      'Tue, Oct 13, 8:50 PM UTC'
    );
  });

  it('round-trips the quick choices and leaves other rules alone', () => {
    for (const quick of [
      { choice: 'daily' as const },
      { choice: 'weekdays' as const },
      { choice: 'weekly' as const, weekday: 'TH' as const },
      { choice: 'monthly' as const, monthDay: 14 },
    ]) {
      expect(matchQuickRepeat(quickRepeatRule(quick))).toEqual(quick);
    }
    expect(matchQuickRepeat('FREQ=MONTHLY;BYDAY=2TU')).toBeNull();
    expect(matchQuickRepeat('FREQ=WEEKLY;INTERVAL=2;BYDAY=MO')).toBeNull();
  });
});

describe('interval windows', () => {
  const window = { windowStart: '05:05', windowEnd: '06:00' };
  // A wall time in Los Angeles (PDT, UTC-7, before 2026-11-01) as an instant.
  const pdt = (wall: string) => new Date(`${wall}-07:00`);

  describe('normalizeAutomationWhen', () => {
    it('keeps a window on an interval, without an anchor', () => {
      const when = ok({ every: '5m', window_start: '05:05', window_end: '06:00' });
      expect(when).toEqual({ kind: 'interval', everyMs: 300_000, tz: LA, ...window });
      expect(ok({ every: '1h', window_start: ' 09:00 ', window_end: '17:00 ' })).toMatchObject({
        windowStart: '09:00',
        windowEnd: '17:00',
      });
    });

    it('lets agents go down to 5m only with a window of at most 2h', () => {
      expect(ok({ every: '10m', window_start: '05:00', window_end: '07:00' })).toMatchObject({
        everyMs: 600_000,
      });
      expect(error({ every: '10m', window_start: '05:00', window_end: '07:01' })).toBe(AGENT_FLOOR);
      expect(error({ every: '14m' })).toBe(AGENT_FLOOR);
      expect(error({ every: '4m', window_start: '05:05', window_end: '06:00' })).toBe(
        'every must be at least 5m for agents, even with a window (1m for people).'
      );
      // A longer window keeps the usual floor and allows it.
      expect(ok({ every: '15m', window_start: '09:00', window_end: '17:00' })).toMatchObject({
        everyMs: 900_000,
        windowStart: '09:00',
      });
    });

    it('measures a window that crosses midnight across it', () => {
      expect(ok({ every: '5m', window_start: '23:30', window_end: '01:00' })).toMatchObject({
        windowStart: '23:30',
        windowEnd: '01:00',
      });
      expect(error({ every: '5m', window_start: '22:00', window_end: '02:00' })).toBe(AGENT_FLOOR);
      expect(intervalWindowMs({ start: '22:00', end: '02:00' })).toBe(4 * 3_600_000);
      expect(intervalWindowMs({ start: '05:05', end: '06:00' })).toBe(55 * 60_000);
    });

    it('keeps the people floor at 1m, window or not', () => {
      expect(ok({ every: '1m', window_start: '05:05', window_end: '06:00' }, PERSON)).toMatchObject(
        { everyMs: 60_000, windowStart: '05:05' }
      );
      expect(ok({ every: '1m', window_start: '00:00', window_end: '23:59' }, PERSON)).toMatchObject(
        { everyMs: 60_000 }
      );
      expect(ok({ every: '5m' }, PERSON)).toEqual({ kind: 'interval', everyMs: 300_000, tz: LA });
    });

    it('never raises an agent floor set below 5m, and then has no window hint', () => {
      const low: NormalizeWhenOptions = { ...AGENT, minEveryMs: 180_000, agentMinEveryMs: 180_000 };
      expect(error({ every: '2m' }, low)).toBe(
        'every must be at least 3m for agents (1m for people).'
      );
      expect(error({ every: '2m', window_start: '05:05', window_end: '06:00' }, low)).toBe(
        'every must be at least 3m for agents, even with a window (1m for people).'
      );
      expect(ok({ every: '3m' }, low)).toMatchObject({ everyMs: 180_000 });
    });

    it('returns the exact window error texts', () => {
      const pair =
        'A window needs both window_start and window_end, e.g. {every:"5m", window_start:"05:05", window_end:"06:00"}.';
      expect(error({ every: '15m', window_start: '05:05' })).toBe(pair);
      expect(error({ every: '15m', window_end: '06:00' })).toBe(pair);
      expect(error({ every: '15m', window_start: '5:05', window_end: '06:00' })).toBe(
        'window_start must be a time like "05:05".'
      );
      expect(error({ every: '15m', window_start: '05:05', window_end: '24:00' })).toBe(
        'window_end must be a time like "06:00".'
      );
      expect(error({ every: '15m', window_start: '05:05', window_end: '05:05' })).toBe(
        'window_start and window_end must differ.'
      );
      expect(
        error({
          every: '15m',
          at: '2026-10-14T05:05',
          window_start: '05:05',
          window_end: '06:00',
        })
      ).toBe('every with a window runs from window_start each day; leave out at.');
      expect(error({ every: '1d', window_start: '05:05', window_end: '06:00' })).toBe(
        'every with a window must be under 1d (the window repeats each day).'
      );
      const needsEvery = 'window_start and window_end work only with every.';
      expect(error({ in: '2h', window_start: '05:05', window_end: '06:00' })).toBe(needsEvery);
      expect(error({ at: '2026-10-14T09:00', window_start: '05:05', window_end: '06:00' })).toBe(
        needsEvery
      );
      expect(
        error({ repeat: 'FREQ=DAILY', at: '09:00', window_start: '05:05', window_end: '06:00' })
      ).toBe(needsEvery);
      expect(error({ window_start: '05:05', window_end: '06:00' })).toBe(
        'when must have exactly one of in, at, repeat, every, first_open.'
      );
    });
  });

  describe('next run', () => {
    const every5 = { kind: 'interval' as const, everyMs: 300_000, tz: LA, ...window };
    const next = (after: Date) => nextAutomationRun(every5, after)?.toISOString();

    it('runs on the window grid inside it, its end included', () => {
      expect(next(pdt('2026-10-14T05:12:00'))).toBe(pdt('2026-10-14T05:15:00').toISOString());
      expect(next(pdt('2026-10-14T05:05:00'))).toBe(pdt('2026-10-14T05:10:00').toISOString());
      expect(next(pdt('2026-10-14T05:55:00'))).toBe(pdt('2026-10-14T06:00:00').toISOString());
    });

    it('skips outside the window to the next window start', () => {
      expect(next(pdt('2026-10-14T04:00:00'))).toBe(pdt('2026-10-14T05:05:00').toISOString());
      expect(next(pdt('2026-10-14T06:00:00'))).toBe(pdt('2026-10-15T05:05:00').toISOString());
      expect(next(pdt('2026-10-14T13:00:00'))).toBe(pdt('2026-10-15T05:05:00').toISOString());
    });

    it('reads the day in the automation’s zone (23:59 local is the next UTC day)', () => {
      const lateEvening = pdt('2026-10-14T23:59:00');
      expect(lateEvening.toISOString()).toBe('2026-10-15T06:59:00.000Z');
      expect(next(lateEvening)).toBe(pdt('2026-10-15T05:05:00').toISOString());
    });

    it('keeps the window on the wall clock across a daylight-saving change', () => {
      // Sat 06:30 PDT → Sun 2026-11-01 05:05 PST (DST ended at 02:00), 13:05Z.
      expect(next(pdt('2026-10-31T06:30:00'))).toBe('2026-11-01T13:05:00.000Z');
    });

    it('ignores the interval anchor when a window is set', () => {
      expect(nextAutomationRun(every5, pdt('2026-10-14T05:12:00'), NOW)?.toISOString()).toBe(
        pdt('2026-10-14T05:15:00').toISOString()
      );
    });

    it('runs a window that crosses midnight from the day it opens', () => {
      const night = { start: '23:30', end: '00:30' };
      const at = (iso: string) =>
        nextWindowedIntervalRun(20 * 60_000, night, 'UTC', new Date(iso)).toISOString();
      expect(at('2026-10-14T12:00:00Z')).toBe('2026-10-14T23:30:00.000Z');
      expect(at('2026-10-14T23:55:00Z')).toBe('2026-10-15T00:10:00.000Z');
      // Yesterday's window is still open after midnight, its end included.
      expect(at('2026-10-14T00:15:00Z')).toBe('2026-10-14T00:30:00.000Z');
      expect(at('2026-10-14T00:30:00Z')).toBe('2026-10-14T23:30:00.000Z');
    });

    it('runs once per window when the interval is longer than it', () => {
      const hourWindow = { start: '05:00', end: '06:00' };
      expect(
        nextWindowedIntervalRun(
          2 * 3_600_000,
          hourWindow,
          'UTC',
          new Date('2026-10-14T05:00:00Z')
        ).toISOString()
      ).toBe('2026-10-15T05:00:00.000Z');
    });

    it('refuses a malformed window', () => {
      expect(() =>
        nextWindowedIntervalRun(300_000, { start: '05:05', end: '05:05' }, 'UTC', NOW)
      ).toThrow('An interval window needs two different times (HH:mm).');
      expect(() =>
        nextWindowedIntervalRun(300_000, { start: '5:05', end: '06:00' }, 'UTC', NOW)
      ).toThrow('An interval window needs two different times (HH:mm).');
    });

    it('skips a window a daylight-saving change empties, and agrees with the inside check', () => {
      const NY = 'America/New_York';
      // 2026-03-08: 02:00 EST jumps to 03:00 EDT, so 02:30–03:00 would open at
      // 03:30, after it closes: no run that day, the next is 02:30 EDT on the 9th.
      const spring = { start: '02:30', end: '03:00' };
      expect(
        nextWindowedIntervalRun(
          5 * 60_000,
          spring,
          NY,
          new Date('2026-03-08T05:00:00Z')
        ).toISOString()
      ).toBe('2026-03-09T06:30:00.000Z');
      expect(isWithinIntervalWindow(new Date('2026-03-08T07:30:00Z'), spring, NY)).toBe(false);
      // A window that straddles the jump runs only at instants inside it.
      const straddle = { start: '01:30', end: '03:30' };
      let cursor = new Date('2026-03-08T05:00:00Z');
      for (let i = 0; i < 8; i += 1) {
        cursor = nextWindowedIntervalRun(15 * 60_000, straddle, NY, cursor);
        expect(isWithinIntervalWindow(cursor, straddle, NY)).toBe(true);
      }
      // 2026-11-01: 02:00 EDT falls back to 01:00 EST, so 01:30 happens twice.
      // The window is one opening (01:30 to 02:30 EST), and the inside check
      // reads the same opening: the first 01:45 (EDT) is outside, as no run
      // falls there, and a wake a minute and a half late is still inside.
      const fall = { start: '01:30', end: '02:30' };
      const night: string[] = [];
      cursor = new Date('2026-11-01T04:00:00Z');
      for (let i = 0; i < 6; i += 1) {
        cursor = nextWindowedIntervalRun(15 * 60_000, fall, NY, cursor);
        night.push(cursor.toISOString());
      }
      expect(night).toEqual([
        '2026-11-01T06:30:00.000Z',
        '2026-11-01T06:45:00.000Z',
        '2026-11-01T07:00:00.000Z',
        '2026-11-01T07:15:00.000Z',
        '2026-11-01T07:30:00.000Z',
        '2026-11-02T06:30:00.000Z',
      ]);
      expect(isWithinIntervalWindow(new Date('2026-11-01T05:45:00Z'), fall, NY)).toBe(false);
      expect(isWithinIntervalWindow(new Date('2026-11-01T07:16:30Z'), fall, NY)).toBe(true);
      expect(isWithinIntervalWindow(new Date('2026-11-01T07:31:30Z'), fall, NY)).toBe(false);
    });

    it('leaves an interval without a window on its anchor lattice, all day', () => {
      const plain = { kind: 'interval' as const, everyMs: 300_000, tz: LA };
      const anchor = pdt('2026-10-14T00:02:00');
      expect(nextAutomationRun(plain, pdt('2026-10-14T13:00:00'), anchor)?.toISOString()).toBe(
        pdt('2026-10-14T13:02:00').toISOString()
      );
      expect(nextAutomationRun(plain, pdt('2026-10-14T04:00:00'), anchor)?.toISOString()).toBe(
        pdt('2026-10-14T04:02:00').toISOString()
      );
    });
  });

  it('automationFloorError rechecks a stored interval against the agents’ floor', () => {
    const floors = { minEveryMs: 15 * 60_000, agentMinEveryMs: 15 * 60_000 };
    const short = { kind: 'interval' as const, everyMs: 300_000, tz: LA };
    expect(automationFloorError(short, floors)).toBe(AGENT_FLOOR);
    expect(automationFloorError({ ...short, ...window }, floors)).toBeNull();
    expect(automationFloorError({ ...short, everyMs: 900_000 }, floors)).toBeNull();
    expect(automationFloorError(short, { ...floors, minEveryMs: 60_000 })).toBeNull();
    expect(
      automationFloorError({ kind: 'once', at: '2026-10-14T16:00:00.000Z', tz: LA }, floors)
    ).toBeNull();
  });

  it('isWithinIntervalWindow includes both ends, to the second', () => {
    const w = { start: '05:05', end: '06:00' };
    const inUtc = (iso: string) => isWithinIntervalWindow(new Date(iso), w, 'UTC');
    expect(inUtc('2026-10-14T05:05:00Z')).toBe(true);
    expect(inUtc('2026-10-14T05:30:00Z')).toBe(true);
    expect(inUtc('2026-10-14T06:00:00Z')).toBe(true);
    expect(inUtc('2026-10-14T06:00:01Z')).toBe(false);
    expect(inUtc('2026-10-14T05:04:59Z')).toBe(false);
    const night = { start: '22:00', end: '02:00' };
    expect(isWithinIntervalWindow(new Date('2026-10-14T23:00:00Z'), night, 'UTC')).toBe(true);
    expect(isWithinIntervalWindow(new Date('2026-10-14T01:59:00Z'), night, 'UTC')).toBe(true);
    expect(isWithinIntervalWindow(new Date('2026-10-14T02:00:30Z'), night, 'UTC')).toBe(false);
    expect(isWithinIntervalWindow(new Date('2026-10-14T12:00:00Z'), night, 'UTC')).toBe(false);
    // Read in the given zone: 12:30Z is 05:30 PDT.
    expect(isWithinIntervalWindow(new Date('2026-10-14T12:30:00Z'), w, LA)).toBe(true);
  });

  it('says the window in words, naming the zone like a repeat', () => {
    const when = { kind: 'interval' as const, everyMs: 300_000, tz: LA, ...window };
    expect(describeAutomationWhen(when, LA)).toBe('every 5 minutes from 5:05 AM to 6:00 AM');
    expect(describeAutomationWhen(when, 'UTC')).toBe(
      'every 5 minutes from 5:05 AM to 6:00 AM (America/Los_Angeles)'
    );
    expect(describeAutomationWhen(when, LA, { namedZone: true })).toBe(
      'every 5 minutes from 5:05 AM to 6:00 AM (America/Los_Angeles)'
    );
  });
});

describe('first open of the day', () => {
  const ONE = 'when must have exactly one of in, at, repeat, every, first_open.';
  const BAD_FIRST_OPEN = 'first_open must be true, e.g. {first_open:true, after:"05:00"}.';
  const BAD_AFTER = 'after must be a time like "05:00".';

  it('stores {first_open} with its earliest time, 05:00 by default, in tz', () => {
    expect(ok({ first_open: true })).toEqual({ kind: 'first_open', after: '05:00', tz: LA });
    expect(ok({ first_open: true, after: ' 07:30 ', tz: 'UTC' })).toEqual({
      kind: 'first_open',
      after: '07:30',
      tz: 'UTC',
    });
    // No interval floor: it is once a day.
    expect(
      automationFloorError(
        { kind: 'first_open', after: '05:00', tz: LA },
        {
          minEveryMs: 15 * 60_000,
          agentMinEveryMs: 15 * 60_000,
        }
      )
    ).toBeNull();
  });

  it('refuses a first_open that is not true, a bad after, after without it and a second shape', () => {
    expect(error({ first_open: false })).toBe(BAD_FIRST_OPEN);
    expect(error({ first_open: 'yes' })).toBe(BAD_FIRST_OPEN);
    expect(error({ first_open: true, after: '5am' })).toBe(BAD_AFTER);
    expect(error({ first_open: true, after: '24:00' })).toBe(BAD_AFTER);
    expect(error({ every: '1h', after: '05:00' })).toBe('after works only with first_open.');
    expect(error({ repeat: 'FREQ=DAILY', at: '09:00', after: '05:00' })).toBe(
      'after works only with first_open.'
    );
    expect(error({ after: '05:00' })).toBe(ONE);
    expect(error({ first_open: true, at: '2026-10-14T05:00' })).toBe(ONE);
    expect(error({ first_open: true, every: '1h' })).toBe(ONE);
    expect(error({ first_open: true, window_start: '05:00', window_end: '06:00' })).toBe(
      'window_start and window_end work only with every.'
    );
    expect(error({ first_open: true, tz: 'Not/AZone' })).toBe('Unknown time zone "Not/AZone".');
  });

  it('says it in words, naming the zone when it differs or when asked', () => {
    const when = { kind: 'first_open' as const, after: '05:00', tz: LA };
    expect(describeAutomationWhen(when, LA)).toBe('when Snaglet first opens, after 5:00 AM');
    expect(describeAutomationWhen(when)).toBe('when Snaglet first opens, after 5:00 AM');
    expect(describeAutomationWhen(when, 'UTC')).toBe(
      'when Snaglet first opens, after 5:00 AM (America/Los_Angeles)'
    );
    expect(describeAutomationWhen(when, LA, { namedZone: true })).toBe(
      'when Snaglet first opens, after 5:00 AM (America/Los_Angeles)'
    );
  });

  it('is due from its next `after`: today while it is ahead, else tomorrow, on the wall clock', () => {
    // NOW is 10:00 PDT: today's 05:00 has passed, 11:00 has not.
    expect(nextFirstOpenRun('05:00', LA, NOW).toISOString()).toBe('2026-10-14T12:00:00.000Z');
    expect(nextFirstOpenRun('11:00', LA, NOW).toISOString()).toBe('2026-10-13T18:00:00.000Z');
    expect(nextFirstOpenRun('10:00', LA, NOW).toISOString()).toBe('2026-10-14T17:00:00.000Z');
    // Across the fall-back: Sat Oct 31 06:00 PDT, then Sun Nov 1 05:00 PST.
    expect(nextFirstOpenRun('05:00', LA, new Date('2026-10-31T13:00:00.000Z')).toISOString()).toBe(
      '2026-11-01T13:00:00.000Z'
    );
    // A time a spring-forward skips is due an hour later on the wall clock.
    expect(nextFirstOpenRun('02:30', LA, new Date('2026-03-08T09:00:00.000Z')).toISOString()).toBe(
      '2026-03-08T10:30:00.000Z'
    );
    expect(
      nextAutomationRun({ kind: 'first_open', after: '05:00', tz: LA }, NOW)?.toISOString()
    ).toBe('2026-10-14T12:00:00.000Z');
  });

  it('runs at the first tick at or after `after`, once a local day, and never catches a day up', () => {
    const tick = (at: string, ranToday: boolean) =>
      firstOpenTick('05:00', LA, new Date(at), ranToday);
    // 04:59 PDT: not yet, it waits for today's 05:00.
    expect(tick('2026-10-13T11:59:00.000Z', false)).toEqual({
      run: false,
      nextRunAt: new Date('2026-10-13T12:00:00.000Z'),
    });
    // 05:00 sharp, or Snaglet first opened at 07:30: it runs, claimed for today's 05:00.
    const today = { run: true, slot: new Date('2026-10-13T12:00:00.000Z') };
    expect(tick('2026-10-13T12:00:00.000Z', false)).toEqual(today);
    expect(tick('2026-10-13T14:30:00.000Z', false)).toEqual(today);
    // It already ran today: tomorrow's 05:00.
    expect(tick('2026-10-13T14:30:00.000Z', true)).toEqual({
      run: false,
      nextRunAt: new Date('2026-10-14T12:00:00.000Z'),
    });
    // 23:59 PDT is still today.
    expect(tick('2026-10-14T06:59:00.000Z', false)).toEqual(today);
    // 00:30 the next day: yesterday is gone; it waits for today's 05:00.
    expect(tick('2026-10-14T07:30:00.000Z', false)).toEqual({
      run: false,
      nextRunAt: new Date('2026-10-14T12:00:00.000Z'),
    });
  });

  it('bounds a local day in its zone, 25 hours on a fall-back day', () => {
    expect(localDayBounds(NOW, LA)).toEqual({
      start: new Date('2026-10-13T07:00:00.000Z'),
      end: new Date('2026-10-14T07:00:00.000Z'),
    });
    const { start, end } = localDayBounds(new Date('2026-11-01T20:00:00.000Z'), LA);
    expect(end.getTime() - start.getTime()).toBe(25 * 3_600_000);
  });
});
