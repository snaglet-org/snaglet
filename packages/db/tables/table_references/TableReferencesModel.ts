/**
 * The Snaglet items relation fields may link to (`table_fields.reference_kind`):
 * a closed allowlist with one fixed resolver per kind. Resolvers read only an
 * id, a title, an archived flag and a context line (the parent container's
 * name, an agent's role, a member's role or email) — never content, prompts,
 * credentials, key hashes or provider settings — and nothing outside the
 * allowlist is ever queried.
 *
 * Links have no foreign key. {@link assertLinkable}
 * checks the ids a write adds and locks them FOR KEY SHARE, as a foreign key
 * check would: a purge waits for the write, an archive (a non-key update)
 * does not. Stored ids that were archived or purged since stay put; reads
 * show them as archived or leave them out (unavailable). A purged agent's
 * links are cleared ({@link clearAgentLinks}), because a new agent may take
 * its name slug as its id.
 */
import { getDb, transaction, type DbQueryable } from '@snaglet/db/db';
import { quoteIdentifier } from '@snaglet/db/sql-utils';
import {
  CUSTOM_TABLES_SCHEMA,
  type TableCatalogRow,
  TableCatalog,
} from '@snaglet/db/tables/table_catalog';
import {
  helperAgentExclusionSql,
  helperMemberExclusionSql,
} from '@snaglet/db/tables/agents/visibility';
import { visibleThreadRowSql } from '@snaglet/db/tables/threads/visibility';
import { GHOST_AGENT_ID, GHOST_MEMBER_ID } from '@snaglet/shared/constants';
import {
  ErrorCode,
  TABLE_ENTRY_SEARCH_DEFAULT_LIMIT,
  TABLE_ENTRY_SEARCH_MAX_EXCLUDE,
  TABLE_ENTRY_SEARCH_MAX_LIMIT,
  TABLE_ENTRY_SEARCH_MAX_OFFSET,
  TABLE_ENTRY_SEARCH_QUERY_MAX_LENGTH,
  TABLE_REFERENCE_ID_PATTERN,
  TABLE_REFERENCE_KINDS,
  type RelatedTableItems,
  type TableReferenceItem,
  type TableReferenceKind,
  type TableReferenceSearchQuery,
  type TableReferenceSearchResponse,
} from '@snaglet/shared/types';
import {
  AppError,
  isTableReferenceKind,
  tableReferenceKindArticle,
  tableReferenceKindName,
} from '@snaglet/shared/utils';

function badRequest(message: string): AppError {
  return new AppError(message, ErrorCode.VALIDATION_ERROR, 400);
}

/**
 * One kind's resolver. `from` joins the lockable row (`spine`) to its content
 * table; `columns` selects `id`, `title`, `archived`, `context`, `updated_at`
 * and `eligible` (whether the row can be linked as this kind: a project
 * container).
 */
interface KindSource {
  from: string;
  /** The row an added link locks FOR KEY SHARE. */
  spine: string;
  /** The title expression, as `columns` selects it. */
  title: string;
  columns: string;
  /** Rows that are this kind's items at all; ids of other rows read as missing. */
  where: string;
  /** Why a row that exists is not linkable as this kind, when `eligible` is false. */
  ineligible?: string;
  /** The `nodes.type` of a node-backed kind. */
  nodeType?: string;
}

function nodeSource(
  type: string,
  table: string,
  title: string,
  eligible = 'true',
  ineligible?: string,
  where?: string
): KindSource {
  return {
    from: `public.nodes AS n JOIN public.${table} AS t ON t.id = n.id
           LEFT JOIN public.containers AS parent ON parent.id = n.container_id`,
    spine: 'n',
    title,
    columns: `n.id, ${title} AS title, n.archived, parent.name AS context,
              n.updated_at, ${eligible} AS eligible`,
    where: where ? `n.type = '${type}' AND ${where}` : `n.type = '${type}'`,
    ...(ineligible ? { ineligible } : {}),
    nodeType: type,
  };
}

