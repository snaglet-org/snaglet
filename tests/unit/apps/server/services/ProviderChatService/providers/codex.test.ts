/**
 * Codex provider: ChatGPT-account deactivation on rejection and the
 * refresh-token import from the Codex CLI's ~/.codex/auth.json.
 */

jest.mock('@server/services/ProviderCredentialService', () => ({
  providerCredentialService: {
    getFullCredentialById: jest.fn(),
    resolveCredentialIdForModel: jest.fn(),
    updateSecret: jest.fn(async () => undefined),
  },
}));
jest.mock('@snaglet/db/tables/models', () => ({
  Models: { findByProviderAndModelId: jest.fn(async () => null), deactivate: jest.fn() },
}));
jest.mock('@server/config/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.mock('@server/services/ProviderChatService/providers/openai', () => ({
  chatOpenAI: jest.fn(async () => ({ reply: 'ok', stopReason: 'end_turn', usage: {} })),
}));
jest.mock('@server/services/ProviderChatService/providers/codexCliAuth', () => ({
  readCodexCliAuth: jest.fn(),
}));
jest.mock('@server/services/ProviderChatService/providers/shared/responses-api', () => ({
  callResponsesEndpoint: jest.fn(async () => ({ reply: 'ok', stopReason: 'end_turn', usage: {} })),
  collectResponsesSSE: jest.fn(),
  extractResponsesErrorReason: (b: string) => b,
}));

import type { SnagletAgent } from '@server/services/AgentService';
import { chatCodex, verifyCodexOAuth } from '@server/services/ProviderChatService/providers/codex';
import { providerCredentialService } from '@server/services/ProviderCredentialService';
import { Models } from '@snaglet/db/tables/models';
import { readCodexCliAuth } from '@server/services/ProviderChatService/providers/codexCliAuth';
import { callResponsesEndpoint } from '@server/services/ProviderChatService/providers/shared/responses-api';
import { openAIPromptCacheKey } from '@server/services/ProviderChatService/providers/shared/promptCacheKey';

const getFullCredentialById = providerCredentialService.getFullCredentialById as jest.Mock;
const updateSecret = providerCredentialService.updateSecret as jest.Mock;
const readCli = readCodexCliAuth as jest.Mock;
const responses = callResponsesEndpoint as jest.Mock;

const originalFetch = global.fetch;

function makeAgent(modelId: string): SnagletAgent {
  return {
    id: 'agent-codex',
    name: 'Codex Agent',
    provider: 'codex',
    modelId,
    systemPrompt: 'You are a test.',
    credentialId: 'cred-1',
  } as unknown as SnagletAgent;
}

beforeEach(() => {
  jest.clearAllMocks();
  responses.mockResolvedValue({ reply: 'ok', stopReason: 'end_turn', usage: {} });
});
afterAll(() => {
  global.fetch = originalFetch;
});

describe('codex deactivation', () => {
  it('deactivates a ChatGPT-unsupported model and surfaces a clear message', async () => {
    getFullCredentialById.mockResolvedValue({
      id: 'cred-1',
      authType: 'oauth',
      encryptedSecret: 'access-token',
      // refresh_token present + far-future expiry → resolve returns immediately.
      metadataJson: { refresh_token: 'rt', account_id: 'acc', expires: Date.now() + 3_600_000 },
    });
    (Models.findByProviderAndModelId as jest.Mock).mockResolvedValue({ id: 'm-52codex' });
    (Models.deactivate as jest.Mock).mockResolvedValue(true);

    responses.mockImplementationOnce(
      async (args: { errorTransform: (m: string) => Promise<string> }) => {
        const message = await args.errorTransform(
          'codex request failed (400): The requested model `gpt-5.2-codex` is not supported when using Codex with a ChatGPT account.'
        );
        throw new Error(message);
      }
    );

    await expect(chatCodex(makeAgent('gpt-5.2-codex'), [])).rejects.toThrow(
      /removed from the picker/i
    );

    await new Promise((r) => setTimeout(r, 0));
    expect(Models.findByProviderAndModelId).toHaveBeenCalledWith('codex', 'gpt-5.2-codex');
    expect(Models.deactivate).toHaveBeenCalledWith('m-52codex');
  });

  it('passes an unrelated error through untouched (no deactivation)', async () => {
    getFullCredentialById.mockResolvedValue({
      id: 'cred-1',
      authType: 'oauth',
      encryptedSecret: 'access-token',
      metadataJson: { refresh_token: 'rt', account_id: 'acc', expires: Date.now() + 3_600_000 },
    });

    responses.mockImplementationOnce(
      async (args: { errorTransform: (m: string) => Promise<string> }) => {
        const message = await args.errorTransform('codex request failed (500): upstream boom');
        throw new Error(message);
      }
    );

    await expect(chatCodex(makeAgent('gpt-5.4'), [])).rejects.toThrow(/upstream boom/);
    expect(Models.deactivate).not.toHaveBeenCalled();
  });
});

