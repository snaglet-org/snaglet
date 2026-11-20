import { helperThreadExclusionSql } from '@snaglet/db/tables/threads/visibility';
/**
 * Candidate producers for the semantic workspace-search lane: the per-store
 * vector queries (nodes, current thread summaries, content-addressed files)
 * and the content FTS channel that feed the RRF fusion in semantic.ts.
 *
 * Container scope (`allowedContainerIds`) admits a message or thread summary
 * when its thread's project (`nodes.project_id`) is in the allowed set —
 * threads are not in the folder tree, so that is the only placement a thread
 * has. Nothing in a subagent helper thread is ever a candidate (helper
 * messages are never embedded either; this also covers the FTS channel).
 */

import { getDb } from '@snaglet/db';
import { rankCd } from '@server/services/search/lexicalQuery';
import {
  timeRangeBoostSql,
  timeRangeFilterSql,
  timeRangeParams,
  type NormalizedSearchTimeRange,
} from '@server/services/search/timeRange';
import { VECTOR_SEARCH_CANDIDATE_POOL } from '@snaglet/shared/constants';
import { vectorLiteral } from '@snaglet/shared/utils';
import type { SemanticSearchKind } from './types';
import { memoryScopeParams, memoryScopeSql, type MemorySearchScope } from './memoryScope';

export interface SemanticVectorCandidateRow {
  id: string;
  kind: SemanticSearchKind;
  title: string | null;
  // Winning-chunk offsets for line-range surfacing. Null for older unchunked
  // rows whose chunk columns are not populated.
  chunk_index: number | null;
  chunk_start: number | null;
  chunk_end: number | null;
}

interface ScoredCandidateRow extends SemanticVectorCandidateRow {
  score: number;
}

export async function semanticVectorCandidates(args: {
  query: string;
  kinds: SemanticSearchKind[];
  limit: number;
  allowedContainerIds: string[] | null;
  vector: number[];
  modelId: string;
  timeRange: NormalizedSearchTimeRange | null;
  // Project-folder scoping for the `file` kind only. When non-null, file hits
  // are constrained to this project's files (indexed equality on
  // files.project_id). When null, no file scoping is applied (workspace-wide).
  // Non-file kinds are never affected by this filter.
  fileProjectId: string | null;
  // Optional path-prefix LIKE pattern narrowing file hits to a subtree of the
  // owner project (for satellite projects nested in a shared folder). Null = no
  // path narrowing. Only affects the `file` kind.
  filePathPrefix: string | null;
  includeArchived?: boolean;
  includeSupersededThreadSummaries?: boolean;
  // Whose memories may come back (memoryScope.ts). None: no memory matches.
  memoryScope?: MemorySearchScope | null;
}): Promise<SemanticVectorCandidateRow[]> {
  if (args.kinds.length === 0) return [];
  // File embeddings are content-addressed and live in their own table
  // (file_embeddings); the file kind runs as a separate query deduped
  // by content, then merges with node-kind candidates by score.
  const nodeKinds = args.kinds.filter(
    (kind) =>
      kind !== 'file' &&
      (kind !== 'thread_summary' || args.includeSupersededThreadSummaries === true)
  );
  const [nodeRows, threadSummaryRows, fileRows] = await Promise.all([
    nodeKinds.length > 0 ? nodeVectorCandidates({ ...args, kinds: nodeKinds }) : [],
    args.kinds.includes('thread_summary') && !args.includeSupersededThreadSummaries
      ? currentThreadSummaryVectorCandidates(args)
      : [],
    args.kinds.includes('file') ? fileVectorCandidates(args) : [],
  ]);
  return [...nodeRows, ...threadSummaryRows, ...fileRows]
    .sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : 1))
    .slice(0, args.limit)
    .map(({ score: _score, ...row }) => row);
}

