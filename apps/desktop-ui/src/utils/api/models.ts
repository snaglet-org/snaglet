import { fetchData, getApiUrl } from './core';
import type { ModelRow, ModelMetadata } from './types';
import type { ModelEntitlementMeta } from '@snaglet/shared/types';

interface CreateModelInput {
  providerId: string;
  modelId: string;
  displayName?: string;
  metadata?: ModelMetadata;
  contextWindowTokens?: number | null;
  maxOutputTokens?: number | null;
}

interface UpdateModelInput {
  displayName?: string;
  contextWindowTokens?: number | null;
  maxOutputTokens?: number | null;
}

export interface BulkModelInput {
  modelId: string;
  displayName?: string;
  description?: string;
  family?: string | null;
  contextWindowTokens?: number | null;
  maxOutputTokens?: number | null;
  supportsTools?: boolean;
  supportsVision?: boolean;
  supportsReasoning?: boolean;
  metadata?: ModelMetadata;
}

/** A chat model from a provider's live catalog (discovery never lists embedding models). */
export interface DiscoveredModel {
  modelId: string;
  displayName: string;
  description?: string;
  family?: string | null;
  contextWindowTokens?: number | null;
  maxOutputTokens?: number | null;
  supportsTools?: boolean;
  supportsVision?: boolean;
  supportsReasoning?: boolean;
  metadata?: ModelMetadata;
  isPreview?: boolean;
  /**
   * Discovery-time entitlement hint (Copilot). Present only when the payload
   * marks the model as plan/policy-blocked; drives the "not on your plan" badge.
   */
  entitlement?: ModelEntitlementMeta;
  alreadyImported: boolean;
  existingModelId?: string;
  /**
   * Lifecycle state for a provider-hosted dedicated/reserved endpoint (e.g.
   * Together dedicated endpoints: 'STARTED' | 'STOPPED' | 'PENDING' | ...).
   * Undefined for ordinary serverless/catalog models.
   */
  endpointState?: string;
}

export interface DiscoveryResult {
  providerId: string;
  models: DiscoveredModel[];
  warning?: string;
  /** True when Ollama is not installed or not running on this machine */
  ollamaNotInstalled?: boolean;
  /** Models configured in DB that were not returned by live discovery (stale) */
  staleModels?: Array<{ id: string; modelId: string; name: string }>;
}

export const modelsApi = {
  list: () => fetchData<ModelRow[]>(getApiUrl('/models')),
  listForProvider: (providerId: string) =>
    fetchData<ModelRow[]>(getApiUrl(`/models/${providerId}`)),
  create: (data: CreateModelInput) =>
    fetchData<ModelRow>(getApiUrl('/models'), {
      method: 'POST',
      body: JSON.stringify(data),
    }),
  update: (id: string, data: UpdateModelInput) =>
    fetchData<ModelRow>(getApiUrl(`/models/${id}`), {
      method: 'PATCH',
      body: JSON.stringify(data),
    }),
  createBulk: (providerId: string, models: BulkModelInput[]) =>
    fetchData<ModelRow[]>(getApiUrl('/models/bulk'), {
      method: 'POST',
      body: JSON.stringify({ providerId, models }),
    }),
  discover: (providerId: string) =>
    fetchData<DiscoveryResult>(getApiUrl(`/models/${providerId}/available`)),
  remove: (id: string) =>
    fetchData<{ success: boolean }>(getApiUrl(`/models/${id}`), {
      method: 'DELETE',
    }),
};
