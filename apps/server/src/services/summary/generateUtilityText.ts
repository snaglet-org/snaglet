/**
 * generateUtilityText — run a small utility text job (summarization) on a
 * resolved utility model through the normal provider stack:
 * `providerChatService.complete()` with a minimal synthetic agent, so every
 * provider the chat path supports works here too, with the provider layer's
 * own retry/error semantics (no second retry layer around providers that
 * already retry; see ProviderRetryHandledError).
 *
 * Timeout: each call gets an AbortController bounded by the resolved
 * model's `timeoutMs` (cloud 60s / local 300s). On timeout the
 * in-flight request is aborted and a plain Error is thrown; callers treat
 * any throw as "no summary this pass" (visible skip, never a partial
 * write).
 */

import type { SnagletAgent } from '@server/services/AgentService';
import { providerChatService } from '@server/services/ProviderChatService';
import type { ResolvedUtilityModel } from './UtilityModelResolver';
import { withLocalProviderSlot } from './utilityConcurrency';

export interface UtilityTextArgs {
  /** System/instruction prompt (plain text; never demand JSON). */
  system?: string;
  /** The user-message payload to run. */
  userMessage: string;
  /** Output token bound; defaults to 1024 (summary-sized). */
  maxOutputTokens?: number;
  /** Override the resolved model's timeout (tests / special callers). */
  timeoutMs?: number;
  /**
   * Caller cancellation (an in-run compaction passes the run's abort signal).
   * Aborting rejects with an AbortError, never the timeout error, so the caller
   * can tell a Stop from a slow model.
   */
  signal?: AbortSignal;
  /**
   * Optional: receives the provider stop signal. Not called when the
   * provider reports no stop reason (local runtimes) — callers then rely on
   * the text-shape ending check alone.
   */
  onResult?: (meta: UtilityTextMeta) => void;
}

/** Provider stop signal for a utility text job. */
interface UtilityTextMeta {
  /** Raw provider stop reason. */
  stopReason: string;
  /**
   * True when the provider reported that output stopped at the token cap
   * (`max_tokens` / `length` / `incomplete`).
   */
  truncated: boolean;
}

const TRUNCATION_STOP_REASONS = new Set([
  'max_tokens',
  'length',
  'incomplete',
  'max_output_tokens',
]);

/** Whether a provider stop reason means output was cut at the token cap. */
function isTruncationStopReason(stopReason: string | undefined | null): boolean {
  if (!stopReason) return false;
  return TRUNCATION_STOP_REASONS.has(String(stopReason).toLowerCase());
}

/** Build the minimal agent shape `providerChatService.complete` needs. */
function buildUtilityAgent(model: ResolvedUtilityModel, system?: string): SnagletAgent {
  const now = new Date().toISOString();
  return {
    id: `utility:${model.providerId}`,
    name: 'Snaglet Utility Summarizer',
    provider: model.providerId,
    modelId: model.modelId,
    credentialId: model.credentialId,
    systemPrompt: system ?? '',
    rawSystemPrompt: null,
    toolAccessMode: null,
    toolAccessAllowList: null,
    toolAccessDenyList: null,
    mcpServers: null,
    toolOverrides: null,
    maxToolCallsPerTurn: null,
    maxDurationSeconds: null,
    fallbacks: null,
    disableModelFallback: true,
    createdAt: now,
    updatedAt: now,
    archived: false,
    archivedAt: null,
  };
}

export async function generateUtilityText(
  model: ResolvedUtilityModel,
  args: UtilityTextArgs
): Promise<string> {
  // Local runtimes get a single global slot (concurrency 1) so background
  // summarization never competes with itself — or with the user's own chat
  // latency — on ollama / LM Studio / the Apple shim.
  if (model.isLocal) {
    return withLocalProviderSlot(() => generateUtilityTextInner(model, args));
  }
  return generateUtilityTextInner(model, args);
}

function callerAbortError(): DOMException {
  return new DOMException('utility text generation aborted by caller', 'AbortError');
}

async function generateUtilityTextInner(
  model: ResolvedUtilityModel,
  args: UtilityTextArgs
): Promise<string> {
  // Checked again here: a local-provider call may have waited for its slot.
  if (args.signal?.aborted) throw callerAbortError();
  const agent = buildUtilityAgent(model, args.system);
  const timeoutMs = args.timeoutMs ?? model.timeoutMs;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const onCallerAbort = (): void => controller.abort();
  args.signal?.addEventListener('abort', onCallerAbort, { once: true });
  try {
    const result = await providerChatService.complete(
      agent,
      [{ role: 'user', content: args.userMessage }],
      undefined,
      {
        maxOutputTokens: args.maxOutputTokens ?? 1024,
        signal: controller.signal,
      }
    );
    const stopReason = typeof result.stopReason === 'string' ? result.stopReason : '';
    if (stopReason && args.onResult) {
      args.onResult({ stopReason, truncated: isTruncationStopReason(stopReason) });
    }
    return result.reply;
  } catch (err) {
    if (args.signal?.aborted) throw callerAbortError();
    if (controller.signal.aborted) {
      throw new Error(
        `utility text generation timed out after ${timeoutMs}ms on ${model.providerId}/${model.modelId}`
      );
    }
    throw err;
  } finally {
    clearTimeout(timer);
    args.signal?.removeEventListener('abort', onCallerAbort);
  }
}
