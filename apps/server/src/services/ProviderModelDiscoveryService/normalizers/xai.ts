import { providerCredentialService } from '@server/services/ProviderCredentialService';
import { resolveXaiBaseUrl } from '@server/services/ProviderChatService/providers/xai';
import type { DiscoveredModel } from '../types';
import { reportedLimits } from '../reportedLimits';

/**
 * xAI (Grok) discovery. xAI exposes two catalog endpoints:
 *   - GET /v1/models — the OpenAI-standard `{ object, data: [...] }` envelope,
 *     minimal per-model fields.
 *   - GET /v1/language-models — the richer `{ models: [...] }` catalog carrying
 *     `input_modalities` / `output_modalities` (["text"] or ["text","image"]),
 *     pricing, and `aliases`.
 *
 * We read /v1/language-models so vision support comes from the AUTHORITATIVE
 * `input_modalities` flag rather than an id heuristic. Tool-calling isn't a flag
 * on the response — every current Grok text model supports OpenAI-style function
 * calling, so we default `supportsTools` on and infer reasoning from the id
 * (grok-4 / grok-*-mini / *reasoning are reasoning models). Image-generation
 * models (output_modalities without "text") are filtered out — they are not
 * chat-completion models.
 */

interface XaiLanguageModelEntry {
  id: string;
  object?: string;
  created?: number;
  owned_by?: string;
  version?: string;
  fingerprint?: string;
  input_modalities?: string[];
  output_modalities?: string[];
  context_length?: number;
  aliases?: string[];
}

interface XaiLanguageModelsResponse {
  models?: XaiLanguageModelEntry[];
}

export async function discoverXaiModels(): Promise<DiscoveredModel[]> {
  const secret = await providerCredentialService.getSecret('xai');
  if (!secret) {
    throw new Error('No xAI credential configured');
  }

  const baseUrl = await resolveXaiBaseUrl();
  const res = await fetch(`${baseUrl}/language-models`, {
    headers: {
      Accept: 'application/json',
      Authorization: `Bearer ${secret}`,
    },
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`xAI /v1/language-models failed (${res.status}): ${body.slice(0, 200)}`);
  }

  const json = (await res.json()) as XaiLanguageModelsResponse;
  const entries = Array.isArray(json.models) ? json.models : [];

  return entries.filter(isChatModel).map(normalize);
}

function isChatModel(entry: XaiLanguageModelEntry): boolean {
  // Chat-completion models emit text. An entry whose output modalities exclude
  // text (e.g. an image-generation model) is not a chat model.
  const outputs = entry.output_modalities;
  if (Array.isArray(outputs) && outputs.length > 0) {
    return outputs.includes('text');
  }
  // No modality info → assume chat (Grok's text models are the common case).
  return true;
}

function normalize(entry: XaiLanguageModelEntry): DiscoveredModel {
  const id = entry.id;
  return {
    modelId: id,
    displayName: inferDisplayName(id),
    family: inferFamily(id),
    contextWindowTokens: entry.context_length ?? inferContextWindow(id),
    maxOutputTokens: null,
    reportedLimits: reportedLimits(entry.context_length, undefined),
    // Every current Grok text model supports OpenAI-style function calling.
    supportsTools: true,
    supportsVision: inferVision(entry),
    supportsReasoning: inferReasoning(id),
    isPreview: /preview|beta|experimental/i.test(id),
    alreadyImported: false,
  };
}

function inferDisplayName(id: string): string {
  return id
    .split(/[-_]/)
    .map((part) =>
      /^grok$/i.test(part)
        ? 'Grok'
        : /^\d/.test(part)
          ? part
          : part.charAt(0).toUpperCase() + part.slice(1)
    )
    .join(' ');
}

function inferFamily(id: string): string {
  const s = id.toLowerCase();
  if (/grok-?4/.test(s)) return 'grok-4';
  if (/grok-?3/.test(s)) return 'grok-3';
  if (/grok-?2/.test(s)) return 'grok-2';
  if (/grok/.test(s)) return 'grok';
  return 'xai';
}

function inferContextWindow(id: string): number {
  // grok-4 ships a 256K context window; grok-2 / grok-3 are 131K.
  return /grok-?4/i.test(id) ? 256_000 : 131_072;
}

function inferVision(entry: XaiLanguageModelEntry): boolean {
  const inputs = entry.input_modalities;
  if (Array.isArray(inputs) && inputs.length > 0) {
    return inputs.includes('image');
  }
  // Fallback when modality info is absent: only *-vision ids are multimodal.
  return /vision/i.test(entry.id);
}

function inferReasoning(id: string): boolean {
  return /grok-?4|mini|reason/i.test(id);
}