const SOURCES: Readonly<Record<TableReferenceKind, KindSource>> = {
  doc: nodeSource('doc', 'docs', "COALESCE(NULLIF(btrim(t.title), ''), 'Untitled doc')"),
  project: nodeSource(
    'container',
    'containers',
    't.name',
    "t.category IS NOT DISTINCT FROM 'project'",
    'is a container, not a project'
  ),
  container: nodeSource('container', 'containers', 't.name'),
  // Subagent helper threads are never items: they live inside their parent.
  thread: nodeSource(
    'thread',
    'threads',
    "COALESCE(NULLIF(btrim(t.title), ''), 'Untitled thread')",
    'true',
    undefined,
    visibleThreadRowSql('t')
  ),
  image: nodeSource('image', 'images', "COALESCE(NULLIF(btrim(t.alt_text), ''), 'Untitled image')"),
  agent: {
    from: 'public.agents AS a',
    spine: 'a',
    title: 'a.name',
    columns: 'a.id, a.name AS title, a.archived, a.role AS context, a.updated_at, true AS eligible',
    // The ghost system agent, subagent helpers and vestigial tombstones are
    // never items.
    where: `a.deleted_at IS NULL AND a.id <> '${GHOST_AGENT_ID}' AND ${helperAgentExclusionSql('a')}`,
  },
  // A workspace member: an agent's, a user's or an external MCP client's
  // principal row. Its display name lives on the principal (agents.name,
  // users.name, mcp_api_keys.name), as members.routes.ts resolves it; the
  // context line is the agent's role, the user's email or the client kind.
  // Archived agents and deactivated users read as archived; a tombstoned
  // agent, the ghost, a subagent helper and a member whose principal has no
  // name (a revoked key) are never items. A purged agent's or user's member
  // row cascades away, so its links read as unavailable like any purged item.
  member: {
    from: `public.members AS m
           LEFT JOIN public.agents AS a ON a.id = m.agent_id
           LEFT JOIN public.users AS u ON u.id::text = m.user_id::text
           LEFT JOIN public.mcp_api_keys AS k ON k.member_id = m.id`,
    spine: 'm',
    title: 'COALESCE(a.name, u.name, k.name)',
    columns: `m.id, COALESCE(a.name, u.name, k.name) AS title,
              COALESCE(a.archived, NOT u.active, false) AS archived,
              CASE m.kind
                WHEN 'agent' THEN a.role
                WHEN 'user' THEN u.email
                ELSE 'external MCP client'
              END AS context,
              m.updated_at, true AS eligible`,
    where: `m.id <> '${GHOST_MEMBER_ID}' AND (a.id IS NULL OR a.deleted_at IS NULL)
            AND ${helperMemberExclusionSql('m')}
            AND COALESCE(a.name, u.name, k.name) IS NOT NULL`,
  },
};

/**
 * SQL that is true when `column` (an item relation's column: one id, or a
 * `text[]` list when `multiple`) links an item of `kind` whose title — as
 * reads show it, archived items included — matches the ILIKE `pattern` (a
 * bound parameter, `\` escapes). Purged items never match. For entry
 * filters, which match a relation by what its chip displays.
 */
export function itemTitleMatch(
  kind: TableReferenceKind,
  column: string,
  multiple: boolean,
  pattern: string
): string {
  const source = SOURCES[kind];
  const link = multiple ? `= ANY(${column})` : `= ${column}`;
  return `EXISTS (SELECT 1 FROM ${source.from}
                   WHERE ${source.where} AND ${source.spine}.id ${link}
                     AND (${source.title}) ILIKE ${pattern} ESCAPE '\\')`;
}

/** `value` as a literal ILIKE pattern body: `\`, `%` and `_` escaped. */
function likeLiteral(value: string): string {
  return value.replace(/[\\%_]/g, '\\$&');
}

/**
 * Titles of the given items (ids as stored), one query per kind. Archived
 * items are included and flagged; purged ones, other kinds' ids and anything
 * a kind never resolves (the ghost agent) are absent.
 */
