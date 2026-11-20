/**
 * makeOpenAICompatibleProvider — factory for providers that speak OpenAI's
 * Chat Completions wire format on their own endpoint (Together, Mistral,
 * Meta's Llama API compat surface). One place owns the shared shape:
 *
 * URL resolution order:
 *   1. `providers.base_url` for the provider's row, if set (regional or
 *      proxied endpoints).
 *   2. The fallback URL the caller bakes in.
 *
 * The base URL is resolved per call on purpose — a base_url edit in Settings
 * takes effect without a restart, and the providers row is a trivial lookup.
 */
import type { SnagletAgent } from '@server/services/AgentService';
import { Providers } from '@snaglet/db/tables/providers';
import { chatOpenAI, verifyOpenAI, normalizeOpenAIBaseUrl } from './openai';
import type {
  OnChunkCallback,
  ProviderChatOptions,
  ProviderChatResult,
  ProviderMessage,
  ProviderVerifyResult,
} from '../types';

export interface OpenAICompatibleProvider {
  resolveBaseUrl: () => Promise<string>;
  chat: (
    agent: SnagletAgent,
    messages: ProviderMessage[],
    onChunk?: OnChunkCallback,
    options?: ProviderChatOptions
  ) => Promise<ProviderChatResult>;
  verify: (secret: string) => Promise<ProviderVerifyResult>;
}

export interface OpenAICompatibleProviderOptions {
  /**
   * Flatten top-level `anyOf`/`oneOf`/`allOf` schema combinators out of tool
   * parameter schemas before sending them. Verified live against xAI's Grok
   * API: a tool whose root schema is a union (e.g. `apply_patch`'s
   * `anyOf: [{required:['patch']}, {required:['input']}]`) 400s the *entire*
   * request with `"tool parameter root must be an object type (root schema
   * is an anyOf/oneOf union with a non-object branch)"` — same failure class
   * Copilot has (see `copilot.ts`). Off by default so providers with a more
   * permissive JSON-Schema surface (Together, Mistral, plain OpenAI) keep
   * schemas verbatim.
   */
  strictToolSchemas?: boolean;
}

export function makeOpenAICompatibleProvider(
  providerId: string,
  fallbackBaseUrl: string,
  providerOptions?: OpenAICompatibleProviderOptions
): OpenAICompatibleProvider {
  const resolveBaseUrl = async (): Promise<string> => {
    const provider = await Providers.findProvider(providerId).catch(() => null);
    return provider?.baseUrl ? normalizeOpenAIBaseUrl(provider.baseUrl) : fallbackBaseUrl;
  };
  // Errors and payload logs must carry the real provider — a Mistral 401
  // surfaced as "OpenAI request failed" sends the user to the wrong
  // credential. `providerId` tags the logs; the capitalized form prefixes
  // user-facing errors ("Mistral request failed (401)").
  const errorLabel = providerId.charAt(0).toUpperCase() + providerId.slice(1);
  return {
    resolveBaseUrl,
    chat: async (agent, messages, onChunk, options) =>
      chatOpenAI(agent, messages, onChunk, options, {
        baseUrl: await resolveBaseUrl(),
        providerLabel: providerId,
        errorLabel,
        strictToolSchemas: providerOptions?.strictToolSchemas,
      }),
    verify: async (secret) => verifyOpenAI(secret, providerId, { baseUrl: await resolveBaseUrl() }),
  };
}
