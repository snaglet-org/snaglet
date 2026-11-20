// Unit tests for the get_providers tool.
const mockListSafe = jest.fn();

jest.mock('@server/services/ProviderCredentialService', () => ({
  providerCredentialService: {
    listSafe: mockListSafe,
  },
}));

import getProviders from '@server/services/ToolService/handlers/agents/getProviders';

describe('get_providers tool', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('reports when no providers are configured', async () => {
    mockListSafe.mockResolvedValue([]);

    const result = (await getProviders({}, {}, undefined as never)) as {
      output: string;
      rawContent: { providers: unknown[] };
    };

    expect(result.output).toContain('No providers');
    expect(result.rawContent.providers).toEqual([]);
  });

  it('lists configured providers with secrets stripped', async () => {
    mockListSafe.mockResolvedValue([
      {
        id: 'cred-1',
        providerId: 'anthropic',
        authType: 'api_key',
        label: 'Anthropic',
        hasSecret: true,
        verificationStatus: 'verified',
        updatedAt: '2026-01-01T00:00:00Z',
      },
      {
        id: 'cred-2',
        providerId: 'openai',
        authType: 'api_key',
        label: 'OpenAI',
        hasSecret: false,
        verificationStatus: 'unverified',
        updatedAt: '2026-01-02T00:00:00Z',
      },
    ]);

    const result = (await getProviders({}, {}, undefined as never)) as {
      output: string;
      rawContent: { providers: Array<Record<string, unknown>> };
    };

    expect(result.output).toContain('anthropic');
    expect(result.output).toContain('openai');
    expect(result.output).toContain('2 provider');
    // No secret material is ever surfaced.
    expect(JSON.stringify(result.rawContent)).not.toMatch(/secret.*[:=].*[A-Za-z0-9]{8}/);
    expect(result.rawContent.providers).toHaveLength(2);
    expect(result.rawContent.providers[0]).not.toHaveProperty('secret');
  });
});