async function readItems(
  idsByKind: ReadonlyMap<TableReferenceKind, readonly string[]>,
  runner: DbQueryable = getDb()
): Promise<RelatedTableItems> {
  const related: RelatedTableItems = {};
  for (const [kind, ids] of idsByKind) {
    const unique = [...new Set(ids)];
    if (!unique.length) continue;
    const source = SOURCES[kind];
    const { rows } = await runner.query<{ id: string; title: string; archived: boolean }>(
      `SELECT ${source.columns} FROM ${source.from}
        WHERE ${source.where} AND ${source.spine}.id = ANY($1::text[])`,
      [unique]
    );
    if (!rows.length) continue;
    const items: Record<string, TableReferenceItem> = {};
    for (const row of rows)
      Object.defineProperty(items, row.id, {
        value: { title: row.title, archived: row.archived },
        enumerable: true,
        configurable: true,
        writable: true,
      });
    related[kind] = items;
  }
  return related;
}

/** The ids that are items of `kind` (archived ones included). */
async function existingItems(
  kind: TableReferenceKind,
  ids: readonly string[],
  runner: DbQueryable = getDb()
): Promise<Set<string>> {
  const unique = [...new Set(ids)];
  if (!unique.length) return new Set();
  const source = SOURCES[kind];
  const { rows } = await runner.query<{ id: string; eligible: boolean }>(
    `SELECT ${source.columns} FROM ${source.from}
      WHERE ${source.where} AND ${source.spine}.id = ANY($1::text[])`,
    [unique]
  );
  return new Set(rows.filter((row) => row.eligible).map((row) => row.id));
}

/**
 * Refuse (400, prefixed with `label`) any id that is missing, of another
 * kind or not live, and lock the rest FOR KEY SHARE until the caller's
 * transaction ends. Only ids a write adds are checked, so links that were
 * archived or purged since survive edits and reorders.
 */
async function assertLinkable(
  kind: TableReferenceKind,
  ids: readonly string[],
  label: string,
  tx: DbQueryable
): Promise<void> {
  const unique = [...new Set(ids)].sort();
  if (!unique.length) return;
  const source = SOURCES[kind];
  const { rows } = await tx.query<{ id: string; archived: boolean; eligible: boolean }>(
    `SELECT ${source.columns} FROM ${source.from}
      WHERE ${source.where} AND ${source.spine}.id = ANY($1::text[])
      ORDER BY ${source.spine}.id FOR KEY SHARE OF ${source.spine}`,
    [unique]
  );
  const found = new Map(rows.map((row) => [row.id, row]));
  for (const id of unique) {
    const row = found.get(id);
    if (!row) {
      const other = await otherNodeType(kind, id, tx);
      throw badRequest(
        other
          ? `${label}: ${id} is ${other}, not ${tableReferenceKindArticle(kind)}.`
          : `${label}: there is no ${tableReferenceKindName(kind)} ${id}.`
      );
    }
    if (!row.eligible)
      throw badRequest(`${label}: ${id} ${source.ineligible ?? 'cannot be linked'}.`);
    if (row.archived) throw badRequest(`${label}: ${id} is archived. Restore it before linking.`);
  }
}

/** The article-and-type (`a thread`) of a workspace node with this id, for messages. */
async function otherNodeType(
  kind: TableReferenceKind,
  id: string,
  tx: DbQueryable
): Promise<string | null> {
  if (kind === 'agent' || kind === 'member') return null;
  const { rows } = await tx.query<{ type: string }>(
    'SELECT type::text AS type FROM public.nodes WHERE id = $1',
    [id]
  );
  const type = rows[0]?.type;
  // A node of this very type that the kind leaves out (a subagent helper
  // thread) reads as missing, not as another kind.
  if (!type || type === SOURCES[kind].nodeType) return null;
  const name = type.replace(/_/g, ' ');
  return `${/^[aeiou]/i.test(name) ? 'an' : 'a'} ${name}`;
}

interface ParsedSearch {
  kind: TableReferenceKind;
  q: string;
  limit: number;
  offset: number;
  exclude: string[];
}

