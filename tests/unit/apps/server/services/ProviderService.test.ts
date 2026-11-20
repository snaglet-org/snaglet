// Mock @snaglet/db
const mockListAll = jest.fn();
const mockFindProvider = jest.fn();
const mockListByProviderIds = jest.fn();
const mockListByProviderId = jest.fn();

jest.mock('@snaglet/db/tables/providers', () => ({
  Providers: {
    listAll: (...args: unknown[]) => mockListAll(...args),
    findProvider: (...args: unknown[]) => mockFindProvider(...args),
  },
}));

jest.mock('@snaglet/db/tables/provider_auth_types', () => ({
  ProviderAuthTypes: {
    listByProviderIds: (...args: unknown[]) => mockListByProviderIds(...args),
    listByProviderId: (...args: unknown[]) => mockListByProviderId(...args),
  },
}));

import { providerService } from '@server/services/ProviderService';

describe('ProviderService', () => {
  beforeEach(() => jest.clearAllMocks());

  describe('list', () => {
    it('should return an empty list when DB has no providers', async () => {
      mockListAll.mockResolvedValue([]);

      const providers = await providerService.list();

      expect(providers).toEqual([]);
    });

    it('should return an empty list when DB throws', async () => {
      mockListAll.mockRejectedValue(new Error('DB down'));

      const providers = await providerService.list();

      expect(providers).toEqual([]);
    });

    it('should return all providers from DB', async () => {
      mockListAll.mockResolvedValue([
        {
          id: 'anthropic',
          name: 'Anthropic',
          description: '',
          website: null,
          api_docs: null,
          sort_order: 0,
        },
        {
          id: 'some-unknown',
          name: 'Unknown',
          description: '',
          website: null,
          api_docs: null,
          sort_order: 99,
        },
      ]);
      mockListByProviderIds.mockResolvedValue([]);

      const providers = await providerService.list();

      const ids = providers.map((p) => p.id);
      expect(ids).toContain('anthropic');
      expect(ids).toContain('some-unknown');
    });

    it('should enrich codex:codex-subscription with metadata fields', async () => {
      mockListAll.mockResolvedValue([
        {
          id: 'codex',
          name: 'Codex',
          description: '',
          website: null,
          api_docs: null,
          sort_order: 0,
        },
      ]);
      mockListByProviderIds.mockResolvedValue([
        {
          id: 'codex:codex-subscription',
          providerId: 'codex',
          name: 'Codex Sub',
          type: 'oauth',
          description: 'OAuth',
          tokenLabel: null,
          tokenPlaceholder: null,
          tokenHelp: null,
          sortOrder: 0,
        },
      ]);

      const providers = await providerService.list();
      const codex = providers.find((p) => p.id === 'codex');

      expect(codex).toBeDefined();
      const authType = codex!.authTypes.find((a) => a.id === 'codex:codex-subscription');
      expect(authType).toBeDefined();
      expect(authType!.metadataFields).toBeDefined();
      expect(authType!.metadataFields!.length).toBe(3);
      expect(authType!.metadataFields!.map((f) => f.key)).toEqual([
        'access_token',
        'refresh_token',
        'account_id',
      ]);
    });

    it('should not add metadataFields to auth types without metadata config', async () => {
      mockListAll.mockResolvedValue([
        {
          id: 'openai',
          name: 'OpenAI',
          description: '',
          website: null,
          api_docs: null,
          sort_order: 0,
        },
      ]);
      mockListByProviderIds.mockResolvedValue([
        {
          id: 'openai:api-key',
          providerId: 'openai',
          name: 'API Key',
          type: 'api_key',
          description: 'Key',
          tokenLabel: null,
          tokenPlaceholder: null,
          tokenHelp: null,
          sortOrder: 0,
        },
      ]);

      const providers = await providerService.list();
      const openai = providers.find((p) => p.id === 'openai');

      expect(openai!.authTypes[0].metadataFields).toBeUndefined();
    });
  });

  describe('get', () => {
    it('should return provider from DB with auth types', async () => {
      mockFindProvider.mockResolvedValue({
        id: 'anthropic',
        name: 'Anthropic',
        description: 'Claude',
        website: 'https://anthropic.com',
        api_docs: 'https://docs.anthropic.com',
        sort_order: 0,
      });
      mockListByProviderId.mockResolvedValue([
        {
          id: 'anthropic:api-key',
          name: 'API Key',
          type: 'api_key',
          description: 'Direct key',
          token_label: 'API Key',
          token_placeholder: 'sk-ant-...',
          token_help: 'Create in console',
          sort_order: 0,
        },
      ]);

      const provider = await providerService.get('anthropic');

      expect(provider).not.toBeNull();
      expect(provider!.id).toBe('anthropic');
      expect(provider!.authTypes).toHaveLength(1);
      expect(provider!.authTypes[0].id).toBe('anthropic:api-key');
    });

    it('should return null when DB row not found', async () => {
      mockFindProvider.mockResolvedValue(null);

      const provider = await providerService.get('anthropic');

      expect(provider).toBeNull();
    });

    it('should return null for unknown provider not in fallbacks', async () => {
      mockFindProvider.mockResolvedValue(null);

      const provider = await providerService.get('unknown-provider');

      expect(provider).toBeNull();
    });

    it('should return null on DB error', async () => {
      mockFindProvider.mockRejectedValue(new Error('DB down'));

      const provider = await providerService.get('openai');

      expect(provider).toBeNull();
    });
  });
});
