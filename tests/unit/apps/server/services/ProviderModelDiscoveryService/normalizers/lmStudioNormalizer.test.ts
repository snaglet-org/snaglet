import { beforeEach, describe, expect, it, jest } from '@jest/globals';

const resolveLmStudioBaseUrl = jest.fn();

jest.mock('@server/services/ProviderChatService/providers/lm-studio', () => ({
  resolveLmStudioBaseUrl: () => resolveLmStudioBaseUrl(),
}));

import { discoverLmStudioModels } from '@server/services/ProviderModelDiscoveryService/normalizers/lm-studio';

const fetchMock = jest.fn();
// @ts-expect-error — override the global for the test.
global.fetch = fetchMock;

function okJson(payload: unknown) {
  return { ok: true, json: async () => payload } as unknown as Response;
}

beforeEach(() => {
  jest.clearAllMocks();
  resolveLmStudioBaseUrl.mockResolvedValue('http://localhost:1234');
});

describe('discoverLmStudioModels', () => {
  it('lists chat models only: reranker and embedding models are left out', async () => {
    fetchMock.mockResolvedValue(
      okJson({
        data: [
          { id: 'llama-3.1-8b' },
          { id: 'bge-reranker-v2-m3' },
          { id: 'jina-reranker-v2-base' },
          { id: 'nomic-embed-text' },
          { id: 'mxbai-embed-large-v1' },
          { id: 'bge-m3' },
        ],
      })
    );

    const models = await discoverLmStudioModels();

    expect(models.map((m) => m.modelId)).toEqual(['llama-3.1-8b']);
  });

  it('gives chat models the default max output and a family context window', async () => {
    fetchMock.mockResolvedValue(okJson({ data: [{ id: 'llama-3.1-8b' }] }));

    const [chat] = await discoverLmStudioModels();

    expect(chat?.maxOutputTokens).toBe(4096);
    expect(chat?.contextWindowTokens).toBe(131_072);
  });
});