function parseSearch(query: TableReferenceSearchQuery): ParsedSearch {
  if (!isTableReferenceKind(query.kind))
    throw badRequest(`kind must be one of ${TABLE_REFERENCE_KINDS.join(', ')}.`);
  if (query.q !== undefined && typeof query.q !== 'string') throw badRequest('q must be text.');
  const q = (query.q ?? '').trim();
  if (q.length > TABLE_ENTRY_SEARCH_QUERY_MAX_LENGTH)
    throw badRequest(`q can be at most ${TABLE_ENTRY_SEARCH_QUERY_MAX_LENGTH} characters.`);
  const limit = query.limit ?? TABLE_ENTRY_SEARCH_DEFAULT_LIMIT;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > TABLE_ENTRY_SEARCH_MAX_LIMIT)
    throw badRequest(`limit must be between 1 and ${TABLE_ENTRY_SEARCH_MAX_LIMIT}.`);
  const offset = query.offset ?? 0;
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > TABLE_ENTRY_SEARCH_MAX_OFFSET)
    throw badRequest(`offset must be between 0 and ${TABLE_ENTRY_SEARCH_MAX_OFFSET}.`);
  const exclude = query.exclude ?? [];
  if (!Array.isArray(exclude) || exclude.length > TABLE_ENTRY_SEARCH_MAX_EXCLUDE)
    throw badRequest(`exclude can list at most ${TABLE_ENTRY_SEARCH_MAX_EXCLUDE} ids.`);
  if (exclude.some((id) => typeof id !== 'string' || !TABLE_REFERENCE_ID_PATTERN.test(id)))
    throw badRequest('exclude must list item ids.');
  return { kind: query.kind, q, limit, offset, exclude };
}

/**
 * Live items of one kind for a relation picker, best first: title starts
 * with `q`, then title contains it (case-insensitive, literal; an exact id
 * matches too), ties most recently updated first. An empty `q` lists the most
 * recently updated. `exclude` is left out before paging.
 */
async function search(
  query: TableReferenceSearchQuery,
  runner: DbQueryable = getDb()
): Promise<TableReferenceSearchResponse> {
  const { kind, q, limit, offset, exclude } = parseSearch(query);
  const source = SOURCES[kind];
  const params: unknown[] = [];
  const param = (value: unknown) => `$${params.push(value)}`;
  const conditions = ['NOT item.archived', 'item.eligible'];
  const order: string[] = [];
  if (exclude.length) conditions.push(`item.id <> ALL(${param(exclude)}::text[])`);
  if (q) {
    const contains = param(`%${likeLiteral(q)}%`);
    const prefix = param(`${likeLiteral(q)}%`);
    conditions.push(`(item.title ILIKE ${contains} ESCAPE '\\' OR item.id = ${param(q)})`);
    order.push(
      `CASE WHEN item.title ILIKE ${prefix} ESCAPE '\\' THEN 0 WHEN item.title ILIKE ${contains} ESCAPE '\\' THEN 1 ELSE 2 END`
    );
  }
  order.push('item.updated_at DESC', 'item.id');
  const { rows } = await runner.query<{ id: string; title: string; context: string | null }>(
    `SELECT item.id, item.title, item.context
       FROM (SELECT ${source.columns} FROM ${source.from} WHERE ${source.where}) AS item
      WHERE ${conditions.join(' AND ')}
      ORDER BY ${order.join(', ')}
      LIMIT ${param(limit + 1)} OFFSET ${param(offset)}`,
    params
  );
  return {
    hasMore: rows.length > limit,
    results: rows.slice(0, limit).map((row) => ({
      id: row.id,
      title: row.title,
      context: row.context?.trim() ? row.context : null,
    })),
  };
}

/**
 * Live items of `kind` whose title is exactly `title` (ignoring case and
 * surrounding space), at most `max`, for agents that name an item instead of
 * giving its id.
 */
async function findByTitle(
  kind: TableReferenceKind,
  title: string,
  max: number,
  runner: DbQueryable = getDb()
): Promise<Array<{ id: string; title: string }>> {
  const source = SOURCES[kind];
  const { rows } = await runner.query<{ id: string; title: string }>(
    `SELECT item.id, item.title
       FROM (SELECT ${source.columns} FROM ${source.from} WHERE ${source.where}) AS item
      WHERE NOT item.archived AND item.eligible AND lower(btrim(item.title)) = lower(btrim($1))
      ORDER BY item.updated_at DESC, item.id LIMIT $2`,
    [title, max]
  );
  return rows;
}

