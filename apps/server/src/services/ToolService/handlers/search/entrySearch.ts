import { getDb } from '@snaglet/db';
import {
  matchTables,
  readEntryHits,
  rowQuery,
  searchEntries,
  tableTerms,
  SNIPPET_SOURCE_LENGTH,
  type EntrySearchHit,
  type EntrySearchResult,
  type TableMatch,
} from '@snaglet/db/tables/table_entries';
import { TableSemantic } from '@snaglet/db/tables/table_semantic';
import { TableFields } from '@snaglet/db/tables/table_fields';
import type { TableEntryWhere } from '@snaglet/shared/types';
import { AppError, clampInt, getErrorMessage, safeJsonParse } from '@snaglet/shared/utils';
import { resolveEntryTable } from '@server/services/search/paletteEntrySearch';
import {
  fuseRankings,
  SEMANTIC_MAX_DISTANCE,
  type EntryMatch,
} from '@server/services/search/entryFusion';
import {
  timePhraseIn,
  searchEntriesWithTime,
  textWords,
  type TimeMatch,
} from '@server/services/search/entryTimeSearch';
import type { MonthPhrase } from '@server/services/search/monthPhrase';
import { searchSemantic } from '@server/services/tableSemantic/TableSemanticService';
import type { ToolHandler } from '@server/services/ToolService/types';

async function tableNames(ids: readonly string[]): Promise<Map<string, string>> {
  if (!ids.length) return new Map();
  const { rows } = await getDb().query<{ id: string; name: string }>(
    'SELECT id, name FROM public.table_catalog WHERE id = ANY($1::text[])',
    [[...ids]]
  );
  return new Map(rows.map((row) => [row.id, row.name]));
}

/** Tables one search reads when no `table` is named; the reply says how many were left out. */
export const ENTRY_SEARCH_MAX_TABLES = 40;
/** Tables a query with no `table` searches once the tables are matched to it. */
const ENTRY_MATCH_TABLES = 3;
/** Further matching tables the reply names, so the model can widen to them. */
const ALSO_MATCHED_SHOWN = 5;
const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 50;
/** Characters of a snippet around the match. */
const SNIPPET_WINDOW = 140;

function text(value: unknown, key: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') throw new Error(`${key} must be a string.`);
  return value.trim() || undefined;
}

/** A short excerpt of `source` around the first occurrence of `term`, with ellipses where cut. */
export function snippetAround(source: string, term: string): string {
  const flat = source.replace(/\s+/g, ' ').trim().slice(0, SNIPPET_SOURCE_LENGTH);
  const at = flat.toLowerCase().indexOf(term.toLowerCase());
  const start = at < 0 ? 0 : Math.max(0, at - Math.floor((SNIPPET_WINDOW - term.length) / 2));
  const end = Math.min(flat.length, start + SNIPPET_WINDOW);
  return `${start > 0 ? '…' : ''}${flat.slice(start, end)}${end < flat.length ? '…' : ''}`;
}

/** The first keyword of `query`, as the search reads it (a quoted phrase stays whole). */
function firstTerm(query: string): string | null {
  const match = /"([^"]*)"|[^\s"]+/.exec(query);
  const term = (match?.[1] ?? match?.[0] ?? '').trim();
  return term || null;
}

/**
 * `filters` as field conditions: `[{field, operator, value?}]` (as `table`
 * op:query `where`), or a JSON string of one. Field names become field ids
 * of the named table; unknown names and operators are refused with the
 * valid names.
 */
async function readFilters(raw: unknown, tableId: string | null): Promise<TableEntryWhere[]> {
  if (raw === undefined || raw === null) return [];
  const list: unknown = typeof raw === 'string' ? safeJsonParse<unknown>(raw, null) : raw;
  if (!Array.isArray(list))
    throw new Error('filters must be a list of {field, operator, value} conditions.');
  if (!list.length) return [];
  if (!tableId) throw new Error('filters apply to one table: pass table too.');
  const fields = (await TableFields.listFields(tableId)).filter((field) => !field.managed);
  const byName = new Map(fields.map((field) => [field.name.toLowerCase(), field]));
  return list.map((item: unknown, index) => {
    const condition = (item ?? {}) as { field?: unknown; operator?: unknown; value?: unknown };
    const name = typeof condition.field === 'string' ? condition.field.trim() : '';
    const field = byName.get(name.toLowerCase());
    if (!field)
      throw new Error(
        `filters[${index}].field names an unknown field: ${name || '(none)'}. Valid names: ${fields.map((f) => f.name).join(', ') || '(none)'}.`
      );
    if (typeof condition.operator !== 'string' || !condition.operator)
      throw new Error(`filters[${index}].operator is required.`);
    return {
      fieldId: field.id,
      operator: condition.operator,
      ...(condition.value !== undefined ? { value: condition.value } : {}),
    } as TableEntryWhere;
  });
}

async function projectNames(ids: ReadonlyArray<string | null>): Promise<Map<string, string>> {
  const wanted = [...new Set(ids.filter((id): id is string => id !== null))];
  if (!wanted.length) return new Map();
  const { rows } = await getDb().query<{ id: string; name: string }>(
    'SELECT id, name FROM public.containers WHERE id = ANY($1::text[])',
    [wanted]
  );
  return new Map(rows.map((row) => [row.id, row.name]));
}

