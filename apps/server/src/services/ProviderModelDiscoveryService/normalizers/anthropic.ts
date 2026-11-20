import { providerCredentialService } from '@server/services/ProviderCredentialService';
import { isAnthropicOAuthToken } from '@server/services/ProviderChatService/shared';
import type { DiscoveredModel } from '../types';
import { reportedLimits } from '../reportedLimits';
import {
  anthropicContextWindow,
  anthropicMaxOutput,
} from '@server/services/ProviderChatService/providers/anthropicLimits';

/**
 * Anthropic's GET /v1/models returns each model's id, display name and, on
 * current API versions, `max_input_tokens` (the context window) and
 * `max_tokens` (the output cap). Those reported limits are stored as they
 * are. Only when an entry lacks them are the limits inferred from the model
 * id; capability flags are always inferred from the id.
 */

interface AnthropicModelEntry {
  id: string;
  display_name?: string;
  type?: string;
  created_at?: string;
  max_input_tokens?: number;
  max_tokens?: number;
}

interface AnthropicModelsResponse {
  data?: AnthropicModelEntry[];
  has_more?: boolean;
  first_id?: string;
  last_id?: string;
}

export async function discoverAnthropicModels(): Promise<DiscoveredModel[]> {
  const secret = await providerCredentialService.getSecret('anthropic');
  if (!secret) {
    throw new Error('No Anthropic credential configured');
  }

  const headers: Record<string, string> = { 'anthropic-version': '2023-06-01' };
  if (isAnthropicOAuthToken(secret)) {
    headers['Authorization'] = `Bearer ${secret}`;
    headers['anthropic-beta'] = 'oauth-2025-04-20';
    headers['anthropic-dangerous-direct-browser-access'] = 'true';
  } else {
    headers['x-api-key'] = secret;
  }

  const res = await fetch('https://api.anthropic.com/v1/models?limit=1000', { headers });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Anthropic /v1/models failed (${res.status}): ${body.slice(0, 200)}`);
  }

  const json = (await res.json()) as AnthropicModelsResponse;
  const entries = Array.isArray(json.data) ? json.data : [];

  return entries.map(normalize);
}

function normalize(entry: AnthropicModelEntry): DiscoveredModel {
  const id = entry.id;
  const family = inferFamily(id);
  const reported = reportedLimits(entry.max_input_tokens, entry.max_tokens);

  return {
    modelId: id,
    displayName: entry.display_name || id,
    family,
    contextWindowTokens: reported.contextWindowTokens ?? anthropicContextWindow(id),
    maxOutputTokens: reported.maxOutputTokens ?? anthropicMaxOutput(id),
    reportedLimits: reported,
    supportsTools: true,
    supportsVision: true,
    supportsReasoning: inferReasoning(id),
    alreadyImported: false,
  };
}

function inferFamily(modelId: string): string {
  if (modelId.includes('opus')) return 'claude-opus';
  if (modelId.includes('sonnet')) return 'claude-sonnet';
  if (modelId.includes('haiku')) return 'claude-haiku';
  return 'claude';
}

function inferReasoning(modelId: string): boolean {
  // Extended thinking is shipped on opus-4+ and sonnet-4.5+; haiku stays fast-only.
  if (/opus-4/.test(modelId) || /opus-5/.test(modelId)) return true;
  if (/sonnet-4[5-9]/.test(modelId) || /sonnet-5/.test(modelId)) return true;
  return false;
}
