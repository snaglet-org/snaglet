/**
 * Year phrases in a search ("this year", "next year", "last year", "a few years
 * ago", "3 years ago", "in 2 years", "in a few years", "the next 2 years", "the
 * past year", "in 2025"), turned into a range of days like the day, week and
 * month phrases (dayPhrase.ts, weekPhrase.ts, monthPhrase.ts); the same
 * open-range words work ("before next year", "since last year", "by 2027").
 *
 * A year is a calendar year (January to December). `last year`, `this year`,
 * `3 years ago` and `in 2 years` are calendar years; "a few years ago" is 2 to 4
 * years back and "in a few years" 2 to 4 ahead; "the next 2 years" and "the past
 * year" are rolling windows counted from today. A bare year ("2025") counts only
 * after a lead-in word ("in 2025", "since 2023") so a number in a title is left
 * alone. Dates are `YYYY-MM-DD` in the user's zone.
 */
import { clean, group, LEAD, type MonthPhrase, type MonthRange } from './monthPhrase';
import { addDays, COUNT, countGroup, countOf, range } from './weekPhrase';

const MIN_YEAR = 1900;
const MAX_YEAR = 2200;

const jan = (year: number) => `${String(year).padStart(4, '0')}-01-01`;

/** `day` moved by whole years (29 February lands on 1 March in a common year). */
function addYears(day: string, years: number): string {
  const [y, m, d] = day.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y + years, m - 1, d)).toISOString().slice(0, 10);
}

/** The year phrase in `query` (today is `YYYY-MM-DD`), or null. Only the first counts. */
export function parseYearPhrase(query: string, today: string): MonthPhrase | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(today)) return null;
  const thisYear = Number(today.slice(0, 4));
  const result = (found: RegExpExecArray, found_range: MonthRange): MonthPhrase => ({
    range: found_range,
    residual: clean(query, found[0]),
    matched: found[0],
  });
  const yearRange = (first: number, count: number, label: string, q?: string) => {
    if (first < MIN_YEAR || first + count > MAX_YEAR) return null;
    const from = jan(first);
    const to = jan(first + count);
    const years = count === 1 ? `${first}` : `${first} to ${first + count - 1}`;
    return range(from, to, today, `${label} (${years})`, q);
  };

  // the next / past N years: a rolling window from today ("in the next 2 years", "over the last 3 years", "the past year")
  const rolling = new RegExp(
    `\\b(?:(?:in|over|during|within|for)\\s+)?(?:the\\s+)?(?<dir>next|coming|following|last|past)\\s+(?:${COUNT}\\s+)?years?\\b`,
    'i'
  ).exec(query);
  if (rolling) {
    const dir = group(rolling, 'dir').toLowerCase();
    const counted = Boolean(rolling.groups?.n);
    const article = /\bthe\s+(?:next|coming|following|last|past)/i.test(rolling[0]);
    const future = dir === 'next' || dir === 'coming' || dir === 'following';
    // "last year" / "next year" alone are calendar years (handled below); a count or "the" makes a window
    const plainYear = !counted && !article && (dir === 'last' || dir === 'next');
    if (!plainYear) {
      const n = counted ? countOf(group(rolling, 'n')) : 1;
      if (n >= 1 && n <= 100) {
        const label = `${future ? 'the next' : 'the past'} ${n === 1 ? 'year' : `${n} years`}`;
        const from = future ? today : addYears(today, -n);
        const to = future ? addYears(today, n) : addDays(today, 1);
        return result(rolling, range(from, to, today, `${label} (${from} to ${addDays(to, -1)})`));
      }
    }
  }

  // this / next / last year: a calendar year
  const relative = new RegExp(
    `\\b${LEAD}(?<word>this|current|next|last|previous)\\s+year\\b`,
    'i'
  ).exec(query);
  if (relative) {
    const word = group(relative, 'word').toLowerCase();
    const offset = word === 'next' ? 1 : word === 'this' || word === 'current' ? 0 : -1;
    const phrase = word === 'previous' ? 'last' : word === 'current' ? 'this' : word;
    const found = yearRange(thisYear + offset, 1, `${phrase} year`, relative.groups?.q);
    if (found) return result(relative, found);
  }

  // "a few years ago" (2 to 4 years back), "a couple of years ago" (2), "in a few years" (2 to 4 ahead)
  const few = new RegExp(
    `\\b(?:${LEAD}(?:a\\s+)?(?<few>few|couple(?:\\s+of)?|several)\\s+years?\\s+ago|in\\s+(?:a\\s+)?(?<fewAhead>few|couple(?:\\s+of)?|several)\\s+years?)\\b`,
    'i'
  ).exec(query);
  if (few) {
    const ahead = Boolean(few.groups?.fewAhead);
    const couple = /couple/i.test(few.groups?.few ?? group(few, 'fewAhead'));
    const first = ahead ? thisYear + 2 : thisYear - (couple ? 2 : 4);
    const found = yearRange(
      first,
      couple ? 1 : 3,
      `${couple ? 'a couple of' : 'a few'} years ${ahead ? 'from now' : 'ago'}`,
      ahead ? undefined : few.groups?.q
    );
    if (found) return result(few, found);
  }

  // "N years ago", "a year ago", "in N years", "N years from now"
  const ago = new RegExp(`\\b${LEAD}${COUNT}\\s+years?\\s+ago\\b`, 'i').exec(query);
  const ahead = new RegExp(
    `\\b(?:in\\s+${COUNT}\\s+years?(?!\\s+ago)|${countGroup('n2')}\\s+years?\\s+from\\s+now)\\b`,
    'i'
  ).exec(query);
  const counted = ago ?? ahead;
  if (counted) {
    const n = countOf(counted.groups?.n ?? group(counted, 'n2'));
    if (n >= 1 && n <= 100) {
      const found = yearRange(
        thisYear + (ago ? -n : n),
        1,
        `${n} year${n === 1 ? '' : 's'} ${ago ? 'ago' : 'from now'}`,
        ago?.groups?.q
      );
      if (found) return result(counted, found);
    }
  }

  // a written year after a lead-in: "in 2025", "since 2023", "by 2027"
  const written = new RegExp(
    `\\b(?:(?<q>before|after|until|till|by|since)|in|during|for|of|from)\\s+(?<year>\\d{4})\\b(?!-\\d)`,
    'i'
  ).exec(query);
  if (written) {
    const year = Number(group(written, 'year'));
    const found = yearRange(year, 1, `${year}`, written.groups?.q);
    if (found) return result(written, found);
  }
  return null;
}
