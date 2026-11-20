/**
 * LM Studio model discovery — hits the OpenAI-compatible `/v1/models`
 * endpoint exposed by the LM Studio app.
 *
 * Auth is intentionally not sent: LM Studio runs without auth on localhost.
 * Capability inference is best-effort from the model id, since LM Studio
 * doesn't surface metadata in `/v1/models` (just `{ id, object, owned_by }`).
 */

import { resolveLmStudioBaseUrl } from '@server/services/ProviderChatService/providers/lm-studio';
import type { DiscoveredModel } from '../types';
import { isEmbeddingModelName, isRerankerModelName } from '../modelNameKind';

interface LmStudioModelEntry {
  id: string;
  object?: string;
  owned_by?: string;
}

interface LmStudioModelsResponse {
  data?: LmStudioModelEntry[];
  object?: string;
}

const LM_STUDIO_DEFAULT_CONTEXT = 8_192;
const LM_STUDIO_DEFAULT_MAX_OUTPUT = 4_096;

export async function discoverLmStudioModels(): Promise<DiscoveredModel[]> {
  const baseUrl = await resolveLmStudioBaseUrl();
  const res = await fetch(`${baseUrl}/models`, {
    headers: { Accept: 'application/json' },
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`LM Studio /v1/models failed (${res.status}): ${body.slice(0, 200)}`);
  }

  const json = (await res.json()) as LmStudioModelsResponse;
  const entries = Array.isArray(json.data) ? json.data : [];

  return entries.filter(isChatModel).map(normalize);
}

/** Chat models only: embedding and reranker models are left out by name. */
function isChatModel(entry: LmStudioModelEntry): boolean {
  return !isEmbeddingModelName(entry.id) && !isRerankerModelName(entry.id);
}

function normalize(entry: LmStudioModelEntry): DiscoveredModel {
  const id = entry.id;
  return {
    modelId: id,
    displayName: inferDisplayName(id),
    family: inferFamily(id),
    contextWindowTokens: inferContextWindow(id),
    maxOutputTokens: LM_STUDIO_DEFAULT_MAX_OUTPUT,
    supportsTools: true, // LM Studio's chat templates handle tool calls for most modern models
    supportsVision: /vision|llava|mllama|gemma-3(?!-1b|-270m)|qwen2?-vl|llama-?3\.2-vision/i.test(
      id
    ),
    supportsReasoning: /^(deepseek-r1|o[134])|reasoning/i.test(id),
    isPreview: /preview|rc\d|alpha|beta/i.test(id),
    alreadyImported: false,
  };
}

function inferFamily(id: string): string {
  const lower = id.toLowerCase();
  if (lower.includes('gemma-3') || lower.includes('gemma3')) return 'gemma-3';
  if (lower.includes('gemma-2') || lower.includes('gemma2')) return 'gemma-2';
  if (lower.includes('gemma')) return 'gemma';
  if (lower.includes('llama-3.3')) return 'llama-3.3';
  if (lower.includes('llama-3.2')) return 'llama-3.2';
  if (lower.includes('llama-3.1')) return 'llama-3.1';
  if (lower.includes('llama-3')) return 'llama-3';
  if (lower.includes('llama')) return 'llama';
  if (lower.includes('qwen2.5')) return 'qwen-2.5';
  if (lower.includes('qwen3')) return 'qwen-3';
  if (lower.includes('qwen')) return 'qwen';
  if (lower.includes('mistral')) return 'mistral';
  if (lower.includes('phi-4')) return 'phi-4';
  if (lower.includes('phi-3')) return 'phi-3';
  if (lower.includes('phi')) return 'phi';
  if (lower.includes('deepseek')) return 'deepseek';
  return 'lm-studio';
}

function inferDisplayName(id: string): string {
  // Strip publisher prefix and common GGUF suffixes for a cleaner label.
  // "lmstudio-community/gemma-3-4b-it-GGUF" → "gemma-3-4b-it"
  const stripped = id
    .split('/')
    .pop()!
    .replace(/-?GGUF$/i, '')
    .replace(/-?Q\d+_K_[MS]$/i, '');
  return stripped;
}

function inferContextWindow(id: string): number {
  const lower = id.toLowerCase();
  if (lower.includes('gemma-3') || lower.includes('gemma3')) return 128_000;
  if (lower.includes('llama-3.1') || lower.includes('llama-3.2') || lower.includes('llama-3.3')) {
    return 131_072;
  }
  if (lower.includes('qwen2.5') || lower.includes('qwen3')) return 32_768;
  if (lower.includes('mistral')) return 32_768;
  if (lower.includes('phi-4')) return 16_384;
  return LM_STUDIO_DEFAULT_CONTEXT;
}
