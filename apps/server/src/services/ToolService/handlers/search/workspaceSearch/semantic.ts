import { getDb } from '@snaglet/db';
import type { RankedCandidate } from '@server/services/search/fuseRRF';
import { fuzzyTitleCandidates } from '@server/services/search/ftsSearchNodes';
import { createQueryEmbedding } from '@server/services/search/nodeSearch';
import { settingsService } from '@server/services/settings';
import { searchSettings } from '@server/services/settings/categories/search';
import type { NormalizedSearchTimeRange } from '@server/services/search/timeRange';
import { unique } from '@snaglet/shared/utils';
import { collectThreadConnectedIds, graphChannelHits, graphWalkSemanticHits } from './graph';
import { hydrateSemanticHits } from './hydration';
import type { MemorySearchScope } from './memoryScope';
import { searchLexicalWorkspace } from './lexical';
import { isThreadRecallQuery } from './queryIntent';
import { rankSemanticCandidates } from './ranking';
import { rerankSearchHits } from './rerankHits';
import { semanticFtsCandidates, semanticVectorCandidates } from './semanticCandidates';
import type { SearchHit, SearchableKind, SemanticRankedHit, SemanticSearchKind } from './types';

const STRUCTURAL_HYBRID_FTS_KINDS = new Set<SemanticSearchKind>(['file']);

function structuralCandidateTitle(hit: SearchHit): string | null {
  return hit.kind === 'file' ? hit.relativePath : null;
}

