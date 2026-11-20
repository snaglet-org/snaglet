import { capitalize } from '@snaglet/shared/utils';
import { providerCredentialService } from '@server/services/ProviderCredentialService';
import type { DiscoveredModel } from '../types';

/**
 * OpenAI's GET /v1/models returns { id, created, owned_by, object } — no
 * capabilities or token limits. We infer those from the model id, similar to
 * the anthropic normalizer, and filter out non-chat-completion models
 * (embeddings, whisper, tts, dall-e, moderation, realtime, audio-only).
 */

interface OpenAIModelEntry {
  id: string;
  created?: number;
  owned_by?: string;
  object?: string;
}

interface OpenAIModelsResponse {
  data?: OpenAIModelEntry[];
  object?: string;
}

const NON_MODEL_EXCLUDE_PATTERNS = [
  /whisper/i,
  /^tts/i,
  /dall-e/i,
  /moderation/i,
  /realtime/i,
  /audio-preview/i,
  /transcribe/i,
  /codex-mini/i, // experimental codex variants clutter the list
  /computer-use/i,
  /^omni-moderation/i,
  /image/i,
];

export async function discoverOpenAIModels(): Promise<DiscoveredModel[]> {
  const secret = await providerCredentialService.getSecret('openai');
  if (!secret) {
    throw new Error('No OpenAI credential configured');
  }

  const res = await fetch('https://api.openai.com/v1/models', {
    headers: {
      Accept: 'application/json',
      Authorization: `Bearer ${secret}`,
    },
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`OpenAI /v1/models failed (${res.status}): ${body.slice(0, 200)}`);
  }

  const json = (await res.json()) as OpenAIModelsResponse;
  const entries = Array.isArray(json.data) ? json.data : [];

  return entries.filter(isChatModel).map(normalize);
}

function isChatModel(entry: OpenAIModelEntry): boolean {
  const id = entry.id;
  if (NON_MODEL_EXCLUDE_PATTERNS.some((rx) => rx.test(id))) return false;
  return /^(gpt-|o\d|chatgpt-)/i.test(id) && !isEmbeddingModel(id);
}

function isEmbeddingModel(id: string): boolean {
  return /^text-embedding-|embedding/i.test(id);
}

function normalize(entry: OpenAIModelEntry): DiscoveredModel {
  const id = entry.id;
  return {
    modelId: id,
    displayName: inferDisplayName(id),
    family: inferFamily(id),
    contextWindowTokens: inferContextWindow(id),
    maxOutputTokens: inferMaxOutput(id),
    supportsTools: inferTools(id),
    supportsVision: inferVision(id),
    supportsReasoning: inferReasoning(id),
    isPreview: /preview|-pro\b/.test(id),
    alreadyImported: false,
  };
}

function inferFamily(id: string): string {
  if (/^gpt-5/.test(id)) return 'gpt-5';
  if (/^gpt-4\.1/.test(id)) return 'gpt-4.1';
  if (/^gpt-4o/.test(id)) return 'gpt-4o';
  if (/^gpt-4/.test(id)) return 'gpt-4';
  if (/^gpt-3\.5/.test(id)) return 'gpt-3.5';
  if (/^o(\d)/.test(id)) return `o${RegExp.$1}`;
  if (/^chatgpt-/.test(id)) return 'chatgpt';
  return 'openai';
}

function inferDisplayName(id: string): string {
  // Strip dated suffixes like "-2024-08-06", normalize separators
  const base = id.replace(/-\d{4}-\d{2}-\d{2}$/, '').replace(/-\d{8}$/, '');
  return base
    .split('-')
    .map((part) =>
      /^o\d+$/i.test(part)
        ? part.toLowerCase()
        : /^gpt/i.test(part)
          ? 'GPT' + part.slice(3)
          : capitalize(part)
    )
    .join(' ')
    .replace(/GPT\s*(\d)/, 'GPT-$1');
}

/** Context window lookup. When the API starts exposing this, we switch to it. */
function inferContextWindow(id: string): number {
  if (/^gpt-5/.test(id)) return 400_000;
  if (/^gpt-4\.1/.test(id)) return 1_047_576;
  if (/^gpt-4o/.test(id)) return 128_000;
  if (/^gpt-4-turbo/.test(id)) return 128_000;
  if (/^gpt-4/.test(id)) return 8_192;
  if (/^gpt-3\.5-turbo-16k/.test(id)) return 16_384;
  if (/^gpt-3\.5/.test(id)) return 4_096;
  if (/^o[134]/.test(id)) return 200_000;
  if (/^chatgpt-/.test(id)) return 128_000;
  return 128_000;
}

function inferMaxOutput(id: string): number {
  if (/^gpt-5/.test(id)) return 128_000;
  if (/^gpt-4\.1/.test(id)) return 32_768;
  if (/^gpt-4o-mini/.test(id)) return 16_384;
  if (/^gpt-4o/.test(id)) return 16_384;
  if (/^gpt-4/.test(id)) return 4_096;
  if (/^o[134]/.test(id)) return 100_000;
  if (/^chatgpt-/.test(id)) return 16_384;
  return 4_096;
}

function inferTools(id: string): boolean {
  // GPT-3.5 instruct models don't support tools reliably.
  if (/^gpt-3\.5-turbo-instruct/.test(id)) return false;
  return /^(gpt-|o\d|chatgpt-)/.test(id);
}

function inferVision(id: string): boolean {
  return /^(gpt-4o|gpt-4\.1|gpt-5|o1(?!-mini)|o3(?!-mini)|o4-mini)/.test(id);
}

function inferReasoning(id: string): boolean {
  return /^o[134]/.test(id) || /^gpt-5/.test(id);
}
