import type { ModelEntitlementMeta, ModelMetadata } from '@snaglet/shared/types';

/**
 * Model as returned from a live provider `/models` endpoint,
 * normalized into our shape. The `alreadyImported` flag is filled
 * by the dispatcher after joining with the local `models` table.
 */
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
  /**
   * The limits the provider's list endpoint stated for this model. Persistence
   * writes these over stored values; `contextWindowTokens` / `maxOutputTokens`
   * above may instead be inferred, and an inferred value only fills a gap.
   */
  reportedLimits?: { contextWindowTokens?: number; maxOutputTokens?: number };
  isPreview?: boolean;
  /**
   * Entitlement hint derived from the provider payload at discovery time
   * (currently Copilot's per-model `policy.state`). Present only when the
   * payload distinguishes a plan/policy-blocked model; absent means "no signal
   * → treat as available". Display-only on this shape — persisted onto the
   * model row's `metadata.entitlement` by the copilot reconciliation pass, not
   * by bulk import (which would clobber sibling metadata keys).
   */
  entitlement?: ModelEntitlementMeta;
  alreadyImported: boolean;
  existingModelId?: string;
  /**
   * Lifecycle state for a provider-hosted dedicated/reserved endpoint (e.g.
   * Together dedicated endpoints: 'STARTED' | 'STOPPED' | 'PENDING' | ...).
   * Undefined for ordinary serverless/catalog models. Display-only — not
   * persisted onto the imported model row.
   */
  endpointState?: string;
}

/** What a normalizer returns: its chat models, plus every installed model id for a local daemon. */
export interface DiscoveredCatalog {
  models: DiscoveredModel[];
  /**
   * Every model the local daemon has installed, chat or not (Ollama). The
   * stale audit compares imported rows against this, so an installed embedder
   * or reranker imported earlier is not reported as removed.
   */
  installedModelIds?: string[];
}

export interface DiscoveryResult {
  providerId: string;
  models: DiscoveredModel[];
  warning?: string;
  /** True when discovery failed because Ollama is not installed / not reachable */
  ollamaNotInstalled?: boolean;
  /** Models that are configured in the DB but were not returned by live discovery (stale) */
  staleModels?: Array<{ id: string; modelId: string; name: string }>;
}
