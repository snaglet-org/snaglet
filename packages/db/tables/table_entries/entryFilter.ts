import type { DbQueryable } from '@snaglet/db/db';
import { quoteIdentifier } from '@snaglet/db/sql-utils';
import { CUSTOM_TABLES_SCHEMA, ENTRY_POSITION_COLUMN } from '@snaglet/db/tables/table_catalog';
import { itemTitleMatch } from '@snaglet/db/tables/table_references';
import {
  TABLE_ENTRY_FILTER_MAX_KEEP,
  TABLE_ENTRY_FILTER_MAX_TERMS,
  TABLE_ENTRY_FILTER_QUERY_MAX_LENGTH,
  TABLE_ENTRY_ID_PATTERN,
  type TableEntrySort,
  type TableEntryWhere,
  type TableField,
} from '@snaglet/shared/types';
import { isRange, physicalTable, zoneLiteral } from '../table_fields/fieldSchema';
import { entryBadRequest, type EntrySchema } from './entrySchema';
import { entrySortOrder } from './entrySort';
import { entryWhereCondition } from './entryWhere';

/** `value` as a literal ILIKE pattern body: `\`, `%` and `_` escaped. */
export function likeLiteral(value: string): string {
  return value.replace(/[\\%_]/g, '\\$&');
}

/**
 * Fuzzy Name matching: pg_trgm `word_similarity(term, name)` at or above this
 * still matches ("projct" scores 0.57 against "Project"; unrelated words of
 * similar shape score about 0.4 and below).
 */
const NAME_SIMILARITY_THRESHOLD = 0.5;
/**
 * Only unquoted words of 4+ characters with letters and no digits match the
 * Name fuzzily. Shorter words have too few trigrams to judge; digits differing
 * by one (2025, 2026; "Untitled 2", "Untitled 7") score as near-identical; and
 * a "quoted phrase" asks for exactly that text.
 */
const FUZZY_TERM_MIN_LENGTH = 4;

function isFuzzyWord(word: string): boolean {
  return word.length >= FUZZY_TERM_MIN_LENGTH && /\p{L}/u.test(word) && !/\p{N}/u.test(word);
}

/** One word or quoted phrase of `q`; `fuzzy` also matches the Name by similarity. */
export interface EntryFilterTerm {
  text: string;
  fuzzy: boolean;
}

/**
 * A parsed `q` plus field conditions: every term must match some field and
 * every `where` condition must hold; `keep` ids are listed regardless.
 */
export interface EntryFilter {
  terms: EntryFilterTerm[];
  keep: string[];
  where?: TableEntryWhere[];
}

/** `filter` with `where` added; null when there is neither a search nor conditions. */
export function withWhere(
  filter: EntryFilter | null,
  where: readonly TableEntryWhere[],
  keep: unknown
): EntryFilter | null {
  if (!where.length) return filter;
  return { terms: filter?.terms ?? [], keep: filter?.keep ?? parseKeep(keep), where: [...where] };
}

const TERM_PATTERN = /"([^"]*)"|[^\s"]+/g;

/**
 * `q` split into terms: whitespace-separated words, or "quoted phrases" kept
 * whole, repeats dropped (case-insensitively). Null when `q` is absent or has
 * no terms, which lists every entry.
 */
export function parseEntryFilter(q: unknown, keep: unknown): EntryFilter | null {
  if (q === undefined) return null;
  if (typeof q !== 'string') throw entryBadRequest('q must be text.');
  if (q.length > TABLE_ENTRY_FILTER_QUERY_MAX_LENGTH)
    throw entryBadRequest(`q can be at most ${TABLE_ENTRY_FILTER_QUERY_MAX_LENGTH} characters.`);
  const seen = new Set<string>();
  const terms: EntryFilterTerm[] = [];
  for (const match of q.matchAll(TERM_PATTERN)) {
    const quoted = match[1] !== undefined;
    const text = (match[1] ?? match[0]).trim();
    const key = `${quoted}:${text.toLowerCase()}`;
    if (!text || seen.has(key)) continue;
    seen.add(key);
    terms.push({ text, fuzzy: !quoted && isFuzzyWord(text) });
  }
  if (!terms.length) return null;
  if (terms.length > TABLE_ENTRY_FILTER_MAX_TERMS)
    throw entryBadRequest(`Search for at most ${TABLE_ENTRY_FILTER_MAX_TERMS} words at a time.`);
  return { terms, keep: parseKeep(keep) };
}

