import { getDb } from '@snaglet/db';
import { helperThreadExclusionSql } from '@snaglet/db/tables/threads/visibility';
import type { SemanticSearchKind } from '@server/services/ToolService/handlers/search/workspaceSearch/types';
import type { RankedCandidate } from './fuseRRF';
import type { ResolvedScope } from './searchPolicy';
import { rankCd, titleWordsPrefixSql, toolTsQuery, typeaheadWords } from './lexicalQuery';
import {
  timeRangeBoostSql,
  timeRangeFilterSql,
  timeRangeParams,
  type NormalizedSearchTimeRange,
} from './timeRange';
import type { StructuredSearchOrder } from './searchPolicy';
import { MAX_TREE_DEPTH } from '@server/services/ToolService/lib/scopeParentSql';

export type NodeKind = 'doc' | 'thread' | 'container' | 'message' | 'tool';

const FUZZY_KINDS = new Set<SemanticSearchKind>(['doc', 'memory']);

export interface NodeFtsCandidate extends RankedCandidate {
  channel: 'fts';
  kind: NodeKind;
}

/**
 * Index-served trigram gate shared by the semantic fuzzy-title booster and
 * structural lexical fallback.
 */
export function trigramGateSql(column: string, param: string): string {
  return `(${column} % ${param} OR ${param} <% ${column})`;
}

/**
 * Trigram score for short queries against longer titles and paths.
 */
export function trigramScoreSql(column: string, param: string): string {
  return `GREATEST(similarity(${column}, ${param}), word_similarity(${param}, ${column}))`;
}

/**
 * Fuzzy name-matching candidates for kinds whose names participate in the
 * semantic search path.
 */
export async function fuzzyTitleCandidates(args: {
  query: string;
  kinds: SemanticSearchKind[];
  limit: number;
  allowedContainerIds: string[] | null;
}): Promise<Array<{ id: string; kind: SemanticSearchKind; title: string | null }>> {
  const kinds = args.kinds.filter((kind) => FUZZY_KINDS.has(kind));
  if (kinds.length === 0 || !args.query.trim()) return [];
  const kindSet = new Set(kinds);
  const branches: string[] = [];

  if (kindSet.has('doc')) {
    branches.push(`
      SELECT d.id, 'doc'::text AS kind, d.title,
             ${trigramScoreSql('d.title', '$1')} AS score
      FROM public.docs d
      JOIN public.nodes n ON n.id = d.id
      WHERE ${trigramGateSql('d.title', '$1')}
        AND n.archived = false
        AND ($2::text[] IS NULL OR n.container_id = ANY($2::text[]))
    `);
  }

  if (kindSet.has('memory')) {
    branches.push(`
      SELECT mem.id, 'memory'::text AS kind, mem.memory_key AS title,
             ${trigramScoreSql('mem.memory_key', '$1')} AS score
      FROM public.memories mem
      JOIN public.nodes n ON n.id = mem.id
      WHERE ${trigramGateSql('mem.memory_key', '$1')}
        AND n.archived = false
        AND ($2::text[] IS NULL OR n.container_id = ANY($2::text[]))
    `);
  }

  const { rows } = await getDb().query<{
    id: string;
    kind: SemanticSearchKind;
    title: string | null;
  }>(
    `
      SELECT id, kind, title
      FROM (
        ${branches.join('\nUNION ALL\n')}
      ) hits
      ORDER BY score DESC, id ASC
      LIMIT $3
    `,
    [args.query, args.allowedContainerIds, args.limit]
  );
  return rows;
}

const FTS_CHANNEL = 'fts' as const satisfies RankedCandidate['channel'];

type ScopedSql = {
  cte: string;
  params: unknown[];
};

/**
 * `descendants`: the live container subtree rooted at `seed` — the seed row
 * itself plus every un-archived container beneath it, bounded at
 * MAX_TREE_DEPTH like every other tree walk.
 */
