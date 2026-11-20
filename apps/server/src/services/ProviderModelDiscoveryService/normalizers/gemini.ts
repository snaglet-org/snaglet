import { providerCredentialService } from '@server/services/ProviderCredentialService';
import type { DiscoveredModel } from '../types';
import { reportedLimits } from '../reportedLimits';

/**
 * Google Gemini's models endpoint is richer than Anthropic/OpenAI —
 * it already returns inputTokenLimit and outputTokenLimit per model.
 * Capability flags (tools, vision, reasoning) still aren't in the response,
 * so those are inferred from the model id prefix.
 *
 * Auth: API key in query string. Provider id is "google" in this codebase.
 */

interface GeminiModelEntry {
  name: string; // "models/gemini-2.5-pro"
  baseModelId?: string;
  version?: string;
  displayName?: string;
  description?: string;
  inputTokenLimit?: number;
  outputTokenLimit?: number;
  supportedGenerationMethods?: string[];
}

interface GeminiModelsResponse {
  models?: GeminiModelEntry[];
  nextPageToken?: string;
}

export async function discoverGeminiModels(): Promise<DiscoveredModel[]> {
  const secret = await providerCredentialService.getSecret('google');
  if (!secret) {
    throw new Error('No Google / Gemini credential configured');
  }

  // Paginate in case the list ever exceeds the default page size.
  const all: GeminiModelEntry[] = [];
  let pageToken: string | undefined;
  let safety = 5;

  while (safety-- > 0) {
    const url = new URL('https://generativelanguage.googleapis.com/v1beta/models');
    url.searchParams.set('key', secret);
    url.searchParams.set('pageSize', '200');
    if (pageToken) url.searchParams.set('pageToken', pageToken);

    const res = await fetch(url.toString(), {
      headers: { Accept: 'application/json' },
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Gemini /v1beta/models failed (${res.status}): ${body.slice(0, 200)}`);
    }

    const json = (await res.json()) as GeminiModelsResponse;
    if (Array.isArray(json.models)) all.push(...json.models);
    if (!json.nextPageToken) break;
    pageToken = json.nextPageToken;
  }

  return all.filter(isChatModel).map(normalize);
}

function isChatModel(entry: GeminiModelEntry): boolean {
  const methods = entry.supportedGenerationMethods ?? [];
  const id = extractModelId(entry);
  const embedding = methods.includes('embedContent') || /embedding|gecko/i.test(id);
  const chat =
    methods.includes('generateContent') &&
    /^gemini-/i.test(id) &&
    !/embedding|aqa|tts|image-generation|bison|gecko/i.test(id);
  return chat && !embedding;
}

function normalize(entry: GeminiModelEntry): DiscoveredModel {
  const modelId = extractModelId(entry);
  return {
    modelId,
    displayName: entry.displayName || modelId,
    description: entry.description,
    family: inferFamily(modelId),
    contextWindowTokens: entry.inputTokenLimit ?? null,
    maxOutputTokens: entry.outputTokenLimit ?? null,
    reportedLimits: reportedLimits(entry.inputTokenLimit, entry.outputTokenLimit),
    supportsTools: inferTools(modelId),
    supportsVision: inferVision(modelId),
    supportsReasoning: inferReasoning(modelId),
    isPreview: /preview|experimental|-exp\b|-exp-/i.test(modelId),
    alreadyImported: false,
  };
}

function extractModelId(entry: GeminiModelEntry): string {
  if (entry.baseModelId) return entry.baseModelId;
  return entry.name.replace(/^models\//, '');
}

function inferFamily(modelId: string): string {
  if (/^gemini-3/.test(modelId)) return 'gemini-3';
  if (/^gemini-2\.5/.test(modelId)) return 'gemini-2.5';
  if (/^gemini-2/.test(modelId)) return 'gemini-2';
  if (/^gemini-1\.5/.test(modelId)) return 'gemini-1.5';
  if (/^gemini-1/.test(modelId)) return 'gemini-1';
  return 'gemini';
}

function inferTools(modelId: string): boolean {
  // Function calling requires 1.5 or newer.
  return /^gemini-(1\.5|2|3)/.test(modelId);
}

function inferVision(modelId: string): boolean {
  // All Gemini 1.5+ accept image input.
  return /^gemini-(1\.5|2|3)/.test(modelId);
}

function inferReasoning(modelId: string): boolean {
  // Extended thinking on 2.5 Pro and the whole 3.x line.
  if (/^gemini-3/.test(modelId)) return true;
  if (/^gemini-2\.5-pro/.test(modelId)) return true;
  return false;
}
