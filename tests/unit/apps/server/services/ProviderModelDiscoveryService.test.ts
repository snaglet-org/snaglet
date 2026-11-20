import { beforeEach, describe, expect, it } from '@jest/globals';

const listActiveByProviderId = jest.fn();
const discoverOllamaCatalogMock = jest.fn();

jest.mock('@snaglet/db/tables/models', () => ({
  Models: {
    listActiveByProviderId: (...args: unknown[]) => listActiveByProviderId(...args),
  },
}));

// Keep these out of the import graph for this unit test. We only exercise Meta discovery here.
jest.mock('@server/services/ProviderModelDiscoveryService/normalizers/copilot.js', () => ({
  discoverCopilotModels: jest.fn(async () => []),
}));
jest.mock('@server/services/ProviderModelDiscoveryService/normalizers/anthropic.js', () => ({
  discoverAnthropicModels: jest.fn(async () => []),
}));
jest.mock('@server/services/ProviderModelDiscoveryService/normalizers/openai.js', () => ({
  discoverOpenAIModels: jest.fn(async () => []),
}));
jest.mock('@server/services/ProviderModelDiscoveryService/normalizers/gemini.js', () => ({
  discoverGeminiModels: jest.fn(async () => []),
}));
jest.mock('@server/services/ProviderModelDiscoveryService/normalizers/codex.js', () => ({
  discoverCodexModels: jest.fn(async () => []),
}));
jest.mock('@server/services/ProviderModelDiscoveryService/normalizers/mistral.js', () => ({
  discoverMistralModels: jest.fn(async () => []),
}));
jest.mock('@server/services/ProviderModelDiscoveryService/normalizers/ollama.js', () => ({
  discoverOllamaCatalog: (...args: unknown[]) => discoverOllamaCatalogMock(...args),
  OllamaNotInstalledError: class OllamaNotInstalledError extends Error {},
}));

import { discoverModels } from '@server/services/ProviderModelDiscoveryService';

describe('ProviderModelDiscoveryService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    listActiveByProviderId.mockResolvedValue([]);
    discoverOllamaCatalogMock.mockResolvedValue({ models: [], installedModelIds: [] });
  });

  it('does not return stale models for non-Ollama providers', async () => {
    listActiveByProviderId.mockResolvedValue([
      { id: 'model-row-1', modelId: 'removed-openai-model', displayName: 'Removed OpenAI Model' },
    ]);

    const result = await discoverModels('openai');

    expect(result.providerId).toBe('openai');
    expect(result.staleModels).toBeUndefined();
  });

  it('returns stale models for Ollama when imported models are no longer installed', async () => {
    discoverOllamaCatalogMock.mockResolvedValue({
      models: [{ modelId: 'llama3.2:latest', displayName: 'Llama 3.2', alreadyImported: false }],
      installedModelIds: ['llama3.2:latest'],
    });
    listActiveByProviderId.mockResolvedValue([
      { id: 'model-row-1', modelId: 'llama3.2:latest', displayName: 'Llama 3.2' },
      { id: 'model-row-2', modelId: 'missing-local-model', displayName: 'Missing Local Model' },
    ]);

    const result = await discoverModels('ollama');

    expect(result.staleModels).toEqual([
      { id: 'model-row-2', modelId: 'missing-local-model', name: 'Missing Local Model' },
    ]);
  });

  it('does not report an installed non-chat model imported earlier as stale', async () => {
    // Discovery lists chat models only, but the reranker and the embedder are
    // still installed, so their old `llm` rows are not "no longer installed".
    discoverOllamaCatalogMock.mockResolvedValue({
      models: [{ modelId: 'llama3.2:latest', displayName: 'Llama 3.2', alreadyImported: false }],
      installedModelIds: ['llama3.2:latest', 'bge-reranker-v2-m3', 'snowflake-arctic-l'],
    });
    listActiveByProviderId.mockResolvedValue([
      { id: 'row-chat', modelId: 'llama3.2:latest', displayName: 'Llama 3.2', type: 'llm' },
      { id: 'row-rerank', modelId: 'bge-reranker-v2-m3', displayName: 'BGE', type: 'llm' },
      { id: 'row-embed', modelId: 'snowflake-arctic-l', displayName: 'Arctic', type: 'llm' },
      { id: 'row-gone', modelId: 'removed-model', displayName: 'Removed', type: 'llm' },
    ]);

    const result = await discoverModels('ollama');

    expect(result.models.map((m) => m.modelId)).toEqual(['llama3.2:latest']);
    expect(result.staleModels).toEqual([
      { id: 'row-gone', modelId: 'removed-model', name: 'Removed' },
    ]);
  });

  it('calls the chat-only normalizer with no kind and joins imported rows', async () => {
    discoverOllamaCatalogMock.mockResolvedValue({
      models: [{ modelId: 'llama3.2:latest', displayName: 'Llama 3.2', alreadyImported: false }],
      installedModelIds: ['llama3.2:latest'],
    });
    listActiveByProviderId.mockResolvedValue([
      { id: 'model-row-1', modelId: 'llama3.2:latest', displayName: 'Llama 3.2', type: 'llm' },
    ]);

    const result = await discoverModels('ollama');

    expect(discoverOllamaCatalogMock).toHaveBeenCalledWith();
    expect(result.models).toEqual([
      expect.objectContaining({
        modelId: 'llama3.2:latest',
        alreadyImported: true,
        existingModelId: 'model-row-1',
      }),
    ]);
  });

  it('never adds imported embedding rows the live catalog did not list', async () => {
    listActiveByProviderId.mockResolvedValue([
      {
        id: 'model-row-embed',
        modelId: 'text-embedding-3-small',
        displayName: 'Text Embedding 3 Small',
        type: 'embedding',
        dimensions: 1536,
      },
    ]);

    const result = await discoverModels('openai');

    expect(result.models).toEqual([]);
  });
});
