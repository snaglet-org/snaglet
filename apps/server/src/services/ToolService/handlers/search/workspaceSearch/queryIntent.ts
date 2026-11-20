/**
 * Deterministic (no-LLM) query-intent triggers for the semantic/hybrid lane.
 * Each trigger adds a dedicated per-kind channel so that kind competes within
 * itself instead of drowning in the shared pool, then fuses via RRF.
 */

const THREAD_RECALL_PATTERN = /\b(thread|conversation|chat|talk\w*)\b/i;

/**
 * True for conversational-recall queries ("that thread where…").
 */
export function isThreadRecallQuery(query: string): boolean {
  return THREAD_RECALL_PATTERN.test(query);
}
