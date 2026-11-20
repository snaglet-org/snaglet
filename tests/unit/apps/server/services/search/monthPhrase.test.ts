/** Month phrases in an entry search, with today fixed at 2026-10-19. */
import { describe, expect, it } from '@jest/globals';
import { parseMonthPhrase } from '@server/services/search/monthPhrase';

const TODAY = '2026-10-19';
const parse = (query: string) => parseMonthPhrase(query, TODAY);

describe('relative months', () => {
  it('this, next and last month', () => {
    expect(parse('tasks due this month')?.range).toMatchObject({
      from: '2026-10-01',
      to: '2026-11-01',
      direction: 'current',
      monthName: null,
    });
    expect(parse('due next month')?.range).toMatchObject({
      from: '2026-11-01',
      to: '2026-12-01',
      direction: 'future',
    });
    expect(parse('last month')?.range).toMatchObject({
      from: '2026-09-01',
      to: '2026-10-01',
      direction: 'past',
    });
    expect(parse('previous month')?.range.from).toBe('2026-09-01');
  });

  it('crosses a year edge', () => {
    expect(parseMonthPhrase('next month', '2026-12-20')?.range).toMatchObject({
      from: '2027-01-01',
      to: '2027-02-01',
    });
    expect(parseMonthPhrase('last month', '2027-01-05')?.range).toMatchObject({
      from: '2026-12-01',
      to: '2027-01-01',
    });
  });

  it('a few months ago spans two to four months back; a couple is two', () => {
    expect(parse('something I did a few months ago')?.range).toMatchObject({
      from: '2026-06-01',
      to: '2026-09-01',
      direction: 'past',
    });
    expect(parse('a couple of months ago')?.range).toMatchObject({
      from: '2026-08-01',
      to: '2026-09-01',
    });
  });

  it('N months ago and in N months, in digits or words', () => {
    expect(parse('3 months ago')?.range).toMatchObject({ from: '2026-07-01', to: '2026-08-01' });
    expect(parse('five months ago')?.range).toMatchObject({ from: '2026-05-01', to: '2026-06-01' });
    expect(parse('due in 2 months')?.range).toMatchObject({
      from: '2026-12-01',
      to: '2027-01-01',
      direction: 'future',
    });
    expect(parse('in two months')?.range.from).toBe('2026-12-01');
  });

  it('removes the phrase and its lead-in from the query', () => {
    expect(parse('budget due next month')?.residual).toBe('budget due');
    expect(parse('what is due in 2 months')?.residual).toBe('what is due');
    expect(parse('in 3 months ago')?.range.from).toBe('2026-07-01');
  });
});

describe('named months', () => {
  it('picks the nearest occurrence: the month a person most likely means', () => {
    // Today is October 2026: June 2026 is 4 months back, June 2027 is 8 ahead.
    expect(parse('due in June')?.range).toMatchObject({
      from: '2026-06-01',
      to: '2026-07-01',
      monthName: 'june',
      label: 'June 2026',
    });
    // December is 2 ahead.
    expect(parse('december')?.range.from).toBe('2026-12-01');
    // January is 3 ahead (2027), not 9 back.
    expect(parse('in January')?.range.from).toBe('2027-01-01');
  });

  it('takes an explicit year, and this / next / last before the month', () => {
    expect(parse('june 2027')?.range.from).toBe('2027-06-01');
    expect(parse('in March 2025')?.range).toMatchObject({ from: '2025-03-01', to: '2025-04-01' });
    expect(parse('next june')?.range.from).toBe('2027-06-01');
    expect(parse('last june')?.range.from).toBe('2026-06-01');
    expect(parse('this june')?.range.from).toBe('2026-06-01');
    expect(parse('next december')?.range.from).toBe('2026-12-01');
    expect(parse('last october')?.range.from).toBe('2025-10-01');
  });

  it('removes the month and its lead-in, keeps the other words', () => {
    expect(parse('taxes due in June')?.residual).toBe('taxes due');
    expect(parse('June budget')?.residual).toBe('budget');
    expect(parse('june')?.residual).toBe('');
  });

  it('treats "may" and short forms as words unless something makes them a month', () => {
    expect(parse('tasks that may matter')).toBeNull();
    expect(parse('May I see my tasks')).toBeNull();
    expect(parse('due in may')?.range.from).toBe('2026-05-01');
    expect(parse('may 2026')?.range.from).toBe('2026-05-01');
    expect(parse('may')?.range.monthName).toBe('may');
    expect(parse('the mar of the sea')).toBeNull();
    expect(parse('due in dec')?.range.from).toBe('2026-12-01');
    expect(parse('by sept')?.range).toMatchObject({ from: null, to: '2027-10-01' });
    expect(parse('in sept')?.range.from).toBe('2026-09-01');
  });

  it('is null when no month is mentioned', () => {
    expect(parse('something urgent')).toBeNull();
    expect(parse('tomorrow')).toBeNull();
    expect(parse('')).toBeNull();
  });
});

