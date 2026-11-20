/**
 * rerankSearchHits — tier-3 precision pass for COMMITTED search paths.
 *
 * Palette/type-ahead calls never come through here (rerank is a property of
 * the calling path — see docs "Search UX & tiering"); committed searches
 * (agent workspace_search, RAG injection) re-order their candidate set with
 * the local ONNX cross-encoder before returning. Cap and degrade behavior
 * live in the shared reorderByRerank contract.
 */

import { reorderByRerank, reorderByRerankScored } from '@server/services/reranking/reorderByRerank';
import type { SearchHit } from './types';

export { RERANK_MAX_CANDIDATES } from '@server/services/reranking/reorderByRerank';

function field(hit: SearchHit, key: string): string {
  const value = (hit as unknown as Record<string, unknown>)[key];
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * Every field that carries a hit's identity/body across the per-kind
 * SearchHit shapes. Must cover every kind: a kind whose text lives under a
 * name missing from this list is judged by the cross-encoder as its bare
 * kind string ("thread_summary") and systematically sinks — this silently
 * kneecaps thread summaries (`summaryText`/`threadTitle`), semantic file
 * hits (`relativePath`), and memory keys (`key`). When adding a SearchHit
 * kind, add its text fields here.
 */
const HIT_TEXT_FIELDS = [
  'title',
  'name',
  'threadTitle',
  'summaryText',
  'key',
  'snippet',
  'content',
  'contentText',
  'description',
  'relativePath',
  'path',
] as const;

/** Text the cross-encoder judges a hit by (shared with opening-retrieval). */
export function searchHitText(hit: SearchHit): string {
  const record = hit as unknown as Record<string, unknown>;
  const stringParts = HIT_TEXT_FIELDS.map((key) => field(hit, key)).filter(Boolean);
  const tags = Array.isArray(record.tags)
    ? record.tags.filter((t): t is string => typeof t === 'string').join(' ')
    : '';
  return [...new Set([...stringParts, tags].filter(Boolean))].join(' — ') || hit.kind;
}

/** Re-order `hits` by cross-encoder relevance to `query`. */
export async function rerankSearchHits(query: string, hits: SearchHit[]): Promise<SearchHit[]> {
  return reorderByRerank({
    query,
    items: hits,
    getId: (hit) => hit.id,
    getText: searchHitText,
    context: 'committed workspace search',
  });
}

/**
 * Scored variant used by the committed-search finish pipeline: reorders by
 * cross-encoder relevance AND returns the raw score per hit id so the quality
 * floor can threshold. `scoreById` is empty when the reranker is offline.
 */
export async function rerankSearchHitsScored(
  query: string,
  hits: SearchHit[]
): Promise<{ items: SearchHit[]; scoreById: Map<string, number> }> {
  return reorderByRerankScored({
    query,
    items: hits,
    getId: (hit) => hit.id,
    getText: searchHitText,
    context: 'committed workspace search',
  });
}
