import { transaction, type DbQueryable } from '@snaglet/db/db';
import { quoteIdentifier } from '@snaglet/db/sql-utils';
import { CUSTOM_TABLES_SCHEMA, ENTRY_POSITION_COLUMN } from '@snaglet/db/tables/table_catalog';
import { TableFields } from '@snaglet/db/tables/table_fields';
import type { TableEntryWhere, TableField } from '@snaglet/shared/types';
import { utcInstantText } from '../table_fields/fieldSchema';
import { entryBadRequest } from './entrySchema';
import {
  dateRangeCondition,
  dateSortSql,
  isFillerWord,
  pickDateFields,
  type DateRange,
} from './entryDate';
import { entryWhereCondition, parseEntryWhere } from './entryWhere';
import {
  entryTermsCondition,
  likeLiteral,
  parseEntryFilter,
  relationTargets,
  storedNameLabel,
  type EntryFilterTerm,
  type RelationTarget,
} from './entryFilter';

/** One entry found by {@link searchEntriesAcrossTables}. */
export interface EntrySearchHit {
  tableId: string;
  /** The table's catalog (display) name. */
  tableName: string;
  /** The table's project home; null for a workspace-wide table. */
  projectId: string | null;
  entryId: string;
  /** The stored Name ('' when empty or the table has no Name field). */
  name: string;
  /** Relevance in [0, 1]; 0 for every row of a browse (no keywords). */
  score: number;
  /** UTC ISO instant. */
  createdAt: string;
  /**
   * With `snippets`: up to {@link SNIPPET_SOURCE_LENGTH} characters of the first
   * text field (other than the title) that contains the first keyword; null when
   * the match was in the title or another kind of field.
   */
  snippet?: string | null;
}

export interface EntrySearchOptions {
  /**
   * Keywords, parsed like a table's toolbar search (words AND-ed, "quoted
   * phrases" whole). Empty browses: one table's rows in row order, or the
   * newest rows across tables.
   */
  q: string;
  /** Search only these tables (catalog ids). */
  tableIds?: readonly string[];
  /** Search only the tables whose project home is this project. */
  projectId?: string;
  limit: number;
  /**
   * `recent` orders matches newest first (`created_at`) instead of by how well
   * the Name answers; default `relevance`.
   */
  sort?: 'relevance' | 'recent';
  /**
   * Field conditions every entry must also meet (field ids, validated like a
   * table read's `where`). Field ids belong to one table, so this needs
   * `tableIds` to name exactly one.
   */
  where?: readonly TableEntryWhere[];
  /** Search at most this many tables (catalog order); the rest are counted, not read. */
  maxTables?: number;
  /** Carry a short matched-text snippet on each hit. */
  snippets?: boolean;
  /**
   * Only rows with a date in this range: the field a word of `q` names ("due"),
   * else any date field the table has, else the creation time. Filler words and
   * the words that named the field are not matched against the row's text, and
   * the rows come soonest first (newest first for a range in the past) before
   * any text score.
   */
  dateRange?: DateRange;
}

/** What {@link searchEntries} read, beside the hits. */
export interface EntrySearchResult {
  hits: EntrySearchHit[];
  tablesSearched: number;
  /** Tables left unread because of `maxTables`. */
  tablesOmitted: number;
  /** With a `dateRange`: the names of the date fields it was applied to. */
  dateFields?: string[];
}

/** Longest cell text a snippet is cut from; the caller trims it further. */
export const SNIPPET_SOURCE_LENGTH = 300;

/**
 * Codes a read hits when a table, its fields or a relation target changes
 * under it, or a table is locked past the lock timeout. The combined read is
 * then repeated table by table, and a table that still fails is left out.
 */
const SKIPPED_TABLE_ERRORS = new Set(['42703', '42P01', '55P03']);

function isSkippedTableError(error: unknown): boolean {
  const code =
    typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined;
  return typeof code === 'string' && SKIPPED_TABLE_ERRORS.has(code);
}

/** Bounds one search, which runs on every keystroke of a quick search. */
const SEARCH_STATEMENT_TIMEOUT_MS = 3000;
const SEARCH_LOCK_TIMEOUT_MS = 1000;
const POSITION = quoteIdentifier(ENTRY_POSITION_COLUMN);
const ESCAPE = "ESCAPE '\\'";

interface SearchedTable {
  id: string;
  name: string;
  table_name: string;
  project_id: string | null;
}

