/**
 * Interval repeats on datetime fields ("every d:h:m:s" from the row's date
 * and time): the rule's checks, the one-second floor, expansion in absolute
 * time across DST (down to one second), the window cap, done-advance, jump to
 * now, overdue at its time, and the editor's model and sentences.
 */
import {
  REPEAT_INTERVAL_MIN_SECONDS,
  advanceTableRepeat,
  createTableRepeat,
  describeTableRepeat,
  formatRepeatInterval,
  intervalRepeatRule,
  isTableRepeatOverdue,
  isTableRepeatUpcoming,
  jumpTableRepeatToUpcoming,
  normalizeRepeatDraft,
  normalizeRepeatRule,
  repeatDraftFor,
  repeatDraftFromRepeat,
  repeatDraftIntervalProblem,
  repeatDraftSummary,
  repeatDraftUpcoming,
  repeatEveryOf,
  repeatInputFromDraft,
  repeatIntervalProblem,
  skipTableRepeatToUpcoming,
  tableDateTimeToUtc,
  tableRepeatCellText,
  tableRepeatIntervalOccurrences,
  tableRepeatIntervalSeconds,
  tableRepeatProblem,
  tableRepeatSummary,
  tableRepeatWallTime,
  tableRepeatWriteProblem,
  upcomingRepeatOccurrences,
  type RepeatDraft,
  type TableRepeat,
} from '@snaglet/shared/utils';

function ok<T>(result: { ok: true; value: T } | { ok: false; error: string }): T {
  if (!result.ok) throw new Error(result.error);
  return result.value;
}

function errorOf(result: { ok: boolean; error?: string }): string {
  if (result.ok) throw new Error('expected an error');
  return result.error ?? '';
}

const NY = 'America/New_York';
const LA = 'America/Los_Angeles';

function every(date: string, rrule: string, tz = 'UTC'): TableRepeat {
  return ok(createTableRepeat({ date, rrule, tz }));
}

/** Seconds between consecutive occurrences, read as instants in `tz`. */
function gaps(walls: string[], tz: string): number[] {
  const at = walls.map((wall) => Date.parse(tableDateTimeToUtc(wall, tz)!));
  return at.slice(1).map((ms, i) => (ms - at[i]!) / 1000);
}

describe('interval rules', () => {
  it.each([
    ['FREQ=SECONDLY;INTERVAL=5400', 'FREQ=MINUTELY;INTERVAL=90', 5400],
    ['FREQ=MINUTELY;INTERVAL=120', 'FREQ=HOURLY;INTERVAL=2', 7200],
    ['FREQ=SECONDLY;INTERVAL=90', 'FREQ=SECONDLY;INTERVAL=90', 90],
    ['rrule:freq=hourly;interval=1;count=4', 'FREQ=HOURLY;COUNT=4', 3600],
    ['FREQ=MINUTELY;UNTIL=20261231T235959Z', 'FREQ=MINUTELY;UNTIL=20261231T235959', 60],
  ])('normalizes %s to the coarsest unit', (input, rule, seconds) => {
    const created = every('2026-10-15T09:00:00', input);
    expect(created.rrule).toBe(rule);
    expect(tableRepeatIntervalSeconds(created.rrule)).toBe(seconds);
  });

  it('builds a rule from seconds', () => {
    expect(intervalRepeatRule(60)).toBe('FREQ=MINUTELY');
    expect(intervalRepeatRule(5400)).toBe('FREQ=MINUTELY;INTERVAL=90');
    expect(intervalRepeatRule(2 * 86_400 + 15)).toBe('FREQ=SECONDLY;INTERVAL=172815');
    expect(intervalRepeatRule(3 * 86_400)).toBe('FREQ=HOURLY;INTERVAL=72');
  });

  it('is at least one second (the shared floor)', () => {
    expect(REPEAT_INTERVAL_MIN_SECONDS).toBe(1);
    expect(repeatIntervalProblem(0)).toBe('The shortest interval is 1 s.');
    expect(repeatIntervalProblem(1)).toBeNull();
    expect(
      errorOf(
        createTableRepeat({
          date: '2026-10-15T09:00:00',
          rrule: 'FREQ=SECONDLY;INTERVAL=0',
          tz: 'UTC',
        })
      )
    ).toMatch(/positive whole number/);
    expect(every('2026-10-15T09:00:00', 'FREQ=SECONDLY').rrule).toBe('FREQ=SECONDLY');
    expect(every('2026-10-15T09:00:00', 'FREQ=SECONDLY;INTERVAL=30').rrule).toBe(
      'FREQ=SECONDLY;INTERVAL=30'
    );
    expect(every('2026-10-15T09:00:00', 'FREQ=SECONDLY;INTERVAL=60').rrule).toBe('FREQ=MINUTELY');
    expect(every('2026-10-15T09:00:00', 'FREQ=SECONDLY;INTERVAL=172815').rrule).toBe(
      'FREQ=SECONDLY;INTERVAL=172815'
    );
    expect(
      errorOf(
        createTableRepeat({
          date: '2026-10-15T09:00:00',
          rrule: 'FREQ=HOURLY;INTERVAL=24000',
          tz: 'UTC',
        })
      )
    ).toBe('The longest interval is 999 days.');
  });

  it.each([
    ['2026-10-15', 'FREQ=HOURLY', 'needs a date with a time'],
    ['2026-10-15T09:00:00', 'FREQ=HOURLY;BYDAY=MO', 'not BYDAY'],
    ['2026-10-15T09:00:00', 'FREQ=HOURLY;COUNT=2;UNTIL=20261231', 'not both'],
    ['2026-10-15T09:00:00', 'FREQ=MINUTELY;INTERVAL=1.5', 'positive whole'],
  ])('refuses %s (%s)', (date, rrule, message) => {
    expect(errorOf(createTableRepeat({ date, rrule, tz: 'UTC' }))).toContain(message);
  });

  it('refuses a zone the runtime does not know (an interval steps in absolute time)', () => {
    expect(
      errorOf(
        createTableRepeat({ date: '2026-10-15T09:00:00', rrule: 'FREQ=HOURLY', tz: 'Mars/Base' })
      )
    ).toContain("isn't a known zone");
  });

  it('passes the stored and the write checks; automations still refuse sub-daily rules', () => {
    const repeat = every('2026-10-15T09:00:00', 'FREQ=MINUTELY;INTERVAL=90');
    expect(tableRepeatProblem(repeat)).toBeNull();
    expect(tableRepeatWriteProblem(repeat)).toBeNull();
    expect(tableRepeatWriteProblem(repeat, { range: true })).toBeNull();
    expect(tableRepeatProblem({ ...repeat, rrule: 'FREQ=SECONDLY;INTERVAL=30' })).toBeNull();
    expect(tableRepeatProblem({ ...repeat, rrule: 'FREQ=SECONDLY;INTERVAL=0' })).toBe(
      'INTERVAL must be a positive whole number.'
    );
    expect(errorOf(normalizeRepeatRule('FREQ=HOURLY'))).toBe(
      'FREQ must be DAILY, WEEKLY, MONTHLY or YEARLY (got HOURLY).'
    );
    expect(tableRepeatIntervalSeconds('FREQ=DAILY')).toBeNull();
  });

  it('describes itself', () => {
    expect(ok(describeTableRepeat(every('2026-10-15T09:00:00', 'FREQ=MINUTELY;INTERVAL=90')))).toBe(
      'every 1 h 30 min'
    );
    expect(
      ok(describeTableRepeat(every('2026-10-15T09:00:00', 'FREQ=HOURLY;INTERVAL=54;COUNT=3')))
    ).toBe('every 2 days 6 h for 3 times');
    expect(formatRepeatInterval(90)).toBe('1 min 30 s');
    expect(formatRepeatInterval(86_400)).toBe('1 day');
    expect(formatRepeatInterval(2 * 86_400 + 15)).toBe('2 days 15 s');
  });
});

