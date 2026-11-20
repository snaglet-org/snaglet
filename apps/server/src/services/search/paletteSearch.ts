import { createQueryEmbedding } from './nodeSearch';
import { searchWorkspace } from './core';

import type { PaletteNodeKind } from '@snaglet/shared/constants/nodeKinds';
import {
  closestKeys,
  coverageFor,
  emptyBuckets,
  isMeaningOnly,
  mergeChannels,
  normalizeMinScore,
  normalizePerKindLimit,
  readSearchPreferences,
  resolveSemanticProvider,
} from './paletteSearchSupport';
import { hydratePaletteHits, paletteHit } from './paletteSearchHydration';
import {
  isNodeSearchPaletteKind,
  normalizeKinds,
  supportsPaletteVector,
} from './paletteSearchSupport';
import { browseKind, resolveExactId, searchPaletteOnlyKind } from './paletteSearchQueries';
import type {
  NodeSearchPaletteKind,
  PaletteSearchHit,
  PaletteSearchInput,
  PaletteSearchResult,
  PaletteSemanticStatus,
} from './paletteSearchSupport';

// Re-exported for back-compat with existing import sites.
export type { PaletteSearchInput, PaletteSearchResult };

export async function paletteSearch(input: PaletteSearchInput): Promise<PaletteSearchResult> {
  const query = input.query.trim();
  const kinds = normalizeKinds(input.kinds);
  const perKindLimit = normalizePerKindLimit(input.perKindLimit);
  const minScore = normalizeMinScore(input.minScore);
  const byKind = emptyBuckets(kinds);
  const preferences = await readSearchPreferences();
  // An explicit mode is a per-query selection from the calling search surface
  // and therefore overrides the stored agent defaults. Omitted mode preserves
  // the existing preference-gated behavior for non-interactive callers.
  const keywordEnabled = input.mode === undefined ? preferences.useFts : input.mode !== 'semantic';
  const vectorEnabled = input.mode === undefined ? preferences.useVector : input.mode !== 'keyword';
  const semantic = !vectorEnabled
    ? { provider: null, status: 'disabled' as PaletteSemanticStatus, reason: null }
    : await resolveSemanticProvider(preferences, vectorEnabled);
  const metadata = () => ({
    semanticStatus: semantic.status,
    semanticStatusReason: semantic.status === 'ready' ? null : semantic.reason,
    coverage: coverageFor(kinds, preferences, semantic.status, input.mode),
  });
  if (!query) {
    if (input.kinds === undefined || kinds.length === 0) {
      return { byKind, channelsUsed: [], ...metadata() };
    }
    await Promise.all(
      kinds.map(async (kind) => {
        byKind[kind] = await browseKind(kind, perKindLimit);
      })
    );
    return { byKind, channelsUsed: [], ...metadata() };
  }

  const exact = await resolveExactId(query);
  if (exact && kinds.includes(exact.kind)) {
    byKind[exact.kind] = await hydratePaletteHits(exact.kind, [
      paletteHit(exact.kind, exact.id, {}),
    ]);
    return { byKind, channelsUsed: [], ...metadata() };
  }

  const shouldEmbed =
    vectorEnabled &&
    semantic.status === 'ready' &&
    kinds.some((kind) => supportsPaletteVector(kind));
  const precomputedEmbedding = shouldEmbed
    ? await createQueryEmbedding(query, undefined, semantic.provider, (message) => {
        semantic.reason = message;
      })
    : null;
  if (shouldEmbed && !precomputedEmbedding) semantic.status = 'unavailable';
  const channelsUsed = new Set<'fts' | 'vector'>();
  // Each lane's hits before hydration; only the ones listed are hydrated.
  const found = emptyBuckets(kinds);

  await Promise.all(
    kinds.map(async (kind) => {
      if (isNodeSearchPaletteKind(kind)) {
        const embedding = supportsPaletteVector(kind) ? precomputedEmbedding : null;
        // A broad search keeps up to perKindLimit keyword hits per kind. RRF
        // interleaves meaning-only neighbors with them, so ask for twice as
        // many; a neighbor then rarely pushes a keyword hit out (RRF's title
        // boost can still lift one whose title contains the query).
        const limit = input.broadInteractiveSearch && embedding ? perKindLimit * 2 : perKindLimit;
        const result = await searchWorkspace(query, {
          kind,
          scope: input.scope ?? { container_id: 'root' },
          limit,
          min_score: minScore,
          precomputedEmbedding: embedding,
          // Explicit per-query modes bypass stored defaults in nodeSearch;
          // omitted mode keeps the existing preference-gated behavior.
          mode: input.mode,
          // Palette/type-ahead is tier 1+2 only (keyword + vector) — the
          // cross-encoder never runs on keystroke-driven queries.
          rerank: false,
          // Keystroke-driven: a half-typed last word still finds its title.
          typeahead: true,
          time_range: input.timeRange,
          order_by: input.orderBy,
        });
        mergeChannels(channelsUsed, result.channels_used);
        found[kind] = result.hits as PaletteSearchHit[];
        return;
      }
      if (keywordEnabled) {
        const hits = await searchPaletteOnlyKind({
          query,
          kind: kind as Exclude<PaletteNodeKind, NodeSearchPaletteKind>,
          limit: perKindLimit,
        });
        if (hits.length > 0) channelsUsed.add('fts');
        found[kind] = hits;
      }
    })
  );

  // A broad search keeps each kind's keyword hits, then only the closest
  // meaning-only hits across all kinds; the route pools those with files.
  const closestMeaning = input.broadInteractiveSearch
    ? closestKeys(
        kinds.flatMap((kind) =>
          (found[kind] ?? [])
            .filter(isMeaningOnly)
            .map((hit) => ({ key: hit.node_id, similarity: hit.vectorSimilarity ?? 0 }))
        )
      )
    : null;
  await Promise.all(
    kinds.map(async (kind) => {
      const hits = found[kind] ?? [];
      const listed = closestMeaning
        ? [
            ...hits.filter((hit) => !isMeaningOnly(hit)).slice(0, perKindLimit),
            ...hits.filter((hit) => isMeaningOnly(hit) && closestMeaning.has(hit.node_id)),
          ]
        : hits.slice(0, perKindLimit);
      byKind[kind] = await hydratePaletteHits(kind, listed);
    })
  );

  return {
    byKind,
    channelsUsed: [...channelsUsed],
    ...metadata(),
  };
}