function descendantsCte(seed: string): string {
  return `
          descendants AS (
            ${seed}
            UNION ALL
            SELECT child.id, parent.depth + 1
              FROM public.nodes child
              JOIN descendants parent ON child.container_id = parent.id
             WHERE child.type = 'container'
               AND child.archived = false
               AND parent.depth < ${MAX_TREE_DEPTH}
          )`;
}

/**
 * Subtree of a project container; empty when `param` is not a project.
 * (`c.id` is the primary key, so the seed is at most one row without a LIMIT —
 * which a UNION ALL branch could not carry anyway.)
 */
function projectDescendantsCte(param: string): string {
  return descendantsCte(`
            SELECT c.id AS id, 0 AS depth
              FROM public.containers c
             WHERE c.id = ${param}
               AND c.category = 'project'`);
}

/** Subtree of any live container. */
function containerDescendantsCte(param: string): string {
  return descendantsCte(`
            SELECT n.id, 0 AS depth
              FROM public.nodes n
             WHERE n.id = ${param}
               AND n.type = 'container'
               AND n.archived = false`);
}

type WorkspaceLexicalKind = 'thread' | 'container';

function isWorkspaceLexicalKind(kind: NodeKind): kind is WorkspaceLexicalKind {
  return kind === 'thread' || kind === 'container';
}

/**
 * Scope membership for the kinds that are their own search surface. A
 * container is in scope when it is the scope container or nested in it. A
 * thread is not in the folder tree: it is in scope when its project
 * (`nodes.project_id`) is the scope container or nested in it — so a project
 * scope includes nested projects' threads, and a plain folder scope includes
 * the threads of every project beneath it. Messages and summaries (below)
 * follow their thread the same way. Subagent helper threads and their
 * messages are never in any scope.
 */
function scopedWorkspaceNodeIdsSql(kind: WorkspaceLexicalKind, scope: ResolvedScope): ScopedSql {
  const helperFilter = kind === 'thread' ? `AND ${helperThreadExclusionSql('n.id')}` : '';
  switch (scope.mode) {
    case 'project':
      if (!scope.project_id) throw new Error('project scope missing project_id');
      return {
        cte: `
          ${projectDescendantsCte('$1')},
          scoped AS (
            SELECT n.id AS node_id
              FROM public.nodes n
              JOIN descendants c
                ON ${kind === 'container' ? 'c.id = n.id' : 'c.id = n.project_id'}
             WHERE n.type = '${kind}'
               AND n.archived = false
               ${helperFilter}
          )
        `,
        params: [scope.project_id],
      };
    case 'container_subtree':
      if (!scope.container_id) throw new Error('container scope missing container_id');
      return {
        cte: `
          ${containerDescendantsCte('$1')},
          scoped AS (
            SELECT n.id AS node_id
              FROM public.nodes n
              JOIN descendants c
                ON ${kind === 'container' ? 'c.id = n.id' : 'c.id = n.project_id'}
             WHERE n.type = '${kind}'
               AND n.archived = false
               ${helperFilter}
          )
        `,
        params: [scope.container_id],
      };
    case 'root':
      return {
        cte: `
          scoped AS (
            SELECT n.id AS node_id
              FROM public.nodes n
             WHERE n.type = '${kind}'
               AND n.archived = false
               ${helperFilter}
          )
        `,
        params: [],
      };
    case 'none':
      return {
        cte: `scoped AS (SELECT NULL::text AS node_id WHERE false)`,
        params: [],
      };
  }
}

