/**
 * reorderByRerank — the tier-3 reorder contract shared by every committed
 * search path (agent workspace_search, node search / RAG injection).
 *
 * Scores at most {@link RERANK_MAX_CANDIDATES} items with the local ONNX
 * cross-encoder and re-orders them by relevance to the query. Everything
 * past the cap keeps its incoming (RRF) order behind the reranked block, as
 * does anything the reranker unexpectedly drops. Degrades gracefully: any
 * failure (model not installed, runtime error) returns the incoming order.
 * With the `reranker` feature flag off it returns the incoming order without
 * scoring or logging anything, and frees a session left loaded from when the
 * flag was on.
 */
import { logger } from '@server/config/logger';
import { getErrorMessage } from '@snaglet/shared/utils';
import { releaseLocalReranker, rerank, warnIfRerankerUnavailable } from './LocalRerankerService';
import { isRerankerEnabled } from './rerankerFlag';

/**
 * Hard cap on candidates handed to the cross-encoder per committed search.
 * Cost is linear in candidates (query×candidate pairs) and the tail past
 * ~50 RRF-ranked hits almost never contains the answer.
 */
export const RERANK_MAX_CANDIDATES = 50;

export async function reorderByRerank<T>(opts: {
  query: string;
  items: T[];
  getId: (item: T) => string;
  getText: (item: T) => string;
  /** Label for degrade logs, e.g. 'committed workspace search'. */
  context: string;
}): Promise<T[]> {
  return (await reorderByRerankScored(opts)).items;
}

/**
 * Scored variant: reorders like {@link reorderByRerank} AND returns the raw
 * cross-encoder score per reranked id. The quality floor needs
 * the scores, not just the order. `scoreById` is empty when the reranker is
 * turned off, unavailable or degraded — callers must treat "no score" as "not floored"
 * (the floor is a precision gate, never a way to hide results when the judge
 * is offline).
 */
export async function reorderByRerankScored<T>(opts: {
  query: string;
  items: T[];
  getId: (item: T) => string;
  getText: (item: T) => string;
  context: string;
}): Promise<{ items: T[]; scoreById: Map<string, number> }> {
  const { query, items, getId, getText, context } = opts;
  const scoreById = new Map<string, number>();
  if (items.length === 0 || !query.trim()) return { items, scoreById };
  if (!(await isRerankerEnabled())) {
    // No-op unless a session is still loaded; frees it now rather than at idle unload.
    await releaseLocalReranker();
    return { items, scoreById };
  }
  const candidates = items.slice(0, RERANK_MAX_CANDIDATES);
  const tail = items.slice(RERANK_MAX_CANDIDATES);
  try {
    const response = await rerank({
      query,
      candidates: candidates.map((item) => ({ id: getId(item), text: getText(item) })),
      topK: candidates.length,
    });
    for (const result of response.results) {
      if (result.id) scoreById.set(result.id, result.score);
    }
    const byId = new Map(candidates.map((item) => [getId(item), item]));
    const reordered = response.results
      .map((result) => (result.id ? byId.get(result.id) : undefined))
      .filter((item): item is T => item !== undefined);
    const seen = new Set(reordered.map((item) => getId(item)));
    const missed = candidates.filter((item) => !seen.has(getId(item)));
    return { items: [...reordered, ...missed, ...tail], scoreById };
  } catch (err) {
    const notInstalled = await warnIfRerankerUnavailable(context);
    if (!notInstalled) {
      logger.warn(`[rerank] ${context} failed — keeping incoming order: ${getErrorMessage(err)}`);
    }
    return { items, scoreById: new Map() };
  }
}