describe('interval expansion', () => {
  it('counts from the row’s date and time, then every interval', () => {
    const repeat = every('2026-10-15T09:00:00', 'FREQ=MINUTELY;INTERVAL=90');
    expect(ok(upcomingRepeatOccurrences(repeat, 4))).toEqual([
      '2026-10-15T09:00:00',
      '2026-10-15T10:30:00',
      '2026-10-15T12:00:00',
      '2026-10-15T13:30:00',
    ]);
    const seconds = every('2026-10-15T09:00:00', 'FREQ=SECONDLY;INTERVAL=90');
    expect(ok(upcomingRepeatOccurrences(seconds, 3))).toEqual([
      '2026-10-15T09:00:00',
      '2026-10-15T09:01:30',
      '2026-10-15T09:03:00',
    ]);
  });

  it('ends after COUNT steps or on UNTIL (inclusive; a date covers its day)', () => {
    expect(
      ok(upcomingRepeatOccurrences(every('2026-10-15T09:00:00', 'FREQ=HOURLY;COUNT=3'), 9))
    ).toEqual(['2026-10-15T09:00:00', '2026-10-15T10:00:00', '2026-10-15T11:00:00']);
    expect(
      ok(upcomingRepeatOccurrences(every('2026-10-15T21:00:00', 'FREQ=HOURLY;UNTIL=20261015'), 9))
    ).toEqual(['2026-10-15T21:00:00', '2026-10-15T22:00:00', '2026-10-15T23:00:00']);
    expect(
      ok(
        upcomingRepeatOccurrences(
          every('2026-10-15T09:00:00', 'FREQ=HOURLY;UNTIL=20261015T110000'),
          9
        )
      )
    ).toEqual(['2026-10-15T09:00:00', '2026-10-15T10:00:00', '2026-10-15T11:00:00']);
  });

  describe('is absolute time, not wall clock, across DST (America/New_York)', () => {
    it('every 24 h moves an hour on the wall clock at spring-forward; "every day" does not', () => {
      const interval = every('2026-03-07T09:00:00', 'FREQ=HOURLY;INTERVAL=24', NY);
      const walls = ok(upcomingRepeatOccurrences(interval, 3));
      expect(walls).toEqual(['2026-03-07T09:00:00', '2026-03-08T10:00:00', '2026-03-09T10:00:00']);
      expect(gaps(walls, NY)).toEqual([86_400, 86_400]);
      const daily = every('2026-03-07T09:00:00', 'FREQ=DAILY', NY);
      expect(ok(upcomingRepeatOccurrences(daily, 3))).toEqual([
        '2026-03-07T09:00:00',
        '2026-03-08T09:00:00',
        '2026-03-09T09:00:00',
      ]);
    });

    it('every hour steps over the skipped hour at spring-forward, an hour apart', () => {
      const walls = ok(
        upcomingRepeatOccurrences(every('2026-03-08T00:30:00', 'FREQ=HOURLY', NY), 4)
      );
      expect(walls).toEqual([
        '2026-03-08T00:30:00',
        '2026-03-08T01:30:00',
        '2026-03-08T03:30:00',
        '2026-03-08T04:30:00',
      ]);
      expect(gaps(walls, NY)).toEqual([3600, 3600, 3600]);
    });

    it('at fall-back the repeated hour keeps its second pass, so wall times only grow', () => {
      const walls = ok(
        upcomingRepeatOccurrences(every('2026-11-01T00:10:00', 'FREQ=MINUTELY;INTERVAL=20', NY), 8)
      );
      // 01:10 / 01:30 / 01:50 EDT name the same wall times as their EST pass,
      // which is the one PostgreSQL (and the cell) reads: those three are left out.
      expect(walls).toEqual([
        '2026-11-01T00:10:00',
        '2026-11-01T00:30:00',
        '2026-11-01T00:50:00',
        '2026-11-01T01:10:00',
        '2026-11-01T01:30:00',
        '2026-11-01T01:50:00',
        '2026-11-01T02:10:00',
        '2026-11-01T02:30:00',
      ]);
      expect(gaps(walls, NY)).toEqual([1200, 1200, 4800, 1200, 1200, 1200, 1200]);
      // A day-long interval across it is still 24 h of absolute time.
      const day = ok(
        upcomingRepeatOccurrences(every('2026-10-31T09:00:00', 'FREQ=HOURLY;INTERVAL=24', NY), 2)
      );
      expect(day).toEqual(['2026-10-31T09:00:00', '2026-11-01T08:00:00']);
    });

    it('a start in the spring-forward gap stays the first occurrence', () => {
      const walls = ok(
        upcomingRepeatOccurrences(every('2026-03-08T02:30:00', 'FREQ=HOURLY', NY), 3)
      );
      expect(walls).toEqual(['2026-03-08T02:30:00', '2026-03-08T04:30:00', '2026-03-08T05:30:00']);
    });
  });
});

