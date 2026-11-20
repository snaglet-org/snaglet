/**
 * An agent saved with no provider and no model (the starter agents on a fresh
 * install) runs on whatever the user connected. On its first run it adopts a
 * connected provider and one of its models, and keeps them, so the agent's
 * page shows the choice and the user can change it there.
 *
 * Providers are tried in this order: a key that passed its test, then a key
 * not tested yet (newest first in both), then a keyless local provider that has
 * imported models. A key whose last test failed is never chosen.
 *
 * The model is the provider's pinned default (`defaultModelId` in its
 * metadata) while that model is listed, current and tool-capable; otherwise
 * the first of the provider's models in picker order (most capable first, see
 * `sortModels`) that is tool-capable and current (not marked legacy or
 * deprecated), an alias rather than a dated snapshot.
 *
 * The Get started pane offers the same choice before that first run
 * (`suggestConnectedModel`, served as GET /api/providers/default-model), so the
 * person sees and confirms it instead of finding it picked for them.
 */
import { Models, type ModelRow } from '@snaglet/db/tables/models';
import { Providers, type ProviderRow } from '@snaglet/db/tables/providers';
import { ProviderAuthTypes } from '@snaglet/db/tables/provider_auth_types';
import { getErrorMessage, sortModels } from '@snaglet/shared/utils';
import { logger } from '@server/config/logger';
import { agentService } from './AgentService';
import { providerCredentialService } from './ProviderCredentialService';

const DATED_SNAPSHOT = /-\d{8}$|-\d{4}-\d{2}-\d{2}$/;

/** A chat model an agent can run on: it calls tools and is not marked legacy or deprecated. */
function runsAgents(m: ModelRow): boolean {
  return m.supportsTools && (m.type === 'llm' || m.type === 'chat') && !m.metadata?.lifecycle;
}

/**
 * One provider's default model: its pinned default while that model is listed
 * and can run agents, else the most capable model that can, an alias over a
 * dated snapshot. A model without tool support, or marked legacy or
 * deprecated, is never the default.
 */
function pickModel(models: ModelRow[], pinnedId: string | undefined): ModelRow | null {
  const pinned = pinnedId ? models.find((m) => m.modelId === pinnedId) : undefined;
  if (pinned && runsAgents(pinned)) return pinned;
  const usable = sortModels(models).filter(runsAgents);
  return usable.find((m) => !DATED_SNAPSHOT.test(m.modelId)) ?? usable[0] ?? null;
}

async function candidateProviders(): Promise<ProviderRow[]> {
  const providers = (await Providers.listAll()).filter((p) => p.type === 'llm' && p.enabled);
  const authTypes = await ProviderAuthTypes.listByProviderIds(providers.map((p) => p.id));
  const keyless = new Set(
    providers
      .map((p) => p.id)
      .filter((id) => {
        const types = authTypes.filter((a) => a.providerId === id);
        return types.length > 0 && types.every((a) => a.type === 'none');
      })
  );
  const llm = new Set(providers.map((p) => p.id));
  const credentials = (await providerCredentialService.listSafe())
    .filter((c) => llm.has(c.providerId) && !keyless.has(c.providerId))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const ordered = [
    ...credentials.filter((c) => c.verificationStatus === 'ok').map((c) => c.providerId),
    ...credentials.filter((c) => c.verificationStatus === 'untested').map((c) => c.providerId),
    ...providers.filter((p) => keyless.has(p.id)).map((p) => p.id),
  ];
  const byId = new Map(providers.map((p) => [p.id, p] as const));
  return [...new Set(ordered)].flatMap((id) => {
    const provider = byId.get(id);
    return provider ? [provider] : [];
  });
}

/** A connected provider's default model, as an agent with none would take it. */
interface ConnectedModelChoice {
  providerId: string;
  modelId: string;
  displayName: string;
}

/**
 * The first connected provider's default model, or null when nothing usable is
 * connected. Reads only; a lookup failure throws.
 */
export async function suggestConnectedModel(): Promise<ConnectedModelChoice | null> {
  for (const provider of await candidateProviders()) {
    const model = pickModel(
      await Models.listActiveByProviderId(provider.id),
      provider.defaultMetadata?.defaultModelId
    );
    if (model) {
      return { providerId: provider.id, modelId: model.modelId, displayName: model.displayName };
    }
  }
  return null;
}

/**
 * Give an agent with no provider and no model the first connected provider's
 * default model, and save it on the agent. Returns the choice, or null when
 * the agent already has a model, nothing usable is connected, or the lookup
 * fails (the caller then reports "no model" as before).
 */
export async function adoptConnectedModel(
  agentId: string
): Promise<{ provider: string; modelId: string } | null> {
  try {
    const agent = await agentService.get(agentId);
    if (!agent || agent.provider || agent.modelId) return null;
    const choice = await suggestConnectedModel();
    if (!choice) return null;
    const { providerId, modelId } = choice;
    await agentService.update(agentId, { provider: providerId, modelId });
    logger.info(`[agents] ${agentId} had no model and now uses ${providerId}/${modelId}`);
    return { provider: providerId, modelId };
  } catch (err) {
    logger.warn(`[agents] could not pick a model for ${agentId}: ${getErrorMessage(err)}`);
    return null;
  }
}
