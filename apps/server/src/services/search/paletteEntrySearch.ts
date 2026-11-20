/**
 * Table rows ("entries") in quick search.
 *
 *   `entry: <keywords>`                  rows across every table
 *   `table:<name> entry: <keywords>`     rows of one table; a multi-word name
 *                                        is quoted (`table:"Reading list"`);
 *                                        `table:<name>:entry:<keywords>` is the same
 *
 * An unfiltered palette search may also ask for a short Entries section. Rows
 * match by the rule each table's toolbar search uses (see
 * `searchEntriesAcrossTables`), and only active custom tables are read — the
 * same tables the entry routes serve.
 *
 * The table name is matched forgivingly but never guessed at: exact (case and
 * `_`/space insensitive), then a unique prefix, then a unique contains or
 * fuzzy match. A name that matches several tables, or none, is reported back
 * instead of quietly searching every table.
 */

import { getDb } from '@snaglet/db';
import {
  matchTables,
  readEntryHits,
  rowQuery,
  searchEntriesAcrossTables,
} from '@snaglet/db/tables/table_entries';
import { TableSemantic } from '@snaglet/db/tables/table_semantic';
import type { PaletteEntryHit } from '@snaglet/shared/constants';
import { AppError, getErrorMessage } from '@snaglet/shared/utils';
import { logger } from '@server/config/logger';
import {
  fuseRankings,
  PALETTE_MEANING_HITS,
  SEMANTIC_MAX_DISTANCE,
} from '@server/services/search/entryFusion';
import { searchSemantic } from '@server/services/tableSemantic/TableSemanticService';
import { timePhraseIn, searchEntriesWithTime, textWords } from './entryTimeSearch';
import type { MonthPhrase } from './monthPhrase';

/** A query that asks for entries, split into its table name and keywords. */
export type PaletteEntryQuery = {
  /** The table name as typed (quotes removed); null searches every table. */
  tableName: string | null;
  keywords: string;
};

