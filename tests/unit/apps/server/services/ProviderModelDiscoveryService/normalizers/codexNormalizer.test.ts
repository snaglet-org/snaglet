/**
 * Codex discovery curated list: a ChatGPT-account (OAuth) token runs
 * only curated subscription candidates, including GPT-6.1 Sol and GPT-6 Astra.
 * API-key credentials see the full curated catalog.
 */

const getSecret = jest.fn();

jest.mock('@server/services/ProviderCredentialService', () => ({
  providerCredentialService: { getSecret: (...a: unknown[]) => getSecret(...a) },
}));

import {
  discoverCodexModels,
  inferCodexVision,
} from '@server/services/ProviderModelDiscoveryService/normalizers/codex';

const originalFetch = global.fetch;

beforeEach(() => {
  jest.clearAllMocks();
});
afterAll(() => {
  global.fetch = originalFetch;
});

describe('discoverCodexModels', () => {
  it('restricts a ChatGPT-account (OAuth) token to the supported slice, incl gpt-5.5', async () => {
    // A JWT-looking secret is treated as OAuth.
    getSecret.mockResolvedValue('eyJhbGciOi.payload.sig');

    const models = await discoverCodexModels();
    const ids = models.map((m) => m.modelId).sort();

    expect(ids).toEqual(['gpt-5.4', 'gpt-5.4-mini', 'gpt-5.5', 'gpt-6-astra', 'gpt-6.1-sol']);
    expect(models.find((model) => model.modelId === 'gpt-6-astra')).toMatchObject({
      displayName: 'GPT-6 Astra',
      family: 'gpt-6',
      contextWindowTokens: 272_000,
      maxOutputTokens: 128_000,
      supportsReasoning: true,
      supportsVision: true,
      supportsTools: true,
    });
    expect(models.find((model) => model.modelId === 'gpt-6.1-sol')).toMatchObject({
      displayName: 'GPT-6.1 Sol',
      family: 'gpt-6',
      contextWindowTokens: 500_000,
      maxOutputTokens: 128_000,
      supportsReasoning: true,
      supportsVision: true,
      supportsTools: true,
    });
    // The blocked -codex variants are gone.
    expect(ids).not.toContain('gpt-5.2-codex');
    expect(ids).not.toContain('gpt-5.3-codex');
    expect(ids).not.toContain('codex-latest');
    expect(models.every((model) => model.supportsVision)).toBe(true);
  });

  it('returns the full curated catalog (incl gpt-5.5) for an API-key credential', async () => {
    getSecret.mockResolvedValue('sk-not-a-jwt');
    // Public /v1/models call fails → falls back to the curated list only.
    global.fetch = jest.fn(async () => ({ ok: false, status: 401 })) as unknown as typeof fetch;

    const models = await discoverCodexModels();
    const ids = models.map((m) => m.modelId);

    expect(ids).toContain('gpt-6.1-sol');
    expect(ids).toContain('gpt-6-astra');
    expect(ids).toContain('gpt-5.5');
    expect(ids).toContain('gpt-5.4');
    expect(ids).toContain('gpt-5.2-codex'); // curated list is unfiltered for API keys
    expect(models.every((model) => model.supportsVision)).toBe(true);
  });

  it('marks current models as vision-capable without including legacy code models', () => {
    expect(inferCodexVision('gpt-6.1-sol')).toBe(true);
    expect(inferCodexVision('gpt-6-astra')).toBe(true);
    expect(inferCodexVision('gpt-5.6-sol')).toBe(true);
    expect(inferCodexVision('gpt-5.4-mini')).toBe(true);
    expect(inferCodexVision('codex-latest')).toBe(true);
    expect(inferCodexVision('code-davinci-002')).toBe(false);
  });
});
