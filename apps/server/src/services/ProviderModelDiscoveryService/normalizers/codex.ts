import { providerCredentialService } from '@server/services/ProviderCredentialService';
import type { DiscoveredModel } from '../types';

/**
 * Codex discovery.
 *
 * The Codex subscription auth flow targets `chatgpt.com/backend-api/codex/responses`
 * and doesn't expose a public `/models` catalog endpoint. The API-key flow falls
 * through to the standard OpenAI `/v1/models`, but the Codex catalog on OpenAI's
 * public API is typically sparse compared to what a Codex subscription enables.
 *
 * Strategy: return a curated list of known Codex-subscription models, merged
 * with whatever OpenAI's public `/v1/models` reports when the credential is an
 * API key. This way discovery is always useful even if the subscription endpoint
 * shifts. Users can still add anything missing via the manual Add form.
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

/** Current GPT-5/GPT-6/Codex Responses models accept image input. */
export function inferCodexVision(modelId: string): boolean {
  return /^(?:gpt-[56](?:[.-]|$)|codex(?:-|$))/i.test(modelId);
}

// Known Codex-subscription model catalog.
// Codex's catalog defaults Astra to 272k context and Sol to 500k (extended
// context is opt-in).
const CODEX_KNOWN_MODELS: Array<Omit<DiscoveredModel, 'alreadyImported'>> = [
  mk('gpt-6.1-sol', 'GPT-6.1 Sol', {
    reasoning: true,
    context: 500_000,
    output: 128_000,
    family: 'gpt-6',
  }),
  mk('gpt-6-astra', 'GPT-6 Astra', {
    reasoning: true,
    context: 272_000,
    output: 128_000,
    family: 'gpt-6',
  }),
  mk('gpt-5.5', 'GPT-5.5', { reasoning: true, context: 400_000, output: 128_000 }),
  mk('gpt-5.4', 'GPT-5.4', { reasoning: true, context: 400_000, output: 128_000 }),
  mk('gpt-5.4-mini', 'GPT-5.4 Mini', { reasoning: true, context: 400_000, output: 128_000 }),
  mk('gpt-5.3-codex', 'GPT-5.3 Codex', { reasoning: true, context: 400_000, output: 128_000 }),
  mk('gpt-5.3-codex-spark', 'GPT-5.3 Codex Spark', {
    reasoning: true,
    context: 400_000,
    output: 128_000,
  }),
  mk('gpt-5.2-codex', 'GPT-5.2 Codex', { reasoning: true, context: 400_000, output: 128_000 }),
  mk('gpt-5.2', 'GPT-5.2', { reasoning: true, context: 400_000, output: 128_000 }),
  mk('gpt-5.1-codex-max', 'GPT-5.1 Codex Max', {
    reasoning: true,
    context: 400_000,
    output: 128_000,
  }),
  mk('gpt-5.1-codex-mini', 'GPT-5.1 Codex Mini', {
    reasoning: true,
    context: 400_000,
    output: 128_000,
  }),
  mk('gpt-5.1', 'GPT-5.1', { reasoning: true, context: 400_000, output: 128_000 }),
  mk('codex-latest', 'Codex Latest (rolling)', {
    reasoning: true,
    context: 400_000,
    output: 128_000,
    family: 'alias',
  }),
  mk('codex-mini-latest', 'Codex Mini Latest (rolling)', {
    reasoning: true,
    context: 400_000,
    output: 128_000,
    family: 'alias',
  }),
];

// Curated subscription candidates, including Sol and Astra from the Codex
// catalog. Availability can vary by account; entitlement probing remains
// authoritative.
const CODEX_CHATGPT_ACCOUNT_SUPPORTED_MODELS = new Set([
  'gpt-6.1-sol',
  'gpt-6-astra',
  'gpt-5.5',
  'gpt-5.4',
  'gpt-5.4-mini',
]);

function mk(
  modelId: string,
  displayName: string,
  opts: {
    context: number;
    output: number;
    reasoning?: boolean;
    family?: string;
  }
): Omit<DiscoveredModel, 'alreadyImported'> {
  return {
    modelId,
    displayName,
    family: opts.family ?? (modelId.startsWith('codex') ? 'codex' : 'gpt-5'),
    contextWindowTokens: opts.context,
    maxOutputTokens: opts.output,
    supportsTools: true,
    supportsVision: inferCodexVision(modelId),
    supportsReasoning: Boolean(opts.reasoning),
    isPreview: false,
  };
}

export async function discoverCodexModels(): Promise<DiscoveredModel[]> {
  const cred = await loadCodexCredential();
  const curated =
    cred?.kind === 'oauth'
      ? CODEX_KNOWN_MODELS.filter((m) => CODEX_CHATGPT_ACCOUNT_SUPPORTED_MODELS.has(m.modelId))
      : CODEX_KNOWN_MODELS;

  const known = curated.map((m) => ({ ...m, alreadyImported: false }));

  // Best-effort: if the credential is an API key, also query OpenAI's public
  // /v1/models and merge in anything codex-relevant that isn't already in the
  // curated list. OAuth tokens can't hit api.openai.com so we just skip.
  if (cred?.kind === 'apiKey') {
    try {
      const extras = await fetchPublicCodexModels(cred.secret);
      const existingIds = new Set(known.map((m) => m.modelId));
      for (const m of extras) {
        if (!existingIds.has(m.modelId)) known.push(m);
      }
    } catch {
      // Ignore — the curated list is always useful on its own.
    }
  }

  return known;
}

async function loadCodexCredential(): Promise<
  { kind: 'oauth' } | { kind: 'apiKey'; secret: string } | null
> {
  const secret = await providerCredentialService.getSecret('codex');
  if (!secret) return null;
  // JWT access tokens start with "eyJ" — treat anything else as an API key.
  if (secret.startsWith('eyJ') || secret.includes('chatgpt_account_id')) {
    return { kind: 'oauth' };
  }
  return { kind: 'apiKey', secret };
}

async function fetchPublicCodexModels(apiKey: string): Promise<DiscoveredModel[]> {
  const res = await fetch('https://api.openai.com/v1/models', {
    headers: { Accept: 'application/json', Authorization: `Bearer ${apiKey}` },
  });
  if (!res.ok) throw new Error(`public /v1/models failed (${res.status})`);
  const json = (await res.json()) as OpenAIModelsResponse;
  const entries = Array.isArray(json.data) ? json.data : [];

  return entries
    .filter((e) => /codex/i.test(e.id))
    .map<DiscoveredModel>((e) => ({
      modelId: e.id,
      displayName: e.id,
      family: 'codex',
      contextWindowTokens: 400_000,
      maxOutputTokens: 128_000,
      supportsTools: true,
      supportsVision: inferCodexVision(e.id),
      supportsReasoning: true,
      alreadyImported: false,
    }));
}
