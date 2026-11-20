import {
  ConversationBudget,
  type ConversationBudgetSeed,
} from '@server/services/ConversationBudget';
import { settingsService } from '@server/services/settings';
import { budgetSettings } from '@server/services/settings/categories/budget';
import { clampToCeiling, resolveMaxOutputTokensCeiling } from '@server/services/groupChat/safety';
import type { ThreadRuntimeConfig } from '@server/services/ConfigResolverService';

/**
 * Build a ConversationBudget for a chat turn.
 *
 * Thread overrides live in `threads.config_json.budget` (BudgetConfig):
 *   - `maxWaves`: positive N = cap, honored exactly (by design, no server
 *     ceiling clamps waves); `null` =
 *     genuinely unbounded; undefined/non-positive = settings default (no limit).
 *     Runaway safety comes from `maxTotalOutputTokens` below, which always
 *     applies.
 *   - `maxTotalOutputTokens`: positive N = cap, ceiling-clamped (three-tier:
 *     `min(threadOverride ?? settingsDefault, serverCeiling)`). The per-turn
 *     tool cap bounds tool churn; stored `maxTotalToolIterations` and
 *     `maxOutputTokens` keys from older configs are ignored. The total
 *     only gates dispatch — it never sizes a single reply.
 *
 * `seed` carries consumption from an ended run into its self-healing
 * redispatch so the continuation cannot restart the meters.
 *
 * Side effects: reads from `settingsService`; clamps log via safety.ts.
 */
export async function buildConversationBudget(opts: {
  isGroup: boolean;
  threadRuntimeConfig: ThreadRuntimeConfig | null;
  seed?: ConversationBudgetSeed;
}): Promise<ConversationBudget> {
  const { isGroup, threadRuntimeConfig, seed } = opts;

  // One typed object read per profile: the registry returns the schema-validated
  // object (override or default) atomically — no mixed-state risk where one
  // field is overridden and another silently isn't.
  const budget = isGroup
    ? await settingsService.read(budgetSettings.group)
    : await settingsService.read(budgetSettings.solo);
  const defaults = {
    maxTotalOutputTokens: budget.conversationTokenBudget,
    maxWaves: budget.maxWaves,
  };

  const override = threadRuntimeConfig?.budget;

  // null → genuinely unbounded (no server ceiling clamps waves);
  // positive N → honored exactly; anything else → the
  // settings default (no limit). Runaway safety comes from maxTotalOutputTokens
  // below, which still applies unconditionally.
  const maxWaves =
    override?.maxWaves === null
      ? Number.POSITIVE_INFINITY
      : typeof override?.maxWaves === 'number' && override.maxWaves > 0
        ? override.maxWaves
        : (defaults.maxWaves ?? Number.POSITIVE_INFINITY);

  const tokenCeiling = resolveMaxOutputTokensCeiling();
  const requestedTokens =
    typeof override?.maxTotalOutputTokens === 'number' && override.maxTotalOutputTokens > 0
      ? override.maxTotalOutputTokens
      : defaults.maxTotalOutputTokens;
  const maxTotalOutputTokens = clampToCeiling(
    'maxTotalOutputTokens',
    requestedTokens,
    tokenCeiling
  );

  return new ConversationBudget({ maxTotalOutputTokens, maxWaves }, seed);
}
