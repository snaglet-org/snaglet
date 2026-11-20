import { useEffect, useRef, useState } from 'react';
import {
  paletteSearchApi,
  type PaletteAugmentedResponse,
  type PaletteSearchHit,
  type PaletteSearchKind,
} from '@desktop/utils/api';
import {
  DEFAULT_SEARCH_CHANNELS,
  type SearchChannels,
} from '@desktop/components/SearchModeControl';

/**
 * Keyword-first, debounced-hybrid search shared by the command palette,
 * @-mention popup and tree search. Vector search never fires per keystroke:
 * a keyword-only request renders instantly, and a hybrid request fires only
 * after a `debounceMs` pause for queries of at least `minEnrichmentChars`
 * (callers merge its hits below the keyword hits, see {@link stableMergeById}).
 * Each tier owns an AbortController, and a monotonic request id drops stale
 * responses.
 */
export const TIERED_SEARCH_DEFAULT_DEBOUNCE_MS = 300;
export const TIERED_SEARCH_DEFAULT_MIN_ENRICHMENT_CHARS = 3;

export interface UseTieredSearchOptions {
  /** Raw query text. */
  query: string;
  /** When false no requests fire and all tiers clear. */
  enabled?: boolean;
  kinds?: PaletteSearchKind[];
  projectId?: string;
  threadId?: string;
  limit?: number;
  perKindLimit?: number;
  debounceMs?: number;
  minEnrichmentChars?: number;
  /** Per-query channels selected in the calling search surface. */
  channels?: SearchChannels;
  /** Also ask for table rows (`entries` in the response), as the command palette does. */
  includeEntries?: boolean;
}

export interface TieredSearchState {
  /** Instant keyword (FTS/pg_trgm) response — updates on every keystroke. */
  instant: PaletteAugmentedResponse | null;
  /** Debounced hybrid (keyword+vector) response — the semantic enrichment. */
  enriched: PaletteAugmentedResponse | null;
  instantLoading: boolean;
  enrichmentLoading: boolean;
}

function isAbortError(err: unknown): boolean {
  return (err as { name?: string } | null)?.name === 'AbortError';
}

/**
 * Merge two tiers stably: every `instant` item keeps its position, and only the
 * `enriched` items not already present (by id) are appended, in enriched order.
 * This is what keeps the list the user is reading from reordering when the
 * debounced semantic results land.
 */
export function stableMergeById<T>(
  instant: readonly T[],
  enriched: readonly T[],
  idOf: (item: T) => string
): T[] {
  const seen = new Set(instant.map(idOf));
  const merged: T[] = [...instant];
  for (const item of enriched) {
    const id = idOf(item);
    if (seen.has(id)) continue;
    seen.add(id);
    merged.push(item);
  }
  return merged;
}

/**
 * Stable tier merge for palette hits. Keyword positions remain fixed, while a
 * matching hybrid hit contributes its vector channel metadata.
 */
export function mergePaletteHits(
  instant: readonly PaletteSearchHit[],
  refined: readonly PaletteSearchHit[]
): PaletteSearchHit[] {
  const refinedById = new Map(refined.map((hit) => [hit.node_id, hit]));
  const seen = new Set<string>();
  const merged = instant.map((hit) => {
    const match = refinedById.get(hit.node_id);
    seen.add(hit.node_id);
    if (!match) return hit;
    return {
      ...hit,
      channels: [...new Set([...hit.channels, ...match.channels])],
    };
  });
  for (const hit of refined) {
    if (!seen.has(hit.node_id)) merged.push(hit);
  }
  return merged;
}

