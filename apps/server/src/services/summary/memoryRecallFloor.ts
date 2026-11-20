/**
 * memoryRecallFloor — which recalled memories to auto-inject into the turn
 * tail. A fixed cosine floor can't separate relevant memories from generic
 * prose, so a row needs a vectorScore {@link MEMORY_RECALL_MARGIN} above the
 * candidate mean and at least {@link MEMORY_RECALL_MIN_SIMILARITY}; this
 * favors precision (the agent can still `memory(op:search)`). Keyword matches
 * alone admit only on the keyword-only path. Below {@link MEMORY_RECALL_MIN_POOL}
 * candidates, {@link MEMORY_RECALL_SMALL_POOL_FLOOR} applies. Tuned for a fetch of 10.
 */

import type { MemorySearchResult } from '@snaglet/db/tables/memories';

/** Required lead over the candidate mean vectorScore. */
export const MEMORY_RECALL_MARGIN = 0.1;

/** Absolute vectorScore minimum for any admitted row. */
export const MEMORY_RECALL_MIN_SIMILARITY = 0.55;

/** Fewest scored candidates for the mean to be used as the baseline. */
export const MEMORY_RECALL_MIN_POOL = 5;

/** Absolute floor used instead of the margin when the pool is too small. */
export const MEMORY_RECALL_SMALL_POOL_FLOOR = 0.75;

function vectorOf(row: MemorySearchResult): number | null {
  return typeof row.vectorScore === 'number' && Number.isFinite(row.vectorScore)
    ? row.vectorScore
    : null;
}

/**
 * Filter recalled candidates down to the ones worth injecting, preserving
 * their order. `rows` must be the whole candidate set of one query (the mean
 * is taken over it).
 */
export function selectRecalledMemories(rows: MemorySearchResult[]): MemorySearchResult[] {
  const scores = rows.map(vectorOf).filter((v): v is number => v !== null);

  // Keyword-only recall path (no embedder): rows already passed FTS.
  if (scores.length === 0) {
    return rows.filter((row) => typeof row.keywordScore === 'number' && row.keywordScore > 0);
  }

  if (scores.length < MEMORY_RECALL_MIN_POOL) {
    return rows.filter((row) => {
      const v = vectorOf(row);
      return v !== null && v >= MEMORY_RECALL_SMALL_POOL_FLOOR;
    });
  }

  const mean = scores.reduce((sum, v) => sum + v, 0) / scores.length;
  return rows.filter((row) => {
    const v = vectorOf(row);
    return v !== null && v >= MEMORY_RECALL_MIN_SIMILARITY && v - mean >= MEMORY_RECALL_MARGIN;
  });
}
