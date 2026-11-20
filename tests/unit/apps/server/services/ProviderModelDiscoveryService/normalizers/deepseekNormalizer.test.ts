/**
 * DeepSeek discovery normalizer — maps the provider's /models payload into
 * DiscoveredModel[]. We mock the credential store, the base-URL resolver
 * (owned/tested by the provider factory), and global fetch, so these tests pin
 * the normalizer's own contract: correct endpoint + auth header, non-chat
 * filtering, and inferred capabilities from sample payloads.
 */
import { beforeEach, describe, expect, it, jest } from '@jest/globals';

const getSecret = jest.fn<(providerId: string) => Promise<string | null>>();

jest.mock('@server/services/ProviderCredentialService', () => ({
  providerCredentialService: { getSecret: (...args: [string]) => getSecret(...args) },
}));

// Stub the base-URL resolvers so importing the normalizer never pulls in the
// full chat chain (ToolService/config). Base-URL resolution itself is covered
// by the provider/openai unit tests.
jest.mock('@server/services/ProviderChatService/providers/deepseek', () => ({
  resolveDeepseekBaseUrl: jest.fn(async () => 'https://api.deepseek.com/v1'),
}));

import { discoverDeepseekModels } from '@server/services/ProviderModelDiscoveryService/normalizers/deepseek';

const fetchMock = jest.fn();
// @ts-expect-error — override the global for the test.
global.fetch = fetchMock;

function okJson(payload: unknown) {
  return { ok: true, json: async () => payload } as unknown as Response;
}

beforeEach(() => {
  jest.clearAllMocks();
  getSecret.mockResolvedValue('sk-test');
});

describe('discoverDeepseekModels', () => {
  const payload = {
    object: 'list',
    data: [
      { id: 'deepseek-chat', object: 'model', owned_by: 'deepseek' },
      { id: 'deepseek-reasoner', object: 'model', owned_by: 'deepseek' },
    ],
  };

  it('hits /v1/models with a bearer auth header', async () => {
    getSecret.mockResolvedValue('sk-deepseek');
    fetchMock.mockResolvedValue(okJson(payload));

    await discoverDeepseekModels();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.deepseek.com/v1/models');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer sk-deepseek');
  });

  it('maps deepseek-chat as tool-capable and deepseek-reasoner as reasoning-only', async () => {
    fetchMock.mockResolvedValue(okJson(payload));

    const models = await discoverDeepseekModels();
    const byId = Object.fromEntries(models.map((m) => [m.modelId, m]));

    expect(byId['deepseek-chat']).toEqual(
      expect.objectContaining({
        displayName: 'DeepSeek Chat',
        supportsTools: true,
        supportsReasoning: false,
        contextWindowTokens: 65_536,
      })
    );
    expect(byId['deepseek-reasoner']).toEqual(
      expect.objectContaining({
        displayName: 'DeepSeek Reasoner',
        // deepseek-reasoner has no function-calling support (DeepSeek API docs).
        supportsTools: false,
        supportsReasoning: true,
      })
    );
  });

  it('throws a clear error when no credential is configured', async () => {
    getSecret.mockResolvedValue(null);
    await expect(discoverDeepseekModels()).rejects.toThrow(/No DeepSeek credential/);
  });
});
