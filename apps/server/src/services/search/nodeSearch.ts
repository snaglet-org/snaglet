import { getDb } from '@snaglet/db';
import { Models } from '@snaglet/db/tables/models';
import { VECTOR_SEARCH_CANDIDATE_POOL } from '@snaglet/shared/constants';
import { clamp, getErrorMessage, vectorLiteral } from '@snaglet/shared/utils';
import { logger } from '@server/config/logger';
import {
  resolveEmbeddingProvider,
  type EmbeddingProvider,
} from '@server/services/embedding/EmbeddingProvider';
import { fuseRRF, type FusedResult } from './fuseRRF';
import { reorderByRerank } from '@server/services/reranking/reorderByRerank';
import { ftsSearchNodes, scopedNodeIdsSql, type NodeKind } from './ftsSearchNodes';
import {
  resolveScope,
  type CallerContext,
  type ResolvedScope,
  type ScopeSource,
  type SearchScope,
} from './searchPolicy';
import type { RankedCandidate } from './fuseRRF';
import { settingsService } from '@server/services/settings';
import { searchSettings } from '@server/services/settings/categories/search';
import {
  resolveSearchTimeRange,
  timeRangeBoostSql,
  timeRangeFilterSql,
  timeRangeParams,
  type NormalizedSearchTimeRange,
} from './timeRange';
import type { StructuredSearchOrder } from './searchPolicy';

export type { NodeKind, SearchScope };

export type NodeSearchMode = 'hybrid' | 'semantic' | 'keyword';

export type PrecomputedEmbedding = {
  vector: number[];
  modelId: string;
};

export type WorkspaceSearchNodesInput = {
  query: string;
  kind: NodeKind;
  scope?: SearchScope;
  callerContext?: CallerContext;
  limit?: number;
  mode?: NodeSearchMode;
  time_range?: unknown;
  order_by?: StructuredSearchOrder;
  /** Drop hits whose post-fusion RRF score is below this floor. Defaults to 0. */
  min_score?: number;
  /**
   * Reuse an embedding computed by a multi-kind caller. `null` means the
   * caller already attempted embedding and no vector channel is available.
   */
  precomputedEmbedding?: PrecomputedEmbedding | null;
  /**
   * Tier-3 precision pass: re-order the fused candidates with the local
   * cross-encoder before slicing to `limit`. Explicit per the tiering
   * contract — committed paths (agent tools) pass true; palette/type-ahead
   * never does. Defaults to false. Degrades to RRF order if the reranker
   * model isn't installed.
   */
  rerank?: boolean;
  /**
   * Interactive type-ahead: titles match on word starts as the last word is
   * still being typed (see `ftsSearchNodes`). Palette only.
   */
  typeahead?: boolean;
};

export type NodeSearchHit = {
  node_id: string;
  kind: NodeKind;
  score: number;
  channels: ('fts' | 'vector')[];
  /** Raw cosine similarity from the vector channel, when present. */
  vectorSimilarity?: number;
  payload?: Record<string, unknown>;
};

export type WorkspaceSearchNodesResult = {
  hits: NodeSearchHit[];
  channels_used: ('fts' | 'vector')[];
  scope_applied: ResolvedScope;
  scope_source: ScopeSource;
  suggested?: string;
};

const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 50;
const RRF_CANDIDATE_MULTIPLIER = 4;
const DEFAULT_MIN_SCORE = 0;

export function supportsVectorSearch(kind: NodeKind): kind is 'doc' | 'message' {
  return kind === 'doc' || kind === 'message';
}

function normalizeLimit(limit: unknown): number {
  const n = typeof limit === 'number' && Number.isFinite(limit) ? Math.floor(limit) : DEFAULT_LIMIT;
  return clamp(n, 1, MAX_LIMIT);
}

function normalizeMinScore(minScore: unknown): number {
  if (minScore === undefined) return DEFAULT_MIN_SCORE;
  if (typeof minScore !== 'number' || !Number.isFinite(minScore) || minScore < 0 || minScore > 1) {
    throw new Error('workspaceSearchNodes: min_score must be a number between 0 and 1');
  }
  return minScore;
}

function noScopeSuggestion(kind: NodeKind): string {
  return `No ${kind} search scope could be inferred. Pass container_id: 'root' to search globally or provide project_id/container_id.`;
}

function emptyScopedSuggestion(scope: ResolvedScope): string | undefined {
  if (scope.source !== 'inferred_thread') return undefined;
  const label =
    scope.mode === 'project' && scope.project_id
      ? `project ${scope.project_id}`
      : scope.mode === 'container_subtree' && scope.container_id
        ? `container ${scope.container_id}`
        : 'current scope';
  return `No matches in ${label}. Pass container_id: 'root' to search globally or specify a different project_id/container_id.`;
}

