/**
 * Context budget resolution — turns an agent's effective model (thread
 * override → agent primary → default) into the token budget the compression
 * and usage-estimation paths work against.
 */

import type { SnagletAgent } from '@server/services/AgentService';
import { estimateTokens } from '@server/services/TokenEstimator';
import { Models } from '@snaglet/db/tables/models';
import { Threads } from '@snaglet/db/tables/threads';
import { resolveModelMetadata } from '@server/services/metadataResolver';
import { logger } from '@server/config/logger';
import {
  DEFAULT_CONTEXT_WINDOW,
  DEFAULT_MAX_OUTPUT,
  PROVIDER_DEFAULT_CONTEXT_WINDOW,
  DEFAULT_SAFETY_MARGIN_PCT,
  DEFAULT_TOKEN_BUDGET_RATIO,
  MAX_SUMMARY_CHARS,
  MIN_MESSAGES_BEFORE_COMPRESSION,
  MIN_USABLE_BUDGET_FRACTION,
  MIN_USABLE_BUDGET_TOKENS,
  OUTPUT_RESERVE_CAP_TOKENS,
  PROVIDER_SAFETY_MARGIN_PCT,
} from './constants';
import { measureToolCatalogTokens, type ContextOverheadInput } from './overhead';

export type { ContextOverheadInput };

export interface ContextBudget {
  /** Declared window from the model registry (shown in UI as the raw total). */
  contextWindowTokens: number;
  /** Declared window minus the per-provider safety margin — budget math uses this. */
  effectiveContextWindowTokens: number;
  /** Resolved safety margin percentage (metadata override or provider default). */
  safetyMarginPct: number;
  /** Output size the budget reserves room for: the model's max output, else a default. */
  maxOutputTokens: number;
  /** The model's max output from its catalog row; null when the catalog does not know it. */
  modelMaxOutputTokens: number | null;
  /**
   * Tokens for the system prompt actually sent. That is the COMPOSED prompt
   * when the caller supplies it (`overhead.systemPromptText`); callers that
   * can't fall back to the agent's raw persona field, which is a strict subset.
   */
  systemPromptTokens: number;
  /** Tokens for the advertised `tools` payload. 0 when the caller supplied none. */
  toolCatalogTokens: number;
  /** systemPromptTokens + toolCatalogTokens — everything sent that isn't a message. */
  overheadTokens: number;
  /**
   * True when overhead alone left less than the usable-budget floor, so the
   * floor was applied instead of the (near-zero or negative) real remainder.
   */
  overheadFloored: boolean;
  /** Room left for MESSAGES: effective window − output reserve − overhead. */
  usableBudget: number;
  /** Projected-token threshold that triggers compression (= usableBudget × tokenBudgetRatio). */
  tokenThreshold: number;
  provider: string;
  /** Effective model id — estimator strategies key off it (tiktoken encoding). */
  modelId: string;
  /**
   * Per-model tail override from model_metadata.contextCompression
   *. When undefined — the normal case — the tail
   * is derived at compression time from the token budget.
   */
  tailMessages?: number;
  /**
   * Anthropic prompt-cache TTL. Resolver populates
   * the model-metadata override only; prepareModelAttemptContext applies the
   * runtime default ('1h' chat) so downstream consumers always see a value.
   */
  cacheTtl?: '5m' | '1h';
  /** Internal safety floor: do not compress threads shorter than this. */
  minMessagesBeforeCompression: number;
  /** Internal hard cap on summary text length, in chars. */
  maxSummaryChars: number;
}

/**
 * The output limit one model request carries: the model's max output (the
 * catalog row's limit), so a thinking model has room for its answer after
 * thinking. It is lowered only when the window cannot hold that much output
 * on top of a prompt at the compaction threshold, as for a model whose max
 * output equals its window. Undefined when the catalog does not know the
 * model's limit: the request then leaves the field out and the provider
 * applies its own maximum.
 */
export function requestMaxOutputTokens(
  budget: Pick<ContextBudget, 'contextWindowTokens' | 'overheadTokens' | 'tokenThreshold'> & {
    modelMaxOutputTokens?: number | null;
  }
): number | undefined {
  const limit = budget.modelMaxOutputTokens;
  if (limit === null || limit === undefined) return undefined;
  const room = budget.contextWindowTokens - budget.overheadTokens - budget.tokenThreshold;
  return room > 0 ? Math.min(limit, room) : limit;
}

/**
 * Resolve the context budget for an agent in a thread.
 * Uses the effective model (thread override → agent primary → agent default).
 *
 * `overhead` carries what the caller has already assembled for THIS request —
 * the composed system prompt and the advertised tool catalog. Both are sent on
 * every call and both must come out of the window before any message budget is
 * computed. Callers without them still get a coherent budget; it just
 * understates the overhead, which is exactly the defect this parameter exists
 * to close on the paths that do have the real values.
 */
