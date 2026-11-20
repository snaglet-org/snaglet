/**
 * utilityModels — the per-provider capability table for utility-model
 * (summarization) resolution, in ONE file so per-provider figures can't rot
 * in scattered call sites.
 *
 * This table answers two questions for UtilityModelResolver: whether a
 * provider is a local runtime (privacy-eligible fallback) and
 * what context window to assume when the Models catalog doesn't say.
 * Model CHOICE is not encoded here — the summarizer is an explicit override
 * (thread/agent/global) or the agent's own chat model.
 */

export interface ProviderUtilityCaps {
  /** Local runtimes never leak content — always privacy-eligible. */
  isLocal: boolean;
  /** Fallback context-window tokens when models.context_window_tokens is null. */
  fallbackContextTokens: number;
}

/**
 * Every chat-capable provider in ProviderChatService/providers/registry.ts.
 * Verify-only providers (google-workspace, github) are deliberately absent —
 * the resolver treats unknown/absent ids as not summary-capable.
 */
export const PROVIDER_UTILITY_CAPS: Readonly<Record<string, ProviderUtilityCaps>> = {
  anthropic: { isLocal: false, fallbackContextTokens: 200_000 },
  openai: { isLocal: false, fallbackContextTokens: 128_000 },
  google: { isLocal: false, fallbackContextTokens: 128_000 },
  mistral: { isLocal: false, fallbackContextTokens: 32_000 },
  codex: { isLocal: false, fallbackContextTokens: 128_000 },
  copilot: { isLocal: false, fallbackContextTokens: 128_000 },
  together: { isLocal: false, fallbackContextTokens: 32_000 },
  deepseek: { isLocal: false, fallbackContextTokens: 64_000 },
  xai: { isLocal: false, fallbackContextTokens: 131_072 },
  ollama: { isLocal: true, fallbackContextTokens: 32_768 },
  'lm-studio': { isLocal: true, fallbackContextTokens: 8_192 },
  'apple-on-device': { isLocal: true, fallbackContextTokens: 4_096 },
};

/** Tokens reserved for the generated summary itself. */
const UTILITY_OUTPUT_RESERVE_TOKENS = 1_024;

/** Char-per-token heuristic used across the summary subsystem (~3.5–4). */
const UTILITY_CHARS_PER_TOKEN = 3.5;

/** Floor so degenerate context figures still leave room for a usable prompt. */
const UTILITY_MAX_INPUT_CHARS_FLOOR = 4_000;

/**
 * Cap: a thread-summary prompt never needs more than this, and the cap
 * bounds the billed input for default-on summarization.
 */
const UTILITY_MAX_INPUT_CHARS_CAP = 60_000;

/** Per-call generation timeouts: cloud fails fast, local is patient. */
const UTILITY_CLOUD_TIMEOUT_MS = 60_000;
const UTILITY_LOCAL_TIMEOUT_MS = 300_000;

export function isLocalUtilityProvider(providerId: string): boolean {
  return PROVIDER_UTILITY_CAPS[providerId]?.isLocal === true;
}

/** The model's context window in tokens (the provider's fallback figure when it is unknown). */
export function utilityContextTokens(providerId: string, contextTokens: number | null): number {
  const fallback = PROVIDER_UTILITY_CAPS[providerId]?.fallbackContextTokens ?? 8_192;
  return contextTokens && contextTokens > 0 ? contextTokens : fallback;
}

/**
 * Input budget (in chars) for a summarization prompt against a model whose
 * context window is `contextTokens` (null → the provider's fallback figure).
 */
export function utilityMaxInputChars(providerId: string, contextTokens: number | null): number {
  const tokens = utilityContextTokens(providerId, contextTokens);
  const usable = Math.max(0, tokens - UTILITY_OUTPUT_RESERVE_TOKENS);
  const chars = Math.floor(usable * UTILITY_CHARS_PER_TOKEN);
  return Math.min(UTILITY_MAX_INPUT_CHARS_CAP, Math.max(UTILITY_MAX_INPUT_CHARS_FLOOR, chars));
}

export function utilityTimeoutMs(isLocal: boolean): number {
  return isLocal ? UTILITY_LOCAL_TIMEOUT_MS : UTILITY_CLOUD_TIMEOUT_MS;
}
