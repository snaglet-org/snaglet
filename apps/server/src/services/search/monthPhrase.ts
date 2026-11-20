/**
 * Month phrases in a search ("next month", "this month", "last month",
 * "a few months ago", "2 months ago", "in 3 months", "in June", "June 2027",
 * "last June"), turned into a range of days. Deterministic, no model: the
 * entry search uses it to filter rows by a date field and, for a named month,
 * to still find rows whose text says the month's name.
 *
 * All dates are calendar days in the user's time zone, `YYYY-MM-DD`; `to` is
 * the first day after the range. Words that make an open range ("before June",
 * "after June", "until June", "by June", "since March") leave one
 * end null: they are not "during that month".
 */

export interface MonthRange {
  /** First day of the range; null when it has no start ("before June"). */
  from: string | null;
  /** First day after the range (exclusive); null when it has no end ("after June"). */
  to: string | null;
  /** For people: "June 2026", "next month (November 2026)". */
  label: string;
  /** A named month ("June") can also be matched in text; a relative one cannot. */
  monthName: string | null;
  /** Which way the range lies from today: soonest-first is natural for the future, newest-first for the past. */
  direction: 'past' | 'current' | 'future';
}

export interface MonthPhrase {
  range: MonthRange;
  /** The query with the phrase (and a "due"-style lead-in such as "in") removed. */
  residual: string;
  /** The phrase as it was written. */
  matched: string;
}

const MONTHS = [
  'january',
  'february',
  'march',
  'april',
  'may',
  'june',
  'july',
  'august',
  'september',
  'october',
  'november',
  'december',
] as const;

const MONTH_ALIASES: Record<string, number> = {
  ...Object.fromEntries(MONTHS.map((name, index) => [name, index])),
  jan: 0,
  feb: 1,
  mar: 2,
  apr: 3,
  jun: 5,
  jul: 6,
  aug: 7,
  sep: 8,
  sept: 8,
  oct: 9,
  nov: 10,
  dec: 11,
};

export const NUMBER_WORDS: Record<string, number> = {
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12,
};

const MONTH_NAME = Object.keys(MONTH_ALIASES)
  .sort((a, b) => b.length - a.length)
  .join('|');
/**
 * Words before a month in ordinary writing. `in`, `during`, `for`, `of`, `on`
 * and `from` just point at it ("emails from June", "something from 6 months
 * ago" mean that month); `before`, `after`, `until`, `till`, `by` and `since`
 * change what is meant (a range with one open end), so they are captured as
 * `q`. `due` is not one of them: it stays in the query as the hint for which
 * date field to use.
 */
export const LEAD = '(?:(?:(?<q>before|after|until|till|by|since)|in|during|for|of|on|from)\\s+)?';
const LEAD_IN = /^(?:in|during|for|of|on|from|before|after|until|till|by|since)\s/i;

/** A named capture the matched alternation always fills; the empty string if it did not. */
export function group(found: RegExpExecArray | RegExpMatchArray, name: string): string {
  return found.groups?.[name] ?? '';
}

interface Day {
  year: number;
  month: number; // 0-11
}

function shift(day: Day, months: number): Day {
  const total = day.year * 12 + day.month + months;
  return { year: Math.floor(total / 12), month: ((total % 12) + 12) % 12 };
}

function iso(day: Day): string {
  return `${String(day.year).padStart(4, '0')}-${String(day.month + 1).padStart(2, '0')}-01`;
}

function title(day: Day): string {
  const name = MONTHS[day.month] ?? '';
  return `${name.charAt(0).toUpperCase()}${name.slice(1)} ${day.year}`;
}

function directionOf(from: Day, to: Day, current: Day): MonthRange['direction'] {
  const index = (d: Day) => d.year * 12 + d.month;
  if (index(to) < index(current)) return 'past';
  if (index(from) > index(current)) return 'future';
  return 'current';
}

const BEFORE = new Set(['before', 'until', 'till']);

/**
 * The days a month phrase means. With no qualifier it is the span itself.
 * before / until / till: everything before the span starts; by: up to the end
 * of the span; after: from the day after it ends; since: from its first
 * day on. A qualified range has no month name to look for in text.
 */
function range(
  from: Day,
  last: Day,
  current: Day,
  label: string,
  monthName: string | null,
  qualifier?: string
): MonthRange {
  const q = qualifier?.toLowerCase();
  if (!q)
    return {
      from: iso(from),
      to: iso(shift(last, 1)),
      label,
      monthName,
      direction: directionOf(from, last, current),
    };
  const words = q === 'till' ? 'until' : q;
  if (BEFORE.has(q))
    return {
      from: null,
      to: iso(from),
      label: `${words} ${label}`,
      monthName: null,
      direction: 'past',
    };
  if (q === 'by')
    return {
      from: null,
      to: iso(shift(last, 1)),
      label: `by ${label}`,
      monthName: null,
      direction: 'past',
    };
  if (q === 'after')
    return {
      from: iso(shift(last, 1)),
      to: null,
      label: `after ${label}`,
      monthName: null,
      direction: 'future',
    };
  return {
    from: iso(from),
    to: null,
    label: `${words} ${label}`,
    monthName: null,
    direction: 'future',
  };
}

export function clean(query: string, matched: string): string {
  return query
    .replace(matched, ' ')
    .replace(/\s+/g, ' ')
    .replace(/^[\s,;:.-]+|[\s,;:.-]+$/g, '')
    .trim();
}