export async function resolveContextBudget(
  agent: SnagletAgent,
  threadId: string,
  overhead?: ContextOverheadInput
): Promise<ContextBudget> {
  const effective = await Threads.getEffectiveModel(threadId, agent.id);
  const providerId = effective?.providerId ?? agent.provider;
  const modelId = effective?.modelId ?? agent.modelId ?? '';

  const model = await Models.findByProviderAndModelId(providerId, modelId);

  // An unknown window takes the provider's smallest published one, else 8,192.
  const fallbackWindow = PROVIDER_DEFAULT_CONTEXT_WINDOW[providerId] ?? DEFAULT_CONTEXT_WINDOW;
  const contextWindowTokens = model?.contextWindowTokens ?? fallbackWindow;
  const maxOutputTokens = model?.maxOutputTokens ?? DEFAULT_MAX_OUTPUT;
  // The composed prompt replaces the persona field — the persona is one block
  // inside it, so adding them would double-count.
  const systemPromptText = overhead?.systemPromptText ?? agent.systemPrompt ?? '';
  const systemPromptTokens = estimateTokens(systemPromptText, providerId, modelId);
  const toolCatalogTokens = overhead?.toolRows?.length
    ? measureToolCatalogTokens(overhead.toolRows, providerId, modelId)
    : 0;
  const overheadTokens = systemPromptTokens + toolCatalogTokens;

  if (!model?.contextWindowTokens) {
    logger.warn(
      `[context] No context_window_tokens for ${providerId}/${modelId}, using default ${fallbackWindow}`
    );
  }

  const meta = await resolveModelMetadata(providerId, modelId);
  const cc = meta.contextCompression ?? {};

  // Safety margin: shave the declared window before
  // any budget math — declared windows are optimistic. Metadata override
  // (model row → provider default) wins; clamp to [0, 90] so garbage metadata
  // can't zero out the budget.
  const rawMarginPct =
    meta.safetyMarginPct ?? PROVIDER_SAFETY_MARGIN_PCT[providerId] ?? DEFAULT_SAFETY_MARGIN_PCT;
  const safetyMarginPct = Math.min(90, Math.max(0, Number(rawMarginPct) || 0));
  const effectiveContextWindowTokens = Math.floor(
    contextWindowTokens * (1 - safetyMarginPct / 100)
  );

  // Message room = window − output reserve − everything sent that isn't a
  // message. Note compressMessages measures (system prompt + messages) against
  // the threshold derived from this, so the system prompt sits on both sides:
  // deliberate, and conservative by exactly the prompt's size.
  // The output reserve is the declared max CAPPED: subtracting a large model's
  // full theoretical max output (codex gpt-5.6: 128K of a 372K window) starves
  // the message budget for reply room that is never actually used.
  const outputReserveTokens = Math.min(maxOutputTokens, OUTPUT_RESERVE_CAP_TOKENS);
  const rawUsableBudget = effectiveContextWindowTokens - outputReserveTokens - overheadTokens;
  const usableBudgetFloor = Math.min(
    effectiveContextWindowTokens,
    Math.max(
      MIN_USABLE_BUDGET_TOKENS,
      Math.floor(effectiveContextWindowTokens * MIN_USABLE_BUDGET_FRACTION)
    )
  );
  const overheadFloored = rawUsableBudget < usableBudgetFloor;
  const usableBudget = Math.max(rawUsableBudget, usableBudgetFloor);
  if (overheadFloored) {
    logger.warn(
      `[context] prompt overhead does not fit ${providerId}/${modelId}: ` +
        `system=${systemPromptTokens} tools=${toolCatalogTokens} output_reserve=${outputReserveTokens} ` +
        `effective_window=${effectiveContextWindowTokens} → ${rawUsableBudget} left for messages; ` +
        `floored to ${usableBudget}. Expect provider-side truncation or errors on long threads.`
    );
  }

  // Compaction threshold: hardcoded at 0.6, with
  // model metadata as the only override path (registry row, not user config).
  // User config has no tokenBudgetRatio; a stale key there is ignored.
  const rawTokenBudgetRatio = cc.tokenBudgetRatio ?? DEFAULT_TOKEN_BUDGET_RATIO;

  // Defense-in-depth clamps. Model metadata could carry garbage; keep the
  // resolver total: never return a non-positive threshold or sub-1 tail.
  const tokenBudgetRatio = Math.min(
    1,
    Math.max(0.05, Number(rawTokenBudgetRatio) || DEFAULT_TOKEN_BUDGET_RATIO)
  );
  // Tail: user config does not participate. A
  // model-metadata override passes through (clamped); otherwise undefined —
  // compressMessages derives the tail from the budget at compression time.
  const tailMessages =
    cc.tailMessages !== undefined
      ? Math.max(1, Math.floor(Number(cc.tailMessages) || 1))
      : undefined;

  const tokenThreshold = Math.max(1, Math.floor(usableBudget * tokenBudgetRatio));

  return {
    contextWindowTokens,
    effectiveContextWindowTokens,
    safetyMarginPct,
    maxOutputTokens,
    modelMaxOutputTokens: model?.maxOutputTokens ?? null,
    systemPromptTokens,
    toolCatalogTokens,
    overheadTokens,
    overheadFloored,
    usableBudget,
    tokenThreshold,
    provider: providerId,
    modelId,
    tailMessages,
    cacheTtl: meta.cacheTtl,
    minMessagesBeforeCompression: MIN_MESSAGES_BEFORE_COMPRESSION,
    maxSummaryChars: MAX_SUMMARY_CHARS,
  };
}
