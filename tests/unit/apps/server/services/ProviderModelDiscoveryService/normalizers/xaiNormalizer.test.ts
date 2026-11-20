/**
 * xAI (Grok) discovery normalizer — maps GET /v1/language-models into
 * DiscoveredModel[]. We mock the credential store, the base-URL resolver (owned
 * by the provider factory), and global fetch, so this pins the normalizer's own
 * contract: correct endpoint + auth header, non-chat filtering, and capabilities
 * derived from the authoritative input_modalities flag.
 */
import { beforeEach, describe, expect, it, jest } from '@jest/globals';

const getSecret = jest.fn<(providerId: string) => Promise<string | null>>();

jest.mock('@server/services/ProviderCredentialService', () => ({
  providerCredentialService: { getSecret: (...args: [string]) => getSecret(...args) },
}));

jest.mock('@server/services/ProviderChatService/providers/xai', () => ({
  resolveXaiBaseUrl: jest.fn(async () => 'https://api.x.ai/v1'),
}));

import { discoverXaiModels } from '@server/services/ProviderModelDiscoveryService/normalizers/xai';

const fetchMock = jest.fn();
// @ts-expect-error — override the global for the test.
global.fetch = fetchMock;

function okJson(payload: unknown) {
  return { ok: true, json: async () => payload } as unknown as Response;
}

const payload = {
  models: [
    {
      id: 'grok-4',
      object: 'model',
      owned_by: 'xai',
      input_modalities: ['text', 'image'],
      output_modalities: ['text'],
      context_length: 256_000,
      aliases: ['grok-4-latest'],
    },
    {
      id: 'grok-3-mini',
      object: 'model',
      owned_by: 'xai',
      input_modalities: ['text'],
      output_modalities: ['text'],
      context_length: 131_072,
    },
    {
      id: 'grok-2-1212',
      object: 'model',
      owned_by: 'xai',
      input_modalities: ['text'],
      output_modalities: ['text'],
    },
    // An image-generation model — not a chat model; must be filtered out.
    {
      id: 'grok-2-image-1212',
      object: 'model',
      owned_by: 'xai',
      input_modalities: ['text'],
      output_modalities: ['image'],
    },
  ],
};

beforeEach(() => {
  jest.clearAllMocks();
  getSecret.mockResolvedValue('xai-test');
});

describe('discoverXaiModels', () => {
  it('hits /v1/language-models with a bearer auth header', async () => {
    getSecret.mockResolvedValue('xai-key');
    fetchMock.mockResolvedValue(okJson(payload));

    await discoverXaiModels();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.x.ai/v1/language-models');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer xai-key');
  });

  it('filters image-gen models and maps vision from input_modalities', async () => {
    fetchMock.mockResolvedValue(okJson(payload));

    const models = await discoverXaiModels();
    const ids = models.map((m) => m.modelId);
    expect(ids).toEqual(['grok-4', 'grok-3-mini', 'grok-2-1212']);
    expect(ids).not.toContain('grok-2-image-1212'); // output_modalities excludes text

    const byId = Object.fromEntries(models.map((m) => [m.modelId, m]));
    // grok-4: multimodal (image in inputs), reasoning, tools, 256K context.
    expect(byId['grok-4']).toEqual(
      expect.objectContaining({
        supportsVision: true,
        supportsTools: true,
        supportsReasoning: true,
        contextWindowTokens: 256_000,
        family: 'grok-4',
      })
    );
    // grok-3-mini: text-only (no vision), reasoning (mini), tools.
    expect(byId['grok-3-mini']).toEqual(
      expect.objectContaining({
        supportsVision: false,
        supportsTools: true,
        supportsReasoning: true,
      })
    );
    // grok-2: text-only, tools, not reasoning; context inferred (131K).
    expect(byId['grok-2-1212']).toEqual(
      expect.objectContaining({
        supportsVision: false,
        supportsTools: true,
        supportsReasoning: false,
        contextWindowTokens: 131_072,
      })
    );
  });

  it('throws a clear error when no credential is configured', async () => {
    getSecret.mockResolvedValue(null);
    await expect(discoverXaiModels()).rejects.toThrow(/No xAI credential/);
  });
});