/**
 * search(kinds:["entry"]): rows of the custom Database tables by keyword.
 * Keywords are matched the way a table's own search box matches them (title
 * field first: exact, then prefix, then the rest; text, select, number and
 * date columns too); `sort:"recent"` orders by creation time instead. Only
 * active custom tables are read; an archived or Snaglet table named in `table` is
 * refused by name. Replies carry the title, table, project and a short
 * snippet, never whole rows: read one with table(op:read, table, ids).
 */
/** What a month phrase did, in words, so a model can say it and correct it. */
function monthNote(month: MonthPhrase, dateFields: readonly string[], found: number): string {
  const fields = dateFields.length ? dateFields.join(', ') : 'no date field';
  const text = month.range.monthName
    ? ` Rows that mention "${month.range.monthName}" are included too (found_by: text or both).`
    : '';
  const none =
    found === 0
      ? ' Nothing matched; name the table or field (for example "due"), or give another month.'
      : '';
  const { from, to } = month.range;
  const days = from && to ? `${from} to before ${to}` : from ? `from ${from} on` : `before ${to}`;
  return `Rows with ${fields} ${from && to ? 'in' : 'dated'} ${month.range.label} (${days}), ${month.range.direction === 'past' ? 'newest' : 'soonest'} first.${text}${none}`;
}

