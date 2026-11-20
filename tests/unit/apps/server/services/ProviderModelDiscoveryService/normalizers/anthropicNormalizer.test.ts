/**
 * Anthropic discovery normalizer: the limits GET /v1/models reports
 * (`max_input_tokens`, `max_tokens`) are what the catalog stores, marked as
 * reported so they replace stale stored values. Only an entry without them
 * falls back to limits inferred from the id.
 */
import { beforeEach, describe, expect, it, jest } from '@jest/globals';

const getSecret = jest.fn<(providerId: string) => Promise<string | null>>();

jest.mock('@server/services/ProviderCredentialService', () => ({
  providerCredentialService: { getSecret: (...args: [string]) => getSecret(...args) },
}));

import { discoverAnthropicModels } from '@server/services/ProviderModelDiscoveryService/normalizers/anthropic';

const fetchMock = jest.fn();
// @ts-expect-error — override the global for the test.
global.fetch = fetchMock;

function okJson(payload: unknown) {
  return { ok: true, json: async () => payload } as unknown as Response;
}

beforeEach(() => {
  jest.clearAllMocks();
  getSecret.mockResolvedValue('sk-ant-api03-test');
});

describe('discoverAnthropicModels', () => {
  it('stores the limits the API reports, marked as reported', async () => {
    fetchMock.mockResolvedValue(
      okJson({
        data: [
          {
            id: 'claude-fable-5-2',
            display_name: 'Claude Fable 5.2',
            max_input_tokens: 1_000_000,
            max_tokens: 128_000,
          },
        ],
      })
    );

    const [fable] = await discoverAnthropicModels();

    expect(fable).toMatchObject({
      modelId: 'claude-fable-5-2',
      displayName: 'Claude Fable 5.2',
      contextWindowTokens: 1_000_000,
      maxOutputTokens: 128_000,
      reportedLimits: { contextWindowTokens: 1_000_000, maxOutputTokens: 128_000 },
    });
  });

  it('infers limits by generation for entries that report none, and marks nothing reported', async () => {
    fetchMock.mockResolvedValue(
      okJson({
        data: [
          { id: 'claude-fable-5-2' },
          { id: 'claude-haiku-5-5' },
          { id: 'claude-sonnet-4-6' },
          { id: 'claude-opus-4-5-20251101' },
          { id: 'claude-haiku-4-5-20251001' },
        ],
      })
    );

    const models = await discoverAnthropicModels();
    const limits = Object.fromEntries(
      models.map((m) => [m.modelId, [m.contextWindowTokens, m.maxOutputTokens]])
    );

    expect(limits).toEqual({
      'claude-fable-5-2': [1_000_000, 128_000],
      'claude-haiku-5-5': [1_000_000, 128_000],
      'claude-sonnet-4-6': [1_000_000, 128_000],
      'claude-opus-4-5-20251101': [200_000, 64_000],
      'claude-haiku-4-5-20251001': [200_000, 64_000],
    });
    expect(models.every((m) => Object.keys(m.reportedLimits ?? {}).length === 0)).toBe(true);
  });
});