describe('the window cap (tableRepeatIntervalOccurrences)', () => {
  const minutely = every('2026-01-01T00:00:00', 'FREQ=MINUTELY');

  it('steps straight to the window from a current one far behind, at most `limit`', () => {
    const result = ok(
      tableRepeatIntervalOccurrences(minutely, {
        from: '2026-02-01T00:00:00Z',
        to: '2026-02-02T00:00:00Z',
        limit: 3,
      })
    );
    expect(result).toEqual({
      occurrences: ['2026-02-01T00:00:00', '2026-02-01T00:01:00', '2026-02-01T00:02:00'],
      truncated: true,
    });
  });

  it('is not truncated when the window holds no more than `limit`', () => {
    expect(
      ok(
        tableRepeatIntervalOccurrences(minutely, {
          from: '2026-02-01T00:00:30Z',
          to: '2026-02-01T00:03:00Z',
          limit: 3,
        })
      )
    ).toEqual({
      occurrences: ['2026-02-01T00:01:00', '2026-02-01T00:02:00'],
      truncated: false,
    });
  });

  it('starts at the current one when it is in the window, and never before it', () => {
    const later = { ...minutely, current: '2026-02-01T00:05:00' };
    expect(
      ok(
        tableRepeatIntervalOccurrences(later, {
          from: '2026-02-01T00:00:00Z',
          to: '2026-02-01T00:08:00Z',
          limit: 10,
        })
      ).occurrences
    ).toEqual(['2026-02-01T00:05:00', '2026-02-01T00:06:00', '2026-02-01T00:07:00']);
  });

  it('stops at COUNT and fails for a repeat that is not an interval', () => {
    const counted = every('2026-01-01T00:00:00', 'FREQ=HOURLY;COUNT=2');
    expect(
      ok(
        tableRepeatIntervalOccurrences(counted, {
          from: '2026-01-01T00:00:00Z',
          to: '2026-01-02T00:00:00Z',
          limit: 10,
        })
      )
    ).toEqual({ occurrences: ['2026-01-01T00:00:00', '2026-01-01T01:00:00'], truncated: false });
    expect(
      tableRepeatIntervalOccurrences(every('2026-01-01T00:00:00', 'FREQ=DAILY'), {
        from: '2026-01-01T00:00:00Z',
        to: '2026-01-02T00:00:00Z',
        limit: 10,
      }).ok
    ).toBe(false);
  });

  it('matches the walk from current, in the zone and across fall-back', () => {
    const repeat = every('2026-11-01T00:10:00', 'FREQ=MINUTELY;INTERVAL=20', NY);
    const walked = ok(upcomingRepeatOccurrences(repeat, 12));
    const windowed = ok(
      tableRepeatIntervalOccurrences(repeat, {
        from: tableDateTimeToUtc('2026-11-01T00:00:00', NY)!,
        to: tableDateTimeToUtc('2026-11-01T03:55:00', NY)!,
        limit: 100,
      })
    );
    expect(windowed).toEqual({ occurrences: walked, truncated: false });
  });
});

