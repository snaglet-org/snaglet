import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { PALETTE_ENTRY_STRONG_MATCH_SCORE } from '@snaglet/shared/constants';
import {
  containersApi,
  docsApi,
  paletteSearchApi,
  PALETTE_NODE_KINDS,
  type LibraryTreeChild,
  type PaletteEntryHit,
  type PaletteNodeKind,
  type PaletteAugmentedResponse,
  type PaletteCoverageMode,
  type PaletteSemanticStatus,
  type PaletteFileNodeItem,
  type PaletteFilesystemItem,
} from '@desktop/utils/api';
import {
  mergePaletteHits,
  stableMergeById,
  TIERED_SEARCH_DEFAULT_DEBOUNCE_MS,
  TIERED_SEARCH_DEFAULT_MIN_ENRICHMENT_CHARS,
} from '@desktop/hooks/useTieredSearch';
import {
  DEFAULT_SEARCH_CHANNELS,
  type SearchChannels,
} from '@desktop/components/SearchModeControl';
import {
  entryHitToNode,
  KIND_SECTION_LABELS,
  serverHitToNode,
  toSearchResult,
  type Kind,
  type PaletteResultNode,
  type SearchResult,
  type SearchSection,
} from './paletteResultMappers';
import { planPaletteSearch, type EntryFilter } from '@desktop/utils/api/searchPlan';
import { containerPlaces, resultLocation, type ContainerPlace } from './paletteLocation';
import { flatten, treeHitsFor } from './treeSearch';

/** Filesystem-style filters that aren't workspace node kinds. */
export type FsFilter = 'file' | 'folder';

/**
 * Search results keep list payloads lean. Hydrate server-only records that feed
 * views which consume full snapshots before selecting them.
 */
export async function hydrateSearchResultNode(hit: SearchResult): Promise<PaletteResultNode> {
  if (hit.origin === 'lexical') return hit.node;

  try {
    if (hit.node.kind === 'doc') {
      const doc = await docsApi.get(hit.node.id);
      return { kind: 'doc', ...doc };
    }
    if (hit.node.kind === 'container') {
      const match = flatten(await containersApi.listTree()).find((node) => node.id === hit.node.id);
      return match?.kind === 'container' ? match : hit.node;
    }
  } catch {
    // Opening the lightweight result is still better than dropping the click.
  }

  return hit.node;
}

const MAX_RESULTS = 12;

function entrySection(id: string, label: string, hits: PaletteEntryHit[]): SearchSection {
  return {
    id,
    label,
    origin: 'server',
    results: hits.map((hit) => toSearchResult(entryHitToNode(hit), 'server', ['fts'])),
  };
}

/**
 * Table rows among the other sections. A row whose Name is the query or starts
 * with it (a strong match) is listed right after the first section, so it is
 * seen without scrolling past every kind; the other rows stay in the Entries
 * section after every other kind. Each row appears once, best first. With no
 * other section — an `entry:` search, or a query only rows match — every row
 * is one Entries section, as the server ordered them.
 */
function placeEntrySections(
  sections: SearchSection[],
  entries: PaletteEntryHit[]
): SearchSection[] {
  if (entries.length === 0) return sections;
  const strong = entries.filter((hit) => hit.score >= PALETTE_ENTRY_STRONG_MATCH_SCORE);
  const [first, ...rest] = sections;
  if (!first || strong.length === 0) {
    return [...sections, entrySection('server-entry', KIND_SECTION_LABELS.entry, entries)];
  }
  const weak = entries.filter((hit) => hit.score < PALETTE_ENTRY_STRONG_MATCH_SCORE);
  return [
    first,
    entrySection('server-entry', KIND_SECTION_LABELS.entry, strong),
    ...rest,
    ...(weak.length > 0 ? [entrySection('server-entry-more', 'More entries', weak)] : []),
  ];
}

function isAbortError(err: unknown): boolean {
  return typeof err === 'object' && err !== null && 'name' in err && err.name === 'AbortError';
}

function hasStructuredSearchSyntax(query: string): boolean {
  return /\b(?:in|within|under)\s+(?:the\s+)?(?:project|container)?\s*["']?[\w-]|\b(?:this|current|active)\s+project\b|\b(?:across|between|all|other)\s+projects?\b|\b(?:today|yesterday|tomorrow|ago|last|this|next|latest|newest|recent|january|february|march|april|may|june|july|august|september|october|november|december)\b|\b\d{4}-\d{1,2}-\d{1,2}\b/i.test(
    query
  );
}

