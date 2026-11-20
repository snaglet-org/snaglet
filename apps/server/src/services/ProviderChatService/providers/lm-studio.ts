/**
 * LM Studio provider — local OpenAI-compatible server.
 *
 * LM Studio runs a desktop app that exposes an OpenAI-compatible
 * `/v1/chat/completions` endpoint at `providers.base_url`, defaulting to its
 * standard local port (localhost:1234) when unset.
 * It loads GGUF models on-demand, ships its own chat templates that handle
 * tool calling for many models (Gemma 3 included), and runs without any
 * authentication.
 *
 * URL resolution order:
 *   1. `providers.base_url` for the `lm-studio` row, if set (for users on a
 *      non-default port or running on another machine).
 *   2. Built-in default `http://localhost:1234/v1` (LM Studio's standard port).
 *
 * Auth is never required: LM Studio doesn't authenticate. We pass
 * `authRequired: false` straight through so Snaglet doesn't reject the request
 * for missing credentials.
 */
import { verifyLocalServer } from './shared/verifyLocalServer';
import type { SnagletAgent } from '@server/services/AgentService';
import { chatOpenAI, normalizeOpenAIBaseUrl } from './openai';
import type {
  OnChunkCallback,
  ProviderChatOptions,
  ProviderChatResult,
  ProviderMessage,
  ProviderVerifyResult,
} from '../types';

/**
 * LM Studio's fixed local default. It serves on localhost:1234; the endpoint is
 * resolved at runtime and not user-editable (like Ollama). A non-default port or
 * remote host is set via SNAGLET_LM_STUDIO_URL, not a stored providers.base_url.
 */
const DEFAULT_LM_STUDIO_BASE_URL = 'http://localhost:1234/v1';

export async function resolveLmStudioBaseUrl(): Promise<string> {
  // Keep the explicit fallback: normalizeOpenAIBaseUrl's empty-string fallback
  // is OpenAI's cloud URL, so an unset env must resolve to LM Studio's default,
  // never OpenAI.
  return normalizeOpenAIBaseUrl(
    process.env.SNAGLET_LM_STUDIO_URL?.trim() || DEFAULT_LM_STUDIO_BASE_URL
  );
}

export async function chatLmStudio(
  agent: SnagletAgent,
  messages: ProviderMessage[],
  onChunk?: OnChunkCallback,
  options?: ProviderChatOptions
): Promise<ProviderChatResult> {
  const baseUrl = await resolveLmStudioBaseUrl();
  return chatOpenAI(agent, messages, onChunk, options, {
    baseUrl,
    authRequired: false,
    providerLabel: 'lm-studio',
    errorLabel: 'LM Studio',
  });
}

export async function verifyLmStudio(_secret: string): Promise<ProviderVerifyResult> {
  const baseUrl = await resolveLmStudioBaseUrl();
  return verifyLocalServer(`${baseUrl}/models`, 'LM Studio', 'SNAGLET_LM_STUDIO_URL');
}
