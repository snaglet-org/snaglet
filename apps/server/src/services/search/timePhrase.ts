/**
 * Time phrases in a search: day phrases (dayPhrase.ts), weekday phrases
 * (weekdayPhrase.ts), week phrases
 * (weekPhrase.ts), month phrases (monthPhrase.ts) and year phrases (yearPhrase.ts). When a query has more
 * than one ("due next week in June"), the one written first is used; when
 * two overlap on the same words ("June 20" is both a day and the month June,
 * "in June 2027" a month and the year 2027),
 * the narrower one wins.
 */
import { parseDayPhrase } from './dayPhrase';
import { parseMonthPhrase, type MonthPhrase } from './monthPhrase';
import { parseWeekdayPhrase } from './weekdayPhrase';
import { parseWeekPhrase } from './weekPhrase';
import { parseYearPhrase } from './yearPhrase';

export function parseTimePhrase(query: string, today: string): MonthPhrase | null {
  // Narrowest first, so a tie on overlapping words goes to the more specific phrase.
  const found = [
    parseDayPhrase(query, today),
    parseWeekdayPhrase(query, today),
    parseWeekPhrase(query, today),
    parseMonthPhrase(query, today),
    parseYearPhrase(query, today),
  ].filter((phrase): phrase is MonthPhrase => phrase !== null);
  const span = (phrase: MonthPhrase) => {
    const start = query.indexOf(phrase.matched);
    return { start, end: start + phrase.matched.length };
  };
  let best: MonthPhrase | null = null;
  for (const phrase of found) {
    if (!best) {
      best = phrase;
      continue;
    }
    const a = span(best);
    const b = span(phrase);
    const overlap = b.start < a.end && a.start < b.end;
    if (!overlap && b.start < a.start) best = phrase;
  }
  return best;
}
