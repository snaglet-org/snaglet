/**
 * fallbackPolicy — whether a failed model attempt may retry on the next
 * candidate in the chain.
 *
 * Falling back is a double-cost cache event: the failed provider's warm
 * cache prefix is abandoned, and the fallback provider pays a fresh cache
 * write for the same prefix. Cost-sensitive agents can opt out entirely via
 * `agents.disable_model_fallback = true` — a provider error then fails the
 * turn loudly instead of silently switching models.
 */

export type FallbackDecision =
  | { fallback: true }
  | { fallback: false; reason: 'pinned' | 'disabled' | 'exhausted' };

export function decideFallback(opts: {
  /** Another candidate exists after the one that just failed. */
  hasNextModel: boolean;
  /** The failed candidate was a user-pinned thread override. */
  userPinnedModel: boolean;
  /** agents.config_json.disableModelFallback === true */
  fallbackDisabled: boolean;
}): FallbackDecision {
  if (opts.userPinnedModel) return { fallback: false, reason: 'pinned' };
  if (opts.fallbackDisabled) return { fallback: false, reason: 'disabled' };
  if (!opts.hasNextModel) return { fallback: false, reason: 'exhausted' };
  return { fallback: true };
}
