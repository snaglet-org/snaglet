/** Week phrases in an entry search, with today fixed at Wednesday 2026-10-21 (this week is Mon 2026-10-19 to Sun 2026-10-25). */
import { describe, expect, it } from '@jest/globals';
import { parseTimePhrase } from '@server/services/search/timePhrase';
import { parseWeekPhrase } from '@server/services/search/weekPhrase';

const TODAY = '2026-10-21';
const parse = (query: string, today = TODAY) => parseWeekPhrase(query, today);

describe('calendar weeks (Monday to Sunday)', () => {
  it('this, next and last week', () => {
    expect(parse('due this week')?.range).toMatchObject({
      from: '2026-10-19',
      to: '2026-10-26',
      direction: 'current',
      monthName: null,
    });
    expect(parse('next week')?.range).toMatchObject({
      from: '2026-10-26',
      to: '2026-11-02',
      direction: 'future',
    });
    expect(parse('last week')?.range).toMatchObject({
      from: '2026-10-12',
      to: '2026-10-19',
      direction: 'past',
    });
    expect(parse('previous week')?.range.from).toBe('2026-10-12');
    expect(parse('current week')?.range.from).toBe('2026-10-19');
  });

  it('a Sunday belongs to the week that began on Monday; a Monday starts its own', () => {
    expect(parse('this week', '2026-10-25')?.range).toMatchObject({
      from: '2026-10-19',
      to: '2026-10-26',
    });
    expect(parse('this week', '2026-10-19')?.range).toMatchObject({
      from: '2026-10-19',
      to: '2026-10-26',
    });
    expect(parse('last week', '2026-10-26')?.range.from).toBe('2026-10-19');
  });

  it('crosses a year edge', () => {
    expect(parse('this week', '2026-01-01')?.range).toMatchObject({
      from: '2025-12-29',
      to: '2026-01-05',
    });
    expect(parse('last week', '2026-01-01')?.range).toMatchObject({
      from: '2025-12-22',
      to: '2025-12-29',
    });
    expect(parse('next week', '2026-12-30')?.range).toMatchObject({
      from: '2027-01-04',
      to: '2027-01-11',
    });
  });

  it('a few weeks ago spans two to four weeks back; a couple is two', () => {
    expect(parse('something from a few weeks ago')?.range).toMatchObject({
      from: '2026-09-21',
      to: '2026-10-12',
      direction: 'past',
    });
    expect(parse('a couple of weeks ago')?.range).toMatchObject({
      from: '2026-10-05',
      to: '2026-10-12',
    });
  });

  it('N weeks ago, a week ago and in N weeks, in digits or words', () => {
    expect(parse('3 weeks ago')?.range).toMatchObject({ from: '2026-09-28', to: '2026-10-05' });
    expect(parse('five weeks ago')?.range.from).toBe('2026-09-14');
    expect(parse('a week ago')?.range).toMatchObject({ from: '2026-10-12', to: '2026-10-19' });
    expect(parse('due in 2 weeks')?.range).toMatchObject({
      from: '2026-11-02',
      to: '2026-11-09',
      direction: 'future',
    });
    expect(parse('in a week')?.range.from).toBe('2026-10-26');
  });
});

describe('rolling windows from today', () => {
  it('the next N weeks and the past N weeks', () => {
    expect(parse('due in the next 2 weeks')?.range).toMatchObject({
      from: '2026-10-21',
      to: '2026-11-04',
      direction: 'current',
    });
    expect(parse('over the last 3 weeks')?.range).toMatchObject({
      from: '2026-09-30',
      to: '2026-10-22',
    });
    expect(parse('the past week')?.range).toMatchObject({ from: '2026-10-14', to: '2026-10-22' });
    expect(parse('past week')?.range.from).toBe('2026-10-14');
    expect(parse('next 2 weeks')?.range.to).toBe('2026-11-04');
    expect(parse('in the last week')?.range.from).toBe('2026-10-14');
  });

  it('"last week" and "next week" alone are calendar weeks, not windows', () => {
    expect(parse('last week')?.range.from).toBe('2026-10-12');
    expect(parse('in the last week')?.range.from).toBe('2026-10-14');
  });
});

describe('open ranges and residual text', () => {
  it('before / until, by, after and since', () => {
    expect(parse('before next week')?.range).toMatchObject({
      from: null,
      to: '2026-10-26',
      direction: 'past',
    });
    expect(parse('until next week')?.range.to).toBe('2026-10-26');
    expect(parse('by next week')?.range).toMatchObject({ from: null, to: '2026-11-02' });
    expect(parse('after this week')?.range).toMatchObject({
      from: '2026-10-26',
      to: null,
      direction: 'future',
    });
    expect(parse('since last week')?.range).toMatchObject({ from: '2026-10-12', to: null });
    expect(parse('before 2 weeks ago')?.range.to).toBe('2026-10-05');
  });

  it('removes the phrase and its lead-in, keeps the other words', () => {
    expect(parse('tasks due next week')?.residual).toBe('tasks due');
    expect(parse('budget in 2 weeks')?.residual).toBe('budget');
    expect(parse('emails from last week')?.residual).toBe('emails');
  });

  it('labels the days', () => {
    expect(parse('this week')?.range.label).toBe('this week (Oct 19 to Oct 25)');
    expect(parse('in the next 2 weeks')?.range.label).toBe('the next 2 weeks (Oct 21 to Nov 3)');
  });

  it('is null for words that only look like weeks', () => {
    for (const query of [
      'weekly report',
      'weeknight plans',
      'the week',
      'week 3 notes',
      '',
      'next quarter',
    ])
      expect(parse(query)).toBeNull();
  });
});

describe('months and weeks together', () => {
  it('uses the phrase written first', () => {
    expect(parseTimePhrase('due next week in June', '2026-10-21')?.range.label).toMatch(
      /^next week/
    );
    expect(parseTimePhrase('June tasks due next week', '2026-10-21')?.range.label).toBe(
      'June 2026'
    );
    expect(parseTimePhrase('due next month', '2026-10-21')?.range.from).toBe('2026-11-01');
    expect(parseTimePhrase('due last week', '2026-10-21')?.range.from).toBe('2026-10-12');
  });
});