const tool: ToolHandler = async (input) => {
  const rawQuery = text(input.query, 'query') ?? '';
  // A month phrase ("due next month", "in June") becomes a date range on the rows; the
  // rest of the words are what to look for.
  const month = rawQuery ? timePhraseIn(rawQuery) : null;
  const tableName = text(input.table, 'table');
  const projectId = text(input.project_id, 'project_id');
  if (input.sort !== undefined && input.sort !== 'relevance' && input.sort !== 'recent')
    throw new Error('sort must be relevance or recent.');
  const limit = clampInt(input.limit, DEFAULT_LIMIT, 1, MAX_LIMIT);

  let tableId: string | null = null;
  let query = month ? month.residual : rawQuery;
  if (tableName) {
    const resolved = await resolveEntryTable(tableName);
    if (resolved.status !== 'resolved') throw new Error(resolved.message);
    tableId = resolved.tableId;
    // "tasks due next month" with table "tasks": the table's own name says where, not what.
    if (month) query = rowQuery(query, tableTerms(resolved.tableName));
  }
  const where = await readFilters(input.filters, tableId);

  // Table-level matching first: score the tables by name, field names, select
  // options and field descriptions, then read rows in only the best few. An
  // explicit `table`, `match_tables: false` or a query no table answers to
  // searches as before (the first 40 tables).
  const matching = !tableId && query !== '' && input.match_tables !== false;
  const matches: TableMatch[] = matching
    ? await matchTables(query, projectId ? { projectId } : {})
    : [];
  const chosen = matches.slice(0, ENTRY_MATCH_TABLES);
  // The words that named the best table said which table to read; the rest
  // are what to look for in its rows ("task memories": table tasks, rows memories).
  const best = chosen[0];
  const rowTerms = best ? rowQuery(query, best.nameTerms) : query;

  const run = (
    tableIds: readonly string[] | null,
    q: string
  ): Promise<EntrySearchResult & { hits: Array<EntrySearchHit & { monthMatch?: TimeMatch }> }> => {
    const options = {
      q,
      limit,
      sort: input.sort === 'recent' || (!q && input.sort === undefined) ? 'recent' : 'relevance',
      snippets: true,
      ...(tableIds ? { tableIds: [...tableIds] } : { maxTables: ENTRY_SEARCH_MAX_TABLES }),
      ...(projectId ? { projectId } : {}),
      ...(where.length ? { where } : {}),
    } as const;
    return month ? searchEntriesWithTime(options, month) : searchEntries(options);
  };

  let result: Awaited<ReturnType<typeof run>>;
  let widened = false;
  try {
    result = tableId
      ? await run([tableId], query)
      : chosen.length
        ? await run(
            chosen.map((match) => match.tableId),
            rowTerms
          )
        : await run(null, query);
    // The matched tables had no row for the words: they may live in rows of a
    // table whose metadata never mentions them, so look everywhere.
    if (!result.hits.length && chosen.length && rowTerms) {
      result = await run(null, rowTerms);
      widened = true;
    }
  } catch (error) {
    if (error instanceof AppError && error.statusCode === 400)
      throw new Error(getErrorMessage(error));
    throw error;
  }

  // Search by meaning, for the tables that have it on (on by default up to the
  // row cap, built in the background; the keyword search above never waited on
  // it). A field filter has no meaning-side equivalent, so it keeps the search
  // keyword-only.
  const mode = input.mode === 'keyword' || input.mode === 'semantic' ? input.mode : 'hybrid';
  const meaningWords = tableId || !chosen.length || widened ? query : rowTerms;
  // With a month phrase only the other words (not "due", not fillers) are worth a meaning search.
  const meaningQuery = month ? textWords(meaningWords) : meaningWords;
  let hits: Array<EntrySearchHit & { match?: EntryMatch; monthMatch?: TimeMatch }> = result.hits;
  let semantic: { tables: string[]; indexing: string[]; used: boolean; note?: string } | undefined;
  if (mode !== 'keyword' && meaningQuery && !where.length) {
    try {
      const scope =
        tableId !== null
          ? [tableId]
          : chosen.length && !widened
            ? chosen.map((match) => match.tableId)
            : await TableSemantic.listSearchable(projectId ? { projectId } : {});
      const found = await searchSemantic(scope, meaningQuery, limit * 3);
      if (found.tableIds.length) {
        const close = found.hits.filter((hit) => hit.distance <= SEMANTIC_MAX_DISTANCE);
        const keyOf = (ref: { tableId: string; entryId: string }) =>
          `${ref.tableId}/${ref.entryId}`;
        const known = new Map<string, EntrySearchHit>(result.hits.map((hit) => [keyOf(hit), hit]));
        const fused = fuseRankings(
          result.hits.map(keyOf),
          close.map(keyOf),
          mode === 'semantic' ? 'semantic' : 'hybrid'
        ).slice(0, limit * 2);
        const missing = fused
          .filter((item) => !known.has(item.key))
          .map((item) => {
            const [tableIdPart, entryId] = item.key.split('/') as [string, string];
            return { tableId: tableIdPart, entryId };
          });
        for (const hit of await readEntryHits(missing)) known.set(keyOf(hit), hit);
        // A row whose vector outlived it (a failed delete) is not read back, so it
        // cannot be returned; the spare candidates keep the page full.
        hits = fused
          .flatMap((item) => {
            const hit = known.get(item.key);
            return hit ? [{ ...hit, match: item.match }] : [];
          })
          .slice(0, limit);
        const names = await tableNames(found.tableIds);
        semantic = {
          tables: found.tableIds.map((id) => names.get(id) ?? id),
          indexing: found.indexing.map((id) => names.get(id) ?? id),
          used: close.length > 0,
          ...(found.indexing.length
            ? {
                note: found.paused
                  ? `The meaning index of some tables is not complete and is not being built: ${found.paused} Keyword results are complete.`
                  : 'Still building the meaning index for some tables; keyword results are complete.',
              }
            : {}),
        };
      }
    } catch (error) {
      semantic = {
        tables: [],
        indexing: [],
        used: false,
        note: `Meaning search was skipped: ${getErrorMessage(error)}`,
      };
    }
  }

  const term = firstTerm(query);
  const projects = await projectNames(hits.map((hit) => hit.projectId));
  return JSON.stringify(
    {
      entries: hits.map((hit) => ({
        id: hit.entryId,
        ref: `entry:${hit.tableId}/${hit.entryId}`,
        title: hit.name || '(untitled)',
        table: hit.tableName,
        ...(hit.projectId ? { project: projects.get(hit.projectId) ?? hit.projectId } : {}),
        ...(hit.snippet
          ? { snippet: snippetAround(hit.snippet, hit.match === 'meaning' || !term ? '' : term) }
          : {}),
        ...(semantic?.used ? { match: hit.match ?? 'keyword' } : {}),
        ...(hit.monthMatch ? { found_by: hit.monthMatch } : {}),
        created_at: hit.createdAt,
      })),
      tables_searched: result.tablesSearched,
      ...(month
        ? {
            time: {
              phrase: month.matched,
              range: month.range.label,
              from: month.range.from,
              before: month.range.to,
              date_fields: result.dateFields ?? [],
              note: monthNote(month, result.dateFields ?? [], hits.length),
            },
          }
        : {}),
      ...(semantic ? { semantic } : {}),
      ...(matching
        ? {
            table_match: {
              chosen: chosen.map((match) => ({ table: match.tableName, why: match.why })),
              ...(matches.length > chosen.length
                ? {
                    also_matched: matches
                      .slice(chosen.length, chosen.length + ALSO_MATCHED_SHOWN)
                      .map((match) => match.tableName),
                  }
                : {}),
              ...(chosen.length && !widened && rowTerms !== query
                ? { searched_for: rowTerms || '(newest rows)' }
                : {}),
              ...(widened ? { widened: true } : {}),
              note: !matches.length
                ? 'No table name, field name or select option matched the query, so up to 40 tables were searched.'
                : widened
                  ? `No rows matched in ${chosen.map((m) => m.tableName).join(', ')}, so every table was searched for "${rowTerms}".`
                  : 'Searched the best-matching tables only; name one with table, or pass match_tables: false to search them all.',
            },
          }
        : {}),
      ...(result.tablesOmitted
        ? {
            tables_omitted: result.tablesOmitted,
            note: `Only the first ${result.tablesSearched} tables were searched; pass table or project_id to search the rest.`,
          }
        : {}),
      ...(result.hits.length === limit
        ? { note_more: 'There may be more matches; narrow the query or raise limit.' }
        : {}),
    },
    null,
    2
  );
};

export default tool;
