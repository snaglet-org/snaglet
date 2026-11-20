import { PALETTE_NODE_KINDS, type PaletteNodeKind } from '@snaglet/shared/constants/nodeKinds';
import {
  PALETTE_MEANING_MATCH_LIMIT,
  type PaletteSearchMode,
} from '@snaglet/shared/constants/paletteSearch';
import { getErrorMessage, unique } from '@snaglet/shared/utils';
import {
  resolveEmbeddingProvider,
  type EmbeddingProvider,
} from '@server/services/embedding/EmbeddingProvider';
import { getLocalEmbedderStatus } from '@server/services/embedding/LocalEmbedderService';
import { LOCAL_EMBEDDER_PROVIDER_ID } from '@server/services/embedding/embedderModelManifest';
import { settingsService } from '@server/services/settings';
import {
  searchSettings,
  type SearchPreferences,
} from '@server/services/settings/categories/search';
import { clampLimit } from '@server/utils/pagination';
import type { NodeSearchHit, SearchScope } from './nodeSearch';
import { supportsVectorSearch } from './nodeSearch';
import type { SearchExecutionMetadata, StructuredSearchOrder } from './searchPolicy';
import type { NormalizedSearchTimeRange } from './timeRange';

export type { PaletteSearchMode };

export type NodeSearchPaletteKind = Extract<
  PaletteNodeKind,
  'container' | 'doc' | 'thread' | 'message' | 'tool'
>;

export type PaletteSearchHit = Omit<NodeSearchHit, 'kind'> & {
  kind: PaletteNodeKind;
};

/**
 * Search tier requested by an interactive surface:
 *   - `keyword`: FTS/pg_trgm only — the cheap "instant" tier that runs on every
 *     keystroke. Never resolves the embedding provider (no network probe) and
 *     never runs the vector channel.
 *   - `hybrid` (default): keyword + vector fused — the debounced enrichment tier.
 *   - `semantic`: vector only.
 */
export type PaletteSearchInput = {
  query: string;
  kinds?: PaletteNodeKind[];
  perKindLimit?: number;
  minScore?: number;
  scope?: SearchScope;
  /** True only for unfiltered human search across the workspace. */
  broadInteractiveSearch?: boolean;
  timeRange?: NormalizedSearchTimeRange | null;
  orderBy?: StructuredSearchOrder;
  clientDebounceMs?: number;
  /** Search tier. Omitted / `hybrid` preserves the pref-gated keyword+vector path. */
  mode?: PaletteSearchMode;
};

export type PaletteSearchResult = {
  byKind: Partial<Record<PaletteNodeKind, PaletteSearchHit[]>>;
  channelsUsed: ('fts' | 'vector')[];
  semanticStatus: PaletteSemanticStatus;
  /**
   * User-facing reason when semanticStatus is not 'ready' — e.g.
   * "The local embedding model is not installed yet." Lets search UIs
   * tell the user why results are lexical-only and how to fix it.
   */
  semanticStatusReason?: string | null;
  coverage: Partial<Record<PaletteNodeKind, PaletteCoverageMode>>;
  executionPlan?: SearchExecutionMetadata;
};

export type PaletteSemanticStatus = 'ready' | 'disabled' | 'unavailable';
export type PaletteCoverageMode = 'hybrid' | 'semantic' | 'lexical' | 'disabled';

const NODE_SEARCH_PALETTE_KINDS = new Set<PaletteNodeKind>([
  'container',
  'doc',
  'thread',
  'message',
  'tool',
]);

export function isNodeSearchPaletteKind(kind: PaletteNodeKind): kind is NodeSearchPaletteKind {
  return NODE_SEARCH_PALETTE_KINDS.has(kind);
}

export function supportsPaletteVector(kind: PaletteNodeKind): boolean {
  return isNodeSearchPaletteKind(kind) && supportsVectorSearch(kind);
}

export function normalizeKinds(kinds: PaletteNodeKind[] | undefined): PaletteNodeKind[] {
  if (kinds === undefined) return [...PALETTE_NODE_KINDS];
  const allowed = new Set<string>(PALETTE_NODE_KINDS);
  return unique(kinds.filter((kind) => allowed.has(kind)));
}

const DEFAULT_PER_KIND_LIMIT = 6;
const MAX_PER_KIND_LIMIT = 20;

export async function readSearchPreferences(): Promise<SearchPreferences> {
  return settingsService.read(searchSettings.preferences);
}

export function normalizePerKindLimit(limit: unknown): number {
  if (typeof limit !== 'number' || !Number.isFinite(limit)) return DEFAULT_PER_KIND_LIMIT;
  return clampLimit(limit, {
    defaultLimit: DEFAULT_PER_KIND_LIMIT,
    defaultOnNonPositive: false,
    max: MAX_PER_KIND_LIMIT,
  });
}