/** Entries whose links a purge cleared, per table, for realtime reloads. */
export interface ClearedItemLinks {
  tableId: string;
  entryIds: string[];
}

/**
 * Remove `agentId` from every agent relation: single links become null,
 * lists keep their other links in order. Covers archived and deleted fields
 * and tables too (their tombstone columns), so nothing the id pointed at can
 * resurface when a new agent takes its slug. Runs in the purge's
 * transaction; returns the visible entries it changed. The clears are not
 * history steps, so undoing an older step that touched them refuses instead
 * of overwriting.
 */
async function clearAgentLinks(agentId: string, tx: DbQueryable): Promise<ClearedItemLinks[]> {
  const fields = async () =>
    (
      await tx.query<{
        field_id: string;
        column_name: string;
        multiple: boolean;
        field_state: string;
        table_id: string;
      }>(
        `SELECT field.id AS field_id, field.column_name, field.multiple, field.state AS field_state,
                field.table_id
           FROM public.table_fields AS field
           JOIN public.table_catalog AS catalog ON catalog.id = field.table_id
          WHERE field.reference_kind = 'agent' AND catalog.origin = 'custom'
          ORDER BY field.table_id, field.id`
      )
    ).rows;
  const tableIds = [...new Set((await fields()).map((field) => field.table_id))];
  if (!tableIds.length) return [];
  // Field DDL holds these FOR UPDATE; re-read the columns once it has finished.
  await tx.query(
    'SELECT id FROM public.table_catalog WHERE id = ANY($1::text[]) ORDER BY id FOR SHARE',
    [tableIds]
  );
  const tables = new Map<string, TableCatalogRow>();
  for (const id of tableIds) {
    const row = await TableCatalog.findById(id, tx);
    if (row) tables.set(id, row);
  }
  const cleared = new Map<string, Set<string>>();
  for (const field of await fields()) {
    const table = tables.get(field.table_id);
    if (!table) continue;
    const target = `${quoteIdentifier(CUSTOM_TABLES_SCHEMA)}.${quoteIdentifier(table.tableName)}`;
    const column = quoteIdentifier(field.column_name);
    // A column or table dropped outside Snaglet holds no links to clear.
    await tx.query('SAVEPOINT snaglet_clear_agent_links');
    let rows: Array<{ id: string }>;
    try {
      rows = (
        await tx.query<{ id: string }>(
          field.multiple
            ? `UPDATE ONLY ${target} SET ${column} = array_remove(${column}, $1::text)
                WHERE ${column} @> ARRAY[$1::text] RETURNING id::text AS id`
            : `UPDATE ONLY ${target} SET ${column} = NULL WHERE ${column} = $1::text RETURNING id::text AS id`,
          [agentId]
        )
      ).rows;
      await tx.query('RELEASE SAVEPOINT snaglet_clear_agent_links');
    } catch (error) {
      const code =
        typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined;
      if (code !== '42703' && code !== '42P01') throw error;
      await tx.query('ROLLBACK TO SAVEPOINT snaglet_clear_agent_links');
      continue;
    }
    if (!rows.length || field.field_state !== 'active' || table.state !== 'active') continue;
    const ids = cleared.get(table.id) ?? new Set<string>();
    for (const row of rows) ids.add(row.id);
    cleared.set(table.id, ids);
  }
  return [...cleared].map(([tableId, ids]) => ({ tableId, entryIds: [...ids] }));
}

class TableReferencesModelClass {
  readItems = readItems;
  existingItems = existingItems;
  assertLinkable = assertLinkable;
  findByTitle = findByTitle;
  clearAgentLinks = clearAgentLinks;

  /** {@link search} in a read-only snapshot with the usual lock and statement timeouts. */
  async search(query: TableReferenceSearchQuery): Promise<TableReferenceSearchResponse> {
    parseSearch(query);
    return transaction(async (tx) => {
      await tx.query('SET LOCAL statement_timeout = 15000');
      return search(query, tx);
    });
  }
}

export const TableReferences = new TableReferencesModelClass();
