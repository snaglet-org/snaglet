/**
 * Entry search for a query with a month phrase ("due next month", "taxes in
 * June"): rows with a date in that month, soonest first, and, for a named
 * month, also rows whose text says the month's name (an entry that is all
 * about June is found even when its dates lie elsewhere). The two lists are
 * merged by reciprocal rank fusion, so a row that is both comes first.
 */
import {
  isFillerWord,
  searchEntries,
  type EntrySearchHit,
  type EntrySearchOptions,
  type EntrySearchResult,
} from '@snaglet/db/tables/table_entries';
import { userTimeZone } from '@snaglet/shared/utils';
import type { MonthPhrase } from './monthPhrase';
import { parseTimePhrase } from './timePhrase';

/** Words that name which date to use, not what to find ("due" in "tasks due in June"). */
const DATE_HINT_WORDS = new Set([
  'due',
  'deadline',
  'created',
  'added',
  'made',
  'entered',
  'start',
  'starts',
  'started',
  'end',
  'ends',
  'ended',
  'date',
  'dated',
  'scheduled',
]);

const RRF_K = 60;

/** Today as `YYYY-MM-DD` in the user's time zone. */
export function todayInUserZone(now: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: userTimeZone(),
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}

/** The month or week phrase in `query` (today in the user's zone), or null. */
export function timePhraseIn(query: string, now?: Date): MonthPhrase | null {
  return parseTimePhrase(query, todayInUserZone(now));
}

/** What a row is, besides its place in the list: found by its date, its text, or both. */
export type TimeMatch = 'date' | 'text' | 'both';

export interface TimeSearchResult extends EntrySearchResult {
  hits: Array<EntrySearchHit & { monthMatch: TimeMatch }>;
}

const keyOf = (hit: { tableId: string; entryId: string }) => `${hit.tableId}/${hit.entryId}`;

/** The words of the query that say what to find, without fillers and date hints. */
export function textWords(residual: string): string {
  return residual
    .split(/\s+/)
    .filter((word) => word && !isFillerWord(word) && !DATE_HINT_WORDS.has(word.toLowerCase()))
    .join(' ');
}

/**
 * Search the tables for a query whose month phrase `phrase` was taken out
 * (`options.q` is the rest). Date lane: rows with a date in the month. Text
 * lane (named months only): rows that say the month's name.
 */
export async function searchEntriesWithTime(
  options: EntrySearchOptions,
  phrase: MonthPhrase
): Promise<TimeSearchResult> {
  const { range } = phrase;
  const wide = { ...options, limit: Math.max(options.limit * 2, options.limit + 10) };
  const date = await searchEntries({
    ...wide,
    dateRange: { from: range.from, to: range.to, direction: range.direction },
  });
  const text = range.monthName
    ? await searchEntries({
        ...wide,
        q: [range.monthName, textWords(options.q)].filter(Boolean).join(' '),
      })
    : null;

  const scores = new Map<string, number>();
  const hits = new Map<string, EntrySearchHit>();
  const inDate = new Set<string>();
  const inText = new Set<string>();
  const add = (list: EntrySearchHit[], into: Set<string>) =>
    list.forEach((hit, rank) => {
      const key = keyOf(hit);
      into.add(key);
      hits.set(key, hits.get(key) ?? hit);
      scores.set(key, (scores.get(key) ?? 0) + 1 / (RRF_K + rank + 1));
    });
  add(date.hits, inDate);
  if (text) add(text.hits, inText);
  const ordered = [...scores.entries()].sort((a, b) => b[1] - a[1]).slice(0, options.limit);
  return {
    hits: ordered.flatMap(([key]) => {
      const hit = hits.get(key);
      if (!hit) return [];
      return [
        {
          ...hit,
          monthMatch: inDate.has(key) ? (inText.has(key) ? 'both' : 'date') : 'text',
        },
      ];
    }),
    tablesSearched: Math.max(date.tablesSearched, text?.tablesSearched ?? 0),
    tablesOmitted: Math.max(date.tablesOmitted, text?.tablesOmitted ?? 0),
    ...(date.dateFields ? { dateFields: date.dateFields } : {}),
  };
}
