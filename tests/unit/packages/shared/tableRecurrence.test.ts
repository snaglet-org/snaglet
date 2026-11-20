import {
  advanceTableRepeat,
  createTableRepeat,
  describeTableRepeat,
  isTableRepeatOverdue,
  nextRepeatOccurrence,
  normalizeRepeatRule,
  repeatOccurrenceToColumn,
  skipTableRepeatToUpcoming,
  tableRepeatProblem,
  upcomingRepeatOccurrences,
  type TableRepeat,
} from '@snaglet/shared/utils';

function series(date: string, rrule: string, tz = 'America/Los_Angeles'): TableRepeat {
  const created = createTableRepeat({ date, rrule, tz });
  if (!created.ok) throw new Error(created.error);
  return created.value;
}

function ok<T>(result: { ok: true; value: T } | { ok: false; error: string }): T {
  if (!result.ok) throw new Error(result.error);
  return result.value;
}

/** Walks the series by repeated completion (model A), as the server will. */
function walk(repeat: TableRepeat, steps: number): string[] {
  const out = [repeat.current];
  let at: TableRepeat | null = repeat;
  for (let i = 1; i < steps && at; i += 1) {
    at = ok(advanceTableRepeat(at)).next;
    if (at) out.push(at.current);
  }
  return out;
}

describe('normalizeRepeatRule', () => {
  it('normalizes case, the RRULE: prefix and part order (FREQ first)', () => {
    expect(ok(normalizeRepeatRule('rrule:byday=mo,we;freq=weekly'))).toBe(
      'FREQ=WEEKLY;BYDAY=MO,WE'
    );
  });

  it('drops a trailing Z from UNTIL (series are floating wall time)', () => {
    expect(ok(normalizeRepeatRule('FREQ=DAILY;UNTIL=20261010T120000Z'))).toBe(
      'FREQ=DAILY;UNTIL=20261010T120000'
    );
  });

  it.each([
    ['', 'empty'],
    ['BYDAY=MO', 'needs FREQ'],
    ['FREQ=HOURLY', 'FREQ must be'],
    ['FREQ=DAILY;FOO=1', 'Unsupported rule part FOO'],
    ['FREQ=DAILY;DTSTART=20260101', "DTSTART isn't allowed"],
    ['FREQ=DAILY;TZID=UTC', "TZID isn't allowed"],
    ['FREQ=DAILY;COUNT=3;UNTIL=20261231', 'not both'],
    ['FREQ=DAILY;COUNT=0', 'positive whole number'],
    ['FREQ=DAILY;INTERVAL=x', 'positive whole number'],
    ['FREQ=DAILY;UNTIL=20261340', 'UNTIL must be'],
    ['FREQ=WEEKLY;BYDAY=2TU', 'needs FREQ=MONTHLY or YEARLY'],
    ['FREQ=WEEKLY;BYDAY=XX', "isn't valid"],
    ['FREQ=DAILY;FREQ=WEEKLY', 'appears twice'],
    ['FREQ=WEEKLY;WKST=XX', 'WKST must be'],
    ['FREQ=DAILY\nFREQ=WEEKLY', 'single RRULE line'],
  ])('rejects %j (%s)', (rule, message) => {
    const result = normalizeRepeatRule(rule);
    expect(result.ok).toBe(false);
    expect(result.ok ? '' : result.error).toContain(message);
  });
});

describe('createTableRepeat / tableRepeatProblem', () => {
  it('snapshots the given zone and starts current at the anchor', () => {
    expect(series('2026-10-05', 'FREQ=WEEKLY', 'Europe/Berlin')).toEqual({
      rrule: 'FREQ=WEEKLY',
      dtstart: '2026-10-05',
      current: '2026-10-05',
      tz: 'Europe/Berlin',
    });
  });

  it.each([
    [{ date: '2026-02-30', rrule: 'FREQ=DAILY', tz: 'UTC' }, 'wall-clock'],
    [{ date: '2026-10-05T09:30', rrule: 'FREQ=DAILY', tz: 'UTC' }, 'wall-clock'],
    [{ date: '2026-10-05', rrule: 'FREQ=DAILY', tz: "UTC'; drop" }, 'IANA'],
  ])('rejects %j', (input, message) => {
    const result = createTableRepeat(input);
    expect(result.ok ? '' : result.error).toContain(message);
  });

  it('accepts a stored value and flags tampered ones', () => {
    const repeat = series('2026-10-05', 'FREQ=WEEKLY');
    expect(tableRepeatProblem(repeat)).toBeNull();
    expect(tableRepeatProblem({ ...repeat, current: '2026-10-05T09:00:00' })).toContain('match');
    expect(tableRepeatProblem({ ...repeat, current: '2026-09-01' })).toContain('before the start');
    expect(tableRepeatProblem([])).toContain('object');
  });
});

