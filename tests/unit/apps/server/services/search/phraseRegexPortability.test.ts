/**
 * The packaged desktop app runs Node 22, which rejects a named group used twice in one
 * pattern ("Duplicate capture group name"); Node 24 accepts it, so a plain parse test passes in
 * dev. This records every pattern the phrase parsers build and fails on a repeated group name.
 */
import { afterEach, describe, expect, it } from '@jest/globals';
import { parseDayPhrase } from '@server/services/search/dayPhrase';
import { parseMonthPhrase } from '@server/services/search/monthPhrase';
import { parseWeekPhrase } from '@server/services/search/weekPhrase';
import { parseWeekdayPhrase } from '@server/services/search/weekdayPhrase';
import { parseYearPhrase } from '@server/services/search/yearPhrase';

const TODAY = '2026-10-21';
const QUERIES = [
  'in 3 days',
  '3 days from now',
  '2 days ago',
  'the next 5 days',
  'in 2 weeks',
  '2 weeks ago',
  'the last 3 weeks',
  'in 2 years',
  '2 years from now',
  '3 years ago',
  'the next 2 years',
  'in 2 months',
  '3 months ago',
  'in a few days',
  'watched-changes delivery',
];

const RealRegExp = RegExp;
const seen: string[] = [];

function record() {
  const Recording = new Proxy(RealRegExp, {
    construct(target, args) {
      seen.push(String(args[0] instanceof RealRegExp ? args[0].source : args[0]));
      return Reflect.construct(target, args);
    },
  });
  (globalThis as { RegExp: RegExpConstructor }).RegExp = Recording;
}

afterEach(() => {
  (globalThis as { RegExp: RegExpConstructor }).RegExp = RealRegExp;
  seen.length = 0;
});

describe('phrase regexes stay valid on Node 22', () => {
  it('no pattern a parser builds repeats a named group', () => {
    record();
    for (const q of QUERIES) {
      parseDayPhrase(q, TODAY);
      parseWeekPhrase(q, TODAY);
      parseMonthPhrase(q, TODAY);
      parseYearPhrase(q, TODAY);
      parseWeekdayPhrase(q, TODAY);
    }
    const built = [...seen];
    (globalThis as { RegExp: RegExpConstructor }).RegExp = RealRegExp;
    expect(built.length).toBeGreaterThan(20);
    const repeated = built.filter((source) => {
      const names = [...source.matchAll(/\(\?<([A-Za-z_]\w*)>/g)].map((m) => m[1]);
      return new Set(names).size !== names.length;
    });
    expect(repeated).toEqual([]);
  });
});

describe('forward counts still parse', () => {
  const span = (q: string, parse: (q: string, t: string) => ReturnType<typeof parseDayPhrase>) => {
    const r = parse(q, TODAY)?.range;
    return r && [r.from, r.to];
  };
  it('days', () => {
    expect(span('in 3 days', parseDayPhrase)).toEqual(['2026-10-24', '2026-10-25']);
    expect(span('3 days from now', parseDayPhrase)).toEqual(['2026-10-24', '2026-10-25']);
  });
  it('years', () => {
    expect(span('in 2 years', parseYearPhrase)).toEqual(span('2 years from now', parseYearPhrase));
    expect(parseYearPhrase('in 2 years', TODAY)?.range.label).toContain('2 years from now');
  });
});
