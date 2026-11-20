import { beforeEach, describe, expect, it, jest } from '@jest/globals';

const resolveOllamaBaseUrl = jest.fn();

jest.mock('@server/services/ProviderChatService/providers/ollama', () => ({
  getOllamaApiRoot: (baseUrl: string) => baseUrl,
  inferOllamaContextWindow: jest.fn(() => 8192),
  inferOllamaDisplayName: (id: string) => id,
  inferOllamaFamily: (id: string) => id.split('-')[0],
  inferOllamaVision: jest.fn(() => false),
  resolveOllamaBaseUrl: () => resolveOllamaBaseUrl(),
}));

import { discoverOllamaCatalog } from '@server/services/ProviderModelDiscoveryService/normalizers/ollama';

const fetchMock = jest.fn();
// @ts-expect-error — override the global for the test.
global.fetch = fetchMock;

function okJson(payload: unknown) {
  return { ok: true, json: async () => payload } as unknown as Response;
}

/** /api/tags lists `names`; /api/show answers with `capabilities[name]` (none → show fails). */
function mockOllama(names: string[], capabilities: Record<string, string[]> = {}) {
  fetchMock.mockImplementation((url: unknown, init?: unknown) => {
    if (String(url).includes('/api/tags')) {
      return Promise.resolve(okJson({ models: names.map((name) => ({ name })) }));
    }
    if (String(url).includes('/api/show')) {
      const { name } = JSON.parse(String((init as { body?: unknown } | undefined)?.body)) as {
        name: string;
      };
      const caps = capabilities[name];
      if (!caps) return Promise.resolve({ ok: false } as unknown as Response);
      return Promise.resolve(okJson({ capabilities: caps, model_info: {} }));
    }
    return Promise.resolve({ ok: false } as unknown as Response);
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  resolveOllamaBaseUrl.mockResolvedValue('http://localhost:11434');
});

describe('discoverOllamaCatalog', () => {
  it('never returns an embedding or reranker model, by name or by /api/show capabilities', async () => {
    const installed = [
      'llama3.2:latest',
      'qwen3:8b',
      'nomic-embed-text',
      'mxbai-embed-large',
      'bge-m3',
      'bge-reranker-v2-m3',
      'jina-reranker-v2-base',
      'snowflake-arctic-l',
    ];
    mockOllama(installed, {
      'qwen3:8b': ['completion', 'tools'],
      // No embedding-looking name: only /api/show says it is an embedder.
      'snowflake-arctic-l': ['embedding'],
    });

    const { models, installedModelIds } = await discoverOllamaCatalog();

    expect(models.map((m) => m.modelId)).toEqual(['llama3.2:latest', 'qwen3:8b']);
    // The stale audit still sees every installed model, chat or not.
    expect(installedModelIds).toEqual(installed);
  });

  it('prefers explicit /api/show capabilities over name heuristics', async () => {
    // A name with "embed" in it is still a chat model when /api/show says so.
    mockOllama(['embed-chat-7b', 'bge-reranker-v2-m3'], {
      'embed-chat-7b': ['completion'],
      'bge-reranker-v2-m3': ['completion'],
    });

    const { models } = await discoverOllamaCatalog();

    // Rerankers stay out whatever /api/show says.
    expect(models.map((m) => m.modelId)).toEqual(['embed-chat-7b']);
    expect(models[0]?.maxOutputTokens).toBe(8192);
  });
});