describe('expansion edge cases', () => {
  it('monthly on the 31st skips short months (RFC 5545)', () => {
    expect(walk(series('2026-01-31', 'FREQ=MONTHLY;BYMONTHDAY=31'), 4)).toEqual([
      '2026-01-31',
      '2026-03-31',
      '2026-05-31',
      '2026-07-31',
    ]);
  });

  it('monthly on the last day lands on Feb 28 and Feb 29', () => {
    expect(walk(series('2026-01-31', 'FREQ=MONTHLY;BYMONTHDAY=-1'), 3)).toEqual([
      '2026-01-31',
      '2026-02-28',
      '2026-03-31',
    ]);
    expect(walk(series('2028-01-31', 'FREQ=MONTHLY;BYMONTHDAY=-1'), 2)).toEqual([
      '2028-01-31',
      '2028-02-29',
    ]);
  });

  it('yearly on Feb 29 only hits leap years', () => {
    expect(walk(series('2028-02-29', 'FREQ=YEARLY'), 3)).toEqual([
      '2028-02-29',
      '2032-02-29',
      '2036-02-29',
    ]);
  });

  it('Nth weekday: the second Tuesday, and the last Friday', () => {
    expect(walk(series('2026-10-13', 'FREQ=MONTHLY;BYDAY=2TU'), 3)).toEqual([
      '2026-10-13',
      '2026-11-10',
      '2026-12-08',
    ]);
    expect(walk(series('2026-10-30', 'FREQ=MONTHLY;BYDAY=-1FR'), 3)).toEqual([
      '2026-10-30',
      '2026-11-27',
      '2026-12-25',
    ]);
  });

  it('weekly on several days with an interval', () => {
    expect(walk(series('2026-10-05', 'FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,TH'), 5)).toEqual([
      '2026-10-05',
      '2026-10-08',
      '2026-10-19',
      '2026-10-22',
      '2026-11-02',
    ]);
  });

  it('WKST changes which weeks an INTERVAL=2 weekly rule hits', () => {
    // Anchor Sunday Oct 4. Week starting MO: Sun is the end of the Sep 28 week,
    // so the next Tuesday is in the "off" week. Week starting SU: same week.
    expect(walk(series('2026-10-04', 'FREQ=WEEKLY;INTERVAL=2;BYDAY=SU,TU;WKST=MO'), 3)).toEqual([
      '2026-10-04',
      '2026-10-13',
      '2026-10-18',
    ]);
    expect(walk(series('2026-10-04', 'FREQ=WEEKLY;INTERVAL=2;BYDAY=SU,TU;WKST=SU'), 3)).toEqual([
      '2026-10-04',
      '2026-10-06',
      '2026-10-18',
    ]);
  });

  it('a datetime series keeps its wall-clock time across DST', () => {
    const repeat = series('2026-10-30T09:30:00', 'FREQ=DAILY');
    expect(walk(repeat, 4)).toEqual([
      '2026-10-30T09:30:00',
      '2026-10-31T09:30:00',
      '2026-11-01T09:30:00',
      '2026-11-02T09:30:00',
    ]);
    // Los Angeles falls back on Nov 1: 09:30 PDT is 16:30Z, 09:30 PST is 17:30Z.
    expect(repeatOccurrenceToColumn(repeat, '2026-10-31T09:30:00')).toBe(
      '2026-10-31T16:30:00.000000Z'
    );
    expect(repeatOccurrenceToColumn(repeat, '2026-11-02T09:30:00')).toBe(
      '2026-11-02T17:30:00.000000Z'
    );
  });

  it('a wall time skipped by spring-forward resolves as PostgreSQL does', () => {
    const repeat = series('2027-03-13T02:30:00', 'FREQ=DAILY');
    // 02:30 doesn't exist on Mar 14 2027 in Los Angeles; it becomes 03:30 PDT.
    expect(repeatOccurrenceToColumn(repeat, '2027-03-14T02:30:00')).toBe(
      '2027-03-14T10:30:00.000000Z'
    );
    expect(walk(repeat, 3)[2]).toBe('2027-03-15T02:30:00');
  });

  it('date fields store the wall date unchanged', () => {
    expect(repeatOccurrenceToColumn(series('2026-10-05', 'FREQ=DAILY'), '2026-10-06')).toBe(
      '2026-10-06'
    );
  });
});