export async function searchSemanticWorkspace(args: {
  query: string;
  kinds: SemanticSearchKind[];
  mode: 'semantic' | 'hybrid';
  limit: number;
  allowedContainerIds: string[] | null;
  threadId: string | null;
  graphDepth: number;
  timeRange: NormalizedSearchTimeRange | null;
  // Resolved owner project id for file-kind scoping (null = workspace-wide).
  fileProjectId: string | null;
  // SQL LIKE pattern (e.g. 'apps/server/%') constraining file hits to a satellite
  // project's subtree of the owner's index; null = the owner's whole tree.
  filePathPrefix: string | null;
  /**
   * Tier-3 precision pass (explicit, per the tiering contract): committed
   * paths pass true; keystroke-driven paths never do. Defaults to false so
   * callers that rerank themselves (RAG opening-retrieval) don't double-pay.
   */
  rerank?: boolean;
  /**
   * Booster overrides (eval harness only). Each key overrides its
   * matching search preference for THIS call, so the eval tab can measure a
   * booster alone without flipping global settings. Real callers omit this
   * and get the persisted preferences (all boosters default off).
   */
  boosters?: { fuzzyTitles?: boolean; threadRecall?: boolean };
  // Archived policy: excluded everywhere unless the tool caller opts in.
  includeArchived?: boolean;
  /**
   * Committed-path pool mode: return the hydrated RRF pool (up to `size`) in
   * fusion order WITHOUT the internal rerank / graph-walk backfill, so the
   * finish pipeline (committedSearch) can rerank, build evidence cards, and
   * apply the floor at pool level. Overrides `rerank`/graph-walk when set.
   */
  poolMode?: { size: number } | null;
  /** Explicit thread_summary searches may intentionally inspect history. */
  includeSupersededThreadSummaries?: boolean;
  /**
   * Whose memories may come back (memoryScope.ts): every memory candidate is
   * filtered by it, and hydration drops any that slip through another
   * channel. None: no memory is returned.
   */
  memoryScope?: MemorySearchScope | null;
}): Promise<SearchHit[]> {
  const kinds = unique(args.kinds);
  const memoryScope = args.memoryScope ?? null;
  if (kinds.length === 0) return [];

  const preferences = await settingsService.read(searchSettings.preferences);
  const channels: RankedCandidate[][] = [];
  const kindById = new Map<string, SemanticSearchKind>();
  const candidateLimit = Math.max(args.limit * 4, args.limit);

  // Embed the query once; the main vector lane shares it.
  const queryEmbedding = preferences.useVector ? await createQueryEmbedding(args.query) : null;

  if (preferences.useVector) {
    const embedding = queryEmbedding;
    if (embedding) {
      const vectorHits = await semanticVectorCandidates({
        query: args.query,
        kinds,
        limit: candidateLimit,
        allowedContainerIds: args.allowedContainerIds,
        vector: embedding.vector,
        modelId: embedding.modelId,
        timeRange: args.timeRange,
        fileProjectId: args.fileProjectId,
        filePathPrefix: args.filePathPrefix,
        includeArchived: args.includeArchived,
        includeSupersededThreadSummaries: args.includeSupersededThreadSummaries,
        memoryScope,
      });
      for (const hit of vectorHits) kindById.set(hit.id, hit.kind);
      channels.push(
        vectorHits.map((hit, index) => ({
          id: hit.id,
          rank: index + 1,
          channel: 'vector',
          title: hit.title,
        }))
      );
    }
  }

  if (args.mode === 'hybrid' && preferences.useFts) {
    const structuralKinds = kinds.filter((kind) => STRUCTURAL_HYBRID_FTS_KINDS.has(kind));
    const [contentFtsHits, structuralLexical] = await Promise.all([
      semanticFtsCandidates({
        query: args.query,
        kinds: kinds.filter((kind) => !STRUCTURAL_HYBRID_FTS_KINDS.has(kind)),
        limit: candidateLimit,
        allowedContainerIds: args.allowedContainerIds,
        timeRange: args.timeRange,
        includeArchived: args.includeArchived,
        includeSupersededThreadSummaries: args.includeSupersededThreadSummaries,
        memoryScope,
      }),
      structuralKinds.length > 0
        ? searchLexicalWorkspace({
            query: args.query,
            kinds: new Set<SearchableKind>(structuralKinds),
            limit: candidateLimit,
            allowedContainerIds: args.allowedContainerIds,
            containerRowsCache: null,
            timeRange: args.timeRange,
            fileProjectId: args.fileProjectId,
            filePathPrefix: args.filePathPrefix,
            includeArchived: args.includeArchived,
            includeSupersededThreadSummaries: args.includeSupersededThreadSummaries,
          })
        : Promise.resolve({ hits: [], threadIds: [] }),
    ]);
    // Hybrid must remain a lexical superset when embeddings are unavailable.
    // The older semantic FTS query covers content-bearing kinds; reuse the
    // canonical lexical lane for structural names/paths rather than duplicating
    // its file SQL here.
    const ftsHits = [
      ...contentFtsHits,
      ...structuralLexical.hits.map((hit) => ({
        id: hit.id,
        kind: hit.kind as SemanticSearchKind,
        title: structuralCandidateTitle(hit),
      })),
    ];
    for (const hit of ftsHits) kindById.set(hit.id, hit.kind);
    channels.push(
      ftsHits.map((hit, index) => ({
        id: hit.id,
        rank: index + 1,
        channel: 'fts',
        title: hit.title,
      }))
    );
  }

  // Intent routing (shadow): conversational-recall queries
  // ("that thread where…", "the conversation about…") get a dedicated
  // thread-summary vector channel, so summaries compete within their own
  // kind instead of drowning under docs/messages in the shared pool, then
  // fuse via RRF. Deterministic trigger, no LLM.
  const threadRecallActive =
    (args.boosters?.threadRecall ?? false) && isThreadRecallQuery(args.query);
  if (threadRecallActive && preferences.useVector) {
    const embedding = await createQueryEmbedding(args.query);
    if (embedding) {
      const summaryHits = await semanticVectorCandidates({
        query: args.query,
        kinds: ['thread_summary'],
        limit: 10,
        allowedContainerIds: args.allowedContainerIds,
        vector: embedding.vector,
        modelId: embedding.modelId,
        timeRange: args.timeRange,
        fileProjectId: null,
        filePathPrefix: null,
        includeArchived: args.includeArchived,
        includeSupersededThreadSummaries: args.includeSupersededThreadSummaries,
      });
      if (summaryHits.length > 0) {
        for (const hit of summaryHits) {
          if (!kindById.has(hit.id)) kindById.set(hit.id, hit.kind);
        }
        channels.push(
          summaryHits.map((hit, index) => ({
            id: hit.id,
            rank: index + 1,
            channel: 'thread_recall',
            title: hit.title,
          }))
        );
      }
    }
  }

  // Booster: trigram fuzzy name channel. Per-call override wins
  // over the persisted preference so eval runs can A/B it in isolation.
  const fuzzyActive = args.boosters?.fuzzyTitles ?? preferences.useFuzzyTitles ?? false;
  if (fuzzyActive) {
    const fuzzyHits = await fuzzyTitleCandidates({
      query: args.query,
      kinds,
      limit: candidateLimit,
      allowedContainerIds: args.allowedContainerIds,
    });
    if (fuzzyHits.length > 0) {
      for (const hit of fuzzyHits) {
        if (!kindById.has(hit.id)) kindById.set(hit.id, hit.kind);
      }
      channels.push(
        fuzzyHits.map((hit, index) => ({
          id: hit.id,
          rank: index + 1,
          channel: 'fuzzy',
          title: hit.title,
        }))
      );
    }
  }

  let ranked = rankSemanticCandidates({
    channels,
    kindById,
    query: args.query,
    limit: candidateLimit,
  });

  // Graph proximity as a first-class RRF channel.
  // Seed from the pre-fusion vector+FTS union (top-10), walk 1-hop neighbors,
  // and re-fuse with the graph channel added so a node that is both semantically
  // relevant and link-proximate gets reinforced via channel overlap (RRF k=60
  // bounds the lift so links cannot dominate). Gated off by default for a clean
  // before/after A/B against the eval baseline.
  const graphChannelActive =
    (preferences.useGraphChannel ?? false) && args.graphDepth > 0 && ranked.length > 0;
  if (graphChannelActive) {
    const graphSeeds: SemanticRankedHit[] = ranked.slice(0, 10);
    const graphHits = await graphChannelHits(
      graphSeeds,
      candidateLimit,
      preferences.useGraphHubDamping ?? false,
      preferences.useGraphHubExclude ?? false,
      args.includeArchived ?? false,
      args.includeSupersededThreadSummaries ?? false
    );
    if (graphHits.length > 0) {
      for (const hit of graphHits) kindById.set(hit.id, hit.kind);
      channels.push(
        graphHits.map((hit, index) => ({
          id: hit.id,
          rank: index + 1,
          channel: 'graph',
          title: null,
        }))
      );
      ranked = rankSemanticCandidates({
        channels,
        kindById,
        query: args.query,
        limit: candidateLimit,
      });
    }
  }

  if (preferences.threadBoost && args.threadId) {
    const connectedIds = await collectThreadConnectedIds(args.threadId);
    ranked = ranked
      .map((hit) =>
        connectedIds.has(hit.id)
          ? {
              ...hit,
              score: hit.score * 1.25,
            }
          : hit
      )
      .sort((a, b) => b.score - a.score);
  }

  // Every direct channel (including optional graph channels) must treat the
  // current per-agent summary as canonical. Historical versions remain
  // resolvable by exact id, but never compete in ordinary retrieval.
  if (!args.includeSupersededThreadSummaries) {
    ranked = await keepCurrentThreadSummaries(ranked);
  }

  // Committed-path pool mode: hand the fusion pool to the finish pipeline
  // (rerank + cards + floor happen there, at pool level).
  if (args.poolMode) {
    const pool = ranked.slice(0, Math.min(ranked.length, args.poolMode.size));
    return hydrateSemanticHits(pool, memoryScope);
  }

  const direct = ranked.slice(0, args.limit);
  const directHits = await hydrateSemanticHits(direct, memoryScope);

  // Tier-3 (committed paths only): cross-encoder pass over the hydrated hits.
  const finish = async (hits: SearchHit[]): Promise<SearchHit[]> =>
    args.rerank ? (await rerankSearchHits(args.query, hits)).slice(0, args.limit) : hits;

  // When the graph RRF channel is active, suppress the post-fusion
  // tail-backfill: its hits are scored on an absolute scale and APPENDED below
  // the fused block (never fused), so leaving it on would contaminate a clean
  // before/after A/B of the channel change. The backfill is kept for the
  // channel-off path until metrics confirm the channel subsumes it.
  if (
    graphChannelActive ||
    !preferences.useGraphWalk ||
    args.graphDepth <= 0 ||
    direct.length === 0
  ) {
    return finish(directHits);
  }

  const rawGraphRanked = await graphWalkSemanticHits(
    direct.slice(0, 3),
    args.limit - directHits.length,
    args.includeArchived ?? false,
    args.includeSupersededThreadSummaries ?? false
  );
  const graphRanked = args.includeSupersededThreadSummaries
    ? rawGraphRanked
    : await keepCurrentThreadSummaries(rawGraphRanked);
  if (graphRanked.length === 0) return finish(directHits);
  const graphHits = await hydrateSemanticHits(graphRanked, memoryScope);
  return finish([...directHits, ...graphHits].slice(0, args.limit));
}

async function keepCurrentThreadSummaries(
  ranked: SemanticRankedHit[]
): Promise<SemanticRankedHit[]> {
  const summaryIds = ranked.filter((hit) => hit.kind === 'thread_summary').map((hit) => hit.id);
  if (summaryIds.length === 0) return ranked;
  const { rows } = await getDb().query<{ id: string }>(
    `SELECT id FROM public.thread_summaries WHERE id = ANY($1::text[]) AND is_current = true`,
    [summaryIds]
  );
  const currentIds = new Set(rows.map((row) => row.id));
  return ranked.filter((hit) => hit.kind !== 'thread_summary' || currentIds.has(hit.id));
}
