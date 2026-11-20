/**
 * Week phrases in a search ("this week", "next week", "last week", "a few weeks
 * ago", "3 weeks ago", "in 2 weeks", "in the next 2 weeks", "the past week"),
 * turned into a range of days like the month phrases (monthPhrase.ts): the
 * same open-range words work ("before next week", "since last week", "by next
 * week", "after this week").
 *
 * A calendar week runs Monday to Sunday. `last week`, `this week` and `next
 * week` are calendar weeks; "the next 2 weeks" and "the past week" are rolling
 * windows counted from today. Dates are `YYYY-MM-DD` in the user's zone.
 */
import { clean, group, LEAD, NUMBER_WORDS, type MonthPhrase, type MonthRange } from './monthPhrase';

const DAY_MS = 24 * 60 * 60 * 1000;
const MONTH_SHORT = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
];

export function parseDay(day: string): Date {
  const [y, m, d] = day.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d));
}

function format(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export function addDays(day: string, days: number): string {
  return format(new Date(parseDay(day).getTime() + days * DAY_MS));
}

/** The Monday on or before `day`. */
function weekStart(day: string): string {
  const date = parseDay(day);
  return addDays(day, -((date.getUTCDay() + 6) % 7));
}

export function short(day: string): string {
  const date = parseDay(day);
  return `${MONTH_SHORT[date.getUTCMonth()]} ${date.getUTCDate()}`;
}

/** "Oct 19 to Oct 25": the days of a range whose `to` is exclusive. */
function span(from: string, to: string): string {
  return `${short(from)} to ${short(addDays(to, -1))}`;
}

const BEFORE = new Set(['before', 'until', 'till']);

/**
 * `[from, to)` as a range; a qualifier opens one end the way it does for months:
 * before/until/till end it where the span starts, by at the span's end, after
 * starts where the span ends, since where it starts.
 */
export function range(
  from: string,
  to: string,
  today: string,
  label: string,
  qualifier?: string
): MonthRange {
  const q = qualifier?.toLowerCase();
  const direction: MonthRange['direction'] =
    to <= today ? 'past' : from > today ? 'future' : 'current';
  if (!q) return { from, to, label, monthName: null, direction };
  const word = q === 'till' ? 'until' : q;
  if (BEFORE.has(q))
    return { from: null, to: from, label: `${word} ${label}`, monthName: null, direction: 'past' };
  if (q === 'by')
    return { from: null, to, label: `by ${label}`, monthName: null, direction: 'past' };
  if (q === 'after')
    return { from: to, to: null, label: `after ${label}`, monthName: null, direction: 'future' };
  return { from, to: null, label: `${word} ${label}`, monthName: null, direction: 'future' };
}

/** A count as digits or words, captured as `name`. A pattern may not reuse a name: Node 22 throws. */
export const countGroup = (name: string): string =>
  `(?<${name}>\\d{1,2}|a|an|${Object.keys(NUMBER_WORDS).join('|')})`;
export const COUNT = countGroup('n');

export function countOf(raw: string): number {
  const word = raw.toLowerCase();
  return word === 'a' || word === 'an' ? 1 : (NUMBER_WORDS[word] ?? Number(word));
}

/** The week phrase in `query` (today is `YYYY-MM-DD`), or null. Only the first counts. */
export function parseWeekPhrase(query: string, today: string): MonthPhrase | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(today)) return null;
  const monday = weekStart(today);
  const result = (found: RegExpExecArray, range: MonthRange): MonthPhrase => ({
    range,
    residual: clean(query, found[0]),
    matched: found[0],
  });
  const weekRange = (offset: number, count: number, label: string, q?: string) => {
    const from = addDays(monday, 7 * offset);
    const to = addDays(from, 7 * count);
    return range(from, to, today, `${label} (${span(from, to)})`, q);
  };

  // the next / past N weeks: a rolling window from today ("in the next 2 weeks", "over the last 3 weeks", "the past week")
  const rolling = new RegExp(
    `\\b(?:(?:in|over|during|within|for)\\s+)?(?:the\\s+)?(?<dir>next|coming|following|last|past)\\s+(?:${COUNT}\\s+)?weeks?\\b`,
    'i'
  ).exec(query);
  if (rolling) {
    const dir = group(rolling, 'dir').toLowerCase();
    const counted = Boolean(rolling.groups?.n);
    const article = /\bthe\s+(?:next|coming|following|last|past)/i.test(rolling[0]);
    const future = dir === 'next' || dir === 'coming' || dir === 'following';
    // "last week" / "next week" alone are calendar weeks (handled below); a count or "the" makes a window
    const plainWeek = !counted && !article && (dir === 'last' || dir === 'next');
    if (!plainWeek) {
      const n = counted ? countOf(group(rolling, 'n')) : 1;
      if (n >= 1 && n <= 52) {
        const label = `${future ? 'the next' : 'the past'} ${n === 1 ? 'week' : `${n} weeks`}`;
        return result(
          rolling,
          future
            ? range(
                today,
                addDays(today, 7 * n),
                today,
                `${label} (${span(today, addDays(today, 7 * n))})`
              )
            : range(
                addDays(today, -7 * n),
                addDays(today, 1),
                today,
                `${label} (${span(addDays(today, -7 * n), addDays(today, 1))})`
              )
        );
      }
    }
  }

  // this / next / last week: a calendar week
  const relative = new RegExp(
    `\\b${LEAD}(?<word>this|current|next|last|previous)\\s+week\\b`,
    'i'
  ).exec(query);
  if (relative) {
    const word = group(relative, 'word').toLowerCase();
    const offset = word === 'next' ? 1 : word === 'this' || word === 'current' ? 0 : -1;
    const phrase = word === 'previous' ? 'last' : word === 'current' ? 'this' : word;
    return result(relative, weekRange(offset, 1, `${phrase} week`, relative.groups?.q));
  }

  // "a few weeks ago" (2 to 4 weeks back), "a couple of weeks ago" (2)
  const few = new RegExp(
    `\\b${LEAD}(?:a\\s+)?(?<few>few|couple(?:\\s+of)?|several)\\s+weeks?\\s+ago\\b`,
    'i'
  ).exec(query);
  if (few) {
    const couple = /couple/i.test(group(few, 'few'));
    return result(
      few,
      couple
        ? weekRange(-2, 1, 'a couple of weeks ago', few.groups?.q)
        : weekRange(-4, 3, 'a few weeks ago', few.groups?.q)
    );
  }

  // "N weeks ago", "a week ago", "in N weeks"
  const ago = new RegExp(`\\b${LEAD}${COUNT}\\s+weeks?\\s+ago\\b`, 'i').exec(query);
  const ahead = new RegExp(`\\bin\\s+${COUNT}\\s+weeks?\\b(?!\\s+ago)`, 'i').exec(query);
  const counted = ago ?? ahead;
  if (counted) {
    const n = countOf(group(counted, 'n'));
    if (n >= 1 && n <= 52)
      return result(
        counted,
        weekRange(
          ago ? -n : n,
          1,
          `${n} week${n === 1 ? '' : 's'} ${ago ? 'ago' : 'from now'}`,
          ago?.groups?.q
        )
      );
  }
  return null;
}
