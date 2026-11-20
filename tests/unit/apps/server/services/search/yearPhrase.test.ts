/** Year phrases in an entry search, with today fixed at Wednesday 2026-10-21. */
import { describe, expect, it } from '@jest/globals';
import { parseTimePhrase } from '@server/services/search/timePhrase';
import { parseYearPhrase } from '@server/services/search/yearPhrase';

const TODAY = '2026-10-21';
const parse = (query: string, today = TODAY) => parseYearPhrase(query, today);
const bounds = (query: string) => {
  const range = parse(query)?.range;
  return range && [range.from, range.to];
};

describe('calendar years', () => {
  it('this, next and last year', () => {
    expect(bounds('due this year')).toEqual(['2026-01-01', '2027-01-01']);
    expect(bounds('next year')).toEqual(['2027-01-01', '2028-01-01']);
    expect(bounds('last year')).toEqual(['2025-01-01', '2026-01-01']);
    expect(bounds('previous year')).toEqual(['2025-01-01', '2026-01-01']);
    expect(bounds('current year')).toEqual(['2026-01-01', '2027-01-01']);
    expect(parse('this year')?.range.direction).toBe('current');
    expect(parse('next year')?.range.direction).toBe('future');
    expect(parse('last year')?.range.direction).toBe('past');
    expect(parse('last year')?.range.label).toBe('last year (2025)');
  });

  it('N years ago and in N years', () => {
    expect(bounds('3 years ago')).toEqual(['2023-01-01', '2024-01-01']);
    expect(bounds('a year ago')).toEqual(['2025-01-01', '2026-01-01']);
    expect(bounds('two years ago')).toEqual(['2024-01-01', '2025-01-01']);
    expect(bounds('in 2 years')).toEqual(['2028-01-01', '2029-01-01']);
    expect(bounds('5 years from now')).toEqual(['2031-01-01', '2032-01-01']);
  });

  it('a few years ago is 2 to 4 back, and in a few years 2 to 4 ahead', () => {
    expect(bounds('a few years ago')).toEqual(['2022-01-01', '2025-01-01']);
    expect(bounds('a couple of years ago')).toEqual(['2024-01-01', '2025-01-01']);
    expect(bounds('in a few years')).toEqual(['2028-01-01', '2031-01-01']);
    expect(bounds('in a couple of years')).toEqual(['2028-01-01', '2029-01-01']);
  });
});

describe('rolling windows and written years', () => {
  it('the next and past N years count from today', () => {
    expect(bounds('the next 2 years')).toEqual(['2026-10-21', '2028-10-21']);
    expect(bounds('over the past 3 years')).toEqual(['2023-10-21', '2026-10-22']);
    expect(bounds('the past year')).toEqual(['2025-10-21', '2026-10-22']);
  });

  it('a year after a lead-in word; a bare number is left alone', () => {
    expect(bounds('in 2025')).toEqual(['2025-01-01', '2026-01-01']);
    expect(bounds('due during 2027')).toEqual(['2027-01-01', '2028-01-01']);
    expect(parse('budget 2025 plan')).toBeNull();
    expect(parse('room 1999 key')).toBeNull();
    expect(parse('in 2025-06-01')).toBeNull();
    expect(parse('in 3000')).toBeNull();
  });

  it('removes the phrase and its lead-in from the query', () => {
    expect(parse('tasks due last year')?.residual).toBe('tasks due');
  });
});

describe('qualifiers', () => {
  it('before, until, by, after and since open one end', () => {
    expect(parse('before next year')?.range).toMatchObject({ from: null, to: '2027-01-01' });
    expect(parse('by next year')?.range).toMatchObject({ from: null, to: '2028-01-01' });
    expect(parse('after this year')?.range).toMatchObject({ from: '2027-01-01', to: null });
    expect(parse('since last year')?.range).toMatchObject({ from: '2025-01-01', to: null });
    expect(parse('since 2023')?.range).toMatchObject({ from: '2023-01-01', to: null });
    expect(parse('before 2020')?.range).toMatchObject({ from: null, to: '2020-01-01' });
  });
});

describe('with other phrases', () => {
  it('a month with a year stays a month; the earlier phrase wins otherwise', () => {
    expect(parseTimePhrase('due in June 2027', TODAY)?.range).toMatchObject({ from: '2027-06-01' });
    expect(parseTimePhrase('due June 20 2025', TODAY)?.range).toMatchObject({ from: '2025-06-20' });
    expect(parseTimePhrase('last year or next week', TODAY)?.range).toMatchObject({
      from: '2025-01-01',
    });
    expect(parseTimePhrase('next week or last year', TODAY)?.range).toMatchObject({
      from: '2026-10-26',
    });
  });
});