describe('open ranges: before, after, until, till, by, since', () => {
  it('before / until / till end the range at the start of the month, with no start', () => {
    // "June" here is the next June (2027): a deadline a person is looking ahead to.
    for (const word of ['before', 'until', 'till']) {
      const phrase = parse(`tasks due ${word} June`);
      expect(phrase?.range).toMatchObject({
        from: null,
        to: '2027-06-01',
        monthName: null,
        direction: 'past',
      });
      expect(phrase?.residual).toBe('tasks due');
    }
    expect(parse('until June')?.range.label).toBe('until June 2027');
    expect(parse('till June')?.range.label).toBe('until June 2027');
  });

  it('by includes the month; after starts the day after it ends', () => {
    expect(parse('due by June')?.range).toMatchObject({ from: null, to: '2027-07-01' });
    expect(parse('due after June')?.range).toMatchObject({
      from: '2027-07-01',
      to: null,
      direction: 'future',
    });
  });

  it('since starts at the first of the month; from is just "that month"', () => {
    // "since March" is the most recent March that has begun: March 2026, not March 2027.
    expect(parse('bills since March')?.range).toMatchObject({ from: '2026-03-01', to: null });
    // "emails from June" means June, and "from 6 months ago" that month.
    expect(parse('emails from June')?.range).toMatchObject({
      from: '2026-06-01',
      to: '2026-07-01',
    });
    expect(parse('something from 6 months ago')?.range).toMatchObject({
      from: '2026-04-01',
      to: '2026-05-01',
    });
  });

  it('the current month counts as the upcoming one, and a year pins it', () => {
    expect(parse('by October')?.range).toMatchObject({ from: null, to: '2026-11-01' });
    expect(parse('since October')?.range).toMatchObject({ from: '2026-10-01', to: null });
    expect(parse('before June 2026')?.range).toMatchObject({ from: null, to: '2026-06-01' });
    expect(parse('after December 2026')?.range).toMatchObject({ from: '2027-01-01', to: null });
  });

  it('works with relative months and counted months', () => {
    expect(parse('before next month')?.range).toMatchObject({ from: null, to: '2026-11-01' });
    expect(parse('by next month')?.range).toMatchObject({ from: null, to: '2026-12-01' });
    expect(parse('after this month')?.range).toMatchObject({ from: '2026-11-01', to: null });
    expect(parse('since last month')?.range).toMatchObject({ from: '2026-09-01', to: null });
    expect(parse('since 3 months ago')?.range).toMatchObject({ from: '2026-07-01', to: null });
    expect(parse('before a few months ago')?.range.to).toBe('2026-06-01');
  });

  it('plain lead-ins (in, during, for, of, on) still mean that month', () => {
    for (const word of ['in', 'during', 'for', 'of', 'on'])
      expect(parse(`${word} June 2027`)?.range).toMatchObject({
        from: '2027-06-01',
        to: '2027-07-01',
      });
  });
});