/** Straight and curly quotes — macOS substitutes curly ones while typing. */
const ENTRY_QUERY_RE = /^\s*entry:\s*([\s\S]*)$/i;
const QUOTED_TABLE_ENTRY_QUERY_RE = /^\s*table:\s*["“]([^"“”]*)["”]\s*:?\s*entry:\s*([\s\S]*)$/i;
const TABLE_ENTRY_QUERY_RE = /^\s*table:\s*(?:([^"“\s][\s\S]*?)(?:\s+|:))?entry:\s*([\s\S]*)$/i;

/** Longest table name we will look up; catalog names are at most 63 characters. */
const MAX_TABLE_NAME_LENGTH = 200;

/**
 * `entry: <keywords>` or `table:<name> entry: <keywords>`; null for any other
 * query. Pure — no database. An empty name (`table: entry: x`) searches
 * every table.
 */
export function parseEntryQuery(rawQuery: string): PaletteEntryQuery | null {
  const entry = ENTRY_QUERY_RE.exec(rawQuery);
  if (entry) return { tableName: null, keywords: (entry[1] ?? '').trim() };
  const scoped = QUOTED_TABLE_ENTRY_QUERY_RE.exec(rawQuery) ?? TABLE_ENTRY_QUERY_RE.exec(rawQuery);
  if (!scoped) return null;
  const name = (scoped[1] ?? '').trim();
  return { tableName: name || null, keywords: (scoped[2] ?? '').trim() };
}

export type EntryTableResolution =
  | { status: 'resolved'; tableId: string; tableName: string; projectId: string | null }
  | { status: 'not_found' | 'unsearchable'; name: string; message: string }
  | { status: 'ambiguous'; name: string; matches: string[]; message: string };

type CatalogNameRow = {
  id: string;
  name: string;
  origin: string;
  state: string;
  project_id: string | null;
  similarity: number;
};

/** A typed table name as a catalog name compares: lowercase, spaces and dashes as `_`. */
function catalogForm(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, '_');
}

/** Fuzzy matches below this word similarity are not the table the user meant. */
const TABLE_NAME_SIMILARITY_THRESHOLD = 0.5;
/** Names an ambiguity message lists. */
const AMBIGUOUS_NAMES_SHOWN = 5;

function ambiguous(name: string, rows: readonly CatalogNameRow[]): EntryTableResolution {
  const matches = rows.map((row) => row.name).sort((a, b) => a.localeCompare(b));
  const shown = matches.slice(0, AMBIGUOUS_NAMES_SHOWN).join(', ');
  const more = matches.length > AMBIGUOUS_NAMES_SHOWN ? ', …' : '';
  return {
    status: 'ambiguous',
    name,
    matches,
    message: `More than one table matches "${name}" (${shown}${more}). Type more of its name.`,
  };
}

function resolved(row: CatalogNameRow): EntryTableResolution {
  return { status: 'resolved', tableId: row.id, tableName: row.name, projectId: row.project_id };
}

/**
 * The one active custom table `name` means: exact (ignoring case, and spaces
 * versus `_`), else the only table it is a prefix of, else the only table
 * that contains it or is a close fuzzy match. Several candidates at the first
 * tier that has any are ambiguous; an archived or Snaglet (built-in) table of that
 * exact name is named as such rather than "not found".
 */
export async function resolveEntryTable(rawName: string): Promise<EntryTableResolution> {
  const name = rawName.trim();
  const wanted = catalogForm(name);
  if (!wanted || name.length > MAX_TABLE_NAME_LENGTH) {
    return { status: 'not_found', name, message: `No table named "${name}".` };
  }
  const { rows } = await getDb().query<CatalogNameRow>(
    `SELECT id, name, origin, state, project_id,
            public.word_similarity($1, replace(name, '_', ' '))::float8 AS similarity
       FROM public.table_catalog
      WHERE state <> 'deleted'`,
    [wanted.replace(/_/g, ' ')]
  );
  const live = rows.filter((row) => row.origin === 'custom' && row.state === 'active');
  const tiers: Array<(row: CatalogNameRow) => boolean> = [
    (row) => row.name.toLowerCase() === wanted,
    (row) => row.name.toLowerCase().startsWith(wanted),
    (row) =>
      row.name.toLowerCase().includes(wanted) ||
      Number(row.similarity) >= TABLE_NAME_SIMILARITY_THRESHOLD,
  ];
  // An exact name that is not a live table (archived, or a Snaglet table) is named
  // as such before any prefix or fuzzy tier can quietly pick a different table.
  const retired = rows.find((row) => row.name.toLowerCase() === wanted && !live.includes(row));
  for (const [index, tier] of tiers.entries()) {
    const matches = live.filter(tier);
    const [only] = matches;
    if (matches.length === 1 && only) return resolved(only);
    if (matches.length > 1) return ambiguous(name, matches);
    if (index === 0 && retired) break;
  }
  if (retired?.origin === 'builtin') {
    return {
      status: 'unsearchable',
      name,
      message: `${retired.name} is a Snaglet table; it has no entries to search.`,
    };
  }
  if (retired) {
    return {
      status: 'unsearchable',
      name,
      message: `${retired.name} is archived. Restore it to search its entries.`,
    };
  }
  return { status: 'not_found', name, message: `No table named "${name}".` };
}

/**
 * Entries matching `keywords` (or a browse when empty), best first. Never
 * throws for a bad search: a query the toolbar search would refuse (too long,
 * too many words) or a read that timed out finds nothing, so the rest of the
 * palette still answers.
 *
 * Meaning search is opt-in (`byMeaning`): it embeds the query, so only the
 * deliberate `entry:` search asks for it. The short Entries section of every
 * ordinary palette search stays keyword-only, so typing never waits on the embedder.
 */
export async function searchPaletteEntries(args: {
  keywords: string;
  tableId?: string;
  projectId?: string;
  limit: number;
  byMeaning?: boolean;
}): Promise<PaletteEntryHit[]> {
  try {
    const month = args.keywords ? timePhraseIn(args.keywords) : null;
    if (month) return await searchByMonth(month, args);
    const keyword = await searchEntriesAcrossTables({
      q: args.keywords,
      ...(args.tableId ? { tableIds: [args.tableId] } : {}),
      ...(args.projectId ? { projectId: args.projectId } : {}),
      limit: args.limit,
    });
    return args.byMeaning ? await withMeaning(keyword, args) : keyword;
  } catch (err) {
    if (err instanceof AppError && err.statusCode === 400) return [];
    logger.warn(`[palette-entries] entry search failed: ${getErrorMessage(err)}`);
    return [];
  }
}

/** Tables a month search reads when none is named and the words point at some. */
const MONTH_SEARCH_TABLES = 3;

/**
 * A search with a month phrase ("tasks due next month", "June"): rows dated in
 * the month, soonest first, plus, for a named month, rows that say its name.
 * Plain SQL, so the instant keyword tier may run it too. The words that name a
 * table ("tasks") pick up to three tables, as in the `search` tool.
 */
async function searchByMonth(
  month: MonthPhrase,
  args: {
    keywords: string;
    tableId?: string;
    projectId?: string;
    limit: number;
    byMeaning?: boolean;
  }
): Promise<PaletteEntryHit[]> {
  let tableIds: string[] | undefined = args.tableId ? [args.tableId] : undefined;
  let q = month.residual;
  if (!tableIds) {
    const matches = await matchTables(q, args.projectId ? { projectId: args.projectId } : {});
    const [best] = matches;
    if (best) {
      tableIds = matches.slice(0, MONTH_SEARCH_TABLES).map((match) => match.tableId);
      q = rowQuery(q, best.nameTerms);
    }
  }
  const found = await searchEntriesWithTime(
    {
      q,
      limit: args.limit,
      ...(tableIds ? { tableIds } : {}),
      ...(args.projectId ? { projectId: args.projectId } : {}),
    },
    month
  );
  // Best first: a row both dated then and mentioning the month, then the rest in order.
  const hits: PaletteEntryHit[] = found.hits.map((hit, rank) => ({
    tableId: hit.tableId,
    tableName: hit.tableName,
    projectId: hit.projectId,
    entryId: hit.entryId,
    name: hit.name,
    score: Math.max(0.3, 0.85 - rank * 0.005),
    createdAt: hit.createdAt,
  }));
  const words = textWords(q);
  return args.byMeaning && words ? withMeaning(hits, { ...args, keywords: words }) : hits;
}

/** Score of a row found only by meaning: below every keyword match, above none. */
function meaningScore(distance: number): number {
  return Math.max(0.2, 0.7 - distance);
}

/**
 * Add the rows nearest the keywords in meaning, from the tables that have
 * search by meaning on, to the keyword hits (same fusion and cut as the
 * `search` tool, at most a few). Keywords that match nothing still find "artistic" in a
 * table of quotes. Any failure (embedder missing, no table with it on) leaves the
 * keyword hits as they were.
 */
async function withMeaning(
  keyword: PaletteEntryHit[],
  args: { keywords: string; tableId?: string; projectId?: string; limit: number }
): Promise<PaletteEntryHit[]> {
  if (!args.keywords.trim()) return keyword;
  try {
    const scope = args.tableId
      ? [args.tableId]
      : await TableSemantic.listSearchable(args.projectId ? { projectId: args.projectId } : {});
    const found = await searchSemantic(scope, args.keywords, args.limit * 3);
    const close = found.hits
      .filter((hit) => hit.distance <= SEMANTIC_MAX_DISTANCE)
      .slice(0, PALETTE_MEANING_HITS);
    if (!close.length) return keyword;
    const keyOf = (ref: { tableId: string; entryId: string }) => `${ref.tableId}/${ref.entryId}`;
    const known = new Map<string, PaletteEntryHit>(keyword.map((hit) => [keyOf(hit), hit]));
    const fused = fuseRankings(keyword.map(keyOf), close.map(keyOf), 'hybrid').slice(
      0,
      args.limit * 2
    );
    const missing = fused
      .filter((item) => !known.has(item.key))
      .map((item) => {
        const [tableId, entryId] = item.key.split('/') as [string, string];
        return { tableId, entryId };
      });
    const distances = new Map(close.map((hit) => [keyOf(hit), hit.distance]));
    for (const hit of await readEntryHits(missing))
      known.set(keyOf(hit), {
        tableId: hit.tableId,
        tableName: hit.tableName,
        projectId: hit.projectId,
        entryId: hit.entryId,
        name: hit.name,
        score: meaningScore(distances.get(keyOf(hit)) ?? SEMANTIC_MAX_DISTANCE),
        createdAt: hit.createdAt,
      });
    return fused
      .flatMap((item) => {
        const hit = known.get(item.key);
        return hit ? [hit] : [];
      })
      .slice(0, args.limit);
  } catch (err) {
    logger.warn(`[palette-entries] meaning search skipped: ${getErrorMessage(err)}`);
    return keyword;
  }
}

/** Tables whose rows a `table:` search lists after the tables themselves. */
const TABLE_FILTER_ROW_TABLES = 3;

/**
 * Under a `table:` filter the results are the tables, then their rows: the first rows of
 * the best few matching tables, followed by the rows that match the typed words anywhere.
 * Never throws (a failed read just leaves the keyword rows).
 */
export async function rowsOfTablesFirst(
  tableIds: readonly string[],
  keywordRows: PaletteEntryHit[],
  limit: number
): Promise<PaletteEntryHit[]> {
  if (!tableIds.length) return keywordRows;
  try {
    const own = await searchEntriesAcrossTables({
      q: '',
      tableIds: tableIds.slice(0, TABLE_FILTER_ROW_TABLES),
      limit,
    });
    const seen = new Set<string>();
    return [...own, ...keywordRows]
      .filter((hit) => {
        const key = `${hit.tableId}/${hit.entryId}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .slice(0, limit);
  } catch (err) {
    logger.warn(`[palette-entries] rows of tables failed: ${getErrorMessage(err)}`);
    return keywordRows;
  }
}