describe('codex prompt cache key', () => {
  it('sends the per-agent prompt_cache_key to the Codex backend', async () => {
    getFullCredentialById.mockResolvedValue({
      id: 'cred-1',
      authType: 'oauth',
      encryptedSecret: 'access-token',
      metadataJson: { refresh_token: 'rt', account_id: 'acc', expires: Date.now() + 3_600_000 },
    });

    await chatCodex(makeAgent('gpt-5.4'), []);

    expect(responses).toHaveBeenCalledWith(
      expect.objectContaining({ promptCacheKey: openAIPromptCacheKey('agent-codex') })
    );
  });
});

describe('codex refresh-token import from ~/.codex/auth.json', () => {
  it('adopts the CLI refresh token when the credential has none, then refreshes', async () => {
    getFullCredentialById.mockResolvedValue({
      id: 'cred-1',
      authType: 'oauth',
      encryptedSecret: 'stored-access',
      // No refresh_token, so it would expire unrecoverably. account_id matches the CLI's.
      metadataJson: { account_id: 'acc', expires: Date.now() + 3 * 24 * 3_600_000 },
    });
    readCli.mockResolvedValue({
      accessToken: 'cli-access',
      refreshToken: 'cli-refresh',
      accountId: 'acc',
    });

    const fetchMock = jest.fn(async () => ({
      ok: true,
      json: async () => ({
        access_token: 'fresh-access',
        expires_in: 3600,
        refresh_token: 'rotated-refresh',
      }),
    }));
    global.fetch = fetchMock as unknown as typeof fetch;

    await chatCodex(makeAgent('gpt-5.4'), []);

    // The CLI auth was consulted…
    expect(readCli).toHaveBeenCalled();
    // …the imported refresh token was persisted (peeled into the bundle downstream)…
    expect(updateSecret).toHaveBeenCalledWith(
      'cred-1',
      'cli-access',
      expect.objectContaining({ refresh_token: 'cli-refresh', account_id: 'acc' })
    );
    // …and a refresh ran against the OAuth token endpoint, minting a fresh token.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(updateSecret).toHaveBeenCalledWith(
      'cred-1',
      'fresh-access',
      expect.objectContaining({ refresh_token: 'rotated-refresh' })
    );
  });

  it('skips the CLI import when the account id does not match', async () => {
    getFullCredentialById.mockResolvedValue({
      id: 'cred-1',
      authType: 'oauth',
      encryptedSecret: 'stored-access',
      metadataJson: { account_id: 'acc-A', expires: Date.now() + 3 * 24 * 3_600_000 },
    });
    readCli.mockResolvedValue({
      accessToken: 'cli-access',
      refreshToken: 'cli-refresh',
      accountId: 'acc-B',
    });
    global.fetch = jest.fn() as unknown as typeof fetch;

    await chatCodex(makeAgent('gpt-5.4'), []);

    expect(updateSecret).not.toHaveBeenCalled();
    expect(global.fetch).not.toHaveBeenCalled();
  });
});

describe('Codex account credential verification', () => {
  it('authenticates without selecting a model, even when usage is exhausted', async () => {
    global.fetch = jest.fn().mockResolvedValue(
      new Response(JSON.stringify({ plan_type: 'pro', rate_limit: { allowed: false } }), {
        status: 200,
      })
    );
    const result = await verifyCodexOAuth('submitted-token', {
      metadata: { account_id: 'account', refresh_token: 'refresh' },
    });
    expect(result.valid).toBe(true);
    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(global.fetch).toHaveBeenCalledWith(
      'https://chatgpt.com/backend-api/wham/usage',
      expect.objectContaining({
        method: 'GET',
        headers: expect.objectContaining({
          Authorization: 'Bearer submitted-token',
          'ChatGPT-Account-Id': 'account',
        }),
      })
    );
    expect((global.fetch as jest.Mock).mock.calls[0][1]).not.toHaveProperty('body');
    expect(readCli).not.toHaveBeenCalled();
    expect(updateSecret).not.toHaveBeenCalled();
    expect(responses).not.toHaveBeenCalled();
  });

  it.each([401, 403, 429, 500])(
    'does not mistake HTTP %i for a valid credential',
    async (status) => {
      global.fetch = jest.fn().mockResolvedValue(new Response('{}', { status }));
      const result = await verifyCodexOAuth('bad-token', { metadata: { refresh_token: 'rt' } });
      expect(result.valid).toBe(false);
      expect(global.fetch).toHaveBeenCalledTimes(1);
      expect(readCli).not.toHaveBeenCalled();
      expect(updateSecret).not.toHaveBeenCalled();
    }
  );

  it.each(['<html>Sign in</html>', '{}'])(
    'rejects unexpected successful payloads',
    async (body) => {
      global.fetch = jest.fn().mockResolvedValue(new Response(body, { status: 200 }));
      expect((await verifyCodexOAuth('token')).valid).toBe(false);
    }
  );

  it('reports a network failure without claiming authentication failed', async () => {
    global.fetch = jest.fn().mockRejectedValue(new Error('offline'));
    expect(await verifyCodexOAuth('token')).toEqual({
      valid: false,
      message: expect.stringContaining('Could not reach Codex'),
    });
  });
});