describe('done, skip and move on an interval', () => {
  it('done advances by exactly one interval', () => {
    const repeat = every('2026-10-15T09:00:00', 'FREQ=MINUTELY;INTERVAL=90');
    const done = ok(advanceTableRepeat(repeat));
    expect(done.finished).toBe('2026-10-15T09:00:00');
    expect(done.next?.current).toBe('2026-10-15T10:30:00');
    expect(ok(advanceTableRepeat(done.next!)).next?.current).toBe('2026-10-15T12:00:00');
    const last = every('2026-10-15T09:00:00', 'FREQ=HOURLY;COUNT=1');
    expect(ok(advanceTableRepeat(last)).next).toBeNull();
  });

  it('skip to upcoming skips the past ones', () => {
    const repeat = every('2026-10-15T09:00:00', 'FREQ=MINUTELY;INTERVAL=30');
    const skipped = ok(skipTableRepeatToUpcoming(repeat, '2026-10-15T10:10:00'));
    expect(skipped.skipped).toEqual([
      '2026-10-15T09:00:00',
      '2026-10-15T09:30:00',
      '2026-10-15T10:00:00',
    ]);
    expect(skipped.next?.current).toBe('2026-10-15T10:30:00');
  });

  describe('the moment as `now`: instants for an interval', () => {
    // 15 min from 00:30 PDT on Nov 1 (LA): 01:00–01:45 PDT are left out, 01:00 PST is next.
    const quarter = every('2026-11-01T00:30:00', 'FREQ=MINUTELY;INTERVAL=15', LA);
    const behind = { ...quarter, current: '2026-11-01T00:45:00' };
    const FIRST = new Date('2026-11-01T08:30:00Z'); // 01:30 PDT, the first pass
    const SECOND = new Date('2026-11-01T09:30:00Z'); // 01:30 PST, the second

    it('reads a moment as the zone’s wall time, to the second; UTC’s for an unknown zone', () => {
      expect(tableRepeatWallTime(FIRST, LA)).toBe('2026-11-01T01:30:00');
      expect(tableRepeatWallTime(SECOND, LA)).toBe('2026-11-01T01:30:00');
      expect(tableRepeatWallTime(new Date('2026-10-15T16:00:00.999Z'), LA)).toBe(
        '2026-10-15T09:00:00'
      );
      expect(tableRepeatWallTime(new Date('2026-10-15T16:00:00.999Z'), 'Not/A_Zone')).toBe(
        '2026-10-15T16:00:00'
      );
    });

    it('in the first pass of the fall-back hour, skips and jumps only what is past', () => {
      expect(ok(skipTableRepeatToUpcoming(behind, FIRST))).toEqual({
        skipped: ['2026-11-01T00:45:00'],
        next: { ...behind, current: '2026-11-01T01:00:00' },
      });
      expect(ok(jumpTableRepeatToUpcoming(behind, FIRST))?.current).toBe('2026-11-01T01:00:00');
      // On 01:00 PST (09:00Z), nothing is past yet.
      const onOne = { ...quarter, current: '2026-11-01T01:00:00' };
      expect(ok(skipTableRepeatToUpcoming(onOne, FIRST)).skipped).toEqual([]);
      expect(ok(jumpTableRepeatToUpcoming(onOne, FIRST))).toBe(onOne);
    });

    it('in the second pass, and with a wall `now`, as before', () => {
      const asBefore = {
        skipped: ['2026-11-01T00:45:00', '2026-11-01T01:00:00', '2026-11-01T01:15:00'],
        next: { ...behind, current: '2026-11-01T01:30:00' },
      };
      expect(ok(skipTableRepeatToUpcoming(behind, SECOND))).toEqual(asBefore);
      expect(ok(jumpTableRepeatToUpcoming(behind, SECOND))?.current).toBe('2026-11-01T01:30:00');
      // A wall time names the second pass, whichever pass it is sent in.
      expect(ok(skipTableRepeatToUpcoming(behind, '2026-11-01T01:30:00'))).toEqual(asBefore);
      expect(ok(jumpTableRepeatToUpcoming(behind, '2026-11-01T01:30:00'))?.current).toBe(
        '2026-11-01T01:30:00'
      );
    });

    it('drops the fraction of a second, as a wall time does', () => {
      // 09:00 PDT is 16:00Z: at 16:00:00.5 it isn't past yet.
      const hourly = every('2026-10-15T09:00:00', 'FREQ=HOURLY', LA);
      const half = new Date('2026-10-15T16:00:00.500Z');
      expect(ok(skipTableRepeatToUpcoming(hourly, half)).skipped).toEqual([]);
      expect(ok(jumpTableRepeatToUpcoming(hourly, half))).toBe(hourly);
      expect(ok(skipTableRepeatToUpcoming(hourly, new Date('2026-10-15T16:00:01Z')))).toEqual({
        skipped: ['2026-10-15T09:00:00'],
        next: { ...hourly, current: '2026-10-15T10:00:00' },
      });
    });

    it('a day-based repeat reads the moment as its wall time, as before', () => {
      // Every day at 01:30: on Nov 1 that names the second pass, yet at 01:45
      // PDT (the first pass) it reads past, as with the wall time.
      const daily = every('2026-10-30T01:30:00', 'FREQ=DAILY', LA);
      const at = new Date('2026-11-01T08:45:00Z');
      const byWall = ok(skipTableRepeatToUpcoming(daily, '2026-11-01T01:45:00'));
      expect(byWall.skipped).toEqual([
        '2026-10-30T01:30:00',
        '2026-10-31T01:30:00',
        '2026-11-01T01:30:00',
      ]);
      expect(ok(skipTableRepeatToUpcoming(daily, at))).toEqual(byWall);
      for (const repeat of [
        every('2026-10-14T21:30:00', 'FREQ=WEEKLY', LA),
        every('2026-10-05', 'FREQ=WEEKLY;BYDAY=MO', LA),
      ])
        expect(ok(skipTableRepeatToUpcoming(repeat, at))).toEqual(
          ok(skipTableRepeatToUpcoming(repeat, '2026-11-01T01:45:00'))
        );
    });
  });

  describe('jump to now', () => {
    it('lands where Skip to upcoming would, without listing the missed ones', () => {
      const repeat = every('2026-10-15T09:00:00', 'FREQ=MINUTELY;INTERVAL=30');
      expect(ok(jumpTableRepeatToUpcoming(repeat, '2026-10-15T10:10:00'))).toEqual({
        ...repeat,
        current: '2026-10-15T10:30:00',
      });
      // At a step's own time that one is upcoming (not past), as for Skip to upcoming.
      expect(ok(jumpTableRepeatToUpcoming(repeat, '2026-10-15T10:30:00'))?.current).toBe(
        '2026-10-15T10:30:00'
      );
      // Across both DST changes, and from inside the hour a spring-forward skips.
      for (const [start, rule, tz, now] of [
        ['2026-11-01T00:10:00', 'FREQ=MINUTELY;INTERVAL=20', NY, '2026-11-01T01:00:00'],
        ['2026-11-01T00:10:00', 'FREQ=MINUTELY;INTERVAL=20', NY, '2026-11-01T01:20:00'],
        ['2026-11-01T00:30:00', 'FREQ=MINUTELY;INTERVAL=15', LA, '2026-11-01T02:05:00'],
        ['2026-03-08T01:30:00', 'FREQ=MINUTELY;INTERVAL=15', LA, '2026-03-08T03:00:00'],
        ['2026-03-08T01:30:00', 'FREQ=MINUTELY;INTERVAL=15', LA, '2026-03-08T02:30:00'],
        ['2026-03-07T09:00:00', 'FREQ=HOURLY;INTERVAL=24', NY, '2026-03-09T09:30:00'],
      ] as const) {
        const series = every(start, rule, tz);
        expect(ok(jumpTableRepeatToUpcoming(series, now))).toEqual(
          ok(skipTableRepeatToUpcoming(series, now)).next
        );
      }
      expect(
        ok(
          jumpTableRepeatToUpcoming(
            every('2026-03-08T01:30:00', 'FREQ=MINUTELY;INTERVAL=15', LA),
            '2026-03-08T02:30:00'
          )
        )?.current
      ).toBe('2026-03-08T03:00:00');
    });

    it('jumps a 1-minute row a week behind in one step, past Skip to upcoming’s 5,000', () => {
      const minutely = every('2026-10-08T09:00:00', 'FREQ=MINUTELY', LA);
      expect(errorOf(skipTableRepeatToUpcoming(minutely, '2026-10-15T09:00:30'))).toContain(
        'More than 5000 missed occurrences; edit the date or use Jump to now instead.'
      );
      expect(ok(jumpTableRepeatToUpcoming(minutely, '2026-10-15T09:00:30'))).toEqual({
        ...minutely,
        current: '2026-10-15T09:01:00',
      });
      // Years behind at one minute is the same one step.
      const old = every('2020-01-01T00:00:00', 'FREQ=MINUTELY', LA);
      expect(ok(jumpTableRepeatToUpcoming(old, '2026-10-15T09:00:30'))?.current).toBe(
        '2026-10-15T09:01:00'
      );
    });

    it('stays put when not behind, is null past the end, and is for intervals only', () => {
      const repeat = every('2026-10-15T09:00:00', 'FREQ=HOURLY');
      expect(ok(jumpTableRepeatToUpcoming(repeat, '2026-10-15T09:00:00'))).toBe(repeat);
      expect(ok(jumpTableRepeatToUpcoming(repeat, '2026-10-15T08:00:00'))).toBe(repeat);
      const three = every('2026-10-15T09:00:00', 'FREQ=HOURLY;COUNT=3');
      expect(ok(jumpTableRepeatToUpcoming(three, '2026-10-15T10:30:00'))?.current).toBe(
        '2026-10-15T11:00:00'
      );
      expect(ok(jumpTableRepeatToUpcoming(three, '2026-10-15T11:00:01'))).toBeNull();
      const until = every('2026-10-15T09:00:00', 'FREQ=MINUTELY;INTERVAL=30;UNTIL=20261015T120000');
      expect(ok(jumpTableRepeatToUpcoming(until, '2026-10-15T12:00:00'))?.current).toBe(
        '2026-10-15T12:00:00'
      );
      expect(ok(jumpTableRepeatToUpcoming(until, '2026-10-15T12:00:01'))).toBeNull();
      expect(
        errorOf(jumpTableRepeatToUpcoming(every('2026-10-12', 'FREQ=WEEKLY'), '2026-10-20'))
      ).toBe('Only a repeat at an interval can jump to now; skip or move this one instead.');
      expect(errorOf(jumpTableRepeatToUpcoming(repeat, 'soon'))).toContain('"now" must be');
    });
  });

  it('knows its upcoming occurrences without walking to them', () => {
    const repeat = every('2026-01-01T00:00:00', 'FREQ=MINUTELY');
    expect(isTableRepeatUpcoming(repeat, '2026-01-01T00:00:00')).toBe(true);
    expect(isTableRepeatUpcoming(repeat, '2026-06-01T10:31:00')).toBe(true);
    expect(isTableRepeatUpcoming(repeat, '2026-06-01T10:31:30')).toBe(false);
    expect(
      isTableRepeatUpcoming({ ...repeat, current: '2026-01-01T00:05:00' }, '2026-01-01T00:04:00')
    ).toBe(false);
    expect(isTableRepeatUpcoming(repeat, '2026-01-01')).toBe(false);
    const weekly = every('2026-10-12', 'FREQ=WEEKLY;BYDAY=MO');
    expect(isTableRepeatUpcoming(weekly, '2026-10-19')).toBe(true);
    expect(isTableRepeatUpcoming(weekly, '2026-10-21')).toBe(false);
  });
});