export function scopedNodeIdsSql(kind: NodeKind, scope: ResolvedScope): ScopedSql {
  if (isWorkspaceLexicalKind(kind)) return scopedWorkspaceNodeIdsSql(kind, scope);
  if (kind === 'tool') {
    return {
      cte: `
        scoped AS (
          SELECT t.id AS node_id
            FROM public.tools t
            JOIN public.nodes n ON n.id = t.id
           WHERE n.type = 'tool'
             AND n.archived = false
        )
      `,
      params: [],
    };
  }

  switch (scope.mode) {
    case 'project':
      if (!scope.project_id) throw new Error('project scope missing project_id');
      if (kind === 'doc') {
        return {
          cte: `
            ${projectDescendantsCte('$1')},
            scoped AS (
              SELECT d.id AS node_id
                FROM public.docs d
                JOIN public.nodes n ON n.id = d.id
                JOIN descendants c ON c.id = n.container_id
               WHERE n.type = 'doc'
                 AND n.archived = false
            )
          `,
          params: [scope.project_id],
        };
      }
      if (kind === 'message') {
        return {
          cte: `
            ${projectDescendantsCte('$1')},
            scoped AS (
              SELECT m.id AS node_id
                FROM public.messages m
                JOIN public.nodes mn ON mn.id = m.id
                JOIN public.nodes tn ON tn.id = m.thread_id
                JOIN descendants c ON c.id = tn.project_id
               WHERE mn.type = 'message'
                 AND mn.archived = false
                 AND tn.type = 'thread'
                 AND tn.archived = false
                 AND ${helperThreadExclusionSql('m.thread_id')}
            )
          `,
          params: [scope.project_id],
        };
      }
      throw new Error(`scopedNodeIdsSql: unsupported project-scoped kind ${kind}`);
    case 'container_subtree':
      if (!scope.container_id) throw new Error('container scope missing container_id');
      if (kind === 'doc') {
        return {
          cte: `
            ${containerDescendantsCte('$1')},
            scoped AS (
              SELECT d.id AS node_id
                FROM public.docs d
                JOIN public.nodes n ON n.id = d.id
                JOIN descendants c ON c.id = n.container_id
               WHERE n.type = 'doc'
                 AND n.archived = false
            )
          `,
          params: [scope.container_id],
        };
      }
      if (kind === 'message') {
        return {
          cte: `
            ${containerDescendantsCte('$1')},
            scoped AS (
              SELECT m.id AS node_id
                FROM public.messages m
                JOIN public.nodes mn ON mn.id = m.id
                JOIN public.nodes tn ON tn.id = m.thread_id
                JOIN descendants c ON c.id = tn.project_id
               WHERE mn.type = 'message'
                 AND mn.archived = false
                 AND tn.type = 'thread'
                 AND tn.archived = false
                 AND ${helperThreadExclusionSql('m.thread_id')}
            )
          `,
          params: [scope.container_id],
        };
      }
      throw new Error(`scopedNodeIdsSql: unsupported container-scoped kind ${kind}`);
    case 'root':
      if (kind === 'doc') {
        return {
          cte: `
            scoped AS (
              SELECT d.id AS node_id
                FROM public.docs d
                JOIN public.nodes n ON n.id = d.id
               WHERE n.type = 'doc'
                 AND n.archived = false
            )
          `,
          params: [],
        };
      }
      if (kind === 'message') {
        return {
          cte: `
            scoped AS (
              SELECT m.id AS node_id
                FROM public.messages m
                JOIN public.nodes mn ON mn.id = m.id
                JOIN public.nodes tn ON tn.id = m.thread_id
               WHERE mn.type = 'message'
                 AND mn.archived = false
                 AND tn.type = 'thread'
                 AND tn.archived = false
                 AND ${helperThreadExclusionSql('m.thread_id')}
            )
          `,
          params: [],
        };
      }
      throw new Error(`scopedNodeIdsSql: unsupported root-scoped kind ${kind}`);
    case 'none':
      return {
        cte: `scoped AS (SELECT NULL::text AS node_id WHERE false)`,
        params: [],
      };
  }
}

