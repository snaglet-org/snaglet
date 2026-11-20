/**
 * Weekday phrases in a search ("friday", "on monday", "this friday", "next
 * tuesday", "last wednesday", "this weekend", "next weekend", "last weekend"),
 * turned into a range of days like the day, week and month phrases
 * (dayPhrase.ts, weekPhrase.ts, monthPhrase.ts); the same open-range words work
 * ("before friday", "by monday", "after next tuesday", "since last friday").
 *
 * A bare weekday is its next occurrence, today included ("friday" on a Friday is
 * today). `this` and `next` follow the calendar weeks of weekPhrase.ts (Monday to
 * Sunday): "this friday" is the Friday of this week, "next friday" the Friday of
 * next week. `last friday` is the most recent Friday before today. A weekend is
 * Saturday and Sunday of the week. A bare weekday also finds rows that say its
 * name, like a named month does. The short names (mon, tue, wed, thu, fri, sat,
 * sun) count only after this/next/last, since "sat" and "wed" are also words.
 * Dates are `YYYY-MM-DD` in the user's zone.
 */
import { clean, group, LEAD, type MonthPhrase, type MonthRange } from './monthPhrase';
import { addDays, parseDay, range, short } from './weekPhrase';

const WEEKDAYS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];
const SHORT_NAMES: Record<string, number> = {
  mon: 0,
  tue: 1,
  tues: 1,
  wed: 2,
  thu: 3,
  thur: 3,
  thurs: 3,
  fri: 4,
  sat: 5,
  sun: 6,
};
const FULL = WEEKDAYS.join('|');
const SHORTS = Object.keys(SHORT_NAMES).join('|');

/** Monday-based index (0 Monday .. 6 Sunday) of a written weekday name. */
function weekdayIndex(word: string): number {
  const lower = word.toLowerCase();
  const full = WEEKDAYS.indexOf(lower);
  return full >= 0 ? full : (SHORT_NAMES[lower] ?? -1);
}

const monday = (day: string) => addDays(day, -((parseDay(day).getUTCDay() + 6) % 7));
const todayIndex = (day: string) => (parseDay(day).getUTCDay() + 6) % 7;

/** The weekday phrase in `query` (today is `YYYY-MM-DD`), or null. Only the first counts. */
export function parseWeekdayPhrase(query: string, today: string): MonthPhrase | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(today)) return null;
  const result = (found: RegExpExecArray, found_range: MonthRange): MonthPhrase => ({
    range: found_range,
    residual: clean(query, found[0]),
    matched: found[0],
  });

  // this / next / last weekend
  const weekend = new RegExp(
    `\\b${LEAD}(?<word>this|next|last|previous|coming)\\s+weekend\\b`,
    'i'
  ).exec(query);
  if (weekend) {
    const word = group(weekend, 'word').toLowerCase();
    const offset = word === 'next' || word === 'coming' ? 1 : word === 'this' ? 0 : -1;
    const saturday = addDays(monday(today), 5 + 7 * offset);
    const label = `${word === 'previous' ? 'last' : word === 'coming' ? 'next' : word} weekend`;
    return result(
      weekend,
      range(
        saturday,
        addDays(saturday, 2),
        today,
        `${label} (${short(saturday)} to ${short(addDays(saturday, 1))})`,
        weekend.groups?.q
      )
    );
  }

  // a weekday, alone or after this / next / last
  const named = new RegExp(
    `\\b${LEAD}(?:(?<word>this|next|last|previous)\\s+(?<name>${FULL}|${SHORTS})|(?<bare>${FULL}))\\b`,
    'i'
  ).exec(query);
  if (!named) return null;
  const index = weekdayIndex(named.groups?.name ?? group(named, 'bare'));
  if (index < 0) return null;
  const word = named.groups?.word?.toLowerCase();

  let day: string;
  if (word === 'this') day = addDays(monday(today), index);
  else if (word === 'next') day = addDays(monday(today), index + 7);
  else if (word === 'last' || word === 'previous')
    day = addDays(today, -((todayIndex(today) - index + 7) % 7 || 7));
  else day = addDays(today, (index - todayIndex(today) + 7) % 7);

  const label = `${word ? `${word === 'previous' ? 'last' : word} ` : ''}${WEEKDAYS[index]}`;
  const found_range = range(
    day,
    addDays(day, 1),
    today,
    `${label} (${short(day)})`,
    named.groups?.q
  );
  // A plain "friday" also finds rows that say so, like a named month.
  if (!word && !named.groups?.q) found_range.monthName = WEEKDAYS[index] ?? null;
  return result(named, found_range);
}
