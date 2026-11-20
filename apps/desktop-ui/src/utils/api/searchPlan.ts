import type { PaletteNodeKind } from './palette-search';
import { entrySectionWanted } from './palette-search';

/**
 * One search plan for every quick search (sidebar, `@` picker, ⌘K): how typed text becomes the
 * entry filter, and how a filter + kinds + text become the palette request. Each surface keeps its
 * own chips and rendering; none of them decides these rules itself.
 *
 * The palette's `entry:` filter: table rows only, across every table, or
 * within one table with `table:<name> entry:` (a multi-word name quoted:
 * `table:"Reading list" entry: …`). The server resolves the name forgivingly
 * and reports a name it cannot resolve, so the client only splits the text.
 */

/** Rows across every table (`table: null`) or within the table `table` names. */
export type EntryFilter = { table: string | null };

/** Straight and curly quotes — macOS substitutes curly ones while typing. */
const ENTRY_RE = /^(?:entry|entries|row|rows):\s*([\s\S]*)$/i;
const QUOTED_TABLE_ENTRY_RE = /^\s*["“]([^"“”]*)["”]\s*:?\s*entry:\s*([\s\S]*)$/i;
const BARE_TABLE_ENTRY_RE = /^\s*([^"“\s][\s\S]*?)(?:\s+|:)entry:\s*([\s\S]*)$/i;
const TABLE_PREFIX_RE = /^table:([\s\S]*)$/i;

/** `<name> entry: <rest>` after a table prefix or chip; null otherwise. */
function tableEntry(text: string): { filter: EntryFilter; remainder: string } | null {
  if (/^\s*entry:/i.test(text)) {
    return { filter: { table: null }, remainder: text.replace(/^\s*entry:\s*/i, '') };
  }
  const match = QUOTED_TABLE_ENTRY_RE.exec(text) ?? BARE_TABLE_ENTRY_RE.exec(text);
  if (!match) return null;
  const table = match[1].trim();
  return { filter: { table: table || null }, remainder: match[2] };
}

/**
 * Typed palette text that turns on the entry filter, with what stays in the
 * input: `entry: …`, `table:<name> entry: …` (typed whole or pasted), or
 * `<name> entry: …` typed after a Table chip (`tableChip`). Null leaves the
 * text as it is.
 */
export function entryFilterFromText(
  text: string,
  tableChip: boolean
): { filter: EntryFilter; remainder: string } | null {
  const entry = ENTRY_RE.exec(text);
  if (entry) return { filter: { table: null }, remainder: entry[1]! };
  const prefixed = TABLE_PREFIX_RE.exec(text);
  if (prefixed) return tableEntry(prefixed[1]!);
  return tableChip ? tableEntry(text) : null;
}

/** The query text the palette route reads for an entry search. */
export function entryServerQuery(filter: EntryFilter, term: string): string {
  const keywords = term.trim();
  // A quoted name keeps a multi-word name whole; quotes inside it cannot be.
  const table = filter.table?.replace(/["“”]/g, '').trim();
  return (table ? `table:"${table}" entry: ${keywords}` : `entry: ${keywords}`).trim();
}

/** What one quick search sends to the palette route. */
type PaletteSearchPlan = {
  /** The query text, with the `entry:` / `file:` / `folder:` prefix the route parses. */
  query: string;
  /** Node kinds to restrict to; undefined searches every kind. */
  kinds: PaletteNodeKind[] | undefined;
  /** Whether to ask for the Entries (table rows) section beside the node results. */
  includeEntries: boolean;
  /** An entry search: its results are table rows only, and it is one keyword request. */
  entryOnly: boolean;
  /** Most rows a list shows: null lists every row found (entry search), 0 none. */
  rowLimit: number | null;
};

/** Rows shown beside the other results of an unfiltered search. */
const ROWS_BESIDE_RESULTS = 5;
/** Rows shown under a `table:` filter, after the tables. */
const ROWS_UNDER_TABLE_FILTER = 8;
/** Table hits kept when other kinds would crowd them out of a capped list. */
const TABLE_HITS_KEPT = 2;

/**
 * Cap a list to `max` hits while keeping up to `TABLE_HITS_KEPT` table hits (a destination of
 * their own) at the end, instead of letting the other kinds cut them first.
 */
export function keepTables<T>(hits: readonly T[], isTable: (hit: T) => boolean, max: number): T[] {
  const tables = hits.filter(isTable).slice(0, TABLE_HITS_KEPT);
  const rest = hits.filter((hit) => !isTable(hit));
  return [...rest.slice(0, Math.max(0, max - tables.length)), ...tables];
}

/**
 * The request for the typed text, filters and kinds. `kinds` are the kind chips (a stray `entry`
 * kind is ignored: rows come from `entryFilter`); `allowEntries` is false where the caller cannot
 * show rows or the search is pinned to kinds.
 */
export function planPaletteSearch(input: {
  term: string;
  kinds?: readonly string[] | null;
  fsFilter?: 'file' | 'folder' | null;
  entryFilter?: EntryFilter | null;
  allowEntries?: boolean;
}): PaletteSearchPlan {
  const term = input.term.trim();
  if (input.entryFilter) {
    return {
      query: entryServerQuery(input.entryFilter, term),
      kinds: undefined,
      includeEntries: false,
      entryOnly: true,
      rowLimit: null,
    };
  }
  const nodeKinds = input.kinds?.filter((kind): kind is PaletteNodeKind => kind !== 'entry');
  const includeEntries =
    input.allowEntries !== false && !input.fsFilter && entrySectionWanted(input.kinds);
  return {
    query: input.fsFilter ? `${input.fsFilter}: ${term}`.trim() : term,
    kinds: !input.fsFilter && nodeKinds?.length ? nodeKinds : undefined,
    includeEntries,
    entryOnly: false,
    rowLimit: !includeEntries
      ? 0
      : input.kinds?.length
        ? ROWS_UNDER_TABLE_FILTER
        : ROWS_BESIDE_RESULTS,
  };
}