export async function ftsSearchNodes(args: {
  query: string;
  kind: NodeKind;
  scope: ResolvedScope;
  limit: number;
  timeRange?: NormalizedSearchTimeRange | null;
  orderBy?: StructuredSearchOrder;
  /**
   * Interactive type-ahead (the palette and `@` search): a doc, thread or
   * folder whose title has every typed word as a word start also matches.
   */
  typeahead?: boolean;
}): Promise<NodeFtsCandidate[]> {
  const query = args.query.trim();
  if (!query || args.limit < 1) return [];
  const scoped = scopedNodeIdsSql(args.kind, args.scope);
  const queryIdx = scoped.params.length + 1;
  const fromIdx = scoped.params.length + 2;
  const toIdx = scoped.params.length + 3;
  const limitIdx = scoped.params.length + 4;
  const params: unknown[] = [
    ...scoped.params,
    query,
    ...timeRangeParams(args.timeRange ?? null),
    Math.max(1, Math.floor(args.limit)),
  ];
  // Only the titled kinds bind the words; an unused bind parameter is an error.
  const titled = args.kind === 'doc' || isWorkspaceLexicalKind(args.kind);
  const words = args.typeahead && titled ? typeaheadWords(query) : [];
  if (words.length > 0) params.push(words);
  const wordsIdx = scoped.params.length + 5;
  /** The lexical predicate, widened by the type-ahead title match when on. */
  const matchSql = (lexical: string, titleExpression: string) =>
    words.length > 0
      ? `(${lexical} OR ${titleWordsPrefixSql(titleExpression, `$${wordsIdx}`)})`
      : lexical;
  const orderedBy = (timeExpression: string, relevanceExpression: string, idExpression: string) => {
    if (args.orderBy === 'created_desc' || args.orderBy === 'updated_desc') {
      return `${timeExpression} DESC NULLS LAST, ${relevanceExpression} DESC, ${idExpression} ASC`;
    }
    return `${relevanceExpression} DESC, ${idExpression} ASC`;
  };

  if (args.kind === 'doc') {
    const timeExpression = args.timeRange?.field === 'created_at' ? 'd.created_at' : 'n.updated_at';
    const scoreExpression = `ts_rank(d.search_text, q.tsq)`;
    const { rows } = await getDb().query<{
      id: string;
      title: string;
      score: number;
    }>(
      `
        WITH RECURSIVE
        ${scoped.cte},
        q AS (SELECT websearch_to_tsquery('english', $${queryIdx}) AS tsq)
        SELECT
          d.id,
          d.title,
          (${scoreExpression} * ${timeRangeBoostSql(timeExpression, args.timeRange ?? null, fromIdx, toIdx)}) AS score
        FROM public.docs d
        JOIN scoped s ON s.node_id = d.id
        JOIN public.nodes n ON n.id = d.id
        CROSS JOIN q
        WHERE ${matchSql('d.search_text @@ q.tsq', "COALESCE(d.title, '')")}
          ${timeRangeFilterSql(timeExpression, args.timeRange ?? null, fromIdx, toIdx)}
        ORDER BY ${orderedBy(timeExpression, 'score', 'd.id')}
        LIMIT $${limitIdx}
      `,
      params
    );

    return rows.map((row, index) => ({
      id: row.id,
      rank: index + 1,
      channel: FTS_CHANNEL,
      kind: args.kind,
      title: row.title,
    }));
  }

  if (args.kind === 'message') {
    const timeExpression = args.timeRange?.field === 'updated_at' ? 'n.updated_at' : 'm.created_at';
    // Stored generated vector — indexed, and populated for every message
    // rather than only the few that NLP enrichment happened to touch.
    const searchExpression = 'm.search_text';
    const scoreExpression = rankCd(searchExpression, 'q.tsq');
    const { rows } = await getDb().query<{
      id: string;
      title: string;
      score: number;
    }>(
      `
        WITH RECURSIVE
        ${scoped.cte},
        q AS (SELECT websearch_to_tsquery('english', $${queryIdx}) AS tsq)
        SELECT
          m.id,
          LEFT(m.content, 120) AS title,
          (${scoreExpression} * ${timeRangeBoostSql(timeExpression, args.timeRange ?? null, fromIdx, toIdx)}) AS score
        FROM public.messages m
        JOIN scoped s ON s.node_id = m.id
        JOIN public.nodes n ON n.id = m.id
        CROSS JOIN q
        WHERE ${searchExpression} @@ q.tsq
          ${timeRangeFilterSql(timeExpression, args.timeRange ?? null, fromIdx, toIdx)}
        ORDER BY ${orderedBy(timeExpression, 'score', 'm.id')}
        LIMIT $${limitIdx}
      `,
      params
    );

    return rows.map((row, index) => ({
      id: row.id,
      rank: index + 1,
      channel: FTS_CHANNEL,
      kind: args.kind,
      title: row.title,
    }));
  }

  if (isWorkspaceLexicalKind(args.kind)) {
    const table = args.kind === 'container' ? 'containers' : `${args.kind}s`;
    const alias = args.kind.slice(0, 1);
    const titleExpression =
      args.kind === 'thread' ? `COALESCE(${alias}.title, 'Untitled thread')` : `${alias}.name`;
    // threads/containers intentionally have no stored search_text: the text is
    // a short title, and the pg_trgm title index serves fuzzy title lookup
    // better than an FTS vector would. Vectorized at query time on purpose.
    const searchExpression = `to_tsvector('english', COALESCE(${titleExpression}, ''))`;
    const timeExpression =
      args.kind === 'thread'
        ? args.timeRange?.field === 'created_at'
          ? `${alias}.created_at`
          : args.timeRange?.field === 'updated_at'
            ? 'n.updated_at'
            : `COALESCE(${alias}.last_message_at, n.updated_at, ${alias}.created_at)`
        : args.timeRange?.field === 'created_at'
          ? `${alias}.created_at`
          : 'n.updated_at';
    const scoreExpression = rankCd(searchExpression, 'q.tsq');

    const { rows } = await getDb().query<{
      id: string;
      title: string;
      score: number;
    }>(
      `
        WITH RECURSIVE
        ${scoped.cte},
        q AS (SELECT plainto_tsquery('english', $${queryIdx}) AS tsq)
        SELECT
          ${alias}.id,
          ${titleExpression} AS title,
          (${scoreExpression} * ${timeRangeBoostSql(timeExpression, args.timeRange ?? null, fromIdx, toIdx)}) AS score
        FROM public.${table} ${alias}
        JOIN scoped s ON s.node_id = ${alias}.id
        JOIN public.nodes n ON n.id = ${alias}.id
        CROSS JOIN q
        WHERE ${matchSql(`${searchExpression} @@ q.tsq`, titleExpression)}
          ${timeRangeFilterSql(timeExpression, args.timeRange ?? null, fromIdx, toIdx)}
        ORDER BY ${orderedBy(timeExpression, 'score', `${alias}.id`)}
        LIMIT $${limitIdx}
      `,
      params
    );

    return rows.map((row, index) => ({
      id: row.id,
      rank: index + 1,
      channel: FTS_CHANNEL,
      kind: args.kind,
      title: row.title,
    }));
  }

  if (args.kind === 'tool') {
    // One canonical weighted expression, shared with the workspace lexical
    // lane. Identity/aliases carry weight A, curated keywords B, description
    // prose C — so a decisive identifier match outranks an incidental word.
    const searchExpression = 't.search_text';
    const timeExpression = args.timeRange?.field === 'created_at' ? 't.created_at' : 't.updated_at';
    const scoreExpression = rankCd(searchExpression, 'q.tsq');
    const { rows } = await getDb().query<{
      id: string;
      title: string;
      score: number;
    }>(
      `
        WITH RECURSIVE
        ${scoped.cte},
        q AS (SELECT ${toolTsQuery(`$${queryIdx}`)} AS tsq)
        SELECT
          t.id,
          t.name AS title,
          (${scoreExpression} * ${timeRangeBoostSql(timeExpression, args.timeRange ?? null, fromIdx, toIdx)}) AS score
        FROM public.tools t
        JOIN scoped s ON s.node_id = t.id
        CROSS JOIN q
        WHERE ${searchExpression} @@ q.tsq
          ${timeRangeFilterSql(timeExpression, args.timeRange ?? null, fromIdx, toIdx)}
        ORDER BY ${orderedBy(timeExpression, 'score', 't.id')}
        LIMIT $${limitIdx}
      `,
      params
    );

    return rows.map((row, index) => ({
      id: row.id,
      rank: index + 1,
      channel: FTS_CHANNEL,
      kind: args.kind,
      title: row.title,
    }));
  }

  throw new Error(`ftsSearchNodes: unsupported node kind ${String(args.kind)}`);
}