async function currentThreadSummaryVectorCandidates(args: {
  limit: number;
  allowedContainerIds: string[] | null;
  vector: number[];
  modelId: string;
  timeRange: NormalizedSearchTimeRange | null;
  includeArchived?: boolean;
}): Promise<ScoredCandidateRow[]> {
  const archivedFilter = args.includeArchived
    ? ''
    : 'AND n.archived = false AND tn.archived = false';
  const filterExpression =
    args.timeRange?.field === 'created_at' ? 'ts.created_at' : 'n.updated_at';
  const boostExpression =
    args.timeRange?.field === 'created_at' ? 'best.created_at' : 'best.updated_at';
  const filterSql = timeRangeFilterSql(filterExpression, args.timeRange, 4, 5);
  const boostSql = timeRangeBoostSql(boostExpression, args.timeRange, 4, 5);
  const { rows } = await getDb().query<SemanticVectorCandidateRow & { score: string | number }>(
    `
      WITH eligible AS MATERIALIZED (
        SELECT e.node_id,
               e.vector,
               e.chunk_index,
               e.chunk_start,
               e.chunk_end,
               ts.created_at,
               n.updated_at
        FROM public.embeddings e
        JOIN public.thread_summaries ts ON ts.id = e.node_id AND ts.is_current = true
        JOIN public.nodes n ON n.id = ts.id
        JOIN public.nodes tn ON tn.id = ts.thread_id
        WHERE e.model_id = $2
          AND ${helperThreadExclusionSql('ts.thread_id')}
          ${archivedFilter}
          AND ($3::text[] IS NULL OR n.container_id = ANY($3::text[]) OR tn.project_id = ANY($3::text[]))
          ${filterSql}
      ),
      best AS (
        SELECT DISTINCT ON (node_id)
               node_id,
               chunk_index,
               chunk_start,
               chunk_end,
               created_at,
               updated_at,
               vector <=> $1::vector AS distance
        FROM eligible
        ORDER BY node_id, vector <=> $1::vector
      )
      SELECT node_id AS id,
             'thread_summary'::text AS kind,
             'Thread summary'::text AS title,
             chunk_index,
             chunk_start,
             chunk_end,
             ((1 - distance) * ${boostSql}) AS score
      FROM best
      ORDER BY score DESC, node_id ASC
      LIMIT $6
    `,
    [
      vectorLiteral(args.vector),
      args.modelId,
      args.allowedContainerIds,
      ...timeRangeParams(args.timeRange),
      args.limit,
    ]
  );
  return rows.map((row) => ({ ...row, score: Number(row.score) }));
}