async function vectorSearchNodes(args: {
  query: string;
  kind: NodeKind;
  scope: ResolvedScope;
  limit: number;
  precomputedEmbedding?: PrecomputedEmbedding | null;
  timeRange: NormalizedSearchTimeRange | null;
}): Promise<RankedCandidate[]> {
  if (!args.query.trim() || args.limit < 1) return [];
  if (!supportsVectorSearch(args.kind)) {
    throw new Error(`vectorSearchNodes: unsupported node kind ${args.kind}`);
  }

  const embedding =
    args.precomputedEmbedding === undefined
      ? await createQueryEmbedding(args.query, args.kind)
      : args.precomputedEmbedding;
  if (!embedding) return [];
  const scoped = scopedNodeIdsSql(args.kind, args.scope);
  const vectorIdx = scoped.params.length + 1;
  const modelIdx = scoped.params.length + 2;
  const kindIdx = scoped.params.length + 3;
  const fromIdx = scoped.params.length + 4;
  const toIdx = scoped.params.length + 5;
  const limitIdx = scoped.params.length + 6;
  const activityExpression = (() => {
    if (args.kind === 'message') {
      return args.timeRange?.field === 'updated_at' ? 'n.updated_at' : 'm.created_at';
    }
    return args.timeRange?.field === 'created_at' ? 'd.created_at' : 'n.updated_at';
  })();
  const filterSql = timeRangeFilterSql(activityExpression, args.timeRange, fromIdx, toIdx);
  const boostSql = timeRangeBoostSql(activityExpression, args.timeRange, fromIdx, toIdx);

  const { rows } = await getDb().query<{
    id: string;
    title: string;
    similarity: number;
  }>(
    `
      WITH RECURSIVE
      ${scoped.cte},
      candidates AS (
        -- Keep the HNSW-servable ordered scan + LIMIT shape. Reserved negative
        -- chunk rows belonged to the removed workspace-card subsystem and
        -- must never participate, including during a mixed-version rollout.
        SELECT node_id, vector <=> $${vectorIdx}::vector AS distance
        FROM public.embeddings
        WHERE model_id = $${modelIdx}
          AND chunk_index >= 0
        ORDER BY vector <=> $${vectorIdx}::vector
        LIMIT ${VECTOR_SEARCH_CANDIDATE_POOL}
      ),
      best AS (
        -- Best-chunk-per-node: long content stores one row per chunk, so
        -- aggregate to MIN distance before joining or a multi-chunk doc
        -- would occupy several result slots. Cheap: the pool is tiny.
        SELECT node_id, MIN(distance) AS distance
        FROM candidates
        GROUP BY node_id
      )
      SELECT
        COALESCE(d.id, m.id) AS id,
        COALESCE(d.title, LEFT(m.content, 120), e.node_id) AS title,
        1 - e.distance AS similarity
      FROM best e
      JOIN scoped s ON s.node_id = e.node_id
      JOIN public.nodes n ON n.id = e.node_id AND n.type = $${kindIdx} AND n.archived = false
      LEFT JOIN public.docs d ON d.id = e.node_id AND $${kindIdx} = 'doc'
      LEFT JOIN public.messages m ON m.id = e.node_id AND $${kindIdx} = 'message'
      WHERE TRUE
        ${filterSql}
      ORDER BY ((1 - e.distance) * ${boostSql}) DESC, e.node_id ASC
      LIMIT $${limitIdx}
    `,
    [
      ...scoped.params,
      vectorLiteral(embedding.vector),
      embedding.modelId,
      args.kind,
      ...timeRangeParams(args.timeRange),
      Math.max(1, Math.floor(args.limit)),
    ]
  );

  return rows.map((row, index) => ({
    id: row.id,
    rank: index + 1,
    channel: 'vector',
    title: row.title,
    rawScore: row.similarity,
  }));
}

export async function createQueryEmbedding(
  query: string,
  kind?: NodeKind,
  providerOverride?: EmbeddingProvider | null,
  /** Receives the user-facing reason when the vector channel degrades to lexical. */
  onError?: (message: string) => void
): Promise<PrecomputedEmbedding | null> {
  if (!query.trim()) return null;
  const provider =
    providerOverride === undefined ? await resolveEmbeddingProvider() : providerOverride;
  if (!provider) return null;

  try {
    // The embeddings table stores `model_id` as the models.id PK, not the
    // composite "<provider>:<model>" string. Look up the row so search
    // filters against the same id the orchestrator wrote at embed time.
    const row = await Models.findByProviderAndModelId(provider.info.provider, provider.info.model);
    if (!row) {
      logger.warn('[nodeSearch] vector channel skipped — no models row for active embed provider', {
        provider: provider.info.provider,
        model: provider.info.model,
      });
      onError?.(
        `The built-in embedding model ${provider.info.provider}:${provider.info.model} is missing from the models catalog. Restart Snaglet to restore it.`
      );
      return null;
    }
    return {
      vector: await provider.embedQuery(query),
      modelId: row.id,
    };
  } catch (err) {
    logger.warn('[nodeSearch] vector channel skipped after embedding provider failure', {
      ...(kind ? { kind } : {}),
      err: getErrorMessage(err),
    });
    onError?.(getErrorMessage(err));
    return null;
  }
}