describe('series ends', () => {
  it('COUNT counts the anchor and still holds after advancing', () => {
    const repeat = series('2026-10-05', 'FREQ=WEEKLY;COUNT=3');
    expect(walk(repeat, 10)).toEqual(['2026-10-05', '2026-10-12', '2026-10-19']);
    const last = { ...repeat, current: '2026-10-19' };
    expect(ok(nextRepeatOccurrence(last))).toBeNull();
    expect(ok(advanceTableRepeat(last))).toEqual({ finished: '2026-10-19', next: null });
  });

  it('an anchor off the rule is occurrence #1 and counts toward COUNT', () => {
    // Anchor Tuesday, rule Mondays: Tue, then two Mondays.
    expect(walk(series('2026-10-06', 'FREQ=WEEKLY;BYDAY=MO;COUNT=3'), 10)).toEqual([
      '2026-10-06',
      '2026-10-12',
      '2026-10-19',
    ]);
    expect(walk(series('2026-10-06', 'FREQ=WEEKLY;BYDAY=MO;COUNT=1'), 10)).toEqual(['2026-10-06']);
  });

  it('a date-only UNTIL is inclusive, for date and datetime series', () => {
    expect(walk(series('2026-10-05', 'FREQ=DAILY;UNTIL=20261007'), 10)).toEqual([
      '2026-10-05',
      '2026-10-06',
      '2026-10-07',
    ]);
    expect(walk(series('2026-10-05T18:00:00', 'FREQ=DAILY;UNTIL=20261006'), 10)).toEqual([
      '2026-10-05T18:00:00',
      '2026-10-06T18:00:00',
    ]);
  });

  it('a timed UNTIL compares against the wall time', () => {
    expect(walk(series('2026-10-05T18:00:00', 'FREQ=DAILY;UNTIL=20261006T170000'), 10)).toEqual([
      '2026-10-05T18:00:00',
    ]);
  });
});

describe('model A: advance, upcoming, skip to upcoming', () => {
  it('advance moves current only, keeping the anchor, rule and zone', () => {
    const repeat = series('2026-10-05', 'FREQ=WEEKLY');
    expect(ok(advanceTableRepeat(repeat))).toEqual({
      finished: '2026-10-05',
      next: { ...repeat, current: '2026-10-12' },
    });
  });

  it('advancing from a current that a hand edit moved off the rule rejoins the rule', () => {
    // current stays the series' own occurrence; if it somehow sits off-rule,
    // the next occurrence is still the rule's next one after it.
    const repeat = { ...series('2026-10-05', 'FREQ=WEEKLY'), current: '2026-10-14' };
    expect(ok(nextRepeatOccurrence(repeat))).toBe('2026-10-19');
  });

  it('upcoming lists current first, capped by the series end', () => {
    expect(ok(upcomingRepeatOccurrences(series('2026-10-05', 'FREQ=DAILY;COUNT=2'), 3))).toEqual([
      '2026-10-05',
      '2026-10-06',
    ]);
    expect(ok(upcomingRepeatOccurrences(series('2026-10-05', 'FREQ=DAILY'), 0))).toEqual([]);
  });

  it('skip to upcoming skips every past occurrence (dates compare by day)', () => {
    const repeat = series('2026-09-21', 'FREQ=WEEKLY');
    expect(ok(skipTableRepeatToUpcoming(repeat, '2026-10-07T18:45:00'))).toEqual({
      skipped: ['2026-09-21', '2026-09-28', '2026-10-05'],
      next: { ...repeat, current: '2026-10-12' },
    });
    // Today's occurrence is not in the past for a date field.
    const today = series('2026-10-07', 'FREQ=WEEKLY');
    expect(ok(skipTableRepeatToUpcoming(today, '2026-10-07T23:00:00')).skipped).toEqual([]);
  });

  it('skip to upcoming on a datetime series compares wall times', () => {
    const repeat = series('2026-10-07T09:00:00', 'FREQ=DAILY');
    expect(ok(skipTableRepeatToUpcoming(repeat, '2026-10-08T08:59:00'))).toEqual({
      skipped: ['2026-10-07T09:00:00'],
      next: { ...repeat, current: '2026-10-08T09:00:00' },
    });
  });

  it('skip to upcoming can end the series', () => {
    expect(
      ok(skipTableRepeatToUpcoming(series('2026-09-01', 'FREQ=WEEKLY;COUNT=2'), '2026-10-07'))
    ).toEqual({
      skipped: ['2026-09-01', '2026-09-08'],
      next: null,
    });
  });

  it('skip to upcoming refuses an unbounded backlog instead of looping', () => {
    const result = skipTableRepeatToUpcoming(series('2000-01-01', 'FREQ=DAILY'), '2026-10-07');
    expect(result.ok ? '' : result.error).toContain('missed occurrences');
  });
});