export function normalizeMinScore(minScore: unknown): number | undefined {
  if (minScore === undefined) return undefined;
  if (typeof minScore !== 'number' || !Number.isFinite(minScore) || minScore < 0 || minScore > 1) {
    throw new Error('paletteSearch: minScore must be a number between 0 and 1');
  }
  return minScore;
}

export function emptyBuckets(
  kinds: PaletteNodeKind[]
): Partial<Record<PaletteNodeKind, PaletteSearchHit[]>> {
  return Object.fromEntries(kinds.map((kind) => [kind, []])) as Partial<
    Record<PaletteNodeKind, PaletteSearchHit[]>
  >;
}

/** Found only by meaning: the vector channel matched it and the keyword channel did not. */
export function isMeaningOnly(hit: Pick<PaletteSearchHit, 'channels'>): boolean {
  return hit.channels.includes('vector') && !hit.channels.includes('fts');
}

/** Keys of the `limit` most similar candidates; the key breaks ties so the pick is stable. */
export function closestKeys(
  candidates: { key: string; similarity: number }[],
  limit = PALETTE_MEANING_MATCH_LIMIT
): Set<string> {
  return new Set(
    [...candidates]
      .sort((a, b) => b.similarity - a.similarity || a.key.localeCompare(b.key))
      .slice(0, limit)
      .map((candidate) => candidate.key)
  );
}

/**
 * An unfiltered search's meaning-only workspace hits and its indexed files
 * share one budget: the closest `PALETTE_MEANING_MATCH_LIMIT` of them all.
 * A file's score is cosine similarity, the same scale as `vectorSimilarity`.
 * Keyword hits are kept as they are.
 */
export function shareMeaningBudget<F extends { nodeId: string; score: number }>(
  byKind: PaletteSearchResult['byKind'],
  files: F[]
): { byKind: PaletteSearchResult['byKind']; files: F[] } {
  const keep = closestKeys([
    ...Object.values(byKind).flatMap((hits) =>
      (hits ?? [])
        .filter(isMeaningOnly)
        .map((hit) => ({ key: `node:${hit.node_id}`, similarity: hit.vectorSimilarity ?? 0 }))
    ),
    ...files.map((file) => ({ key: `file:${file.nodeId}`, similarity: file.score })),
  ]);
  return {
    byKind: Object.fromEntries(
      Object.entries(byKind).map(([kind, hits]) => [
        kind,
        (hits ?? []).filter((hit) => !isMeaningOnly(hit) || keep.has(`node:${hit.node_id}`)),
      ])
    ) as PaletteSearchResult['byKind'],
    files: files.filter((file) => keep.has(`file:${file.nodeId}`)),
  };
}

export function mergeChannels(
  current: Set<'fts' | 'vector'>,
  channels: ('fts' | 'vector')[]
): void {
  for (const channel of channels) current.add(channel);
}

export async function resolveSemanticProvider(
  preferences: SearchPreferences,
  vectorEnabled = preferences.useVector
): Promise<{
  provider: EmbeddingProvider | null;
  status: PaletteSemanticStatus;
  /** User-facing reason when status is not 'ready'. */
  reason: string | null;
}> {
  if (!vectorEnabled) {
    return { provider: null, status: 'disabled', reason: 'Vector search is turned off.' };
  }

  try {
    const provider = await resolveEmbeddingProvider();
    if (!provider) {
      return {
        provider: null,
        status: 'unavailable',
        reason: 'The built-in embedding model is not available.',
      };
    }
    // The built-in local embedder is always "configured" but only usable once
    // its model files are downloaded (first boot fetches them in background).
    if (provider.info.provider === LOCAL_EMBEDDER_PROVIDER_ID) {
      const status = await getLocalEmbedderStatus();
      if (!status.ready) {
        return {
          provider: null,
          status: 'unavailable',
          reason: status.error ?? 'The local embedding model is not installed yet.',
        };
      }
    }
    return { provider, status: 'ready', reason: null };
  } catch (err) {
    return {
      provider: null,
      status: 'unavailable',
      reason: getErrorMessage(err),
    };
  }
}

export function coverageFor(
  kinds: PaletteNodeKind[],
  preferences: SearchPreferences,
  semanticStatus: PaletteSemanticStatus,
  mode?: PaletteSearchMode
): Partial<Record<PaletteNodeKind, PaletteCoverageMode>> {
  return Object.fromEntries(
    kinds.map((kind) => {
      const hasLexical = mode === undefined ? preferences.useFts : mode !== 'semantic';
      const vectorEnabled = mode === undefined ? preferences.useVector : mode !== 'keyword';
      const hasSemantic =
        vectorEnabled && semanticStatus === 'ready' && supportsPaletteVector(kind);
      const coverageMode = hasLexical
        ? hasSemantic
          ? 'hybrid'
          : 'lexical'
        : hasSemantic
          ? 'semantic'
          : 'disabled';
      return [kind, coverageMode];
    })
  ) as Partial<Record<PaletteNodeKind, PaletteCoverageMode>>;
}