interface HitRow {
  table_rank: number;
  entry_id: string;
  name: string;
  snaglet_score: number;
  created_at: string;
  snippet: string | null;
  /** The date the row was filtered and ordered by (a `dateRange` search), else null. */
  date_sort: string | null;
}

/**
 * How well the Name alone answers the keywords: the whole query as the Name
 * (1), its start (0.9), inside it (0.8), every word somewhere in it (0.7),
 * else by trigram word similarity (0.2–0.7). Entries matched through another
 * field score at the bottom of that last band.
 */
function nameScore(
  name: string,
  terms: readonly EntryFilterTerm[],
  param: (value: unknown) => string
): string {
  const whole = terms.map((term) => term.text).join(' ');
  const every = terms
    .map((term) => `${name} ILIKE ${param(`%${likeLiteral(term.text)}%`)} ${ESCAPE}`)
    .join(' AND ');
  return `CASE
    WHEN lower(${name}) = lower(${param(whole)}) THEN 1.0
    WHEN ${name} ILIKE ${param(`${likeLiteral(whole)}%`)} ${ESCAPE} THEN 0.9
    WHEN ${name} ILIKE ${param(`%${likeLiteral(whole)}%`)} ${ESCAPE} THEN 0.8
    WHEN ${every} THEN 0.7
    ELSE 0.2 + 0.5 * public.word_similarity(${param(whole)}, ${name})
  END`;
}

/**
 * The first non-title text field that contains the first keyword, cut to
 * {@link SNIPPET_SOURCE_LENGTH} characters; NULL when snippets are off, there
 * are no keywords, or no such field matches (the match was the title, a
 * select, a number...). Select cells and the rest are never copied out.
 */
function snippetSql(
  fields: readonly TableField[],
  terms: readonly EntryFilterTerm[],
  snippets: boolean,
  param: (value: unknown) => string
): string {
  const first = terms[0];
  if (!snippets || !first) return 'NULL::text';
  const columns = fields.filter(
    (field) => field.type === 'text' && !field.isTitle && !field.managed
  );
  if (!columns.length) return 'NULL::text';
  const like = param(`%${likeLiteral(first.text)}%`);
  const cases = columns.map((field) => {
    const column = `entry.${quoteIdentifier(field.columnName)}::text`;
    return `CASE WHEN ${column} ILIKE ${like} ${ESCAPE} THEN left(${column}, ${SNIPPET_SOURCE_LENGTH}) END`;
  });
  return `COALESCE(${cases.join(', ')})`;
}

/** One table's best `limit` matches (or browse rows), as a parenthesized SELECT. */
function tableSelect(
  table: SearchedTable,
  rank: number,
  fields: readonly TableField[],
  terms: readonly EntryFilterTerm[],
  targets: ReadonlyMap<string, RelationTarget>,
  newestFirst: boolean,
  limit: string,
  param: (value: unknown) => string,
  where: readonly TableEntryWhere[],
  snippets: boolean,
  dateRange: DateRange | undefined
): string {
  const title = fields.find((field) => field.isTitle && !field.managed);
  const name = title ? `COALESCE(entry.${quoteIdentifier(title.columnName)}::text, '')` : "''";
  // A date range names its field and drops filler: those words are not matched in the text.
  const picked = dateRange
    ? pickDateFields(
        fields,
        terms.map((term) => term.text)
      )
    : null;
  const rowTerms = picked
    ? terms.filter(
        (term) => !picked.consumed.has(term.text.toLowerCase()) && !isFillerWord(term.text)
      )
    : terms;
  const termsCondition = entryTermsCondition(fields, rowTerms, targets, param, storedNameLabel);
  const whereCondition = entryWhereCondition(where, fields, param);
  const dateCondition =
    dateRange && picked ? dateRangeCondition(picked.fields, dateRange, param) : null;
  const condition =
    [termsCondition, whereCondition, dateCondition].filter((part) => part !== null).join(' AND ') ||
    null;
  const score = termsCondition ? nameScore(name, rowTerms, param) : '0';
  const snippet = snippetSql(fields, rowTerms, snippets, param);
  const first = picked?.fields[0];
  const dateSort = first
    ? dateSortSql(first, `entry.${quoteIdentifier(first.columnName)}`)
    : 'NULL::timestamp';
  const dateDirection = dateRange?.direction === 'past' ? 'DESC' : 'ASC';
  const base =
    termsCondition && !newestFirst
      ? `snaglet_score DESC, entry.${POSITION}, entry.created_at, entry.id`
      : newestFirst
        ? 'entry.created_at DESC, entry.id'
        : `entry.${POSITION}, entry.created_at, entry.id`;
  const order = dateRange ? `date_sort ${dateDirection} NULLS LAST, ${base}` : base;
  return `(SELECT ${rank}::int AS table_rank, entry.id::text AS entry_id, ${name} AS name,
            (${score})::float8 AS snaglet_score, ${utcInstantText('entry.created_at')} AS created_at,
            ${snippet} AS snippet, ${dateSort} AS date_sort, entry.${POSITION} AS snaglet_position
       FROM ONLY ${quoteIdentifier(CUSTOM_TABLES_SCHEMA)}.${quoteIdentifier(table.table_name)} AS entry
      WHERE ${condition ?? 'true'}
      ORDER BY ${order}
      LIMIT ${limit})`;
}