/** Validated `keep` ids, lowercased. */
function parseKeep(keep: unknown): string[] {
  const kept = keep ?? [];
  if (
    !Array.isArray(kept) ||
    kept.length > TABLE_ENTRY_FILTER_MAX_KEEP ||
    kept.some((id) => typeof id !== 'string' || !TABLE_ENTRY_ID_PATTERN.test(id))
  )
    throw entryBadRequest(`keep must list at most ${TABLE_ENTRY_FILTER_MAX_KEEP} entry UUIDs.`);
  return kept.map((id: string) => id.toLowerCase());
}

/**
 * Codes a read hits when a relation target's table or Name column changes
 * under it (renamed, or locked by DDL past the lock timeout).
 */
const TARGET_CHANGED_ERRORS = new Set(['42703', '42P01', '55P03']);

function isTargetChanged(error: unknown): boolean {
  const code =
    typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined;
  return typeof code === 'string' && TARGET_CHANGED_ERRORS.has(code);
}

/** A relation's target, when its Name can be matched: physical table and Name column. */
export interface RelationTarget {
  table: string;
  name: string;
}

/** Active custom targets of the schema's relations that have a Name field, by table id. */
export async function relationTargets(
  fields: readonly TableField[],
  tx: DbQueryable
): Promise<Map<string, RelationTarget>> {
  const ids = [
    ...new Set(
      fields.flatMap((field) =>
        field.type === 'relation' && field.referenceTableId ? [field.referenceTableId] : []
      )
    ),
  ];
  if (!ids.length) return new Map();
  const { rows } = await tx.query<{ id: string; table_name: string; title_column: string }>(
    `SELECT catalog.id, catalog.table_name, title.column_name AS title_column
       FROM public.table_catalog AS catalog
       JOIN public.table_fields AS title
         ON title.table_id = catalog.id AND title.is_title AND title.state = 'active'
      WHERE catalog.id = ANY($1::text[]) AND catalog.origin = 'custom' AND catalog.state = 'active'
        AND to_regclass(format('%I.%I', $2::text, catalog.table_name)) IS NOT NULL`,
    [ids, CUSTOM_TABLES_SCHEMA]
  );
  return new Map(
    rows.map((row) => [
      row.id,
      {
        table: `${quoteIdentifier(CUSTOM_TABLES_SCHEMA)}.${quoteIdentifier(row.table_name)}`,
        name: quoteIdentifier(row.title_column),
      },
    ])
  );
}

/** The full-table row number the filtered read computes before filtering. */
const ROW_NUMBER = '"snagletRowNumber"';
const POSITION = quoteIdentifier(ENTRY_POSITION_COLUMN);
const ESCAPE = "ESCAPE '\\'";

/**
 * The text a term matches as an entry's Name, given its stored column: a
 * Name expression over `entry`.
 */
export type EntryNameLabel = (column: string) => string;

/**
 * The Name as the grid displays it: "Untitled N" (its full-table row number)
 * when empty. Needs the row number the filtered reads compute first.
 */
const numberedNameLabel: EntryNameLabel = (column) =>
  `(CASE WHEN ${column} IS NULL OR ${column} !~ '[^[:space:]]' THEN 'Untitled ' || entry.${ROW_NUMBER} ELSE ${column} END)`;

/**
 * The stored Name alone, for reads across tables that number no rows: an
 * empty Name matches no term.
 */
export const storedNameLabel: EntryNameLabel = (column) => column;

/**
 * One term's match against every searchable field of `entry`, OR-ed:
 * - the Name (as `nameLabel` gives it: by default as displayed, "Untitled N"
 *   when empty) by substring, or for a fuzzy term by trigram word similarity;
 * - other text and select labels (single or multiple) by substring;
 * - numbers by the substring of their decimal text;
 * - dates by an ISO prefix (`2026-09`), datetimes the same in the user's
 *   time zone (`2026-09-30T14`, `2026-09-30 14:30`) or by time (`14:30`); a
 *   range by its start;
 * - relations by substring of a linked entry's Name, for targets in `targets`,
 *   or of a linked Snaglet item's title (archived items included, purged ones not).
 * Checkboxes, managed columns and relations without a named target never match.
 */
