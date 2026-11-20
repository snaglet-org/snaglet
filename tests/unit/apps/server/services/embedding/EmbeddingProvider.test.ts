/**
 * Unit tests for EmbeddingProvider (single local backend).
 *
 * Verifies:
 *   - resolveEmbeddingProvider honors the test override, and otherwise always
 *     resolves the built-in local embedder (no settings, no credentials)
 *   - resolveEmbeddingProviderForModel only resolves local-onnx; retired
 *     remote model shapes resolve to null and probe with a "retired" message
 *   - MockEmbeddingProvider is deterministic and applies the doc/query
 *     prefix split like the real backend
 */

import {
  MockEmbeddingProvider,
  probeEmbeddingModel,
  resetEmbeddingProvider,
  resolveEmbeddingProvider,
  resolveEmbeddingProviderForModel,
  setEmbeddingProvider,
} from '@server/services/embedding/EmbeddingProvider';
import {
  LOCAL_EMBEDDER_DIMENSIONS,
  LOCAL_EMBEDDER_MODEL_ID,
  LOCAL_EMBEDDER_PROVIDER_ID,
} from '@server/services/embedding/embedderModelManifest';

afterEach(() => {
  resetEmbeddingProvider();
  jest.clearAllMocks();
});

describe('resolveEmbeddingProvider', () => {
  it('returns the override when one is set', async () => {
    const mock = new MockEmbeddingProvider(4);
    setEmbeddingProvider(mock);
    expect(await resolveEmbeddingProvider()).toBe(mock);
  });

  it('resolves the built-in local embedder when no override is set', async () => {
    resetEmbeddingProvider();
    const provider = await resolveEmbeddingProvider();
    expect(provider).not.toBeNull();
    expect(provider?.info).toEqual({
      provider: LOCAL_EMBEDDER_PROVIDER_ID,
      model: LOCAL_EMBEDDER_MODEL_ID,
      dimensions: LOCAL_EMBEDDER_DIMENSIONS,
    });
  });

  it('resolves the same singleton across calls (session cache stays warm)', async () => {
    expect(await resolveEmbeddingProvider()).toBe(await resolveEmbeddingProvider());
  });
});

describe('resolveEmbeddingProviderForModel', () => {
  it('resolves the local model shape', async () => {
    const provider = await resolveEmbeddingProviderForModel({
      providerId: LOCAL_EMBEDDER_PROVIDER_ID,
      modelId: LOCAL_EMBEDDER_MODEL_ID,
      dimensions: LOCAL_EMBEDDER_DIMENSIONS,
    });
    expect(provider?.info.provider).toBe(LOCAL_EMBEDDER_PROVIDER_ID);
  });

  it('returns null for retired remote backends', async () => {
    for (const providerId of ['openai', 'google', 'mistral', 'together', 'ollama', 'lm-studio']) {
      expect(
        await resolveEmbeddingProviderForModel({
          providerId,
          modelId: 'anything',
          dimensions: 1536,
        })
      ).toBeNull();
    }
  });
});

describe('probeEmbeddingModel', () => {
  it('reports retired backends with a pointer to the local model', async () => {
    const error = await probeEmbeddingModel({
      providerId: 'ollama',
      modelId: 'nomic-embed-text:latest',
      dimensions: 768,
    });
    expect(error).toMatch(/retired/);
    expect(error).toMatch(/local-onnx/);
  });
});

describe('MockEmbeddingProvider', () => {
  it('produces deterministic vectors of the requested dim', async () => {
    const p = new MockEmbeddingProvider(8);
    const a = await p.embed('hello');
    const b = await p.embed('hello');
    const c = await p.embed('world');
    expect(a).toHaveLength(8);
    expect(a).toEqual(b);
    expect(a).not.toEqual(c);
  });

  it('output values lie in [-1, 1]', async () => {
    const p = new MockEmbeddingProvider(16);
    const vec = await p.embed('bounds check');
    for (const v of vec) {
      expect(v).toBeGreaterThanOrEqual(-1);
      expect(v).toBeLessThanOrEqual(1);
    }
  });

  it('embedDocument and embedQuery produce distinct vectors for the same text', async () => {
    // Mirrors the local backend's task-prefix behavior so doc/query-split
    // bugs are visible under the mock too.
    const p = new MockEmbeddingProvider(8);
    const doc = await p.embedDocument('same text');
    const query = await p.embedQuery('same text');
    expect(doc).not.toEqual(query);
    // Deterministic per method.
    expect(doc).toEqual(await p.embedDocument('same text'));
    expect(query).toEqual(await p.embedQuery('same text'));
  });
});