describe('overdue at its time, not by day', () => {
  const at = (iso: string) => new Date(iso);

  it('an hourly one is overdue once its time has passed, the same day', () => {
    // 09:00 PDT is 16:00Z.
    const hourly = every('2026-10-15T09:00:00', 'FREQ=HOURLY', LA);
    expect(isTableRepeatOverdue(hourly, at('2026-10-15T16:00:00Z'))).toBe(false);
    expect(isTableRepeatOverdue(hourly, at('2026-10-15T16:00:01Z'))).toBe(true);
    // A wall date-time in the zone compares the same way; a date alone is still by day.
    expect(isTableRepeatOverdue(hourly, '2026-10-15T09:00:00')).toBe(false);
    expect(isTableRepeatOverdue(hourly, '2026-10-15T09:00:01')).toBe(true);
    expect(isTableRepeatOverdue(hourly, '2026-10-15')).toBe(false);
    expect(isTableRepeatOverdue(hourly, '2026-10-16')).toBe(true);
    // Done or skipped isn't; the next one isn't yet.
    const log = [{ occurrence: '2026-10-15T09:00:00', kind: 'done' as const }];
    expect(isTableRepeatOverdue(hourly, at('2026-10-15T16:30:00Z'), { log })).toBe(false);
    expect(
      isTableRepeatOverdue(hourly, at('2026-10-15T16:30:00Z'), {
        occurrence: '2026-10-15T10:00:00',
      })
    ).toBe(false);
  });

  it('a day-based repeat at a time stays overdue by day', () => {
    const daily = every('2026-10-15T09:00:00', 'FREQ=DAILY', LA);
    expect(isTableRepeatOverdue(daily, at('2026-10-15T16:00:01Z'))).toBe(false);
    expect(isTableRepeatOverdue(daily, '2026-10-15T23:59:59')).toBe(false);
    // Midnight PDT on Oct 16 is 07:00Z.
    expect(isTableRepeatOverdue(daily, at('2026-10-16T06:59:59Z'))).toBe(false);
    expect(isTableRepeatOverdue(daily, at('2026-10-16T07:00:00Z'))).toBe(true);
    const weekly = every('2026-10-14T21:30:00', 'FREQ=WEEKLY', LA);
    // Overdue from midnight PDT the day after the occurrence's own day.
    expect(isTableRepeatOverdue(weekly, at('2026-10-15T06:59:59Z'))).toBe(false);
    expect(isTableRepeatOverdue(weekly, at('2026-10-15T07:00:00Z'))).toBe(true);
  });

  it('every 15 min across midnight', () => {
    const quarter = every('2026-10-15T23:30:00', 'FREQ=MINUTELY;INTERVAL=15', LA);
    expect(ok(upcomingRepeatOccurrences(quarter, 4))).toEqual([
      '2026-10-15T23:30:00',
      '2026-10-15T23:45:00',
      '2026-10-16T00:00:00',
      '2026-10-16T00:15:00',
    ]);
    // 23:50 PDT on Oct 15 is 06:50Z on Oct 16: overdue the same day.
    const late = { ...quarter, current: '2026-10-15T23:45:00' };
    expect(isTableRepeatOverdue(late, at('2026-10-16T06:50:00Z'))).toBe(true);
    expect(isTableRepeatOverdue(late, '2026-10-15')).toBe(false);
    const midnight = { ...quarter, current: '2026-10-16T00:00:00' };
    expect(isTableRepeatOverdue(midnight, at('2026-10-16T06:59:59Z'))).toBe(false);
    expect(isTableRepeatOverdue(midnight, at('2026-10-16T07:00:01Z'))).toBe(true);
  });

  describe('across DST (America/Los_Angeles)', () => {
    it('fall-back (Nov 1): the repeated hour is its second pass, compared in absolute time', () => {
      // Every hour from 00:00 PDT (07:00Z): 01:00 PDT names the same wall time
      // as 01:00 PST, the pass PostgreSQL reads, so the next one is 01:00 PST (09:00Z).
      const hourly = every('2026-11-01T00:00:00', 'FREQ=HOURLY', LA);
      expect(ok(upcomingRepeatOccurrences(hourly, 3))).toEqual([
        '2026-11-01T00:00:00',
        '2026-11-01T01:00:00',
        '2026-11-01T02:00:00',
      ]);
      const one = { ...hourly, current: '2026-11-01T01:00:00' };
      // 01:30 PDT (08:30Z) is before it; 01:00:01 PST (09:00:01Z) is after.
      expect(isTableRepeatOverdue(one, at('2026-11-01T08:30:00Z'))).toBe(false);
      expect(isTableRepeatOverdue(one, at('2026-11-01T09:00:01Z'))).toBe(true);
      // A wall time can't tell the passes apart: "01:30" reads as the second.
      expect(isTableRepeatOverdue(one, '2026-11-01T01:30:00')).toBe(true);

      const quarter = every('2026-11-01T00:30:00', 'FREQ=MINUTELY;INTERVAL=15', LA);
      const walls = ok(upcomingRepeatOccurrences(quarter, 4));
      expect(walls).toEqual([
        '2026-11-01T00:30:00',
        '2026-11-01T00:45:00',
        '2026-11-01T01:00:00',
        '2026-11-01T01:15:00',
      ]);
      expect(gaps(walls, LA)).toEqual([900, 4500, 900]);
      // 00:45 PDT (07:45Z) is overdue at 01:00 PDT (08:00Z).
      expect(
        isTableRepeatOverdue(
          { ...quarter, current: '2026-11-01T00:45:00' },
          at('2026-11-01T08:00:00Z')
        )
      ).toBe(true);
      const next = { ...quarter, current: '2026-11-01T01:00:00' };
      expect(isTableRepeatOverdue(next, at('2026-11-01T08:50:00Z'))).toBe(false);
      expect(isTableRepeatOverdue(next, at('2026-11-01T09:05:00Z'))).toBe(true);
    });

    it('spring-forward (Mar 8): the skipped hour holds none, an hour apart', () => {
      // 00:30 PST is 08:30Z; 02:00 PST jumps to 03:00 PDT (10:00Z).
      const hourly = every('2026-03-08T00:30:00', 'FREQ=HOURLY', LA);
      expect(ok(upcomingRepeatOccurrences(hourly, 3))).toEqual([
        '2026-03-08T00:30:00',
        '2026-03-08T01:30:00',
        '2026-03-08T03:30:00',
      ]);
      const after = { ...hourly, current: '2026-03-08T03:30:00' };
      expect(isTableRepeatOverdue(after, at('2026-03-08T10:15:00Z'))).toBe(false);
      expect(isTableRepeatOverdue(after, at('2026-03-08T10:31:00Z'))).toBe(true);

      const quarter = every('2026-03-08T01:30:00', 'FREQ=MINUTELY;INTERVAL=15', LA);
      expect(ok(upcomingRepeatOccurrences(quarter, 4))).toEqual([
        '2026-03-08T01:30:00',
        '2026-03-08T01:45:00',
        '2026-03-08T03:00:00',
        '2026-03-08T03:15:00',
      ]);
      expect(
        isTableRepeatOverdue(
          { ...quarter, current: '2026-03-08T01:45:00' },
          at('2026-03-08T09:50:00Z')
        )
      ).toBe(true);
      const three = { ...quarter, current: '2026-03-08T03:00:00' };
      expect(isTableRepeatOverdue(three, at('2026-03-08T09:59:00Z'))).toBe(false);
      expect(isTableRepeatOverdue(three, at('2026-03-08T10:00:30Z'))).toBe(true);
      // A day-based one at 09:00 on the same day is not overdue until the next.
      const daily = every('2026-03-08T09:00:00', 'FREQ=DAILY', LA);
      expect(isTableRepeatOverdue(daily, at('2026-03-08T20:00:00Z'))).toBe(false);
      expect(isTableRepeatOverdue(daily, at('2026-03-09T07:00:00Z'))).toBe(true);
    });
  });
});

