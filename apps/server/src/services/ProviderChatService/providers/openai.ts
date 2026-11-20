import type { SnagletAgent } from '@server/services/AgentService';
import { assertSecret, pickSecret } from '../shared';
import { Providers } from '@snaglet/db/tables/providers';
import { callOpenAICompatibleChatCompletions } from './shared/chat-completions';
import { isOfficialOpenAIUrl, openAIPromptCacheKey } from './shared/promptCacheKey';
import type {
  OnChunkCallback,
  ProviderChatOptions,
  ProviderChatResult,
  ProviderMessage,
  ProviderVerifyResult,
} from '../types';

export const OPENAI_FALLBACK_BASE_URL = 'https://api.openai.com/v1';

/**
 * Normalize a user-supplied base URL to an OpenAI-compatible
 * `<root>/v1` form. Accepts:
 *   - null/empty       → fallback (api.openai.com/v1)
 *   - 'https://x/v1'   → unchanged
 *   - 'https://x'      → 'https://x/v1'
 *   - trailing slashes → trimmed
 *
 * Same shape as `normalizeOllamaBaseUrl`. Sibling provider files
 * (`together.ts`, `lm-studio.ts`) call this on their resolved `base_url`
 * before handing it to `chatOpenAI` via `overrides.baseUrl`.
 */
export function normalizeOpenAIBaseUrl(baseUrl?: string | null): string {
  const raw = (baseUrl ?? '').trim();
  if (!raw) return OPENAI_FALLBACK_BASE_URL;
  const trimmed = raw.replace(/\/+$/, '');
  return /\/v\d+$/.test(trimmed) ? trimmed : `${trimmed}/v1`;
}

/**
 * Resolve the base URL for the given provider id.
 *
 * The canonical `openai` provider stays pinned to `api.openai.com/v1` — it is
 * intentionally not user-configurable here. Other OpenAI-compatible providers
 * (`together`, `lm-studio`) own their own resolver and pass the URL through
 * `chatOpenAI`'s `overrides.baseUrl`. For any non-`openai` id reaching this
 * function, the providers row's `base_url` is read and normalized to `<root>/v1`.
 */
export async function resolveOpenAIBaseUrl(providerId: string): Promise<string> {
  if (providerId === 'openai') return OPENAI_FALLBACK_BASE_URL;
  const provider = (await Providers.findProvider(providerId).catch(() => null)) as {
    baseUrl?: string | null;
    base_url?: string | null;
  } | null;
  return normalizeOpenAIBaseUrl(provider?.baseUrl ?? provider?.base_url);
}

export interface ChatOpenAIOverrides {
  /**
   * Pre-resolved base URL. Sibling provider files (e.g. `together.ts`) supply
   * their own URL instead of going through `resolveOpenAIBaseUrl(agent.provider)`.
   * Keeps each provider file in charge of its own URL rather than hiding it
   * behind a generic resolver.
   */
  baseUrl?: string;
  /**
   * When false, the request goes out without an `Authorization` header if the
   * agent has no credential — this is what makes the `lm-studio` path usable
   * for local servers that don't have auth. Defaults to true for the canonical
   * `openai` and `together` paths.
   */
  authRequired?: boolean;
  /**
   * Log tag for provider payload logging. Sibling providers pass their own id
   * so payload logs are attributed to the real provider, not `openai`.
   */
  providerLabel?: string;
  /**
   * User-facing error prefix ("Mistral request failed (401)"). Sibling
   * providers pass their own display name so errors don't blame OpenAI.
   */
  errorLabel?: string;
  /**
   * Flatten top-level `anyOf`/`oneOf`/`allOf` tool-schema combinators before
   * sending — required by strict OpenAI-style backends (Copilot, xAI) that
   * 400 the whole request on a union-typed tool root. See
   * `openaiCompatible.ts`'s `OpenAICompatibleProviderOptions` for the verified
   * failure mode. Off by default.
   */
  strictToolSchemas?: boolean;
}

/**
 * Run an OpenAI-compatible chat request.
 */
export async function chatOpenAI(
  agent: SnagletAgent,
  messages: ProviderMessage[],
  onChunk?: OnChunkCallback,
  options?: ProviderChatOptions,
  overrides?: ChatOpenAIOverrides
): Promise<ProviderChatResult> {
  const authRequired = overrides?.authRequired ?? true;
  const secret = await pickSecret(agent);
  if (authRequired) assertSecret(secret, agent.provider);

  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (secret) headers.Authorization = `Bearer ${secret}`;

  const baseUrl = overrides?.baseUrl ?? (await resolveOpenAIBaseUrl(agent.provider));
  // OpenAI itself (the openai provider, and codex with an API key) gets a
  // per-agent prompt_cache_key; compatible servers may refuse the field.
  const bodyExtensions = isOfficialOpenAIUrl(baseUrl)
    ? { prompt_cache_key: openAIPromptCacheKey(agent.id) }
    : undefined;
  return callOpenAICompatibleChatCompletions({
    url: `${baseUrl}/chat/completions`,
    providerLabel: overrides?.providerLabel ?? 'openai',
    errorLabel: overrides?.errorLabel ?? 'OpenAI',
    agent,
    messages,
    headers,
    options,
    onChunk,
    strictToolSchemas: overrides?.strictToolSchemas,
    bodyExtensions,
  });
}

export async function verifyOpenAI(
  secret: string,
  providerId: string = 'openai',
  overrides?: { baseUrl?: string }
): Promise<ProviderVerifyResult> {
  const baseUrl = overrides?.baseUrl ?? (await resolveOpenAIBaseUrl(providerId));
  const headers: Record<string, string> = {};
  if (secret) headers.Authorization = `Bearer ${secret}`;
  const res = await fetch(`${baseUrl}/models`, { headers });
  if (!res.ok) {
    const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    const message =
      (data.error as { message?: string } | undefined)?.message ??
      `Authentication failed (${res.status})`;
    return { valid: false, message };
  }
  return { valid: true, message: 'Connected successfully' };
}
