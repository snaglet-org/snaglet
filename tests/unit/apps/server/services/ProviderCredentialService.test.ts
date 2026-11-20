import { randomBytes } from 'crypto';

// Set encryption key before any imports
const TEST_KEY = randomBytes(32).toString('hex');
process.env.CREDENTIAL_ENCRYPTION_KEY = TEST_KEY;

// Mock @snaglet/db
const mockListCredentials = jest.fn();
const mockCreateCredential = jest.fn();
const mockFindById = jest.fn();
const mockFindByProvider = jest.fn();
const mockDeleteById = jest.fn();
const mockUpdateTokens = jest.fn();
const mockPatch = jest.fn();
const mockFindProvider = jest.fn();
const mockUpdatePrimaryCredential = jest.fn();

jest.mock('@snaglet/db/tables/user_provider_credentials', () => ({
  UserProviderCredentials: {
    listAll: mockListCredentials,
    create: mockCreateCredential,
    findById: mockFindById,
    findByProviderId: mockFindByProvider,
    delete: mockDeleteById,
    updateTokens: mockUpdateTokens,
    patch: mockPatch,
    updateVerificationStatus: jest.fn(),
  },
}));

jest.mock('@snaglet/db/tables/providers', () => ({
  Providers: {
    findProvider: mockFindProvider,
    updatePrimaryCredential: mockUpdatePrimaryCredential,
  },
}));

