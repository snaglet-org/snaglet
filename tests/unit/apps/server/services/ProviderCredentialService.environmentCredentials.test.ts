const mockListSafeCredentials = jest.fn();
const mockSaveCredential = jest.fn();
const mockUpdateCredentialSecret = jest.fn();
const mockFindProvider = jest.fn();
const mockUpdatePrimaryCredential = jest.fn();

jest.mock('@server/services/ProviderCredentialService/credentials', () => ({
  listSafeCredentials: mockListSafeCredentials,
  saveCredential: mockSaveCredential,
  updateCredentialSecret: mockUpdateCredentialSecret,
}));

jest.mock('@snaglet/db/tables/providers', () => ({
  Providers: {
    findProvider: mockFindProvider,
    updatePrimaryCredential: mockUpdatePrimaryCredential,
  },
}));

import {
  collectEnvironmentTestCredentials,
  seedEnvironmentTestCredentials,
  shouldSeedEnvironmentTestCredentials,
} from '@server/services/ProviderCredentialService/environmentCredentials';

function safeCredential(overrides: Record<string, unknown> = {}) {
  return {
    id: 'credential-id',
    providerId: 'openai',
    authTypeId: 'openai:api-key',
    authType: 'api_key',
    label: 'Test credential: OpenAI environment',
    hasSecret: true,
    updatedAt: '2026-07-28T00:00:00.000Z',
    verificationStatus: 'untested',
    ...overrides,
  };
}

