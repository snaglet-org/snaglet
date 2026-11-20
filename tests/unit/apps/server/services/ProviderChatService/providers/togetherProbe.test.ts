/**
 * Together serverless entitlement probe — a minimal 1-token chat request whose
 * verdict prunes dedicated-only (non-serverless) models. Mocks the credential
 * store, the base-URL resolver, and global fetch, and pins that Together's
 * "non-serverless" 400 becomes the stored prune reason verbatim.
 */
import { beforeEach, describe, expect, it, jest } from '@jest/globals';

const getSecret = jest.fn<(providerId: string) => Promise<string | null>>();
jest.mock('@server/services/ProviderCredentialService', () => ({
  providerCredentialService: {
    getSecret: (...args: [string]) => getSecret(...args),
    getSecretById: async () => null,
  },
}));

// No providers row → the factory falls back to its baked-in base URL.
jest.mock('@snaglet/db/tables/providers', () => ({
  Providers: { findProvider: jest.fn(async () => null) },
}));

import { probeTogetherModel } from '@server/services/ProviderChatService/providers/together';

const fetchMock = jest.fn();
// @ts-expect-error — override the global for the test.
global.fetch = fetchMock;

const NON_SERVERLESS_BODY = JSON.stringify({
  error: {
    message:
      'Unable to access non-serverless model Hcompany/Holo3-35B-A3B. Please visit https://api.together.ai/models/Hcompany/Holo3-35B-A3B to create and start a new dedicated endpoint for the model.',
    type: 'invalid_request_error',
    code: 'model_not_available',
  },
});

beforeEach(() => {
  jest.clearAllMocks();
  getSecret.mockResolvedValue('together-secret');
});

describe('probeTogetherModel', () => {
  it('posts a 1-token chat request to the Together endpoint with a bearer header', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      body: { cancel: async () => undefined },
    } as unknown as Response);

    const result = await probeTogetherModel('meta-llama/Llama-3.3-70B-Instruct-Turbo');

    expect(result).toEqual({ ok: true });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.together.xyz/v1/chat/completions');
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer together-secret');
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    expect(body.max_tokens).toBe(1);
    expect(body.model).toBe('meta-llama/Llama-3.3-70B-Instruct-Turbo');
  });

  it("prunes a dedicated-only model, storing Together's reason verbatim", async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 400,
      text: async () => NON_SERVERLESS_BODY,
    } as unknown as Response);

    const result = await probeTogetherModel('Hcompany/Holo3-35B-A3B');

    expect(result.ok).toBe(false);
    expect(result.reason).toBe(
      'Unable to access non-serverless model Hcompany/Holo3-35B-A3B. Please visit https://api.together.ai/models/Hcompany/Holo3-35B-A3B to create and start a new dedicated endpoint for the model.'
    );
  });

  it('reports a missing credential instead of throwing', async () => {
    getSecret.mockResolvedValue(null);
    const result = await probeTogetherModel('anything');
    expect(result).toEqual({ ok: false, reason: 'No Together AI credential configured' });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
