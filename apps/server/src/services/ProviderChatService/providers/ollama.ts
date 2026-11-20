import { verifyLocalServer } from './shared/verifyLocalServer';
import { capitalize } from '@snaglet/shared/utils';
import type { SnagletAgent } from '@server/services/AgentService';
import { callOpenAICompatibleChatCompletions } from './shared/chat-completions';
import type {
  OnChunkCallback,
  ProviderChatOptions,
  ProviderChatResult,
  ProviderMessage,
  ProviderVerifyResult,
} from '../types';

const OLLAMA_CONTEXT_WINDOWS: Array<{ pattern: RegExp; tokens: number }> = [
  { pattern: /^llama3\.1:/i, tokens: 131_072 },
  { pattern: /^llama3\.2:/i, tokens: 131_072 },
  { pattern: /^qwen2\.5-coder:/i, tokens: 32_768 },
];

/**
 * Ollama's fixed local default. It always serves on localhost:11434. The base
 * URL is resolved at runtime and is not user-editable in the UI: a value stored
 * in `providers.base_url` is ignored. The only override is the
 * `SNAGLET_OLLAMA_URL` env var, for the rare non-standard host/port setup.
 */
const DEFAULT_OLLAMA_BASE_URL = 'http://localhost:11434';

export function normalizeOllamaBaseUrl(baseUrl?: string | null): string {
  const raw = (baseUrl?.trim() || DEFAULT_OLLAMA_BASE_URL).replace(/\/+$/, '');
  return raw.endsWith('/v1') ? raw : `${raw}/v1`;
}

export function getOllamaApiRoot(baseUrl: string): string {
  return normalizeOllamaBaseUrl(baseUrl).replace(/\/v1$/, '');
}

/**
 * Resolve Ollama's base URL at runtime: `SNAGLET_OLLAMA_URL` env override, else the
 * fixed local default. Deliberately does not read `providers.base_url`: the UI
 * has no endpoint field, and a value stored in older rows has no effect. Kept
 * `async` so `await` call sites are unaffected.
 */
export async function resolveOllamaBaseUrl(): Promise<string> {
  return normalizeOllamaBaseUrl(process.env.SNAGLET_OLLAMA_URL);
}

export function inferOllamaContextWindow(modelId?: string | null): number {
  const normalized = (modelId ?? '').trim().toLowerCase();
  for (const entry of OLLAMA_CONTEXT_WINDOWS) {
    if (entry.pattern.test(normalized)) return entry.tokens;
  }
  return 131_072;
}

export function inferOllamaFamily(modelId?: string | null): string {
  const normalized = (modelId ?? '').trim().toLowerCase();
  if (normalized.startsWith('llama3.1:')) return 'llama3.1';
  if (normalized.startsWith('llama3.2:')) return 'llama3.2';
  if (normalized.startsWith('qwen2.5-coder:')) return 'qwen2.5-coder';
  return normalized.split(':')[0] || 'ollama';
}

export function inferOllamaDisplayName(modelId?: string | null): string {
  const raw = (modelId ?? '').trim();
  if (!raw) return 'Ollama Model';
  return raw
    .split(/[:/-]/)
    .filter(Boolean)
    .map((part) => (/^\d+(\.\d+)?[a-z]?$/i.test(part) ? part.toUpperCase() : capitalize(part)))
    .join(' ');
}

export function inferOllamaVision(modelId?: string | null): boolean {
  return /vision|llava|mllama/i.test(modelId ?? '');
}

export async function chatOllama(
  agent: SnagletAgent,
  messages: ProviderMessage[],
  onChunk?: OnChunkCallback,
  options?: ProviderChatOptions
): Promise<ProviderChatResult> {
  const baseUrl = await resolveOllamaBaseUrl();
  const headers = {
    'Content-Type': 'application/json',
  };

  return callOpenAICompatibleChatCompletions({
    url: `${baseUrl}/chat/completions`,
    providerLabel: 'ollama',
    errorLabel: 'Ollama',
    agent,
    messages,
    headers,
    options,
    onChunk,
    bodyExtensions: {
      options: {
        num_ctx: inferOllamaContextWindow(agent.modelId),
      },
    },
  });
}

export async function verifyOllama(_secret?: string): Promise<ProviderVerifyResult> {
  const baseUrl = await resolveOllamaBaseUrl();
  return verifyLocalServer(`${getOllamaApiRoot(baseUrl)}/api/tags`, 'Ollama', 'SNAGLET_OLLAMA_URL');
}