/** Hits best first: score, then table order, then row order (newest first for a browse). */
function compareHits(newestFirst: boolean, dateOrder: 'ASC' | 'DESC' | null) {
  return (a: HitRow & { snaglet_position?: number }, b: HitRow & { snaglet_position?: number }) => {
    if (dateOrder) {
      if (a.date_sort !== b.date_sort) {
        if (a.date_sort === null) return 1;
        if (b.date_sort === null) return -1;
        return dateOrder === 'ASC'
          ? a.date_sort.localeCompare(b.date_sort)
          : b.date_sort.localeCompare(a.date_sort);
      }
    }
    if (newestFirst) return b.created_at.localeCompare(a.created_at);
    return (
      b.snaglet_score - a.snaglet_score ||
      a.table_rank - b.table_rank ||
      (a.snaglet_position ?? 0) - (b.snaglet_position ?? 0) ||
      a.entry_id.localeCompare(b.entry_id)
    );
  };
}

/**
 * Read every table's best rows: one combined statement, or, when a table or
 * relation target changed under it, table by table without matching linked
 * Names, leaving out a table that still cannot be read.
 */
async function readHits(
  tables: readonly SearchedTable[],
  fieldsByTable: ReadonlyMap<string, TableField[]>,
  terms: readonly EntryFilterTerm[],
  targets: ReadonlyMap<string, RelationTarget>,
  limit: number,
  tx: DbQueryable,
  where: readonly TableEntryWhere[],
  snippets: boolean,
  recent: boolean,
  dateRange: DateRange | undefined
): Promise<Array<HitRow & { snaglet_position: number }>> {
  const newestFirst = recent || (!terms.length && tables.length > 1);
  const dateOrder = dateRange ? (dateRange.direction === 'past' ? 'DESC' : 'ASC') : null;
  const select = (indexes: readonly number[], linked: ReadonlyMap<string, RelationTarget>) => {
    const params: unknown[] = [];
    const param = (value: unknown) => `$${params.push(value)}`;
    const limitParam = param(limit);
    const parts = indexes.map((index) =>
      tableSelect(
        tables[index]!,
        index,
        fieldsByTable.get(tables[index]!.id) ?? [],
        terms,
        linked,
        newestFirst,
        limitParam,
        param,
        where,
        snippets,
        dateRange
      )
    );
    const base = newestFirst
      ? 'created_at DESC, entry_id'
      : 'snaglet_score DESC, table_rank, snaglet_position, entry_id';
    const order = dateOrder ? `date_sort ${dateOrder} NULLS LAST, ${base}` : base;
    return {
      sql: `SELECT * FROM (${parts.join(' UNION ALL ')}) AS hits ORDER BY ${order} LIMIT ${limitParam}`,
      params,
    };
  };
  const all = tables.map((_, index) => index);
  await tx.query('SAVEPOINT snaglet_entry_search');
  try {
    const { sql, params } = select(all, targets);
    const { rows } = await tx.query<HitRow & { snaglet_position: number }>(sql, params);
    await tx.query('RELEASE SAVEPOINT snaglet_entry_search');
    return rows;
  } catch (error) {
    if (!isSkippedTableError(error)) throw error;
    await tx.query('ROLLBACK TO SAVEPOINT snaglet_entry_search');
  }
  const rows: Array<HitRow & { snaglet_position: number }> = [];
  for (const index of all) {
    await tx.query('SAVEPOINT snaglet_entry_search_table');
    try {
      const { sql, params } = select([index], new Map());
      rows.push(...(await tx.query<HitRow & { snaglet_position: number }>(sql, params)).rows);
      await tx.query('RELEASE SAVEPOINT snaglet_entry_search_table');
    } catch (error) {
      if (!isSkippedTableError(error)) throw error;
      await tx.query('ROLLBACK TO SAVEPOINT snaglet_entry_search_table');
    }
  }
  return rows.sort(compareHits(newestFirst, dateOrder)).slice(0, limit);
}