export function useQuickSearch(activeNodeId?: string | null) {
  const cacheRef = useRef<LibraryTreeChild[] | null>(null);
  const cachePromiseRef = useRef<Promise<LibraryTreeChild[]> | null>(null);
  const requestIdRef = useRef(0);
  const keywordAbortRef = useRef<AbortController | null>(null);
  const enrichmentAbortRef = useRef<AbortController | null>(null);
  const enrichmentTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const [lexicalResults, setLexicalResults] = useState<SearchResult[]>([]);
  // The workspace's folders and projects, from the last tree read: each
  // result's location path is spelled from them.
  const [containers, setContainers] = useState<ReadonlyMap<string, ContainerPlace>>(
    () => new Map()
  );
  // Raw tier responses; sections/files/coverage are derived below. Keyword is
  // instant FTS/pg_trgm and enriched adds debounced vector hits.
  const [keywordResult, setKeywordResult] = useState<PaletteAugmentedResponse | null>(null);
  const [enrichedResult, setEnrichedResult] = useState<PaletteAugmentedResponse | null>(null);
  const [executionPlan, setExecutionPlan] = useState<
    PaletteAugmentedResponse['executionPlan'] | null
  >(null);
  const [lexicalLoading, setLexicalLoading] = useState(false);
  const [keywordLoading, setKeywordLoading] = useState(false);
  const [enrichmentLoading, setEnrichmentLoading] = useState(false);

  const loadTree = useCallback(async (): Promise<LibraryTreeChild[]> => {
    if (cacheRef.current) return cacheRef.current;
    if (!cachePromiseRef.current) {
      cachePromiseRef.current = containersApi
        .listTree()
        .then((tree) => {
          const nodes = flatten(tree ?? []);
          cacheRef.current = nodes;
          setContainers(containerPlaces(nodes));
          return nodes;
        })
        // A failed read is not cached, so the next keystroke retries rather
        // than matching against an empty tree until the palette reopens.
        .catch(() => [] as LibraryTreeChild[])
        .finally(() => {
          cachePromiseRef.current = null;
        });
    }
    return cachePromiseRef.current;
  }, []);

  // Per-kind server sections = keyword (instant) hits, with debounced hybrid
  // enrichment stably appended.
  const serverSections = useMemo<SearchSection[]>(
    () =>
      PALETTE_NODE_KINDS.flatMap((kind) => {
        const keywordHits = keywordResult?.byKind[kind] ?? [];
        const enrichedHits = enrichedResult?.byKind[kind] ?? [];
        const mergedHits = mergePaletteHits(keywordHits, enrichedHits);
        if (mergedHits.length === 0) return [];
        return [
          {
            id: `server-${kind}`,
            label: KIND_SECTION_LABELS[kind] ?? kind,
            origin: 'server' as const,
            results: mergedHits.map((hit) =>
              toSearchResult(serverHitToNode(hit), 'server', hit.channels)
            ),
          },
        ];
      }),
    [keywordResult, enrichedResult]
  );

  // File nodes are vector-only, so they arrive with the hybrid enrichment.
  const fileResults = useMemo<PaletteFileNodeItem[]>(
    () => enrichedResult?.files ?? keywordResult?.files ?? [],
    [keywordResult, enrichedResult]
  );
  const filesystemResults = useMemo<PaletteFilesystemItem[]>(
    () =>
      stableMergeById(
        keywordResult?.filesystem ?? [],
        enrichedResult?.filesystem ?? [],
        (item) => item.path
      ),
    [keywordResult, enrichedResult]
  );

  // Coverage / semantic status describe the hybrid tier — surface them only
  // once the enrichment has resolved.
  const coverage: Partial<Record<PaletteNodeKind, PaletteCoverageMode>> =
    enrichedResult?.coverage ?? {};
  const semanticStatus: PaletteSemanticStatus | 'unknown' =
    enrichedResult?.semanticStatus ?? 'unknown';
  const semanticStatusReason = enrichedResult?.semanticStatusReason ?? null;

  const sections = useMemo(() => {
    const serverById = new Map(
      serverSections.flatMap((section) =>
        section.results.map((result) => [result.node.id, result] as const)
      )
    );
    const enrichedLexical = lexicalResults.map((result) => {
      const serverMatch = serverById.get(result.node.id);
      return serverMatch
        ? {
            ...result,
            channels: serverMatch.channels,
          }
        : result;
    });
    const seen = new Set(enrichedLexical.map((result) => result.node.id));
    const dedupedServer = serverSections.flatMap((section) => {
      const results = section.results.filter((result) => {
        if (seen.has(result.node.id)) return false;
        seen.add(result.node.id);
        return true;
      });
      return results.length > 0 ? [{ ...section, results }] : [];
    });

    return [
      ...(enrichedLexical.length > 0
        ? [
            {
              // Name matches from the client-side tree pass, ranked first.
              id: 'lexical',
              label: 'Best matches',
              origin: 'lexical' as const,
              results: enrichedLexical,
            },
          ]
        : []),
      ...dedupedServer,
    ];
  }, [lexicalResults, serverSections]);

  // Table rows: an `entry:` search's results, or the unfiltered search's short
  // Entries section. Keyword-tier only. Strong Name matches follow the first
  // section; the rest are listed after every other kind so they never crowd
  // docs and threads out.
  const allSections = useMemo(
    () =>
      placeEntrySections(sections, keywordResult?.entries ?? []).map((section) => ({
        ...section,
        results: section.results.map((result) => ({
          ...result,
          location: resultLocation(result.node, containers),
        })),
      })),
    [sections, keywordResult, containers]
  );

  const results = useMemo(() => allSections.flatMap((section) => section.results), [allSections]);

  const search = useCallback(
    async (
      term: string,
      kinds: Kind[] | null,
      fsFilter: FsFilter | null = null,
      channels: SearchChannels = DEFAULT_SEARCH_CHANNELS,
      entryFilter: EntryFilter | null = null
    ) => {
      const requestId = ++requestIdRef.current;
      const trimmedTerm = term.trim();
      const hasQuery = Boolean(trimmedTerm || kinds?.length || fsFilter || entryFilter);

      // Supersede prior tiers: abort in-flight requests + cancel the pending
      // enrichment debounce. The previous query's semantic hits are stale.
      keywordAbortRef.current?.abort();
      enrichmentAbortRef.current?.abort();
      if (enrichmentTimerRef.current) clearTimeout(enrichmentTimerRef.current);
      setEnrichedResult(null);
      setExecutionPlan(null);

      if (!hasQuery) {
        setLexicalResults([]);
        setKeywordResult(null);
        setLexicalLoading(false);
        setKeywordLoading(false);
        setEnrichmentLoading(false);
        return;
      }

      // An entry search is one keyword request: rows are matched lexically,
      // so there is no semantic tier and no workspace tree to walk.
      const plan = planPaletteSearch({ term: trimmedTerm, kinds, fsFilter, entryFilter });
      if (plan.entryOnly) {
        const entryController = new AbortController();
        keywordAbortRef.current = entryController;
        setLexicalResults([]);
        setLexicalLoading(false);
        setEnrichmentLoading(false);
        setKeywordLoading(true);
        void paletteSearchApi
          .search({
            query: plan.query,
            mode: 'keyword',
            activeNodeId: activeNodeId ?? undefined,
            signal: entryController.signal,
          })
          .then((response) => {
            if (requestId === requestIdRef.current) {
              setKeywordResult(response);
              setExecutionPlan(response.executionPlan ?? null);
            }
          })
          .catch((err) => {
            if (isAbortError(err) || requestId !== requestIdRef.current) return;
            setKeywordResult(null);
          })
          .finally(() => {
            if (requestId === requestIdRef.current) setKeywordLoading(false);
          });
        return;
      }

      const serverQuery = plan.query;
      const serverKinds = plan.kinds;
      const includeEntries = plan.includeEntries;

      // Instant keyword tier — every keystroke, no debounce.
      if (channels.keyword) {
        const keywordController = new AbortController();
        keywordAbortRef.current = keywordController;
        setKeywordLoading(true);
        void paletteSearchApi
          .search({
            query: serverQuery,
            mode: 'keyword',
            ...(serverKinds ? { kinds: serverKinds } : {}),
            ...(includeEntries ? { includeEntries: true } : {}),
            perKindLimit: 6,
            activeNodeId: activeNodeId ?? undefined,
            signal: keywordController.signal,
          })
          .then((response) => {
            if (requestId === requestIdRef.current) {
              setKeywordResult(response);
              setExecutionPlan(response.executionPlan ?? null);
            }
          })
          .catch((err) => {
            if (isAbortError(err) || requestId !== requestIdRef.current) return;
            setKeywordResult(null);
          })
          .finally(() => {
            if (requestId === requestIdRef.current) setKeywordLoading(false);
          });
      } else {
        setKeywordResult(null);
        setKeywordLoading(false);
      }

      // Debounced hybrid enrichment tier (semantic), gated on length.
      if (channels.vector && trimmedTerm.length >= TIERED_SEARCH_DEFAULT_MIN_ENRICHMENT_CHARS) {
        setEnrichmentLoading(true);
        enrichmentTimerRef.current = setTimeout(() => {
          const enrichmentController = new AbortController();
          enrichmentAbortRef.current = enrichmentController;
          void paletteSearchApi
            .search({
              query: serverQuery,
              mode: channels.keyword ? 'hybrid' : 'semantic',
              ...(serverKinds ? { kinds: serverKinds } : {}),
              perKindLimit: 6,
              activeNodeId: activeNodeId ?? undefined,
              clientDebounceMs: TIERED_SEARCH_DEFAULT_DEBOUNCE_MS,
              signal: enrichmentController.signal,
            })
            .then((response) => {
              if (requestId === requestIdRef.current) {
                setEnrichedResult(response);
                setExecutionPlan(response.executionPlan ?? null);
              }
            })
            .catch((err) => {
              if (isAbortError(err) || requestId !== requestIdRef.current) return;
              setEnrichedResult(null);
            })
            .finally(() => {
              if (requestId === requestIdRef.current) setEnrichmentLoading(false);
            });
        }, TIERED_SEARCH_DEFAULT_DEBOUNCE_MS);
      } else {
        setEnrichmentLoading(false);
      }

      // file:/folder: filter → only file/filesystem results; the server search
      // above handles them, so skip the lexical workspace-node search entirely.
      if (fsFilter) {
        setLexicalResults([]);
        setLexicalLoading(false);
        return;
      }

      // The lexical pass is the client-side name/title matcher over the cached
      // tree; it belongs to the Keyword channel and tolerates typos. Without
      // it the tree is still read, for the results' location paths.
      if (!channels.keyword) {
        setLexicalResults([]);
        setLexicalLoading(false);
        void loadTree();
        return;
      }

      const includesTree =
        !kinds || kinds.some((kind) => kind === 'container' || kind === 'doc' || kind === 'thread');
      const serverMustExecuteStructure = hasStructuredSearchSyntax(trimmedTerm);

      const buildLexicalNodes = (nodes: LibraryTreeChild[]): LibraryTreeChild[] =>
        includesTree && !serverMustExecuteStructure ? treeHitsFor(nodes, trimmedTerm, kinds) : [];

      setLexicalResults(
        buildLexicalNodes(cacheRef.current ?? [])
          .slice(0, MAX_RESULTS)
          .map((node) => toSearchResult(node, 'lexical'))
      );
      setLexicalLoading(true);

      try {
        // Projects are containers (category='project') and tasks are docs, so
        // both surface through the tree walk with no separate fetch.
        const nodes = await loadTree();
        if (requestId !== requestIdRef.current) return;
        setLexicalResults(
          buildLexicalNodes(nodes)
            .slice(0, MAX_RESULTS)
            .map((node) => toSearchResult(node, 'lexical'))
        );
      } finally {
        if (requestId === requestIdRef.current) setLexicalLoading(false);
      }
    },
    [activeNodeId, loadTree]
  );

  /** Bust the cache so the next search re-fetches. */
  const invalidate = useCallback(() => {
    cacheRef.current = null;
    cachePromiseRef.current = null;
  }, []);

  useEffect(
    () => () => {
      requestIdRef.current += 1;
      keywordAbortRef.current?.abort();
      enrichmentAbortRef.current?.abort();
      if (enrichmentTimerRef.current) clearTimeout(enrichmentTimerRef.current);
    },
    []
  );

  return {
    results,
    sections: allSections,
    fileResults,
    filesystemResults,
    loading: lexicalLoading || keywordLoading || enrichmentLoading,
    lexicalLoading,
    serverLoading: keywordLoading || enrichmentLoading,
    semanticStatus,
    semanticStatusReason,
    executionPlan,
    coverage,
    search,
    invalidate,
  };
}
