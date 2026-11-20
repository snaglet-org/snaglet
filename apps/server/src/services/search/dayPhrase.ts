/**
 * Day phrases in a search ("today", "tomorrow", "yesterday", "3 days ago", "a few
 * days ago", "in 2 days", "in a few days", "the next 5 days", "the past 3 days",
 * "June 20"), turned into a range of days like the week and month phrases
 * (weekPhrase.ts, monthPhrase.ts); the same open-range words work ("before
 * tomorrow", "since yesterday", "by June 20", "after today").
 *
 * "a few days ago" is 2 to 4 days back and "in a few days" 2 to 4 days ahead;
 * "the next 5 days" and "the past 3 days" are rolling windows that include
 * today. A written date without a year is the occurrence nearest today.
 * Dates are `YYYY-MM-DD` in the user's zone.
 */
import { clean, group, LEAD, type MonthPhrase, type MonthRange } from './monthPhrase';
import { addDays, COUNT, countGroup, countOf, parseDay, range, short } from './weekPhrase';

const MONTH_NAMES = [
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
const MONTH_ABBREVIATIONS: Record<string, number> = {
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
const MONTH_ALTERNATION = [...MONTH_NAMES, ...Object.keys(MONTH_ABBREVIATIONS)].join('|');

function monthIndex(word: string): number {
  const lower = word.toLowerCase();
  const full = MONTH_NAMES.indexOf(lower as (typeof MONTH_NAMES)[number]);
  return full >= 0 ? full : (MONTH_ABBREVIATIONS[lower] ?? -1);
}

function dayText(day: string): string {
  return `${short(day)}, ${day.slice(0, 4)}`;
}

/** One day as a range (`to` is the day after). */
function oneDay(day: string, today: string, label: string, qualifier?: string): MonthRange {
  return range(day, addDays(day, 1), today, `${label} (${short(day)})`, qualifier);
}

/** A window `[from, to)` with its days in the label. */
function window(
  from: string,
  to: string,
  today: string,
  label: string,
  qualifier?: string
): MonthRange {
  return range(
    from,
    to,
    today,
    `${label} (${short(from)} to ${short(addDays(to, -1))})`,
    qualifier
  );
}

/** The year that puts month/day nearest `today` (a tie goes to the upcoming one); null for an impossible date. */
function nearestYear(month: number, day: number, today: string): number | null {
  const todayTime = parseDay(today).getTime();
  const base = Number(today.slice(0, 4));
  const candidates = [base - 1, base, base + 1].filter((year) => {
    const date = new Date(Date.UTC(year, month, day));
    return date.getUTCMonth() === month && date.getUTCDate() === day;
  });
  if (!candidates.length) return null;
  const distance = (year: number) => Math.abs(Date.UTC(year, month, day) - todayTime);
  return candidates.sort((a, b) => distance(a) - distance(b) || b - a)[0] ?? null;
}

/** The day phrase in `query` (today is `YYYY-MM-DD`), or null. Only the first counts. */
export function parseDayPhrase(query: string, today: string): MonthPhrase | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(today)) return null;
  const result = (found: RegExpExecArray, found_range: MonthRange): MonthPhrase => ({
    range: found_range,
    residual: clean(query, found[0]),
    matched: found[0],
  });

  // a written date: "June 20", "June 20th, 2026", "20 June", "the 20th of June"
  const monthFirst = new RegExp(
    `\\b${LEAD}(?<month>${MONTH_ALTERNATION})\\.?\\s+(?<day>\\d{1,2})(?:st|nd|rd|th)?(?!\\d)(?:,?\\s+(?<year>\\d{4}))?\\b`,
    'i'
  ).exec(query);
  const dayFirst = new RegExp(
    `\\b${LEAD}(?:the\\s+)?(?<day>\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?(?<month>${MONTH_ALTERNATION})\\b\\.?(?:,?\\s+(?<year>\\d{4}))?`,
    'i'
  ).exec(query);
  const dated = [monthFirst, dayFirst]
    .filter((found): found is RegExpExecArray => found !== null)
    .sort((a, b) => a.index - b.index)[0];
  if (dated) {
    const month = monthIndex(group(dated, 'month'));
    const day = Number(group(dated, 'day'));
    const yearText = dated.groups?.year;
    const year = yearText ? Number(yearText) : nearestYear(month, day, today);
    if (year !== null && month >= 0) {
      const date = new Date(Date.UTC(year, month, day));
      if (date.getUTCMonth() === month && date.getUTCDate() === day) {
        const iso = date.toISOString().slice(0, 10);
        return result(dated, oneDay(iso, today, dayText(iso), dated.groups?.q));
      }
    }
  }

  // today / tonight / tomorrow / yesterday
  const named = new RegExp(`\\b${LEAD}(?<word>today|tonight|tomorrow|yesterday)\\b`, 'i').exec(
    query
  );
  // "N days ago", "a few days ago", "in N days", "in a few days", "N days from now"
  const fewAgo = new RegExp(
    `\\b${LEAD}(?:a\\s+)?(?<few>few|couple(?:\\s+of)?|several)\\s+days?\\s+ago\\b`,
    'i'
  ).exec(query);
  const fewAhead = new RegExp(
    `\\bin\\s+(?:a\\s+)?(?<few>few|couple(?:\\s+of)?|several)\\s+days?\\b`,
    'i'
  ).exec(query);
  const ago = new RegExp(`\\b${LEAD}${COUNT}\\s+days?\\s+ago\\b`, 'i').exec(query);
  const ahead = new RegExp(
    `\\b(?:in\\s+${COUNT}\\s+days?(?!\\s+ago)|${countGroup('n2')}\\s+days?\\s+from\\s+now)\\b`,
    'i'
  ).exec(query);
  // "the next 5 days", "over the past 3 days", "the last day"
  const rolling = new RegExp(
    `\\b(?:(?:in|over|during|within|for)\\s+)?the\\s+(?<dir>next|coming|following|last|past)\\s+(?:${COUNT}\\s+)?days?\\b`,
    'i'
  ).exec(query);

  const candidates = [named, fewAgo, fewAhead, ago, ahead, rolling]
    .filter((found): found is RegExpExecArray => found !== null)
    .sort((a, b) => a.index - b.index);
  const found = candidates[0];
  if (!found) return null;

  if (found === named) {
    const word = group(named, 'word').toLowerCase();
    const offset = word === 'tomorrow' ? 1 : word === 'yesterday' ? -1 : 0;
    const label = word === 'tonight' ? 'today' : word;
    return result(named, oneDay(addDays(today, offset), today, label, named.groups?.q));
  }
  if (found === fewAgo || found === fewAhead) {
    const couple = /couple/i.test(group(found, 'few'));
    const back = found === fewAgo;
    const near = 2;
    const far = couple ? 2 : 4;
    const from = back ? addDays(today, -far) : addDays(today, near);
    const to = back ? addDays(today, -near + 1) : addDays(today, far + 1);
    const label = `${couple ? 'a couple of' : 'a few'} days ${back ? 'ago' : 'from now'}`;
    return result(found, window(from, to, today, label, back ? found.groups?.q : undefined));
  }
  if (found === ago || found === ahead) {
    const n = countOf(found.groups?.n ?? group(found, 'n2'));
    if (n < 0 || n > 366) return null;
    const back = found === ago;
    const label = `${n} day${n === 1 ? '' : 's'} ${back ? 'ago' : 'from now'}`;
    return result(
      found,
      oneDay(addDays(today, back ? -n : n), today, label, back ? ago?.groups?.q : undefined)
    );
  }
  // rolling window
  if (!rolling) return null;
  const dir = group(rolling, 'dir').toLowerCase();
  const future = dir === 'next' || dir === 'coming' || dir === 'following';
  const count = rolling.groups?.n;
  const n = count ? countOf(count) : 1;
  if (n < 1 || n > 366) return null;
  const label = `the ${future ? 'next' : 'past'} ${n === 1 ? 'day' : `${n} days`}`;
  return result(
    rolling,
    future
      ? window(today, addDays(today, n), today, label)
      : window(addDays(today, -n), addDays(today, 1), today, label)
  );
}