/**
 * Entries across the active custom tables (or the ones `tableIds` /
 * `projectId` name) that match `q` by the same rule as each table's toolbar
 * search — fuzzy Name, contains on other text, select labels, numbers, date
 * prefixes and linked Names, every word AND-ed — except that an unnamed entry
 * is not matched as "Untitled N" (rows are not numbered across tables).
 * Best first; at most `limit`. Built-in, archived and deleted tables are
 * never read, like the entry routes. Takes no schema locks, as entry names
 * do not: a table whose schema changes mid-read is left out. Throws a 400
 * AppError for a `q` the toolbar search would also refuse.
 */
export async function searchEntriesAcrossTables(
  options: EntrySearchOptions
): Promise<EntrySearchHit[]> {
  return (await searchEntries(options)).hits;
}

/**
 * {@link searchEntriesAcrossTables} with what it read: how many tables were
 * searched and how many `maxTables` left out. `where` conditions are checked
 * against the one table `tableIds` names before anything is read.
 */
export async function searchEntries(options: EntrySearchOptions): Promise<EntrySearchResult> {
  const terms = parseEntryFilter(options.q, undefined)?.terms ?? [];
  const limit = Math.max(1, Math.floor(options.limit));
  const empty: EntrySearchResult = { hits: [], tablesSearched: 0, tablesOmitted: 0 };
  if (options.tableIds && !options.tableIds.length) return empty;
  if (options.where?.length && options.tableIds?.length !== 1)
    throw entryBadRequest('Field filters apply to one table: name it with table.');
  return transaction(async (tx) => {
    await tx.query(`SET LOCAL lock_timeout = ${SEARCH_LOCK_TIMEOUT_MS}`);
    await tx.query(`SET LOCAL statement_timeout = ${SEARCH_STATEMENT_TIMEOUT_MS}`);
    await tx.query("SET LOCAL DateStyle = 'ISO, YMD'");
    await tx.query("SET LOCAL TIME ZONE 'UTC'");
    const params: unknown[] = [CUSTOM_TABLES_SCHEMA];
    let where = '';
    if (options.tableIds) {
      params.push([...options.tableIds]);
      where += ` AND catalog.id = ANY($${params.length}::text[])`;
    }
    if (options.projectId !== undefined) {
      params.push(options.projectId);
      where += ` AND catalog.project_id = $${params.length}`;
    }
    const { rows: found } = await tx.query<SearchedTable>(
      `SELECT catalog.id, catalog.name, catalog.table_name, catalog.project_id
         FROM public.table_catalog AS catalog
        WHERE catalog.origin = 'custom' AND catalog.state = 'active'
          AND to_regclass(format('%I.%I', $1::text, catalog.table_name)) IS NOT NULL${where}
        ORDER BY lower(catalog.name), catalog.id`,
      params
    );
    const tables =
      options.maxTables === undefined ? found : found.slice(0, Math.max(1, options.maxTables));
    const tablesOmitted = found.length - tables.length;
    const [firstTable] = tables;
    if (!firstTable) return { ...empty, tablesOmitted };
    const fieldsByTable = await TableFields.listFieldsByTable(
      tables.map((table) => table.id),
      tx
    );
    const conditions = options.where?.length
      ? parseEntryWhere(options.where, fieldsByTable.get(firstTable.id) ?? [])
      : [];
    const targets = terms.length
      ? await relationTargets([...fieldsByTable.values()].flat(), tx)
      : new Map<string, RelationTarget>();
    const rows = await readHits(
      tables,
      fieldsByTable,
      terms,
      targets,
      limit,
      tx,
      conditions,
      options.snippets === true,
      options.sort === 'recent',
      options.dateRange
    );
    const dateFields = options.dateRange
      ? [
          ...new Set(
            tables.flatMap((table) =>
              pickDateFields(
                fieldsByTable.get(table.id) ?? [],
                terms.map((term) => term.text)
              ).fields.map((field) => field.name)
            )
          ),
        ]
      : undefined;
    return {
      tablesSearched: tables.length,
      tablesOmitted,
      ...(dateFields ? { dateFields } : {}),
      hits: rows.map((row) => {
        const table = tables[row.table_rank]!;
        return {
          tableId: table.id,
          tableName: table.name,
          projectId: table.project_id,
          entryId: row.entry_id,
          name: row.name,
          score: Number(row.snaglet_score),
          createdAt: row.created_at,
          ...(options.snippets ? { snippet: row.snippet } : {}),
        };
      }),
    };
  });
}