async function nodeVectorCandidates(args: {
  kinds: SemanticSearchKind[];
  limit: number;
  allowedContainerIds: string[] | null;
  vector: number[];
  modelId: string;
  timeRange: NormalizedSearchTimeRange | null;
  includeArchived?: boolean;
  memoryScope?: MemorySearchScope | null;
}): Promise<ScoredCandidateRow[]> {
  const archivedFilter = args.includeArchived ? '' : 'AND n.archived = false';
  const timeExpression =
    args.timeRange?.field === 'created_at'
      ? `CASE
           WHEN n.type = 'message' THEN m.created_at
           WHEN n.type = 'doc' THEN d.created_at
           WHEN n.type = 'memory' THEN mem.created_at
           WHEN n.type = 'thread_summary' THEN ts.created_at
           ELSE n.created_at
         END`
      : args.timeRange?.field === 'updated_at'
        ? 'n.updated_at'
        : `CASE WHEN n.type = 'message' THEN m.created_at ELSE n.updated_at END`;
  const filterSql = timeRangeFilterSql(timeExpression, args.timeRange, 5, 6);
  const boostSql = timeRangeBoostSql(timeExpression, args.timeRange, 5, 6);
  const { rows } = await getDb().query<SemanticVectorCandidateRow & { score: string | number }>(
    `
      SELECT
        e.node_id AS id,
        n.type::text AS kind,
        COALESCE(
          d.title,
          LEFT(m.content, 120),
          mem.memory_key,
          'Thread summary'
        ) AS title,
        -- Winning-chunk offsets carried through DISTINCT ON, enabling callers
        -- to surface the matched line range rather than just the node.
        e.chunk_index,
        e.chunk_start,
        e.chunk_end,
        ((1 - e.distance) * ${boostSql}) AS score
      FROM (
        -- Best-chunk-per-node: chunked nodes store multiple rows; pick the
        -- single closest chunk per node so each node fills at most one slot.
        -- DISTINCT ON (instead of MIN/GROUP BY) lets us carry the WINNING
        -- chunk's offsets through, enabling line-range surfacing — landing a
        -- result on the matching chunk, not just the containing node.
        --
        -- The inner pool is the HNSW-servable shape (bare ordered scan +
        -- LIMIT); DISTINCT ON dedups over that small pool.
        SELECT DISTINCT ON (node_id)
          node_id,
          distance,
          chunk_index,
          chunk_start,
          chunk_end
        FROM (
          -- Negative chunk indexes belonged to the removed workspace-card
          -- subsystem. Exclude them explicitly so a stale pre-migration row
          -- can never influence semantic ranking.
          SELECT
            node_id,
            (vector <=> $4::vector) AS distance,
            chunk_index,
            chunk_start,
            chunk_end
          FROM public.embeddings
          WHERE model_id = $2
            AND chunk_index >= 0
          ORDER BY vector <=> $4::vector
          LIMIT ${VECTOR_SEARCH_CANDIDATE_POOL}
        ) pool
        ORDER BY node_id, distance ASC
      ) e
      JOIN public.nodes n ON n.id = e.node_id
      LEFT JOIN public.messages m ON m.id = e.node_id AND n.type = 'message'
      LEFT JOIN public.nodes tn ON tn.id = m.thread_id
      LEFT JOIN public.docs d ON d.id = e.node_id AND n.type = 'doc'
      LEFT JOIN public.memories mem ON mem.id = e.node_id AND n.type = 'memory'
      LEFT JOIN public.thread_summaries ts ON ts.id = e.node_id AND n.type = 'thread_summary'
      LEFT JOIN public.nodes ts_thread_n ON ts_thread_n.id = ts.thread_id AND n.type = 'thread_summary'
      WHERE n.type::text = ANY($1::text[])
        -- Nothing in a subagent helper thread (a message or summary of one).
        AND ${helperThreadExclusionSql('COALESCE(m.thread_id, ts.thread_id)')}
        ${archivedFilter}
        AND (
          $3::text[] IS NULL
          OR n.container_id = ANY($3::text[])
          OR tn.project_id = ANY($3::text[])
          OR ts_thread_n.project_id = ANY($3::text[])
        )
        ${filterSql}
        -- A memory is a candidate only within the caller's memory scope.
        AND (n.type <> 'memory' OR ${memoryScopeSql('mem', 7, 8)})
      ORDER BY score DESC, e.node_id ASC
      LIMIT $9
    `,
    [
      args.kinds,
      args.modelId,
      args.allowedContainerIds,
      vectorLiteral(args.vector),
      ...timeRangeParams(args.timeRange),
      ...memoryScopeParams(args.memoryScope),
      args.limit,
    ]
  );
  return rows.map((row) => ({ ...row, score: Number(row.score) }));
}

/**
 * File-kind vector candidates over the content-addressed store: nearest
 * unique CONTENTS first, each represented by ONE in-scope file row (ordered
 * project id, then path — deterministic). A file linked by several projects
 * or paths therefore fills at most one slot instead of one per link.
 */