jest.mock('@server/config/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import { providerCredentialService } from '@server/services/ProviderCredentialService';
import { encrypt, decrypt } from '@server/utils/encryption';

interface CredentialInsert {
  providerId?: string;
  authTypeId?: string;
  authType?: string;
  label?: string;
  encryptedSecret?: string;
}

function makeRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'cred-1',
    providerId: 'anthropic',
    authTypeId: 'anthropic:api-key',
    authType: 'api_key',
    label: 'My key',
    encryptedSecret: encrypt('sk-ant-test'),
    encryptedBundle: null,
    metadataJson: null,
    updatedAt: '2026-01-01T00:00:00Z',
    createdAt: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

describe('ProviderCredentialService', () => {
  beforeEach(() => jest.clearAllMocks());

  describe('listSafe', () => {
    it('should strip encryptedSecret and return hasSecret flag', async () => {
      mockListCredentials.mockResolvedValue([
        makeRow({ id: 'c1', encryptedSecret: 'v1:abc' }),
        makeRow({ id: 'c2', encryptedSecret: '' }),
      ]);

      const list = await providerCredentialService.listSafe();

      expect(list).toHaveLength(2);
      expect(list[0].id).toBe('c1');
      expect(list[0].hasSecret).toBe(true);
      expect(list[1].hasSecret).toBe(false);
      // Should not contain the raw encrypted value
      expect(Reflect.get(list[0], 'encryptedSecret')).toBeUndefined();
    });

    it('should map snake_case fields to camelCase', async () => {
      mockListCredentials.mockResolvedValue([makeRow()]);

      const [cred] = await providerCredentialService.listSafe();

      expect(cred.providerId).toBe('anthropic');
      expect(cred.authTypeId).toBe('anthropic:api-key');
      expect(cred.authType).toBe('api_key');
      expect(cred.updatedAt).toBe('2026-01-01T00:00:00Z');
    });
  });

  describe('save', () => {
    it('should encrypt the secret before storing', async () => {
      mockCreateCredential.mockImplementation((input: CredentialInsert) => ({
        id: 'new-id',
        providerId: input.providerId,
        authTypeId: input.authTypeId,
        authType: input.authType,
        label: input.label,
        encryptedSecret: input.encryptedSecret,
        updatedAt: '2026-01-01T00:00:00Z',
      }));

      await providerCredentialService.save({
        providerId: 'openai',
        authTypeId: 'openai:api-key',
        authType: 'api_key',
        secret: 'sk-real-key',
      });

      const callArg = mockCreateCredential.mock.calls[0][0];
      expect(callArg.encryptedSecret).toMatch(/^v1:/);
      expect(decrypt(callArg.encryptedSecret)).toBe('sk-real-key');
    });

    it('should normalize gemini → google', async () => {
      mockCreateCredential.mockImplementation((input: CredentialInsert) => ({
        id: 'new-id',
        providerId: input.providerId,
        authTypeId: input.authTypeId,
        authType: input.authType,
        label: input.label,
        encryptedSecret: input.encryptedSecret,
        updatedAt: '2026-01-01T00:00:00Z',
      }));

      await providerCredentialService.save({
        providerId: 'gemini',
        authTypeId: 'google:api-key',
        authType: 'api_key',
        secret: 'AIza-test',
      });

      expect(mockCreateCredential.mock.calls[0][0].providerId).toBe('google');
    });

    it('makes the first credential for a provider its primary automatically', async () => {
      // No existing credential for the provider → the new row becomes primary.
      mockFindByProvider.mockResolvedValue(null);
      mockCreateCredential.mockImplementation((input: Record<string, unknown>) =>
        makeRow({ ...input, id: 'cred-first' })
      );

      await providerCredentialService.save({
        providerId: 'openai',
        authTypeId: 'openai:api-key',
        authType: 'api_key',
        secret: 'sk-first',
      });

      expect(mockFindByProvider).toHaveBeenCalledWith('openai');
      expect(mockUpdatePrimaryCredential).toHaveBeenCalledTimes(1);
      expect(mockUpdatePrimaryCredential).toHaveBeenCalledWith('openai', 'cred-first');
      // Existence is checked before the insert so the new row can't count as
      // "existing" and defeat the first-credential rule.
      expect(mockFindByProvider.mock.invocationCallOrder[0]).toBeLessThan(
        mockCreateCredential.mock.invocationCallOrder[0]
      );
    });

    it('a second credential does not steal an existing primary', async () => {
      mockFindByProvider.mockResolvedValue(makeRow({ id: 'cred-existing', providerId: 'openai' }));
      mockCreateCredential.mockImplementation((input: Record<string, unknown>) =>
        makeRow({ ...input, id: 'cred-second' })
      );

      await providerCredentialService.save({
        providerId: 'openai',
        authTypeId: 'openai:api-key',
        authType: 'api_key',
        secret: 'sk-second',
      });

      expect(mockUpdatePrimaryCredential).not.toHaveBeenCalled();
    });

    it('checks first-credential existence against the normalized provider id', async () => {
      mockFindByProvider.mockResolvedValue(null);
      mockCreateCredential.mockImplementation((input: Record<string, unknown>) =>
        makeRow({ ...input, id: 'cred-google' })
      );

      await providerCredentialService.save({
        providerId: 'gemini',
        authTypeId: 'google:api-key',
        authType: 'api_key',
        secret: 'AIza-test',
      });

      expect(mockFindByProvider).toHaveBeenCalledWith('google');
      expect(mockUpdatePrimaryCredential).toHaveBeenCalledWith('google', 'cred-google');
    });

    it('a failed primary assignment does not fail the credential save', async () => {
      mockFindByProvider.mockResolvedValue(null);
      mockCreateCredential.mockImplementation((input: Record<string, unknown>) =>
        makeRow({ ...input, id: 'cred-orphan' })
      );
      mockUpdatePrimaryCredential.mockRejectedValue(new Error('no providers row'));

      const saved = await providerCredentialService.save({
        providerId: 'openai',
        authTypeId: 'openai:api-key',
        authType: 'api_key',
        secret: 'sk-still-saves',
      });

      expect(saved.id).toBe('cred-orphan');
    });

    it('should generate label from provider:authType when not provided', async () => {
      mockCreateCredential.mockImplementation((input: CredentialInsert) => ({
        id: 'new-id',
        providerId: input.providerId,
        authTypeId: input.authTypeId,
        authType: input.authType,
        label: input.label,
        encryptedSecret: input.encryptedSecret,
        updatedAt: '2026-01-01T00:00:00Z',
      }));

      await providerCredentialService.save({
        providerId: 'openai',
        authTypeId: 'openai:api-key',
        authType: 'api_key',
        secret: 'sk-test',
      });

      expect(mockCreateCredential.mock.calls[0][0].label).toBe('openai:openai:api-key');
    });
  });

  describe('getSecretById', () => {
    it('should decrypt and return the secret', async () => {
      mockFindById.mockResolvedValue(makeRow());

      const secret = await providerCredentialService.getSecretById('cred-1');

      expect(secret).toBe('sk-ant-test');
    });

    it('should return null when credential not found', async () => {
      mockFindById.mockResolvedValue(null);

      const secret = await providerCredentialService.getSecretById('missing');

      expect(secret).toBeNull();
    });

    it('should return null when encryptedSecret is empty', async () => {
      mockFindById.mockResolvedValue(makeRow({ encryptedSecret: '' }));

      const secret = await providerCredentialService.getSecretById('cred-1');

      expect(secret).toBeNull();
    });
  });

  describe('getSecret', () => {
    it('should normalize provider ID before lookup', async () => {
      mockFindByProvider.mockResolvedValue(makeRow());

      await providerCredentialService.getSecret('gemini');

      expect(mockFindByProvider).toHaveBeenCalledWith('google');
    });

    it('should return decrypted secret when found', async () => {
      mockFindByProvider.mockResolvedValue(makeRow());

      const secret = await providerCredentialService.getSecret('anthropic');

      expect(secret).toBe('sk-ant-test');
    });

    it('should return null when no credential exists', async () => {
      mockFindByProvider.mockResolvedValue(null);

      const secret = await providerCredentialService.getSecret('openai');

      expect(secret).toBeNull();
    });
  });

  describe('resolveCredentialIdForModel', () => {
    it('uses explicit override credential when it belongs to the provider', async () => {
      mockFindById.mockResolvedValue(makeRow({ id: 'cred-explicit', providerId: 'openai' }));

      const credentialId = await providerCredentialService.resolveCredentialIdForModel({
        providerId: 'openai',
        modelId: 'gpt-5',
        preferredCredentialId: 'cred-explicit',
      });

      expect(credentialId).toBe('cred-explicit');
      expect(mockFindProvider).not.toHaveBeenCalled();
      expect(mockFindByProvider).not.toHaveBeenCalled();
    });

    it('falls back to provider primary credential when explicit override is missing/mismatched', async () => {
      mockFindById.mockResolvedValue(makeRow({ id: 'cred-other', providerId: 'anthropic' }));
      mockFindProvider.mockResolvedValue({
        id: 'openai',
        primaryCredentialId: 'cred-provider-primary',
      });

      const credentialId = await providerCredentialService.resolveCredentialIdForModel({
        providerId: 'openai',
        modelId: 'gpt-5',
        preferredCredentialId: 'cred-other',
      });

      expect(credentialId).toBe('cred-provider-primary');
      expect(mockFindByProvider).not.toHaveBeenCalled();
    });

    it('falls back to provider primary credential when no explicit override given', async () => {
      mockFindById.mockResolvedValue(null);
      mockFindProvider.mockResolvedValue({
        id: 'openai',
        primaryCredentialId: 'cred-provider-primary',
      });

      const credentialId = await providerCredentialService.resolveCredentialIdForModel({
        providerId: 'openai',
        modelId: 'gpt-5',
      });

      expect(credentialId).toBe('cred-provider-primary');
      expect(mockFindByProvider).not.toHaveBeenCalled();
    });

    it('falls back to latest provider credential when no primary mapping exists', async () => {
      mockFindById.mockResolvedValue(null);
      mockFindProvider.mockResolvedValue({ id: 'google', primaryCredentialId: null });
      mockFindByProvider.mockResolvedValue(
        makeRow({ id: 'cred-provider-default', providerId: 'google' })
      );

      const credentialId = await providerCredentialService.resolveCredentialIdForModel({
        providerId: 'gemini',
        modelId: 'gemini-2.5-pro',
      });

      expect(mockFindProvider).toHaveBeenCalledWith('google');
      expect(mockFindByProvider).toHaveBeenCalledWith('google');
      expect(credentialId).toBe('cred-provider-default');
    });
  });

  describe('remove', () => {
    it('should delegate to UserProviderCredentials.delete', async () => {
      mockDeleteById.mockResolvedValue(true);

      const result = await providerCredentialService.remove('cred-1');

      expect(mockDeleteById).toHaveBeenCalledWith('cred-1');
      expect(result).toBe(true);
    });
  });

  describe('getFullCredentialById', () => {
    it('should return row with decrypted secret', async () => {
      const row = makeRow();
      mockFindById.mockResolvedValue(row);

      const result = await providerCredentialService.getFullCredentialById('cred-1');

      expect(result).not.toBeNull();
      expect(result!.encryptedSecret).toBe('sk-ant-test');
    });

    it('should return null when not found', async () => {
      mockFindById.mockResolvedValue(null);

      const result = await providerCredentialService.getFullCredentialById('missing');

      expect(result).toBeNull();
    });
  });

  describe('updateSecret', () => {
    it('should encrypt the new secret and delegate', async () => {
      mockUpdateTokens.mockResolvedValue(undefined);

      await providerCredentialService.updateSecret('cred-1', 'new-secret', { foo: 'bar' });

      expect(mockUpdateTokens).toHaveBeenCalledTimes(1);
      const [id, encrypted, meta] = mockUpdateTokens.mock.calls[0];
      expect(id).toBe('cred-1');
      expect(encrypted).toMatch(/^v1:/);
      expect(decrypt(encrypted)).toBe('new-secret');
      expect(meta).toEqual({ foo: 'bar' });
    });
  });

  describe('getSafeById', () => {
    it('should return safe mapped credential for an existing id', async () => {
      mockFindById.mockResolvedValue(makeRow({ id: 'cred-safe' }));

      const result = await providerCredentialService.getSafeById('cred-safe');

      expect(result).toEqual(
        expect.objectContaining({
          id: 'cred-safe',
          providerId: 'anthropic',
          authTypeId: 'anthropic:api-key',
          authType: 'api_key',
          label: 'My key',
          hasSecret: true,
          updatedAt: '2026-01-01T00:00:00Z',
        })
      );
    });

    it('should return null for an unknown id', async () => {
      mockFindById.mockResolvedValue(null);

      const result = await providerCredentialService.getSafeById('missing');

      expect(result).toBeNull();
    });
  });

  describe('refresh token encryption (security)', () => {
    it('save peels refresh_token out of plaintext metadata into the encrypted bundle', async () => {
      mockCreateCredential.mockImplementation((input: Record<string, unknown>) => makeRow(input));

      await providerCredentialService.save({
        providerId: 'codex',
        authTypeId: 'codex:codex-subscription',
        authType: 'oauth',
        secret: 'access-token',
        metadata: { refresh_token: 'rt-secret', account_id: 'acct-1' },
      });

      const arg = mockCreateCredential.mock.calls[0][0];
      // Plaintext metadata must not carry the refresh token.
      expect(arg.metadataJson).toEqual({ account_id: 'acct-1' });
      expect(JSON.stringify(arg.metadataJson)).not.toContain('rt-secret');
      // Bundle is encrypted and decrypts back to the refresh token.
      expect(arg.encryptedBundle).toMatch(/^v1:/);
      expect(JSON.parse(decrypt(arg.encryptedBundle))).toEqual({ refresh_token: 'rt-secret' });
    });

    it('save without a refresh_token writes no bundle', async () => {
      mockCreateCredential.mockImplementation((input: Record<string, unknown>) => makeRow(input));

      await providerCredentialService.save({
        providerId: 'anthropic',
        authTypeId: 'anthropic:api-key',
        authType: 'api_key',
        secret: 'sk',
        metadata: { foo: 'bar' },
      });

      const arg = mockCreateCredential.mock.calls[0][0];
      expect(arg.encryptedBundle).toBeUndefined();
      expect(arg.metadataJson).toEqual({ foo: 'bar' });
    });

    it('updateSecret peels refresh_token into the encrypted bundle (4th arg) and strips it from metadata', async () => {
      mockUpdateTokens.mockResolvedValue(undefined);

      await providerCredentialService.updateSecret('cred-1', 'new-access', {
        expires: 123,
        refresh_token: 'rt-new',
      });

      const [id, encSecret, meta, encBundle] = mockUpdateTokens.mock.calls[0];
      expect(id).toBe('cred-1');
      expect(decrypt(encSecret)).toBe('new-access');
      expect(meta).toEqual({ expires: 123 });
      expect(JSON.parse(decrypt(encBundle))).toEqual({ refresh_token: 'rt-new' });
    });

    it('getFullCredentialById re-injects the decrypted refresh token from the bundle', async () => {
      mockFindById.mockResolvedValue(
        makeRow({
          encryptedSecret: encrypt('access-token'),
          encryptedBundle: encrypt(JSON.stringify({ refresh_token: 'rt-from-bundle' })),
          metadataJson: { account_id: 'acct-1' },
        })
      );

      const full = await providerCredentialService.getFullCredentialById('cred-1');

      expect(full!.encryptedSecret).toBe('access-token');
      expect(full!.metadataJson).toEqual({ account_id: 'acct-1', refresh_token: 'rt-from-bundle' });
    });

    it('getFullCredentialById falls back to a legacy plaintext refresh_token', async () => {
      mockFindById.mockResolvedValue(
        makeRow({
          encryptedSecret: encrypt('access-token'),
          encryptedBundle: null,
          metadataJson: { refresh_token: 'rt-legacy', account_id: 'a' },
        })
      );

      const full = await providerCredentialService.getFullCredentialById('cred-1');

      expect(full!.metadataJson).toEqual({ refresh_token: 'rt-legacy', account_id: 'a' });
    });

    it('readRefreshToken prefers the bundle over a legacy plaintext value', () => {
      const rt = providerCredentialService.readRefreshToken({
        encryptedBundle: encrypt(JSON.stringify({ refresh_token: 'rt-bundle' })),
        metadataJson: { refresh_token: 'rt-plaintext' },
      });
      expect(rt).toBe('rt-bundle');
    });

    it('readRefreshToken returns null when none is stored', () => {
      expect(
        providerCredentialService.readRefreshToken({ encryptedBundle: null, metadataJson: {} })
      ).toBeNull();
    });

    it('exportById includes the decrypted refresh token so import round-trips', async () => {
      mockFindById.mockResolvedValue(
        makeRow({
          encryptedSecret: encrypt('access-token'),
          encryptedBundle: encrypt(JSON.stringify({ refresh_token: 'rt-export' })),
          metadataJson: { account_id: 'acct-1' },
        })
      );

      const exported = await providerCredentialService.exportById('cred-1');

      expect(exported!.secret).toBe('access-token');
      expect(exported!.metadata).toEqual({ account_id: 'acct-1', refresh_token: 'rt-export' });
    });

    it('edit peels a refresh_token in the metadata patch into the bundle', async () => {
      mockPatch.mockResolvedValue(makeRow());

      await providerCredentialService.edit('cred-1', {
        metadata: { refresh_token: 'rt-edit', account_id: 'a' },
      });

      const dbPatch = mockPatch.mock.calls[0][1];
      expect(dbPatch.metadataJson).toEqual({ account_id: 'a' });
      expect(JSON.parse(decrypt(dbPatch.encryptedBundle))).toEqual({ refresh_token: 'rt-edit' });
    });
  });
});
