/**
 * Tests for the openai provider's base-URL resolution.
 *
 * The canonical `openai` provider stays pinned to `api.openai.com/v1` and is
 * not user-configurable. Sibling provider files (`together`, `lm-studio`) own
 * their own resolvers and inject the resolved URL via `overrides.baseUrl`, so
 * `resolveOpenAIBaseUrl` itself only needs to handle the canonical id and the
 * generic fallback path for any other id that reaches it.
 */

// Stub the ToolService import chain — its module load runs server config
// (which process.exit(1)s without a real env). We only need toOpenAITools
// to be a no-op for this test file.
jest.mock('@server/services/ToolService/index', () => ({
  toOpenAITools: jest.fn(() => []),
}));

jest.mock('@snaglet/db/tables/providers', () => ({
  Providers: {
    findProvider: jest.fn(),
  },
}));

import {
  normalizeOpenAIBaseUrl,
  resolveOpenAIBaseUrl,
  OPENAI_FALLBACK_BASE_URL,
} from '@server/services/ProviderChatService/providers/openai';
import { Providers } from '@snaglet/db/tables/providers';

describe('normalizeOpenAIBaseUrl', () => {
  it('returns the OpenAI fallback for null/empty', () => {
    expect(normalizeOpenAIBaseUrl(null)).toBe(OPENAI_FALLBACK_BASE_URL);
    expect(normalizeOpenAIBaseUrl(undefined)).toBe(OPENAI_FALLBACK_BASE_URL);
    expect(normalizeOpenAIBaseUrl('')).toBe(OPENAI_FALLBACK_BASE_URL);
    expect(normalizeOpenAIBaseUrl('   ')).toBe(OPENAI_FALLBACK_BASE_URL);
  });

  it('appends /v1 when the base URL omits it', () => {
    expect(normalizeOpenAIBaseUrl('https://openai-compat.example.com/openai')).toBe(
      'https://openai-compat.example.com/openai/v1'
    );
    expect(normalizeOpenAIBaseUrl('http://localhost:8000')).toBe('http://localhost:8000/v1');
  });

  it('keeps an existing /v1 (or other version) suffix', () => {
    expect(normalizeOpenAIBaseUrl('https://api.together.xyz/v1')).toBe(
      'https://api.together.xyz/v1'
    );
    expect(normalizeOpenAIBaseUrl('https://example.com/v2')).toBe('https://example.com/v2');
  });

  it('strips trailing slashes before appending', () => {
    expect(normalizeOpenAIBaseUrl('https://openai-compat.example.com/openai/')).toBe(
      'https://openai-compat.example.com/openai/v1'
    );
    expect(normalizeOpenAIBaseUrl('https://api.together.xyz/v1/')).toBe(
      'https://api.together.xyz/v1'
    );
    expect(normalizeOpenAIBaseUrl('http://localhost:8000///')).toBe('http://localhost:8000/v1');
  });
});

describe('resolveOpenAIBaseUrl', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('always returns the OpenAI fallback for the canonical openai provider', async () => {
    expect(await resolveOpenAIBaseUrl('openai')).toBe(OPENAI_FALLBACK_BASE_URL);
    // Even if a row exists with a base_url, openai is hard-pinned.
    (Providers.findProvider as jest.Mock).mockResolvedValue({
      id: 'openai',
      base_url: 'https://malicious.example/v1',
    });
    expect(await resolveOpenAIBaseUrl('openai')).toBe(OPENAI_FALLBACK_BASE_URL);
    // No DB lookup happens for the canonical id.
    expect(Providers.findProvider).not.toHaveBeenCalled();
  });

  it('reads base_url from the providers row for non-canonical ids', async () => {
    (Providers.findProvider as jest.Mock).mockResolvedValue({
      id: 'some-compat',
      base_url: 'https://openai-compat.example.com/openai',
    });
    expect(await resolveOpenAIBaseUrl('some-compat')).toBe(
      'https://openai-compat.example.com/openai/v1'
    );
    expect(Providers.findProvider).toHaveBeenCalledWith('some-compat');
  });

  it('returns the OpenAI fallback when the row is missing or unconfigured', async () => {
    (Providers.findProvider as jest.Mock).mockResolvedValueOnce(null);
    expect(await resolveOpenAIBaseUrl('some-compat')).toBe(OPENAI_FALLBACK_BASE_URL);

    (Providers.findProvider as jest.Mock).mockResolvedValueOnce({
      id: 'some-compat',
      base_url: null,
    });
    expect(await resolveOpenAIBaseUrl('some-compat')).toBe(OPENAI_FALLBACK_BASE_URL);
  });

  it('falls back gracefully when the providers query rejects', async () => {
    (Providers.findProvider as jest.Mock).mockRejectedValue(new Error('db down'));
    expect(await resolveOpenAIBaseUrl('some-compat')).toBe(OPENAI_FALLBACK_BASE_URL);
  });
});
