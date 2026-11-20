/**
 * EmbeddingProvider — the embedding backend interface and its single shipping
 * implementation.
 *
 * Snaglet embeds with exactly one engine: the built-in local ONNX embedder
 * (nomic-embed-text-v1.5 via `LocalEmbedderService`). Local inference needs
 * no credential, no endpoint, and no user model selection, so
 * `resolveEmbeddingProvider()` always returns the local provider (or the test
 * override).
 *
 * The interface stays pluggable on purpose: tests inject deterministic
 * providers via `setEmbeddingProvider`, and a future engine swap only has to
 * implement `embedDocument`/`embedQuery`.
 */

import { getErrorMessage } from '@snaglet/shared/utils';
import {
  LOCAL_EMBEDDER_DIMENSIONS,
  LOCAL_EMBEDDER_MODEL_ID,
  LOCAL_EMBEDDER_PROVIDER_ID,
} from './embedderModelManifest';
import {
  embedDocument as localEmbedDocument,
  embedQuery as localEmbedQuery,
} from './LocalEmbedderService';
import type { ActiveEmbeddingModel } from './EmbeddingSettings';

export interface EmbeddingProviderInfo {
  /** Stable provider id (`local-onnx`, or `mock` in tests). */
  provider: string;
  /** Model identifier as reported by the backend. */
  model: string;
  /** Vector dimension the provider produces. */
  dimensions: number;
}

export interface EmbeddingProvider {
  readonly info: EmbeddingProviderInfo;
  /**
   * Embed content for ingest/indexing. Must throw on failure.
   *
   * Document vs query is a method, not a caller-built prefix string: backends
   * that need task prefixes (nomic-embed) apply them internally, so no call
   * site can forget. Index-side text goes through `embedDocument`, search
   * queries through `embedQuery` — mixing them silently degrades retrieval.
   */
  embedDocument(text: string): Promise<number[]>;
  /** Embed a search query (see `embedDocument` for the doc/query contract). */
  embedQuery(text: string): Promise<number[]>;
}

// Local ONNX (built-in) — nomic-embed-text-v1.5 via LocalEmbedderService

class LocalEmbeddingProvider implements EmbeddingProvider {
  readonly info: EmbeddingProviderInfo = {
    provider: LOCAL_EMBEDDER_PROVIDER_ID,
    model: LOCAL_EMBEDDER_MODEL_ID,
    dimensions: LOCAL_EMBEDDER_DIMENSIONS,
  };

  // Task prefixes are applied inside LocalEmbedderService — the method is the
  // prefix choice (see the EmbeddingProvider interface contract).
  embedDocument(text: string): Promise<number[]> {
    return localEmbedDocument(text);
  }

  embedQuery(text: string): Promise<number[]> {
    return localEmbedQuery(text);
  }
}

/** Singleton — the service behind it caches its ONNX session process-wide. */
const localProvider = new LocalEmbeddingProvider();

// Mock (tests)

/** Default vector length for the test mock when a dimension isn't specified. */
const MOCK_EMBEDDING_DIM = 1536;

export class MockEmbeddingProvider implements EmbeddingProvider {
  readonly info: EmbeddingProviderInfo;

  constructor(private readonly dim: number = MOCK_EMBEDDING_DIM) {
    this.info = { provider: 'mock', model: 'mock-embedding', dimensions: dim };
  }

  // Mirror the local backend: doc/query prefixes produce distinct vectors, so
  // tests exercising the doc-vs-query split see realistic behavior.
  embedDocument(text: string): Promise<number[]> {
    return this.embed(`search_document: ${text}`);
  }

  embedQuery(text: string): Promise<number[]> {
    return this.embed(`search_query: ${text}`);
  }

  /** Deterministic FNV-hash vector — exposed for tests that need raw control. */
  async embed(text: string): Promise<number[]> {
    const vec = new Array<number>(this.dim);
    let h = 2166136261;
    for (let i = 0; i < text.length; i++) {
      h ^= text.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    for (let i = 0; i < this.dim; i++) {
      h ^= h << 13;
      h ^= h >>> 17;
      h ^= h << 5;
      vec[i] = ((h >>> 0) / 0xffffffff) * 2 - 1;
    }
    return vec;
  }
}

// Resolution

/**
 * Resolve a provider for an explicit model shape. Only the built-in local
 * embedder resolves; anything else returns null (maintenance jobs surface an
 * actionable message).
 */
export async function resolveEmbeddingProviderForModel(
  active: ActiveEmbeddingModel
): Promise<EmbeddingProvider | null> {
  return active.providerId === LOCAL_EMBEDDER_PROVIDER_ID ? localProvider : null;
}

/**
 * Resolve the provider to use for this process:
 *   1. Test override set via setEmbeddingProvider()
 *   2. The built-in local embedder (always available; embeds fail with an
 *      actionable "run pnpm embedder:fetch" error until the model files land)
 */
export async function resolveEmbeddingProvider(): Promise<EmbeddingProvider | null> {
  if (override) return override;
  return localProvider;
}

/**
 * Probe a model shape by running one tiny embed against it. Returns null on
 * success, or a user-facing error message on failure — for the local model
 * that means "files not downloaded yet" (with the fetch hint) or a corrupt
 * install.
 */
export async function probeEmbeddingModel(active: ActiveEmbeddingModel): Promise<string | null> {
  const provider = await resolveEmbeddingProviderForModel(active);
  if (!provider) {
    return `${active.providerId}:${active.modelId} is retired — Snaglet embeds with the built-in local model (${LOCAL_EMBEDDER_PROVIDER_ID}:${LOCAL_EMBEDDER_MODEL_ID}).`;
  }
  try {
    await provider.embedQuery('ping');
    return null;
  } catch (err) {
    return getErrorMessage(err);
  }
}

// Test override hook

let override: EmbeddingProvider | null = null;

/** Replace the auto-resolved provider (for tests or explicit wiring). */
export function setEmbeddingProvider(provider: EmbeddingProvider | null): void {
  override = provider;
}

/** Clear any override and fall back to auto-resolution. */
export function resetEmbeddingProvider(): void {
  override = null;
}