describe('the editor’s interval', () => {
  const ANCHOR = '2026-10-15T09:00:00';
  const draft = (patch: Partial<RepeatDraft> = {}): RepeatDraft => ({
    ...repeatDraftFor(ANCHOR),
    mode: 'interval',
    ...patch,
  });

  it.each<[Partial<RepeatDraft>, string]>([
    [{ every: { days: 0, hours: 1, minutes: 30, seconds: 0 } }, 'Every 1 h 30 min'],
    [{ every: { days: 2, hours: 6, minutes: 0, seconds: 0 } }, 'Every 2 days 6 h'],
    [{ every: { days: 0, hours: 0, minutes: 1, seconds: 30 } }, 'Every 1 min 30 s'],
    [{ every: { days: 1, hours: 0, minutes: 0, seconds: 0 } }, 'Every 1 day'],
    [
      { every: { days: 0, hours: 2, minutes: 0, seconds: 0 }, ends: { kind: 'after', count: 10 } },
      'Every 2 h, 10 times',
    ],
    [
      {
        every: { days: 0, hours: 0, minutes: 45, seconds: 0 },
        ends: { kind: 'on', date: '2026-12-31' },
      },
      'Every 45 min, until Dec 31',
    ],
  ])('reads %j as "%s"', (patch, sentence) => {
    expect(repeatDraftSummary(draft(patch))).toBe(sentence);
  });

  it('saves the rule from the cell’s date and time, with Ends', () => {
    expect(
      ok(repeatInputFromDraft(draft({ every: { days: 0, hours: 1, minutes: 30, seconds: 0 } })))
    ).toEqual({ rrule: 'FREQ=MINUTELY;INTERVAL=90', date: ANCHOR });
    expect(
      ok(
        repeatInputFromDraft(
          draft({
            every: { days: 2, hours: 0, minutes: 0, seconds: 15 },
            ends: { kind: 'after', count: 5 },
          })
        )
      ).rrule
    ).toBe('FREQ=SECONDLY;INTERVAL=172815;COUNT=5');
    expect(
      ok(repeatInputFromDraft(draft({ ends: { kind: 'on', date: '2026-12-31' } }))).rrule
    ).toBe('FREQ=HOURLY;UNTIL=20261231T235959');
    // Only during and time to do it don't apply to an interval.
    expect(ok(repeatInputFromDraft(draft({ months: [11], due: { kind: 'next' } }))).rrule).toBe(
      'FREQ=HOURLY'
    );
  });

  it('refuses all zeros and parts that are not whole numbers; one second is enough', () => {
    const zero = draft({ every: { days: 0, hours: 0, minutes: 0, seconds: 0 } });
    expect(repeatDraftIntervalProblem(zero)).toBe('The shortest interval is 1 s.');
    expect(errorOf(repeatInputFromDraft(zero))).toBe('The shortest interval is 1 s.');
    expect(repeatDraftUpcoming(zero)).toEqual([]);
    const second = draft({ every: { days: 0, hours: 0, minutes: 0, seconds: 1 } });
    expect(repeatDraftIntervalProblem(second)).toBeNull();
    expect(ok(repeatInputFromDraft(second)).rrule).toBe('FREQ=SECONDLY');
    expect(repeatDraftSummary(second)).toBe('Every 1 s');
    expect(
      repeatDraftIntervalProblem(draft({ every: { days: 0, hours: -1, minutes: 90, seconds: 0 } }))
    ).toBe('Use whole numbers, 0 or more.');
    expect(
      repeatDraftIntervalProblem(draft({ every: { days: 0, hours: 0, minutes: 1, seconds: 0 } }))
    ).toBeNull();
    expect(errorOf(repeatInputFromDraft(draft({ ends: { kind: 'on', date: '2026-10-14' } })))).toBe(
      'No dates: check Ends.'
    );
  });

  it('is only for a date with a time', () => {
    const dated = { ...repeatDraftFor('2026-10-15'), mode: 'interval' as const };
    expect(normalizeRepeatDraft(dated).mode).toBe('schedule');
  });

  it('round-trips a stored interval, exactly', () => {
    const input = ok(
      repeatInputFromDraft(
        draft({
          every: { days: 0, hours: 1, minutes: 30, seconds: 0 },
          ends: { kind: 'after', count: 4 },
        })
      )
    );
    const stored = ok(createTableRepeat({ ...input, tz: NY }));
    const { draft: back, exact } = repeatDraftFromRepeat(stored);
    expect(exact).toBe(true);
    expect(back.mode).toBe('interval');
    expect(back.every).toEqual({ days: 0, hours: 1, minutes: 30, seconds: 0 });
    expect(back.ends).toEqual({ kind: 'after', count: 4 });
    expect(tableRepeatSummary(stored)).toBe('Every 1 h 30 min, 4 times');
    expect(repeatEveryOf(172_815)).toEqual({ days: 2, hours: 0, minutes: 0, seconds: 15 });
  });

  it('lists the next times and the cell names the next one with its time', () => {
    expect(
      repeatDraftUpcoming(draft({ every: { days: 0, hours: 0, minutes: 1, seconds: 30 } }), 3).map(
        (item) => (item.kind === 'date' ? item.occurrence : item.start)
      )
    ).toEqual(['2026-10-15T09:00:00', '2026-10-15T09:01:30', '2026-10-15T09:03:00']);
    const repeat = every('2026-10-15T09:01:30', 'FREQ=SECONDLY;INTERVAL=90');
    expect(tableRepeatCellText(repeat, { today: '2026-10-15' })).toBe('Thu Oct 15, 9:01:30 AM');
  });
});