function termMatch(
  fields: readonly TableField[],
  { text: term, fuzzy: fuzzyTerm }: EntryFilterTerm,
  targets: ReadonlyMap<string, RelationTarget>,
  param: (value: unknown) => string,
  nameLabel: EntryNameLabel
): string {
  let contains: string | undefined;
  let prefix: string | undefined;
  const containsParam = () => (contains ??= param(`%${likeLiteral(term)}%`));
  const prefixParam = () => (prefix ??= param(`${likeLiteral(term)}%`));
  const zone = zoneLiteral();
  const predicates = fields.flatMap((field): string[] => {
    if (field.managed) return [];
    const stored = `entry.${quoteIdentifier(field.columnName)}`;
    const column = isRange(field) ? `lower(${stored})` : stored;
    switch (field.type) {
      case 'text': {
        if (!field.isTitle) return [`${column} ILIKE ${containsParam()} ${ESCAPE}`];
        const label = nameLabel(column);
        const fuzzy = fuzzyTerm
          ? [`public.word_similarity(${param(term)}, ${label}) >= ${NAME_SIMILARITY_THRESHOLD}`]
          : [];
        return [`${label} ILIKE ${containsParam()} ${ESCAPE}`, ...fuzzy];
      }
      case 'select':
        return [
          field.multiple
            ? `EXISTS (SELECT 1 FROM unnest(${column}) AS picked(label) WHERE picked.label ILIKE ${containsParam()} ${ESCAPE})`
            : `${column} ILIKE ${containsParam()} ${ESCAPE}`,
        ];
      case 'number':
        return [`${column}::text ILIKE ${containsParam()} ${ESCAPE}`];
      case 'date':
        return [`to_char(${column}, 'YYYY-MM-DD') ILIKE ${prefixParam()} ${ESCAPE}`];
      case 'datetime': {
        const local = `(${column} AT TIME ZONE ${zone})`;
        return [`YYYY-MM-DD"T"HH24:MI`, 'YYYY-MM-DD HH24:MI', 'HH24:MI'].map(
          (format) => `to_char(${local}, '${format}') ILIKE ${prefixParam()} ${ESCAPE}`
        );
      }
      case 'relation': {
        if (field.referenceKind)
          return [itemTitleMatch(field.referenceKind, column, field.multiple, containsParam())];
        const target = field.referenceTableId ? targets.get(field.referenceTableId) : undefined;
        if (!target) return [];
        const link = field.multiple ? `linked.id = ANY(${column})` : `linked.id = ${column}`;
        return [
          `EXISTS (SELECT 1 FROM ONLY ${target.table} AS linked WHERE ${link} AND linked.${target.name} ILIKE ${containsParam()} ${ESCAPE})`,
        ];
      }
      default:
        return [];
    }
  });
  return predicates.length ? `(${predicates.join(' OR ')})` : 'false';
}

/**
 * Every term matched against `entry`'s searchable fields (see `termMatch`),
 * AND-ed; null when there are no terms. The one matching rule the grid's
 * toolbar search and the cross-table quick search share.
 */
export function entryTermsCondition(
  fields: readonly TableField[],
  terms: readonly EntryFilterTerm[],
  targets: ReadonlyMap<string, RelationTarget>,
  param: (value: unknown) => string,
  nameLabel: EntryNameLabel = numberedNameLabel
): string | null {
  if (!terms.length) return null;
  return terms.map((term) => termMatch(fields, term, targets, param, nameLabel)).join(' AND ');
}

/** The WHERE condition over `entry` (with its row number) for `filter`. */
function entryFilterCondition(
  fields: readonly TableField[],
  filter: EntryFilter,
  targets: ReadonlyMap<string, RelationTarget>,
  param: (value: unknown) => string
): string {
  const terms = entryTermsCondition(fields, filter.terms, targets, param);
  const parts = terms ? [terms] : [];
  const where = entryWhereCondition(filter.where ?? [], fields, param);
  if (where) parts.push(where);
  const matches = parts.length ? parts.join(' AND ') : 'true';
  return filter.keep.length
    ? `((${matches}) OR entry.id = ANY(${param(filter.keep)}::uuid[]))`
    : matches;
}

