import { providerCredentialService } from '@server/services/ProviderCredentialService';
import type { DiscoveredModel } from '../types';
import { reportedLimits } from '../reportedLimits';

/**
 * Mistral's /v1/models endpoint is reasonably rich: it returns `max_context_length`,
 * `capabilities.{function_calling, vision, completion_chat}`, and a description
 * per model. We filter to chat-completion models and map capabilities directly.
 */

interface MistralCapabilities {
  completion_chat?: boolean;
  completion_fim?: boolean;
  function_calling?: boolean;
  vision?: boolean;
  fine_tuning?: boolean;
  classification?: boolean;
}

interface MistralModelEntry {
  id: string;
  object?: string;
  name?: string;
  description?: string;
  max_context_length?: number;
  max_completion_tokens?: number;
  capabilities?: MistralCapabilities;
  aliases?: string[];
  deprecation?: string | null;
  type?: string;
  owned_by?: string;
}

interface MistralModelsResponse {
  object?: string;
  data?: MistralModelEntry[];
}

export async function discoverMistralModels(): Promise<DiscoveredModel[]> {
  const secret = await providerCredentialService.getSecret('mistral');
  if (!secret) {
    throw new Error('No Mistral credential configured');
  }

  const res = await fetch('https://api.mistral.ai/v1/models', {
    headers: {
      Accept: 'application/json',
      Authorization: `Bearer ${secret}`,
    },
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Mistral /v1/models failed (${res.status}): ${body.slice(0, 200)}`);
  }

  const json = (await res.json()) as MistralModelsResponse;
  const entries = Array.isArray(json.data) ? json.data : [];

  return entries.filter(isChatModel).map(normalize);
}

/** Chat-completion models only: embedding and moderation models are left out. */
function isChatModel(entry: MistralModelEntry): boolean {
  if (entry.deprecation) return false;
  const caps = entry.capabilities ?? {};
  return caps.completion_chat !== false && !/embed|moderation/i.test(entry.id);
}

function normalize(entry: MistralModelEntry): DiscoveredModel {
  const caps = entry.capabilities ?? {};
  return {
    modelId: entry.id,
    displayName: entry.name || entry.id,
    description: entry.description,
    family: inferFamily(entry.id),
    contextWindowTokens: entry.max_context_length ?? null,
    maxOutputTokens: entry.max_completion_tokens ?? null,
    reportedLimits: reportedLimits(entry.max_context_length, entry.max_completion_tokens),
    supportsTools: Boolean(caps.function_calling),
    supportsVision: Boolean(caps.vision),
    supportsReasoning: inferReasoning(entry.id),
    isPreview: /preview|experimental/i.test(entry.id),
    alreadyImported: false,
  };
}

function inferFamily(modelId: string): string {
  if (/codestral/i.test(modelId)) return 'codestral';
  if (/pixtral/i.test(modelId)) return 'pixtral';
  if (/mixtral/i.test(modelId)) return 'mixtral';
  if (/ministral/i.test(modelId)) return 'ministral';
  if (/mistral-large/i.test(modelId)) return 'mistral-large';
  if (/mistral-medium/i.test(modelId)) return 'mistral-medium';
  if (/mistral-small/i.test(modelId)) return 'mistral-small';
  if (/magistral/i.test(modelId)) return 'magistral';
  return 'mistral';
}

function inferReasoning(modelId: string): boolean {
  // Magistral is Mistral's explicit reasoning model family.
  return /magistral/i.test(modelId);
}
