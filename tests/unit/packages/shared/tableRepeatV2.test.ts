/**
 * Repeat engine (docs/architecture.md): overdue and the write checks. There are no
 * "time to do it" (due windows) or "only during" (active months) options.
 * Overdue means the occurrence's own day (or range end) has passed.
 */
import {
  createTableRepeat,
  isTableRepeatOverdue,
  skipTableRepeatToUpcoming,
  tableRepeatWriteProblem,
  upcomingTableRepeatItems,
  type TableRepeat,
} from '@snaglet/shared/utils';

function ok<T>(result: { ok: true; value: T } | { ok: false; error: string }): T {
  if (!result.ok) throw new Error(result.error);
  return result.value;
}

const TZ = 'America/Los_Angeles';

function schedule(date: string, rrule: string): TableRepeat {
  return ok(createTableRepeat({ date, rrule, tz: TZ }));
}

describe('upcoming occurrences', () => {
  it('lists scheduled days with no due window', () => {
    const rent = schedule('2026-11-01', 'FREQ=MONTHLY');
    expect(ok(upcomingTableRepeatItems(rent, 2))).toEqual([
      { kind: 'date', occurrence: '2026-11-01' },
      { kind: 'date', occurrence: '2026-12-01' },
    ]);
  });
});

describe('tableRepeatWriteProblem', () => {
  it('accepts a well-formed schedule', () => {
    expect(tableRepeatWriteProblem(schedule('2026-10-12', 'FREQ=WEEKLY;BYDAY=MO'))).toBeNull();
    expect(tableRepeatWriteProblem(schedule('2026-10-12', 'FREQ=DAILY'))).toBeNull();
    expect(
      tableRepeatWriteProblem(schedule('2026-10-01', 'FREQ=MONTHLY;BYMONTHDAY=1,15'))
    ).toBeNull();
  });

  it('accepts BYMONTH on a yearly rule ("every year in March")', () => {
    expect(tableRepeatWriteProblem(schedule('2026-03-01', 'FREQ=YEARLY;BYMONTH=3'))).toBeNull();
  });

  it('rejects BYMONTH on a non-yearly rule (it would silently narrow to once a year)', () => {
    const monthly = tableRepeatWriteProblem(schedule('2026-03-01', 'FREQ=MONTHLY;BYMONTH=3'));
    expect(monthly).not.toBeNull();
    expect(monthly).toMatch(/BYMONTH/);
    expect(monthly).toMatch(/FREQ=YEARLY/);
    expect(tableRepeatWriteProblem(schedule('2026-03-02', 'FREQ=WEEKLY;BYMONTH=3'))).not.toBeNull();
    expect(tableRepeatWriteProblem(schedule('2026-03-02', 'FREQ=DAILY;BYMONTH=3'))).not.toBeNull();
  });
});

describe('overdue and skipping to upcoming', () => {
  it('is overdue once the occurrence day has passed, unless done or skipped', () => {
    const rent = schedule('2026-11-01', 'FREQ=MONTHLY');
    expect(isTableRepeatOverdue(rent, '2026-11-01')).toBe(false);
    expect(isTableRepeatOverdue(rent, '2026-11-02')).toBe(true);
  });

  it('skips set days whose own day is past, not the one on today', () => {
    const review = schedule('2026-10-02', 'FREQ=WEEKLY;BYDAY=FR');
    // Oct 9 falls on the comparison day, so it stays; Oct 2 is skipped.
    expect(ok(skipTableRepeatToUpcoming(review, '2026-10-09')).skipped).toEqual(['2026-10-02']);
  });
});
