/**
 * ProviderModelDiscoveryService — fetch the live model catalog from a provider's
 * /models endpoint and return it normalized for the Providers UI.
 *
 * Discovery lists chat models only. Snaglet embeds with its one built-in local
 * model, so embedding (and reranker) models are never discovered or imported.
 *
 * Each normalizer is responsible for: credential resolution, the HTTP call,
 * filtering out non-chat-completion entries (embedding models included), and
 * mapping into `DiscoveredModel`. The dispatcher joins results with the local
 * `models` table to mark which are already imported.
 */

import { Models } from '@snaglet/db/tables/models';
import { discoverCopilotModels } from './normalizers/copilot';
import { discoverAnthropicModels } from './normalizers/anthropic';
import { discoverOpenAIModels } from './normalizers/openai';
import { discoverGeminiModels } from './normalizers/gemini';
import { discoverCodexModels } from './normalizers/codex';
import { discoverDeepseekModels } from './normalizers/deepseek';
import { discoverXaiModels } from './normalizers/xai';
import { discoverMistralModels } from './normalizers/mistral';
import { discoverOllamaCatalog, OllamaNotInstalledError } from './normalizers/ollama';
import { discoverTogetherModels } from './normalizers/together';
import { discoverLmStudioModels } from './normalizers/lm-studio';
import { discoverAppleOnDeviceModels } from './normalizers/apple-on-device';
import type { DiscoveredCatalog, DiscoveredModel, DiscoveryResult } from './types';
import { getErrorMessage } from '@snaglet/shared/utils';

type Normalizer = () => Promise<DiscoveredCatalog>;

/** Adapt a normalizer that returns only its chat list. */
const chatList =
  (discover: () => Promise<DiscoveredModel[]>): Normalizer =>
  async () => ({ models: await discover() });

const NORMALIZERS: Record<string, Normalizer> = {
  copilot: chatList(discoverCopilotModels),
  anthropic: chatList(discoverAnthropicModels),
  openai: chatList(discoverOpenAIModels),
  google: chatList(discoverGeminiModels),
  codex: chatList(discoverCodexModels),
  deepseek: chatList(discoverDeepseekModels),
  xai: chatList(discoverXaiModels),
  mistral: chatList(discoverMistralModels),
  ollama: discoverOllamaCatalog,
  together: chatList(discoverTogetherModels),
  'lm-studio': chatList(discoverLmStudioModels),
  'apple-on-device': chatList(discoverAppleOnDeviceModels),
};

export async function discoverModels(providerId: string): Promise<DiscoveryResult> {
  const normalize = NORMALIZERS[providerId];
  if (!normalize) {
    return {
      providerId,
      models: [],
      warning: `Discovery not yet supported for provider "${providerId}"`,
    };
  }

  let discovered: DiscoveredModel[];
  let installedModelIds: string[] | undefined;
  let discoveryWarning: string | undefined;
  let ollamaNotInstalled = false;
  try {
    ({ models: discovered, installedModelIds } = await normalize());
  } catch (err) {
    if (err instanceof OllamaNotInstalledError) {
      discovered = [];
      ollamaNotInstalled = true;
      discoveryWarning = 'Ollama is not installed or not running on this machine.';
    } else {
      discovered = [];
      discoveryWarning = getErrorMessage(err);
    }
  }

  const existing = await Models.listActiveByProviderId(providerId);
  const existingByModelId = new Map(existing.map((m) => [m.modelId, m]));

  const models: DiscoveredModel[] = discovered.map((m) => {
    const match = existingByModelId.get(m.modelId);
    return match
      ? { ...m, alreadyImported: true, existingModelId: match.id }
      : { ...m, alreadyImported: false };
  });

  // Ollama stale audit: imported local models the daemon no longer has
  // installed. Compared against every installed model, not the chat-only
  // list, so an installed embedder or reranker imported earlier is not
  // reported as removed. Other providers can omit models from discovery for
  // reasons unrelated to removal, so do not surface this audit for them.
  const installedIds = new Set(installedModelIds ?? models.map((m) => m.modelId));
  const staleModels =
    providerId === 'ollama'
      ? existing
          .filter((m) => !installedIds.has(m.modelId))
          .map((m) => ({ id: m.id, modelId: m.modelId, name: m.displayName ?? m.modelId }))
      : [];

  return {
    providerId,
    models,
    ...(staleModels.length ? { staleModels } : {}),
    ...(discoveryWarning ? { warning: discoveryWarning } : {}),
    ...(ollamaNotInstalled ? { ollamaNotInstalled: true as const } : {}),
  };
}

export type { DiscoveryResult };
