/**
 * cacheFootprintTracker — remembers the most recent prompt-cache footprint
 * per (thread, agent) so a model fallback can report how much warm cache it
 * abandons.
 *
 * Footprint = cache_read + cache_creation tokens of the last successful
 * iteration: together they approximate the full cached prefix the provider
 * was serving. Purely observational — bounded in-memory map, no persistence.
 */

const MAX_ENTRIES = 1000;

const footprints = new Map<string, number>();

function keyOf(threadId: string, agentId: string): string {
  return `${threadId}:${agentId}`;
}

export function recordCacheFootprint(
  threadId: string,
  agentId: string,
  usage: { cacheReadTokens?: number; cacheCreationTokens?: number } | undefined
): void {
  if (!usage) return;
  const footprint = (usage.cacheReadTokens ?? 0) + (usage.cacheCreationTokens ?? 0);
  if (footprint <= 0) return;
  // Bounded: evict the oldest entry once full (Map preserves insert order).
  if (!footprints.has(keyOf(threadId, agentId)) && footprints.size >= MAX_ENTRIES) {
    const oldest = footprints.keys().next().value;
    if (oldest !== undefined) footprints.delete(oldest);
  }
  // Delete-then-set so refreshed entries move to the back of the eviction order.
  footprints.delete(keyOf(threadId, agentId));
  footprints.set(keyOf(threadId, agentId), footprint);
}

/** Estimated warm-cache tokens abandoned if this (thread, agent) switches provider now. */
export function estimateAbandonedCacheTokens(threadId: string, agentId: string): number {
  return footprints.get(keyOf(threadId, agentId)) ?? 0;
}