export async function workspaceSearchNodes(
  input: WorkspaceSearchNodesInput
): Promise<WorkspaceSearchNodesResult> {
  const resolvedTimeRange = resolveSearchTimeRange({
    query: input.query.trim(),
    timeRange: input.time_range,
  });
  const query = resolvedTimeRange.query.trim();
  const timeRange = resolvedTimeRange.timeRange;
  const mode = input.mode ?? 'hybrid';
  if (!['hybrid', 'semantic', 'keyword'].includes(mode)) {
    throw new Error('workspaceSearchNodes: mode must be one of hybrid, semantic, keyword');
  }

  const limit = normalizeLimit(input.limit);
  const minScore = normalizeMinScore(input.min_score);
  const scope = await resolveScope({ explicit: input.scope, callerContext: input.callerContext });

  if (!query || scope.mode === 'none') {
    return {
      hits: [],
      channels_used: [],
      scope_applied: scope,
      scope_source: scope.source,
      suggested: scope.mode === 'none' ? noScopeSuggestion(input.kind) : undefined,
    };
  }

  const candidateLimit = limit * RRF_CANDIDATE_MULTIPLIER;
  const channels: RankedCandidate[][] = [];
  const channelsUsed: ('fts' | 'vector')[] = [];
  const applyPreferenceGates = input.mode === undefined;
  const preferences = applyPreferenceGates
    ? await settingsService.read(searchSettings.preferences)
    : null;
  const runFts = mode !== 'semantic' && (!preferences || preferences.useFts);
  const runVector =
    mode !== 'keyword' &&
    supportsVectorSearch(input.kind) &&
    (!preferences || preferences.useVector);

  if (runFts) {
    channelsUsed.push('fts');
    channels.push(
      await ftsSearchNodes({
        query,
        kind: input.kind,
        scope,
        limit: candidateLimit,
        timeRange,
        orderBy: input.order_by,
        typeahead: input.typeahead,
      })
    );
  }

  if (runVector) {
    channelsUsed.push('vector');
    channels.push(
      await vectorSearchNodes({
        query,
        kind: input.kind,
        scope,
        limit: candidateLimit,
        precomputedEmbedding: input.precomputedEmbedding,
        timeRange,
      })
    );
  }

  const fused = fuseRRF(channels, { query });
  const toHit = (row: FusedResult): NodeSearchHit => ({
    node_id: row.id,
    kind: input.kind,
    score: row.score,
    channels: row.channels.filter((c): c is 'fts' | 'vector' => c === 'fts' || c === 'vector'),
    vectorSimilarity: row.rawScores.vector,
  });
  let ordered = fused.filter((row) => row.score >= minScore);
  if (input.rerank && ordered.length > 1) {
    // Tier-3 pass judged by channel titles (docs/tasks titles, message previews).
    ordered = await reorderByRerank({
      query,
      items: ordered,
      getId: (row) => row.id,
      getText: (row) => row.title?.trim() || row.id,
      context: 'committed node search',
    });
  }
  if (input.order_by && input.order_by !== 'relevance' && ordered.length > 1) {
    const ids = ordered.map((row) => row.id);
    const { rows } = await getDb().query<{
      id: string;
      created_at: string;
      updated_at: string;
    }>(
      `SELECT id, created_at, updated_at
         FROM public.nodes
        WHERE id = ANY($1::text[])`,
      [ids]
    );
    const timestampById = new Map(
      rows.map((row) => [
        row.id,
        Date.parse(input.order_by === 'created_desc' ? row.created_at : row.updated_at),
      ])
    );
    ordered.sort((a, b) => {
      const timeDelta = (timestampById.get(b.id) ?? 0) - (timestampById.get(a.id) ?? 0);
      return timeDelta || b.score - a.score || a.id.localeCompare(b.id);
    });
  }
  const hits: NodeSearchHit[] = ordered.slice(0, limit).map(toHit);

  const suggested =
    mode === 'semantic' && !supportsVectorSearch(input.kind)
      ? `Semantic search is not available for ${input.kind} nodes. Use mode: 'keyword'.`
      : channelsUsed.length === 0
        ? 'No workspace search channels are enabled. Pass an explicit mode.'
        : fused.length > 0 && hits.length === 0 && minScore > 0
          ? "No matches above the relevance threshold. Pass min_score: 0 to see weak matches, or container_id: 'root' to search globally."
          : hits.length === 0
            ? emptyScopedSuggestion(scope)
            : undefined;

  return {
    hits,
    channels_used: channelsUsed,
    scope_applied: scope,
    scope_source: scope.source,
    suggested,
  };
}
