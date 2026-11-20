import { getDb, type DbQueryable } from '@snaglet/db/db';
import { TableFields } from '@snaglet/db/tables/table_fields';
import type { TableField } from '@snaglet/shared/types';
import { CUSTOM_TABLES_SCHEMA } from '@snaglet/db/tables/table_catalog';

/** One table a query points at, best first, with the reasons it scored. */
export interface TableMatch {
  tableId: string;
  tableName: string;
  projectId: string | null;
  score: number;
  /** Plain-language reasons, e.g. `name has "tasks"`, `field Status option "Doing"`. */
  why: string[];
  /** UTC ISO instant of the table's latest undo-history step, else its creation. */
  lastActivity: string;
  /**
   * The query terms (stems) this table answered to by its name: they say which
   * table to read, so the row search can leave them out.
   */
  nameTerms: string[];
}

/**
 * Words that say how to read the results, not what to look for. They carry no
 * table signal, so matching skips them ("latest task about memories" matches
 * on `task`, `memories`).
 */
export const STOP_WORDS = new Set([
  'a',
  'an',
  'the',
  'of',
  'about',
  'on',
  'in',
  'for',
  'to',
  'with',
  'my',
  'our',
  'and',
  'or',
  'all',
  'any',
  'new',
  'newest',
  'latest',
  'recent',
  'last',
  'oldest',
  // Filler that shows up in field descriptions ("no value", "this is the ...").
  'no',
  'not',
  'such',
  'thing',
  'things',
  'this',
  'that',
  'these',
  'those',
  'from',
  'what',
  'which',
  'when',
  'where',
  'who',
  'are',
  'was',
  'were',
  'has',
  'have',
  'had',
  'is',
  'it',
  'its',
  'by',
  'at',
  'as',
  'be',
  'do',
  'does',
  'show',
  'find',
  'get',
  'me',
  // Placeholders for the thing asked about ("something I did", "all my items").
  'something',
  'anything',
  'everything',
  'stuff',
  'item',
  'items',
  'entry',
  'entries',
  'row',
  'rows',
  'record',
  'records',
]);

/** A word shorter than this says nothing about a table ("no", "ai"). */
const MIN_TERM_LENGTH = 3;

const MIN_PREFIX_LENGTH = 3;

/** Weights of the lexical signals; a table name outranks a field, a field a description. */
const WEIGHT = {
  nameWord: 6,
  namePrefix: 4,
  nameContains: 3,
  fieldWord: 2.5,
  fieldPrefix: 1.5,
  option: 2,
  description: 1,
} as const;

/** The words of `text`, lowercase, split on anything that is not a letter or digit. */
function words(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
}

/** A crude stem so "tasks" and "task", "entries" and "entry" meet. */
export function stem(word: string): string {
  if (word.length > 4 && word.endsWith('ies')) return `${word.slice(0, -3)}y`;
  if (word.length > 3 && word.endsWith('es') && /(s|x|z|ch|sh)es$/.test(word))
    return word.slice(0, -2);
  if (word.length > 3 && word.endsWith('s') && !word.endsWith('ss')) return word.slice(0, -1);
  return word;
}

/** The terms of a query that can say something about a table. */
export function tableTerms(query: string): string[] {
  const seen = new Set<string>();
  const terms: string[] = [];
  for (const word of words(query)) {
    if (STOP_WORDS.has(word) || word.length < MIN_TERM_LENGTH) continue;
    const key = stem(word);
    if (seen.has(key)) continue;
    seen.add(key);
    terms.push(key);
  }
  return terms;
}

interface Signal {
  weight: number;
  why: string;
  /** The signal came from the table's own name, not a field. */
  byName: boolean;
}

/** How one term matches a piece of metadata made of `parts`: its best signal, or null. */
function matchWords(
  term: string,
  parts: readonly string[],
  weights: { word: number; prefix: number; contains?: number }
): number {
  let best = 0;
  for (const part of parts) {
    const stemmed = stem(part);
    if (stemmed === term) return weights.word;
    if (term.length >= MIN_PREFIX_LENGTH && stemmed.startsWith(term))
      best = Math.max(best, weights.prefix);
    else if (weights.contains && term.length >= MIN_PREFIX_LENGTH && part.includes(term))
      best = Math.max(best, weights.contains);
  }
  return best;
}