/** An entry to read by table and id. */
export interface EntryRef {
  tableId: string;
  entryId: string;
}

/**
 * The hit shape (title, table, project, creation time, a short snippet of the
 * first text cell that is not the title) for entries found some other way,
 * such as by vector. Rows or tables that are gone, archived or deleted are
 * left out; so are built-in tables. Order follows `refs`.
 */
export async function readEntryHits(refs: readonly EntryRef[]): Promise<EntrySearchHit[]> {
  if (!refs.length) return [];
  const byTable = new Map<string, string[]>();
  for (const ref of refs)
    byTable.set(ref.tableId, [...(byTable.get(ref.tableId) ?? []), ref.entryId]);
  return transaction(async (tx) => {
    await tx.query(`SET LOCAL lock_timeout = ${SEARCH_LOCK_TIMEOUT_MS}`);
    await tx.query(`SET LOCAL statement_timeout = ${SEARCH_STATEMENT_TIMEOUT_MS}`);
    await tx.query("SET LOCAL DateStyle = 'ISO, YMD'");
    await tx.query("SET LOCAL TIME ZONE 'UTC'");
    const { rows: tables } = await tx.query<SearchedTable>(
      `SELECT catalog.id, catalog.name, catalog.table_name, catalog.project_id
         FROM public.table_catalog AS catalog
        WHERE catalog.origin = 'custom' AND catalog.state = 'active' AND catalog.id = ANY($1::text[])
          AND to_regclass(format('%I.%I', $2::text, catalog.table_name)) IS NOT NULL`,
      [[...byTable.keys()], CUSTOM_TABLES_SCHEMA]
    );
    const fieldsByTable = await TableFields.listFieldsByTable(
      tables.map((table) => table.id),
      tx
    );
    const found = new Map<string, EntrySearchHit>();
    for (const table of tables) {
      const fields = fieldsByTable.get(table.id) ?? [];
      const title = fields.find((field) => field.isTitle && !field.managed);
      const name = title ? `COALESCE(entry.${quoteIdentifier(title.columnName)}::text, '')` : "''";
      const prose = fields.filter(
        (field) => field.type === 'text' && !field.isTitle && !field.managed
      );
      const snippet = prose.length
        ? `COALESCE(${prose
            .map(
              (field) =>
                `NULLIF(left(entry.${quoteIdentifier(field.columnName)}::text, ${SNIPPET_SOURCE_LENGTH}), '')`
            )
            .join(', ')})`
        : 'NULL::text';
      await tx.query('SAVEPOINT snaglet_entry_hits');
      try {
        const { rows } = await tx.query<{
          entry_id: string;
          name: string;
          created_at: string;
          snippet: string | null;
        }>(
          `SELECT entry.id::text AS entry_id, ${name} AS name,
                  ${utcInstantText('entry.created_at')} AS created_at, ${snippet} AS snippet
             FROM ONLY ${quoteIdentifier(CUSTOM_TABLES_SCHEMA)}.${quoteIdentifier(table.table_name)} AS entry
            WHERE entry.id = ANY($1::uuid[])`,
          [byTable.get(table.id)]
        );
        await tx.query('RELEASE SAVEPOINT snaglet_entry_hits');
        for (const row of rows)
          found.set(`${table.id}/${row.entry_id}`, {
            tableId: table.id,
            tableName: table.name,
            projectId: table.project_id,
            entryId: row.entry_id,
            name: row.name,
            score: 0,
            createdAt: row.created_at,
            snippet: row.snippet,
          });
      } catch (error) {
        if (!isSkippedTableError(error)) throw error;
        await tx.query('ROLLBACK TO SAVEPOINT snaglet_entry_hits');
      }
    }
    return refs.flatMap((ref) => {
      const hit = found.get(`${ref.tableId}/${ref.entryId}`);
      return hit ? [hit] : [];
    });
  });
}