export type FilteredRow<Row> = Row & { total_count: string; entry_row_number: string | null };

/**
 * One page of the entries matching `filter`, in row order: each row carries
 * `projection`, the match count (`total_count`, also on the empty row an
 * out-of-range page returns) and its row number in the whole table
 * (`entry_row_number`), numbered before filtering. Relation targets are read
 * without schema locks, as entry names are: when one changes mid-read, the
 * page is read again without matching linked names.
 */
export async function readFilteredPage<Row>(
  schema: EntrySchema,
  filter: EntryFilter,
  projection: string,
  page: { limit: number; offset: number },
  tx: DbQueryable,
  sort: readonly TableEntrySort[] = []
): Promise<FilteredRow<Row>[]> {
  const table = physicalTable(schema.table);
  const read = async (targets: ReadonlyMap<string, RelationTarget>) => {
    const params: unknown[] = [page.limit, page.offset];
    const param = (value: unknown) => `$${params.push(value)}`;
    const condition = entryFilterCondition(schema.fields, filter, targets, param);
    const order = entrySortOrder(sort, schema.fields, param);
    const { rows } = await tx.query<FilteredRow<Row>>(
      `WITH ranked AS (
         SELECT entry.*, row_number() OVER (ORDER BY entry.${POSITION}, entry.created_at, entry.id) AS ${ROW_NUMBER}
           FROM ONLY ${table} AS entry),
       matched AS (SELECT * FROM ranked AS entry WHERE ${condition})
       SELECT totals.total_count, page.* FROM (SELECT count(*)::text AS total_count FROM matched) totals
       LEFT JOIN LATERAL (SELECT ${projection}, ${ROW_NUMBER}::text AS entry_row_number,
                                 row_number() OVER (ORDER BY ${order}) AS entry_sort_rank
           FROM matched
           ORDER BY ${order} LIMIT $1 OFFSET $2) page ON true
       ORDER BY page.entry_sort_rank ASC`,
      params
    );
    return rows;
  };
  const targets = await relationTargets(schema.fields, tx);
  if (!targets.size) return read(targets);
  await tx.query('SAVEPOINT snaglet_entry_filter');
  try {
    const rows = await read(targets);
    await tx.query('RELEASE SAVEPOINT snaglet_entry_filter');
    return rows;
  } catch (error) {
    if (!isTargetChanged(error)) throw error;
    await tx.query('ROLLBACK TO SAVEPOINT snaglet_entry_filter');
    return read(new Map());
  }
}

/**
 * How many entries come before `entryId` among those matching `filter`
 * (search terms are not supported here), in `sort` order; null when the
 * entry does not exist. `filter.keep` should list the entry so it is counted
 * even when it does not match.
 */
export async function filteredRank(
  schema: EntrySchema,
  filter: EntryFilter,
  sort: readonly TableEntrySort[],
  entryId: string,
  tx: DbQueryable
): Promise<number | null> {
  const table = physicalTable(schema.table);
  const params: unknown[] = [entryId];
  const param = (value: unknown) => `$${params.push(value)}`;
  const condition = entryFilterCondition(schema.fields, filter, new Map(), param);
  const order = entrySortOrder(sort, schema.fields, param);
  const { rows } = await tx.query<{ before: string }>(
    `WITH ranked AS (
       SELECT entry.*, row_number() OVER (ORDER BY entry.${POSITION}, entry.created_at, entry.id) AS ${ROW_NUMBER}
         FROM ONLY ${table} AS entry),
     matched AS (SELECT * FROM ranked AS entry WHERE ${condition})
     SELECT (ordered.rank - 1)::text AS before
       FROM (SELECT id, row_number() OVER (ORDER BY ${order}) AS rank FROM matched) ordered
      WHERE ordered.id = $1::uuid`,
    params
  );
  return rows[0] ? Number(rows[0].before) : null;
}
