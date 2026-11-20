import { providerCredentialService } from '@server/services/ProviderCredentialService';
import { resolveDeepseekBaseUrl } from '@server/services/ProviderChatService/providers/deepseek';
import type { DiscoveredModel } from '../types';
import { reportedLimits } from '../reportedLimits';

/**
 * DeepSeek's GET /models returns the OpenAI-standard envelope
 * `{ object, data: [{ id, object, owned_by }] }`, and on current API versions
 * each entry's `context_window` and `max_output_tokens`. Those reported limits
 * are stored as they are; an entry without them gets the inferred 64K / 8K.
 * Capabilities are inferred from the id: a `reasoner` model has no function
 * calling (DeepSeek API docs), so its tools are off.
 */

interface DeepseekModelEntry {
  id: string;
  object?: string;
  owned_by?: string;
  context_window?: number;
  max_output_tokens?: number;
}

interface DeepseekModelsResponse {
  object?: string;
  data?: DeepseekModelEntry[];
}

export async function discoverDeepseekModels(): Promise<DiscoveredModel[]> {
  const secret = await providerCredentialService.getSecret('deepseek');
  if (!secret) {
    throw new Error('No DeepSeek credential configured');
  }

  const baseUrl = await resolveDeepseekBaseUrl();
  const res = await fetch(`${baseUrl}/models`, {
    headers: {
      Accept: 'application/json',
      Authorization: `Bearer ${secret}`,
    },
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`DeepSeek /v1/models failed (${res.status}): ${body.slice(0, 200)}`);
  }

  const json = (await res.json()) as DeepseekModelsResponse;
  const entries = Array.isArray(json.data) ? json.data : [];

  return entries.map(normalize);
}

function normalize(entry: DeepseekModelEntry): DiscoveredModel {
  const id = entry.id;
  const reasoning = /reason/i.test(id);
  const reported = reportedLimits(entry.context_window, entry.max_output_tokens);
  return {
    modelId: id,
    displayName: inferDisplayName(id),
    family: reasoning ? 'deepseek-reasoner' : 'deepseek-chat',
    contextWindowTokens: reported.contextWindowTokens ?? 65_536,
    maxOutputTokens: reported.maxOutputTokens ?? 8_192,
    reportedLimits: reported,
    // deepseek-reasoner has no function-calling support (DeepSeek API docs).
    supportsTools: !reasoning,
    supportsVision: false,
    supportsReasoning: reasoning,
    isPreview: false,
    alreadyImported: false,
  };
}

function inferDisplayName(id: string): string {
  return id
    .split('-')
    .map((part) =>
      /^deepseek$/i.test(part) ? 'DeepSeek' : part.charAt(0).toUpperCase() + part.slice(1)
    )
    .join(' ');
}
