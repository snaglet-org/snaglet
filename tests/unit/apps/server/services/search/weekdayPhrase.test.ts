/** Weekday phrases in an entry search, with today fixed at Wednesday 2026-10-21 (this week is Mon 2026-10-19 to Sun 2026-10-25). */
import { describe, expect, it } from '@jest/globals';
import { parseTimePhrase } from '@server/services/search/timePhrase';
import { parseWeekdayPhrase } from '@server/services/search/weekdayPhrase';

const TODAY = '2026-10-21';
const parse = (query: string, today = TODAY) => parseWeekdayPhrase(query, today);
const bounds = (query: string) => {
  const range = parse(query)?.range;
  return range && [range.from, range.to];
};

describe('a bare weekday', () => {
  it('is its next occurrence, today included', () => {
    expect(bounds('due friday')).toEqual(['2026-10-23', '2026-10-24']);
    expect(bounds('Wednesday')).toEqual(['2026-10-21', '2026-10-22']);
    expect(bounds('monday')).toEqual(['2026-10-26', '2026-10-27']);
    expect(bounds('on Sunday')).toEqual(['2026-10-25', '2026-10-26']);
    expect(parse('friday')?.range.direction).toBe('future');
    expect(parse('wednesday')?.range.direction).toBe('current');
  });

  it('also finds rows that say its name, but not once it is qualified', () => {
    expect(parse('friday')?.range.monthName).toBe('friday');
    expect(parse('this friday')?.range.monthName).toBeNull();
    expect(parse('before friday')?.range.monthName).toBeNull();
  });

  it('removes the phrase and its lead-in from the query', () => {
    expect(parse('tasks due on friday')?.residual).toBe('tasks due');
  });
});

describe('this, next and last', () => {
  it('this and next follow the Monday to Sunday calendar weeks', () => {
    expect(bounds('this friday')).toEqual(['2026-10-23', '2026-10-24']);
    expect(bounds('this monday')).toEqual(['2026-10-19', '2026-10-20']);
    expect(bounds('next friday')).toEqual(['2026-10-30', '2026-10-31']);
    expect(bounds('next monday')).toEqual(['2026-10-26', '2026-10-27']);
    expect(parse('this monday')?.range.direction).toBe('past');
  });

  it('last is the most recent one before today', () => {
    expect(bounds('last friday')).toEqual(['2026-10-16', '2026-10-17']);
    expect(bounds('last wednesday')).toEqual(['2026-10-14', '2026-10-15']);
    expect(bounds('last monday')).toEqual(['2026-10-19', '2026-10-20']);
    expect(bounds('previous tuesday')).toEqual(['2026-10-20', '2026-10-21']);
    expect(parse('last friday')?.range.label).toBe('last friday (Oct 16)');
  });

  it('short names count only after this, next or last', () => {
    expect(bounds('this fri')).toEqual(['2026-10-23', '2026-10-24']);
    expect(bounds('next thurs')).toEqual(['2026-10-29', '2026-10-30']);
    expect(parse('fri')).toBeNull();
    expect(parse('we sat down and wed')).toBeNull();
    expect(parse('sun')).toBeNull();
  });

  it('weekends are Saturday and Sunday of the week', () => {
    expect(bounds('this weekend')).toEqual(['2026-10-24', '2026-10-26']);
    expect(bounds('next weekend')).toEqual(['2026-10-31', '2026-11-02']);
    expect(bounds('last weekend')).toEqual(['2026-10-17', '2026-10-19']);
    expect(parse('weekend')).toBeNull();
  });
});

describe('qualifiers', () => {
  it('before, until, by, after and since open one end', () => {
    expect(parse('before friday')?.range).toMatchObject({ from: null, to: '2026-10-23' });
    expect(parse('by friday')?.range).toMatchObject({ from: null, to: '2026-10-24' });
    expect(parse('after friday')?.range).toMatchObject({ from: '2026-10-24', to: null });
    expect(parse('since last friday')?.range).toMatchObject({ from: '2026-10-16', to: null });
    expect(parse('before next weekend')?.range).toMatchObject({ from: null, to: '2026-10-31' });
  });
});

describe('with other phrases', () => {
  it('the phrase written first wins', () => {
    expect(parseTimePhrase('tomorrow or friday', TODAY)?.range).toMatchObject({
      from: '2026-10-22',
    });
    expect(parseTimePhrase('friday or tomorrow', TODAY)?.range).toMatchObject({
      from: '2026-10-23',
    });
    expect(parseTimePhrase('due next friday', TODAY)?.range).toMatchObject({ from: '2026-10-30' });
    expect(parseTimePhrase('next week', TODAY)?.range).toMatchObject({ from: '2026-10-26' });
  });
});