describe('environment test credential bootstrap', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockListSafeCredentials.mockResolvedValue([]);
    mockSaveCredential.mockImplementation(async (input) =>
      safeCredential({
        id: `${input.providerId}-credential`,
        providerId: input.providerId,
        authTypeId: input.authTypeId,
        authType: input.authType,
        label: input.label,
      })
    );
    mockFindProvider.mockImplementation(async (providerId) => ({
      id: providerId,
      primaryCredentialId: null,
    }));
    mockUpdatePrimaryCredential.mockResolvedValue({});
  });

  it('runs automatically in development and only by explicit opt-in elsewhere', () => {
    expect(shouldSeedEnvironmentTestCredentials({ NODE_ENV: 'development' })).toBe(true);
    expect(
      shouldSeedEnvironmentTestCredentials({
        NODE_ENV: 'production',
        SNAGLET_SEED_TEST_CREDENTIALS: '1',
      })
    ).toBe(true);
    expect(shouldSeedEnvironmentTestCredentials({ NODE_ENV: 'production' })).toBe(false);
    expect(shouldSeedEnvironmentTestCredentials({ NODE_ENV: 'test' })).toBe(false);
  });

  it('maps every simple supported environment key to its provider auth type', () => {
    const seeds = collectEnvironmentTestCredentials({
      ANTHROPIC_API_KEY: 'anthropic-secret',
      OPENAI_API_KEY: 'openai-secret',
      TOGETHER_API_KEY: 'together-secret',
      MISTRAL_API_KEY: 'mistral-secret',
      GEMINI_API_KEY: 'gemini-secret',
      DEEPSEEK_API_KEY: 'deepseek-secret',
      XAI_API_KEY: 'xai-secret',
    });

    expect(
      seeds.map(({ providerId, authTypeId, label }) => ({ providerId, authTypeId, label }))
    ).toEqual([
      {
        providerId: 'anthropic',
        authTypeId: 'anthropic:api-key',
        label: 'Test credential: Anthropic environment',
      },
      {
        providerId: 'openai',
        authTypeId: 'openai:api-key',
        label: 'Test credential: OpenAI environment',
      },
      {
        providerId: 'together',
        authTypeId: 'together:api-key',
        label: 'Test credential: Together environment',
      },
      {
        providerId: 'mistral',
        authTypeId: 'mistral:api-key',
        label: 'Test credential: Mistral environment',
      },
      {
        providerId: 'google',
        authTypeId: 'google:api-key',
        label: 'Test credential: Gemini environment',
      },
      {
        providerId: 'deepseek',
        authTypeId: 'deepseek:api-key',
        label: 'Test credential: DeepSeek environment',
      },
      {
        providerId: 'xai',
        authTypeId: 'xai:api-key',
        label: 'Test credential: xAI environment',
      },
    ]);
  });

  it('builds Codex and Copilot credentials in their existing metadata formats', () => {
    const seeds = collectEnvironmentTestCredentials({
      CODEX_ACCESS_TOKEN: 'codex-access',
      CODEX_REFRESH_TOKEN: 'codex-refresh',
      CODEX_ACCOUNT_ID: 'codex-account',
      COPILOT_SECRET: 'copilot-secret',
      COPILOT_TOKEN: 'copilot-token',
      COPILOT_BASE_URL: 'https://api.copilot.test',
      COPILOT_EXPIRES_AT: '1900000000000',
    });

    expect(seeds).toEqual([
      expect.objectContaining({
        providerId: 'codex',
        authTypeId: 'codex:codex-subscription',
        authType: 'oauth',
        label: 'Test credential: Codex environment',
        secret: 'codex-access',
        metadata: {
          refresh_token: 'codex-refresh',
          account_id: 'codex-account',
        },
      }),
      expect.objectContaining({
        providerId: 'copilot',
        authTypeId: 'copilot:subscription',
        authType: 'oauth',
        label: 'Test credential: Copilot environment',
        secret: 'copilot-secret',
        metadata: {
          copilot_token: 'copilot-token',
          copilot_base_url: 'https://api.copilot.test',
          copilot_expires_at: '1900000000000',
        },
      }),
    ]);
  });

  it('ignores empty values and composite metadata without a usable primary token', () => {
    expect(
      collectEnvironmentTestCredentials({
        OPENAI_API_KEY: '   ',
        CODEX_REFRESH_TOKEN: 'refresh-only',
        CODEX_ACCOUNT_ID: 'account-only',
        COPILOT_BASE_URL: 'https://base-only.test',
        COPILOT_EXPIRES_AT: '1900000000000',
      })
    ).toEqual([]);
  });

  it('creates encrypted-service rows and makes them primary only when no primary exists', async () => {
    mockFindProvider.mockImplementation(async (providerId) => ({
      id: providerId,
      primaryCredentialId: providerId === 'openai' ? 'user-primary' : null,
    }));

    const report = await seedEnvironmentTestCredentials({
      NODE_ENV: 'development',
      OPENAI_API_KEY: 'openai-secret',
      ANTHROPIC_API_KEY: 'anthropic-secret',
    });

    expect(mockSaveCredential).toHaveBeenCalledTimes(2);
    expect(mockUpdatePrimaryCredential).toHaveBeenCalledTimes(1);
    expect(mockUpdatePrimaryCredential).toHaveBeenCalledWith('anthropic', 'anthropic-credential');
    expect(report).toEqual({
      enabled: true,
      created: 2,
      updated: 0,
      primaryAssigned: 1,
      providers: ['anthropic', 'openai'],
      sourceEnvVars: ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY'],
    });
    expect(JSON.stringify(report)).not.toContain('openai-secret');
    expect(JSON.stringify(report)).not.toContain('anthropic-secret');
  });

  it('updates only its exact labeled row on later boots', async () => {
    mockListSafeCredentials.mockResolvedValue([
      safeCredential({ id: 'user-row', label: 'Personal key' }),
      safeCredential({ id: 'owned-test-row' }),
    ]);
    mockFindProvider.mockResolvedValue({
      id: 'openai',
      primaryCredentialId: 'user-row',
    });

    const report = await seedEnvironmentTestCredentials({
      NODE_ENV: 'development',
      OPENAI_API_KEY: 'rotated-secret',
    });

    expect(mockUpdateCredentialSecret).toHaveBeenCalledWith('owned-test-row', 'rotated-secret', {});
    expect(mockSaveCredential).not.toHaveBeenCalled();
    expect(mockUpdatePrimaryCredential).not.toHaveBeenCalled();
    expect(report.updated).toBe(1);
  });

  it('performs no database reads when production has not opted in', async () => {
    await expect(
      seedEnvironmentTestCredentials({
        NODE_ENV: 'production',
        OPENAI_API_KEY: 'must-not-import',
      })
    ).resolves.toEqual({
      enabled: false,
      created: 0,
      updated: 0,
      primaryAssigned: 0,
      providers: [],
      sourceEnvVars: [],
    });
    expect(mockListSafeCredentials).not.toHaveBeenCalled();
    expect(mockSaveCredential).not.toHaveBeenCalled();
  });
});