async function fileVectorCandidates(args: {
  limit: number;
  vector: number[];
  modelId: string;
  timeRange: NormalizedSearchTimeRange | null;
  fileProjectId: string | null;
  filePathPrefix: string | null;
  includeArchived?: boolean;
}): Promise<ScoredCandidateRow[]> {
  const archivedFilter = args.includeArchived ? '' : 'AND n.archived = false';
  const timeExpression = args.timeRange?.field === 'created_at' ? 'n.created_at' : 'n.updated_at';
  const filterSql = timeRangeFilterSql(timeExpression, args.timeRange, 5, 6);
  const boostSql = timeRangeBoostSql(timeExpression, args.timeRange, 5, 6);
  const { rows } = await getDb().query<SemanticVectorCandidateRow & { score: string | number }>(
    `
      SELECT id, kind, title, chunk_index, chunk_start, chunk_end, score
      FROM (
        SELECT DISTINCT ON (b.content_hash)
          f.id,
          'file'::text AS kind,
          f.relative_path AS title,
          b.chunk_index,
          b.chunk_start,
          b.chunk_end,
          ((1 - b.distance) * ${boostSql}) AS score
        FROM (
          -- Best-chunk-per-content over the HNSW-servable pool shape.
          SELECT DISTINCT ON (content_hash)
            content_hash,
            distance,
            chunk_index,
            chunk_start,
            chunk_end
          FROM (
            SELECT
              content_hash,
              (vector <=> $1::vector) AS distance,
              chunk_index,
              chunk_start,
              chunk_end
            FROM public.file_embeddings
            WHERE model_id = $2
            ORDER BY vector <=> $1::vector
            LIMIT ${VECTOR_SEARCH_CANDIDATE_POOL}
          ) pool
          ORDER BY content_hash, distance ASC
        ) b
        JOIN public.files f ON f.content_hash = b.content_hash
          AND ($3::text IS NULL OR f.project_id = $3::text)
          AND ($4::text IS NULL OR f.relative_path LIKE $4::text)
        JOIN public.nodes n ON n.id = f.id
        WHERE TRUE
          ${archivedFilter}
          ${filterSql}
        ORDER BY b.content_hash, f.project_id ASC, f.relative_path ASC
      ) hits
      ORDER BY score DESC, id ASC
      LIMIT $7
    `,
    [
      vectorLiteral(args.vector),
      args.modelId,
      args.fileProjectId,
      args.filePathPrefix,
      ...timeRangeParams(args.timeRange),
      args.limit,
    ]
  );
  return rows.map((row) => ({ ...row, score: Number(row.score) }));
}