/** The nearest occurrence of `month` to the current month: the one a person most likely means. */
function nearestMonth(month: number, current: Day): Day {
  const candidates = [-1, 0, 1].map((offset) => ({ year: current.year + offset, month }));
  const index = (d: Day) => d.year * 12 + d.month;
  return (
    candidates.sort(
      (a, b) =>
        Math.abs(index(a) - index(current)) - Math.abs(index(b) - index(current)) ||
        index(b) - index(a) // a tie goes to the upcoming one
    )[0] ?? current
  );
}

/**
 * The month phrase in `query`, or null. `today` is the user's current day
 * (`YYYY-MM-DD`). Only the first phrase counts. "may" is only a month when it
 * is capitalized or follows a lead-in word ("in may"), since it is also a verb.
 */
export function parseMonthPhrase(query: string, today: string): MonthPhrase | null {
  const [y, m] = today.split('-').map(Number);
  if (!y || !m) return null;
  const current: Day = { year: y, month: m - 1 };
  const index = (d: Day) => d.year * 12 + d.month;
  const result = (found: RegExpExecArray, range: MonthRange): MonthPhrase => ({
    range,
    residual: clean(query, found[0]),
    matched: found[0],
  });

  // this / next / last month
  const relative = new RegExp(
    `\\b${LEAD}(?<word>this|current|next|last|previous|past)\\s+month\\b`,
    'i'
  ).exec(query);
  if (relative) {
    const word = group(relative, 'word').toLowerCase();
    const offset = word === 'next' ? 1 : word === 'this' || word === 'current' ? 0 : -1;
    const day = shift(current, offset);
    const phrase =
      word === 'previous' || word === 'past' ? 'last' : word === 'current' ? 'this' : word;
    return result(
      relative,
      range(day, day, current, `${phrase} month (${title(day)})`, null, relative.groups?.q)
    );
  }

  // "a few months ago" (2 to 4 months back), "a couple of months ago" (2)
  const few = new RegExp(
    `\\b${LEAD}(?:a\\s+)?(?<few>few|couple(?:\\s+of)?|several)\\s+months?\\s+ago\\b`,
    'i'
  ).exec(query);
  if (few) {
    const couple = /couple/i.test(group(few, 'few'));
    const from = shift(current, couple ? -2 : -4);
    const last = shift(current, -2);
    return result(
      few,
      range(
        from,
        last,
        current,
        couple
          ? `a couple of months ago (${title(from)})`
          : `a few months ago (${title(from)} to ${title(last)})`,
        null,
        few.groups?.q
      )
    );
  }

  // "N months ago", "in N months", in digits or words
  const count = `(?<n>\\d{1,2}|${Object.keys(NUMBER_WORDS).join('|')})`;
  const ago = new RegExp(`\\b${LEAD}${count}\\s+months?\\s+ago\\b`, 'i').exec(query);
  const ahead = new RegExp(`\\bin\\s+${count}\\s+months?\\b(?!\\s+ago)`, 'i').exec(query);
  const counted = ago ?? ahead;
  if (counted) {
    const raw = group(counted, 'n').toLowerCase();
    const n = NUMBER_WORDS[raw] ?? Number(raw);
    if (n >= 1 && n <= 24) {
      const day = shift(current, ago ? -n : n);
      return result(
        counted,
        range(
          day,
          day,
          current,
          `${n} month${n === 1 ? '' : 's'} ${ago ? 'ago' : 'from now'} (${title(day)})`,
          null,
          ago?.groups?.q
        )
      );
    }
  }

  // a named month, optionally "this/next/last" before it and a year after it
  const named = new RegExp(
    `\\b${LEAD}(?:(?<mod>this|next|last)\\s+)?(?<month>${MONTH_NAME})\\b(?:\\s+(?<year>\\d{4})\\b)?`,
    'gi'
  );
  for (const hit of query.matchAll(named)) {
    const q = hit.groups?.q;
    const mod = hit.groups?.mod;
    const year = hit.groups?.year;
    const lower = group(hit, 'month').toLowerCase();
    // A lead-in ("in may"), a this/next/last, or a year makes it a month for certain.
    const led = Boolean(mod) || Boolean(year) || LEAD_IN.test(hit[0]);
    // Short forms ("mar", "dec") and "may" read as ordinary words on their own.
    if (!MONTHS.some((name) => name === lower) && !led) continue;
    if (lower === 'may' && !led && query.trim().toLowerCase() !== 'may') continue;
    const monthIndex = MONTH_ALIASES[lower];
    if (monthIndex === undefined) continue;
    let day: Day;
    if (year) day = { year: Number(year), month: monthIndex };
    else if (mod?.toLowerCase() === 'next') {
      day = { year: current.year, month: monthIndex };
      if (index(day) <= index(current)) day = { year: day.year + 1, month: monthIndex };
    } else if (mod?.toLowerCase() === 'last') {
      day = { year: current.year, month: monthIndex };
      if (index(day) >= index(current)) day = { year: day.year - 1, month: monthIndex };
    } else if (mod?.toLowerCase() === 'this') day = { year: current.year, month: monthIndex };
    else if (q?.toLowerCase() === 'since') {
      // "since March": the most recent March that has begun
      day = { year: current.year, month: monthIndex };
      if (index(day) > index(current)) day = { year: day.year - 1, month: monthIndex };
    } else if (q) {
      // "before / after / until / by / from June": the next June (this month counts)
      day = { year: current.year, month: monthIndex };
      if (index(day) < index(current)) day = { year: day.year + 1, month: monthIndex };
    } else day = nearestMonth(monthIndex, current);
    return result(
      hit as RegExpExecArray,
      range(day, day, current, title(day), MONTHS[monthIndex] ?? null, q)
    );
  }
  return null;
}