export function useTieredSearch(options: UseTieredSearchOptions): TieredSearchState {
  const {
    query,
    enabled = true,
    kinds,
    projectId,
    threadId,
    limit,
    perKindLimit,
    debounceMs = TIERED_SEARCH_DEFAULT_DEBOUNCE_MS,
    minEnrichmentChars = TIERED_SEARCH_DEFAULT_MIN_ENRICHMENT_CHARS,
    channels = DEFAULT_SEARCH_CHANNELS,
    includeEntries = false,
  } = options;
  const keywordEnabled = channels.keyword;
  const vectorEnabled = channels.vector;

  const [instant, setInstant] = useState<PaletteAugmentedResponse | null>(null);
  const [enriched, setEnriched] = useState<PaletteAugmentedResponse | null>(null);
  const [instantLoading, setInstantLoading] = useState(false);
  const [enrichmentLoading, setEnrichmentLoading] = useState(false);

  const requestIdRef = useRef(0);
  const instantAbortRef = useRef<AbortController | null>(null);
  const enrichmentAbortRef = useRef<AbortController | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Kinds is the only non-primitive input; a stable key lets the effect depend
  // on its *content* rather than array identity.
  const kindsKey = kinds ? kinds.join(',') : '';

  useEffect(() => {
    const trimmed = query.trim();
    const hasQuery =
      enabled &&
      (keywordEnabled || vectorEnabled) &&
      (trimmed.length > 0 || (kinds?.length ?? 0) > 0);

    // Supersede any prior tiers before starting new ones.
    const requestId = ++requestIdRef.current;
    instantAbortRef.current?.abort();
    enrichmentAbortRef.current?.abort();
    if (debounceRef.current) clearTimeout(debounceRef.current);

    if (!hasQuery) {
      setInstant(null);
      setEnriched(null);
      setInstantLoading(false);
      setEnrichmentLoading(false);
      return;
    }

    // The prior query's semantic additions are stale — drop them until the new
    // debounced enrichment resolves. (Keyword `instant` is kept until its
    // replacement lands to avoid a flash of empty on fast typists.)
    setEnriched(null);

    // Instant keyword tier
    const instantController = new AbortController();
    if (keywordEnabled) {
      instantAbortRef.current = instantController;
      setInstantLoading(true);
      void paletteSearchApi
        .search({
          query,
          mode: 'keyword',
          kinds,
          projectId,
          threadId,
          limit,
          perKindLimit,
          ...(includeEntries ? { includeEntries: true } : {}),
          signal: instantController.signal,
        })
        .then((response) => {
          if (requestId === requestIdRef.current) setInstant(response);
        })
        .catch((err) => {
          if (isAbortError(err) || requestId !== requestIdRef.current) return;
          setInstant(null);
        })
        .finally(() => {
          if (requestId === requestIdRef.current) setInstantLoading(false);
        });
    } else {
      setInstant(null);
      setInstantLoading(false);
    }

    // Debounced hybrid enrichment tier
    if (vectorEnabled && trimmed.length >= minEnrichmentChars) {
      setEnrichmentLoading(true);
      debounceRef.current = setTimeout(() => {
        const enrichmentController = new AbortController();
        enrichmentAbortRef.current = enrichmentController;
        void paletteSearchApi
          .search({
            query,
            mode: keywordEnabled ? 'hybrid' : 'semantic',
            kinds,
            projectId,
            threadId,
            limit,
            perKindLimit,
            ...(includeEntries ? { includeEntries: true } : {}),
            signal: enrichmentController.signal,
          })
          .then((response) => {
            if (requestId === requestIdRef.current) setEnriched(response);
          })
          .catch((err) => {
            if (isAbortError(err) || requestId !== requestIdRef.current) return;
            setEnriched(null);
          })
          .finally(() => {
            if (requestId === requestIdRef.current) setEnrichmentLoading(false);
          });
      }, debounceMs);
    } else {
      setEnrichmentLoading(false);
    }

    return () => {
      instantController.abort();
      enrichmentAbortRef.current?.abort();
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
    // `kindsKey` stands in for the `kinds` array's content; the remaining deps
    // are primitives read directly in the effect.
  }, [
    query,
    enabled,
    kindsKey,
    projectId,
    threadId,
    limit,
    perKindLimit,
    includeEntries,
    debounceMs,
    minEnrichmentChars,
    keywordEnabled,
    vectorEnabled,
  ]);

  useEffect(
    () => () => {
      requestIdRef.current += 1;
      instantAbortRef.current?.abort();
      enrichmentAbortRef.current?.abort();
      if (debounceRef.current) clearTimeout(debounceRef.current);
    },
    []
  );

  return { instant, enriched, instantLoading, enrichmentLoading };
}