/**
 * Down to one second: every search finds steps by arithmetic, so a fall-back's
 * repeated hour (3,600 left-out steps at one second), a jump with a wall
 * `now` (two hours of steps) and a month's window cost what they do at an
 * hour. Checked against a brute-force walk of the same steps.
 */
describe('a very short interval (down to one second)', () => {
  /** The walls the series names, by walking every step (kept: its wall time names it). */
  function bruteForce(start: string, seconds: number, tz: string, count: number): string[] {
    const startMs = Date.parse(tableDateTimeToUtc(start, tz)!);
    const out: string[] = [start];
    for (let k = 1; out.length < count; k++) {
      const instant = startMs + k * seconds * 1000;
      const wall = tableRepeatWallTime(new Date(instant), tz);
      if (Date.parse(tableDateTimeToUtc(wall, tz)!) === instant) out.push(wall);
    }
    return out;
  }
  const rule = (seconds: number) =>
    seconds % 60 === 0
      ? `FREQ=MINUTELY;INTERVAL=${seconds / 60}`
      : `FREQ=SECONDLY;INTERVAL=${seconds}`;
  /** Runs `fn`, failing when it takes longer than `ms` (a walk of every step would). */
  function quick<T>(fn: () => T, ms = 1000): T {
    const began = performance.now();
    const value = fn();
    expect(performance.now() - began).toBeLessThan(ms);
    return value;
  }

  describe.each([1, 5, 30, 90])('every %i s', (seconds) => {
    it('at fall-back (LA, Nov 1) leaves out the first pass and goes on at the second', () => {
      const start = '2026-11-01T00:59:50';
      const series = every(start, rule(seconds), LA);
      const walls = quick(() => ok(upcomingRepeatOccurrences(series, 14)));
      expect(walls).toEqual(bruteForce(start, seconds, LA, 14));
      // The first one after the start that isn't before 01:00 is in the second pass (PST).
      const after = walls.find((wall) => wall >= '2026-11-01T01:00:00')!;
      expect(tableDateTimeToUtc(after, LA)! >= '2026-11-01T09:00:00').toBe(true);
      // Done on the last one before the hour lands there in one step.
      const before = walls[walls.indexOf(after) - 1]!;
      expect(
        quick(() => ok(advanceTableRepeat({ ...series, current: before })).next?.current)
      ).toBe(after);
      expect(isTableRepeatUpcoming(series, after)).toBe(true);
    });

    it('at spring-forward (LA, Mar 8) steps straight over the missing hour', () => {
      const start = '2026-03-08T01:59:50';
      const series = every(start, rule(seconds), LA);
      const walls = quick(() => ok(upcomingRepeatOccurrences(series, 14)));
      expect(walls).toEqual(bruteForce(start, seconds, LA, 14));
      expect(walls.some((wall) => wall.startsWith('2026-03-08T02:'))).toBe(false);
      expect(gaps(walls, LA).every((gap) => gap === seconds)).toBe(true);
    });

    it('jumps to now with a wall `now` in the fall-back hour, as with the moment', () => {
      const series = every('2026-10-25T09:00:00', rule(seconds), LA);
      // 01:30 names the second pass (09:30Z), whichever pass it is sent in.
      const wall = quick(() => ok(jumpTableRepeatToUpcoming(series, '2026-11-01T01:30:00')));
      const moment = quick(() =>
        ok(jumpTableRepeatToUpcoming(series, new Date('2026-11-01T09:30:00Z')))
      );
      expect(wall?.current).toBe(moment?.current);
      expect(wall?.current! >= '2026-11-01T01:30:00').toBe(true);
      expect(isTableRepeatUpcoming(series, wall!.current)).toBe(true);
    });
  });

  it('jumps a 1-second row a week behind to the very next second, with a wall `now` or the moment', () => {
    const series = every('2026-10-08T09:00:00', 'FREQ=SECONDLY', LA);
    expect(quick(() => ok(jumpTableRepeatToUpcoming(series, '2026-10-15T09:00:30')))?.current).toBe(
      '2026-10-15T09:00:30'
    );
    expect(
      quick(() => ok(jumpTableRepeatToUpcoming(series, new Date('2026-10-15T16:00:30.400Z'))))
        ?.current
    ).toBe('2026-10-15T09:00:30');
    // In the spring-forward gap: the first second after it.
    const march = every('2026-03-08T01:00:00', 'FREQ=SECONDLY', LA);
    expect(quick(() => ok(jumpTableRepeatToUpcoming(march, '2026-03-08T02:30:00')))?.current).toBe(
      '2026-03-08T03:00:00'
    );
  });

  it('Done and Skip at one second; Skip to upcoming lists at most 5,000 (each is logged)', () => {
    const series = every('2026-10-15T09:00:00', 'FREQ=SECONDLY', LA);
    expect(ok(advanceTableRepeat(series)).next?.current).toBe('2026-10-15T09:00:01');
    const skipped = quick(() => ok(skipTableRepeatToUpcoming(series, '2026-10-15T09:00:30')));
    expect(skipped.skipped).toHaveLength(30);
    expect(skipped.next?.current).toBe('2026-10-15T09:00:30');
    // An hour and a half behind is more than it lists: Jump to now goes there in one step.
    expect(
      errorOf(quick(() => skipTableRepeatToUpcoming(series, '2026-10-15T10:30:00'), 5000))
    ).toBe('More than 5000 missed occurrences; edit the date or use Jump to now instead.');
    expect(ok(jumpTableRepeatToUpcoming(series, '2026-10-15T10:30:00'))?.current).toBe(
      '2026-10-15T10:30:00'
    );
  });

  it.each([1, 30])(
    'a month’s window at %i s returns its first 500 at once, truncated',
    (seconds) => {
      const series = every('2026-10-01T00:00:00', rule(seconds), LA);
      const result = quick(() =>
        ok(
          tableRepeatIntervalOccurrences(series, {
            from: '2026-10-31T07:00:00Z',
            to: '2026-12-01T08:00:00Z',
            limit: 500,
          })
        )
      );
      expect(result.truncated).toBe(true);
      expect(result.occurrences).toHaveLength(500);
      expect(gaps(result.occurrences, LA).every((gap) => gap === seconds)).toBe(true);
    }
  );

  it('reads every `stride`-th step from the start, across the fall-back hour too', () => {
    const series = every('2026-11-01T00:58:00', 'FREQ=SECONDLY', LA);
    const result = quick(() =>
      ok(
        tableRepeatIntervalOccurrences(series, {
          from: '2026-11-01T07:58:00Z',
          to: '2026-11-01T09:03:00Z',
          limit: 100,
          stride: 60,
        })
      )
    );
    // 00:58 and 00:59 PDT, then the first pass is left out, then 01:00, 01:01, 01:02 PST.
    expect(result).toEqual({
      occurrences: [
        '2026-11-01T00:58:00',
        '2026-11-01T00:59:00',
        '2026-11-01T01:00:00',
        '2026-11-01T01:01:00',
        '2026-11-01T01:02:00',
      ],
      truncated: false,
    });
    // `current` reads only when it is on the stride.
    const off = { ...series, current: '2026-11-01T00:58:30' };
    expect(
      ok(
        tableRepeatIntervalOccurrences(off, {
          from: '2026-11-01T07:58:00Z',
          to: '2026-11-01T08:00:00Z',
          limit: 100,
          stride: 60,
        })
      ).occurrences
    ).toEqual(['2026-11-01T00:59:00']);
  });
});
