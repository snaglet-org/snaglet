/** Day phrases in an entry search, with today fixed at Wednesday 2026-10-21. */
import { describe, expect, it } from '@jest/globals';
import { parseDayPhrase } from '@server/services/search/dayPhrase';
import { parseTimePhrase } from '@server/services/search/timePhrase';

const TODAY = '2026-10-21';
const parse = (query: string, today = TODAY) => parseDayPhrase(query, today);
const bounds = (query: string) => {
  const range = parse(query)?.range;
  return range && [range.from, range.to];
};

describe('named days', () => {
  it('today, tomorrow, yesterday', () => {
    expect(bounds('due today')).toEqual(['2026-10-21', '2026-10-22']);
    expect(bounds('tonight')).toEqual(['2026-10-21', '2026-10-22']);
    expect(bounds('tomorrow')).toEqual(['2026-10-22', '2026-10-23']);
    expect(bounds('yesterday')).toEqual(['2026-10-20', '2026-10-21']);
    expect(parse('today')?.range.direction).toBe('current');
    expect(parse('tomorrow')?.range.direction).toBe('future');
    expect(parse('yesterday')?.range.direction).toBe('past');
  });

  it('removes the phrase and its lead-in from the query', () => {
    expect(parse('tasks due tomorrow')?.residual).toBe('tasks due');
    expect(parse('tasks on yesterday')?.residual).toBe('tasks');
  });

  it('is not fooled by words that merely contain a day word', () => {
    expect(parse('todays plans')).toBeNull();
    expect(parse('birthday party')).toBeNull();
  });
});

describe('counted days', () => {
  it('N days ago and in N days', () => {
    expect(bounds('3 days ago')).toEqual(['2026-10-18', '2026-10-19']);
    expect(bounds('a day ago')).toEqual(['2026-10-20', '2026-10-21']);
    expect(bounds('two days ago')).toEqual(['2026-10-19', '2026-10-20']);
    expect(bounds('in 2 days')).toEqual(['2026-10-23', '2026-10-24']);
    expect(bounds('5 days from now')).toEqual(['2026-10-26', '2026-10-27']);
  });

  it('a few days ago is 2 to 4 days back, and in a few days 2 to 4 ahead', () => {
    expect(bounds('a few days ago')).toEqual(['2026-10-17', '2026-10-20']);
    expect(bounds('a couple of days ago')).toEqual(['2026-10-19', '2026-10-20']);
    expect(bounds('in a few days')).toEqual(['2026-10-23', '2026-10-26']);
    expect(bounds('in a couple of days')).toEqual(['2026-10-23', '2026-10-24']);
  });

  it('rolling windows include today', () => {
    expect(bounds('the next 5 days')).toEqual(['2026-10-21', '2026-10-26']);
    expect(bounds('over the past 3 days')).toEqual(['2026-10-18', '2026-10-22']);
    expect(bounds('the last day')).toEqual(['2026-10-20', '2026-10-22']);
  });
});

describe('written dates', () => {
  it('month and day, either order, with or without a year', () => {
    expect(bounds('due June 20')).toEqual(['2026-06-20', '2026-06-21']);
    expect(bounds('october 25th')).toEqual(['2026-10-25', '2026-10-26']);
    expect(bounds('25 Oct')).toEqual(['2026-10-25', '2026-10-26']);
    expect(bounds('the 3rd of November')).toEqual(['2026-11-03', '2026-11-04']);
    expect(bounds('Jun 20, 2026')).toEqual(['2026-06-20', '2026-06-21']);
  });

  it('picks the occurrence nearest today and refuses impossible dates', () => {
    expect(bounds('Sept 30')).toEqual(['2026-09-30', '2026-10-01']);
    expect(bounds('january 2')).toEqual(['2027-01-02', '2027-01-03']);
    expect(parse('feb 30')).toBeNull();
    expect(parse('june 2026 notes')).toBeNull();
  });
});

describe('qualifiers', () => {
  it('before, until, by, after and since open one end', () => {
    expect(parse('before tomorrow')?.range).toMatchObject({ from: null, to: '2026-10-22' });
    expect(parse('by tomorrow')?.range).toMatchObject({ from: null, to: '2026-10-23' });
    expect(parse('after today')?.range).toMatchObject({ from: '2026-10-22', to: null });
    expect(parse('since yesterday')?.range).toMatchObject({ from: '2026-10-20', to: null });
    expect(parse('by June 20')?.range).toMatchObject({ from: null, to: '2026-06-21' });
  });
});

describe('with weeks and months', () => {
  it('the written date wins over its month, the earlier phrase wins otherwise', () => {
    expect(parseTimePhrase('due June 20', TODAY)?.range).toMatchObject({ from: '2026-06-20' });
    expect(parseTimePhrase('due in June', TODAY)?.range).toMatchObject({ from: '2026-06-01' });
    expect(parseTimePhrase('this week and tomorrow', TODAY)?.range).toMatchObject({
      from: '2026-10-19',
    });
    expect(parseTimePhrase('tomorrow or next week', TODAY)?.range).toMatchObject({
      from: '2026-10-22',
    });
  });
});