describe('describeTableRepeat', () => {
  it.each([
    ['FREQ=WEEKLY;BYDAY=MO', 'every week on Monday'],
    ['FREQ=MONTHLY;BYMONTHDAY=1', 'every month on the 1st'],
    ['FREQ=DAILY;COUNT=5', 'every day for 5 times'],
    ['FREQ=MONTHLY;BYDAY=2TU', 'every month on the 2nd Tuesday'],
  ])('%s', (rrule, text) => {
    expect(ok(describeTableRepeat(series('2026-10-05', rrule)))).toBe(text);
  });
});

describe('isTableRepeatOverdue — a range is overdue only after its end', () => {
  // A Nov 2–13 range repeating every two weeks. Passing `now` as a wall date
  // keeps the comparison in wall time, tz-independent.
  const rangeRepeat = series('2026-11-02', 'FREQ=WEEKLY;INTERVAL=2');

  it('a running date range is not overdue partway through (Nov 4, end Nov 13)', () => {
    expect(isTableRepeatOverdue(rangeRepeat, '2026-11-04', { occurrenceEnd: '2026-11-13' })).toBe(
      false
    );
  });

  it('the same range is overdue once its end day has passed (Nov 14)', () => {
    expect(isTableRepeatOverdue(rangeRepeat, '2026-11-14', { occurrenceEnd: '2026-11-13' })).toBe(
      true
    );
  });

  it('on the end day itself the range is not yet overdue (Nov 13)', () => {
    expect(isTableRepeatOverdue(rangeRepeat, '2026-11-13', { occurrenceEnd: '2026-11-13' })).toBe(
      false
    );
  });

  it('a single-day occurrence is unchanged: no end, overdue the day after its start', () => {
    const single = series('2026-11-02', 'FREQ=WEEKLY;INTERVAL=2');
    // Without an end, the start day governs (as before this fix).
    expect(isTableRepeatOverdue(single, '2026-11-02')).toBe(false);
    expect(isTableRepeatOverdue(single, '2026-11-03')).toBe(true);
    // An end equal to the start is treated as a single day, not a range.
    expect(isTableRepeatOverdue(single, '2026-11-03', { occurrenceEnd: '2026-11-02' })).toBe(true);
  });

  it('a timed occurrence is unchanged: a point in time, overdue once its instant passes', () => {
    const timed = series('2026-11-02T09:00:00', 'FREQ=WEEKLY;INTERVAL=2');
    expect(isTableRepeatOverdue(timed, '2026-11-02T08:00:00')).toBe(false);
    expect(isTableRepeatOverdue(timed, '2026-11-03T10:00:00')).toBe(true);
  });

  it('a multi-day timed range is overdue only after its end day', () => {
    // A non-interval (weekly) timed series compares by day, like a date one
    // (the interval/sub-daily path is the only instant comparison). So a timed
    // range spanning Nov 2 09:00 → Nov 4 17:00 is still running on Nov 3 and
    // overdue only once its end day (Nov 4) has passed, the same end-vs-start
    // rule as a date range.
    const timedRange = series('2026-11-02T09:00:00', 'FREQ=WEEKLY;INTERVAL=2');
    expect(
      isTableRepeatOverdue(timedRange, '2026-11-03T12:00:00', {
        occurrenceEnd: '2026-11-04T17:00:00',
      })
    ).toBe(false);
    expect(
      isTableRepeatOverdue(timedRange, '2026-11-05T10:00:00', {
        occurrenceEnd: '2026-11-04T17:00:00',
      })
    ).toBe(true);
  });
});