export async function semanticFtsCandidates(args: {
  query: string;
  kinds: SemanticSearchKind[];
  limit: number;
  allowedContainerIds: string[] | null;
  timeRange: NormalizedSearchTimeRange | null;
  includeArchived?: boolean;
  includeSupersededThreadSummaries?: boolean;
  memoryScope?: MemorySearchScope | null;
}): Promise<Array<{ id: string; kind: SemanticSearchKind; title: string | null }>> {
  if (args.kinds.length === 0) return [];
  const archivedFilter = args.includeArchived ? '' : 'AND n.archived = false';
  const threadArchivedFilter = args.includeArchived ? '' : 'AND tn.archived = false';
  const branches: string[] = [];
  const kindSet = new Set(args.kinds);
  const kindTimeExpression = (createdExpression: string, activityExpression = 'n.updated_at') =>
    args.timeRange?.field === 'created_at'
      ? createdExpression
      : args.timeRange?.field === 'updated_at'
        ? 'n.updated_at'
        : activityExpression;

  if (kindSet.has('doc')) {
    const timeExpression = kindTimeExpression('d.created_at');
    const scoreExpression = `ts_rank(d.search_text, q.tsq)`;
    branches.push(`
      SELECT d.id, 'doc'::text AS kind, d.title,
             (${scoreExpression} * ${timeRangeBoostSql(timeExpression, args.timeRange, 3, 4)}) AS score
      FROM public.docs d
      JOIN public.nodes n ON n.id = d.id
      CROSS JOIN q
      WHERE d.search_text @@ q.tsq
        ${archivedFilter}
        AND ($2::text[] IS NULL OR n.container_id = ANY($2::text[]))
        ${timeRangeFilterSql(timeExpression, args.timeRange, 3, 4)}
    `);
  }

  if (kindSet.has('message')) {
    const timeExpression = kindTimeExpression('m.created_at', 'm.created_at');
    // Stored generated vector (messages.search_text), so the GIN index applies.
    const searchExpression = 'm.search_text';
    const scoreExpression = rankCd(searchExpression, 'q.tsq');
    branches.push(`
      SELECT m.id, 'message'::text AS kind, LEFT(m.content, 120) AS title,
             (${scoreExpression} * ${timeRangeBoostSql(timeExpression, args.timeRange, 3, 4)}) AS score
      FROM public.messages m
      JOIN public.nodes n ON n.id = m.id
      JOIN public.nodes tn ON tn.id = m.thread_id
      CROSS JOIN q
      WHERE ${searchExpression} @@ q.tsq
        AND ${helperThreadExclusionSql('m.thread_id')}
        ${archivedFilter}
        ${threadArchivedFilter}
        AND ($2::text[] IS NULL OR n.container_id = ANY($2::text[]) OR tn.project_id = ANY($2::text[]))
        ${timeRangeFilterSql(timeExpression, args.timeRange, 3, 4)}
    `);
  }

  if (kindSet.has('memory')) {
    const timeExpression = kindTimeExpression('mem.created_at');
    // Stored vector now includes the weighted memory_key, so the query-time
    // key concatenation this replaced is redundant as well as unindexed.
    const searchExpression = 'mem.search_text';
    const scoreExpression = rankCd(searchExpression, 'q.tsq');
    branches.push(`
      SELECT mem.id, 'memory'::text AS kind, mem.memory_key AS title,
             (${scoreExpression} * ${timeRangeBoostSql(timeExpression, args.timeRange, 3, 4)}) AS score
      FROM public.memories mem
      JOIN public.nodes n ON n.id = mem.id
      CROSS JOIN q
      WHERE ${searchExpression} @@ q.tsq
        AND ${memoryScopeSql('mem', 5, 6)}
        ${archivedFilter}
        AND ($2::text[] IS NULL OR n.container_id = ANY($2::text[]))
        ${timeRangeFilterSql(timeExpression, args.timeRange, 3, 4)}
    `);
  }

  if (kindSet.has('thread_summary')) {
    const timeExpression = kindTimeExpression('ts.created_at');
    const searchExpression = 'ts.search_text';
    const scoreExpression = rankCd(searchExpression, 'q.tsq');
    branches.push(`
      SELECT ts.id, 'thread_summary'::text AS kind, 'Thread summary'::text AS title,
             (${scoreExpression} * ${timeRangeBoostSql(timeExpression, args.timeRange, 3, 4)}) AS score
      FROM public.thread_summaries ts
      JOIN public.nodes n ON n.id = ts.id
      JOIN public.nodes tn ON tn.id = ts.thread_id
      CROSS JOIN q
      WHERE ${searchExpression} @@ q.tsq
        AND ${helperThreadExclusionSql('ts.thread_id')}
        ${args.includeSupersededThreadSummaries ? '' : 'AND ts.is_current = true'}
        ${archivedFilter}
        ${threadArchivedFilter}
        AND ($2::text[] IS NULL OR n.container_id = ANY($2::text[]) OR tn.project_id = ANY($2::text[]))
        ${timeRangeFilterSql(timeExpression, args.timeRange, 3, 4)}
    `);
  }

  if (branches.length === 0) return [];
  // The memory branch binds the two scope params ($5, $6) ahead of the limit;
  // without it they are left out (an unreferenced param has no type).
  const scopeParams = kindSet.has('memory') ? memoryScopeParams(args.memoryScope) : [];
  const { rows } = await getDb().query<{
    id: string;
    kind: SemanticSearchKind;
    title: string | null;
  }>(
    `
      WITH q AS (SELECT websearch_to_tsquery('english', $1) AS tsq)
      SELECT id, kind, title
      FROM (
        ${branches.join('\nUNION ALL\n')}
      ) hits
      ORDER BY score DESC, id ASC
      LIMIT $${5 + scopeParams.length}
    `,
    [
      args.query,
      args.allowedContainerIds,
      ...timeRangeParams(args.timeRange),
      ...scopeParams,
      args.limit,
    ]
  );
  return rows;
}