/** The best signal `term` has in a table: its name, a field's name, option or description. */
function bestSignal(term: string, tableName: string, fields: readonly TableField[]): Signal | null {
  let best: Signal | null = null;
  const consider = (weight: number, why: string, byName = false) => {
    if (weight > (best?.weight ?? 0)) best = { weight, why, byName };
  };
  consider(
    matchWords(term, words(tableName), {
      word: WEIGHT.nameWord,
      prefix: WEIGHT.namePrefix,
      contains: WEIGHT.nameContains,
    }),
    `name has "${term}"`,
    true
  );
  for (const field of fields) {
    if (field.managed) continue;
    consider(
      matchWords(term, words(field.name), { word: WEIGHT.fieldWord, prefix: WEIGHT.fieldPrefix }),
      `field "${field.name}" matches "${term}"`
    );
    for (const option of field.options ?? [])
      consider(
        matchWords(term, words(option.label), { word: WEIGHT.option, prefix: WEIGHT.option - 0.5 }),
        `field "${field.name}" option "${option.label}"`
      );
    if (field.description)
      consider(
        matchWords(term, words(field.description), { word: WEIGHT.description, prefix: 0 }),
        `field "${field.name}" description mentions "${term}"`
      );
  }
  return best && (best as Signal).weight > 0 ? best : null;
}

/**
 * Score one table for the terms: every term adds its best signal, and a table
 * that explains more of the terms counts for more than one that explains a
 * single term strongly.
 */
export function scoreTable(
  terms: readonly string[],
  tableName: string,
  fields: readonly TableField[]
): { score: number; why: string[]; nameTerms: string[] } {
  let sum = 0;
  let matched = 0;
  const why: string[] = [];
  const nameTerms: string[] = [];
  for (const term of terms) {
    const signal = bestSignal(term, tableName, fields);
    if (!signal) continue;
    sum += signal.weight;
    matched += 1;
    why.push(signal.why);
    // Only a name match that is a whole word or a word start says "read this table".
    if (signal.byName && signal.weight >= WEIGHT.namePrefix) nameTerms.push(term);
  }
  if (!matched) return { score: 0, why: [], nameTerms: [] };
  return { score: sum * (0.5 + (0.5 * matched) / terms.length), why, nameTerms };
}

interface CatalogRow {
  id: string;
  name: string;
  project_id: string | null;
  created_at: string;
  activity: string | null;
}

/**
 * The active custom tables `q` points at, best first, by the lexical signals
 * of their metadata only (table name, field names, select options, field
 * descriptions; there is no table description). Ties go to the table edited
 * most recently (the newest undo-history step that names it). Tables whose
 * score is zero are left out; a query of only stop words matches none. No row
 * is read.
 */
export async function matchTables(
  q: string,
  options: { projectId?: string; runner?: DbQueryable } = {}
): Promise<TableMatch[]> {
  const terms = tableTerms(q);
  if (!terms.length) return [];
  const runner = options.runner ?? getDb();
  const params: unknown[] = [CUSTOM_TABLES_SCHEMA];
  let where = '';
  if (options.projectId !== undefined) {
    params.push(options.projectId);
    where = ` AND catalog.project_id = $${params.length}`;
  }
  const { rows } = await runner.query<CatalogRow>(
    `SELECT catalog.id, catalog.name, catalog.project_id,
            to_char(catalog.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at,
            to_char(recent.updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS activity
       FROM public.table_catalog AS catalog
       LEFT JOIN (
              SELECT table_id, max(updated_at) AS updated_at
                FROM public.table_history, unnest(table_ids) AS table_id
               GROUP BY table_id
            ) AS recent ON recent.table_id = catalog.id
      WHERE catalog.origin = 'custom' AND catalog.state = 'active'
        AND to_regclass(format('%I.%I', $1::text, catalog.table_name)) IS NOT NULL${where}`,
    params
  );
  const fieldsByTable = await TableFields.listFieldsByTable(
    rows.map((row) => row.id),
    runner
  );
  return rows
    .map((row) => {
      const { score, why, nameTerms } = scoreTable(
        terms,
        row.name,
        fieldsByTable.get(row.id) ?? []
      );
      return {
        tableId: row.id,
        tableName: row.name,
        projectId: row.project_id,
        score,
        why,
        lastActivity: row.activity ?? row.created_at,
        nameTerms,
      };
    })
    .filter((match) => match.score > 0)
    .sort(
      (a, b) =>
        b.score - a.score ||
        b.lastActivity.localeCompare(a.lastActivity) ||
        a.tableName.localeCompare(b.tableName)
    );
}

/**
 * `q` for the row search once a table has been chosen: the words that named
 * the table (`consumed` stems) are dropped, since they were about which table
 * to read. A "quoted phrase" is kept whole. Empty when the query was only the
 * table's name, which browses its rows.
 */
export function rowQuery(q: string, consumed: readonly string[]): string {
  const drop = new Set(consumed);
  const kept: string[] = [];
  for (const match of q.matchAll(/"([^"]*)"|[^\s"]+/g)) {
    if (match[1] !== undefined) {
      if (match[1].trim()) kept.push(`"${match[1]}"`);
    } else if (!drop.has(stem(match[0].toLowerCase()))) kept.push(match[0]);
  }
  return kept.join(' ');
}
