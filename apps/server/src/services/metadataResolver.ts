/**
 * metadataResolver — walks the (provider, model) metadata chain.
 *
 * Chain: models.metadata -> providers.default_metadata -> caller's code defaults.
 * Shallow-merges per section (contextCompression, summary) so a model can override
 * individual keys without having to redeclare the whole block.
 *
 * Caller-level overrides (agent config_json, thread agent override) sit *above*
 * this resolver and are applied by whoever calls it (ContextWindowService etc.).
 */

import { Models } from '@snaglet/db/tables/models';
import { Providers } from '@snaglet/db/tables/providers';
import type { ModelMetadata } from '@snaglet/shared/types/metadata';

export async function resolveModelMetadata(
  providerId: string,
  modelId: string
): Promise<ModelMetadata> {
  const [model, provider] = await Promise.all([
    Models.findByProviderAndModelId(providerId, modelId).catch(() => null),
    Providers.findProvider(providerId).catch(() => null),
  ]);

  const modelMeta = (model?.metadata ?? {}) as ModelMetadata;
  const providerMeta = (provider?.defaultMetadata ?? {}) as ModelMetadata;

  return {
    contextCompression: {
      ...providerMeta.contextCompression,
      ...modelMeta.contextCompression,
    },
    summary: {
      ...providerMeta.summary,
      ...modelMeta.summary,
    },
    // Scalars, not sections: model row wins over provider default.
    safetyMarginPct: modelMeta.safetyMarginPct ?? providerMeta.safetyMarginPct,
    cacheTtl: modelMeta.cacheTtl ?? providerMeta.cacheTtl,
  };
}
