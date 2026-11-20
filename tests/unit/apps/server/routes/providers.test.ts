import request from 'supertest';
import express from 'express';
import { UserProviderCredentials } from '@snaglet/db/tables/user_provider_credentials';

const codexToken = [
  Buffer.from(JSON.stringify({ alg: 'RS256' })).toString('base64url'),
  Buffer.from(JSON.stringify({ exp: 1 })).toString('base64url'),
  'invalid-signature',
].join('.');

// Shape thrown by the routes under test — read by the test error handler below.
interface TestAppError {
  httpStatus?: number;
  statusCode?: number;
  code?: string;
  message?: string;
}

const mockProviderList = jest.fn();
const mockProviderGet = jest.fn();
const mockCredListSafe = jest.fn();
const mockCredSave = jest.fn();
const mockCredRemove = jest.fn();
const mockCredEdit = jest.fn();
const mockReadCodexCliAuth = jest.fn();
const mockProvisionProfiles = jest.fn();
const mockCredGetSafeById = jest.fn();
const mockSyncProfilesForCredentialModels = jest.fn();
const mockCredGetFullById = jest.fn();
const mockVerify = jest.fn();
const mockProviderSetEnabled = jest.fn();
const mockProviderFindById = jest.fn();
const mockSyncFromProvider = jest.fn().mockResolvedValue(undefined);
// Default resolves so unrelated credential-create tests don't trip the
// fire-and-forget `.then` chain. clearAllMocks keeps this implementation.
const mockPersistDiscoveredModels = jest
  .fn()
  .mockResolvedValue({ providerId: 'x', discovered: 0, imported: 0, backfilled: 0 });

jest.mock('@server/services/ProviderChatService/providers/codexCliAuth', () => ({
  readCodexCliAuth: (...args: unknown[]) => mockReadCodexCliAuth(...args),
}));

const mockReadUsableClaudeCliAuth = jest.fn();
const mockSyncClaudeCode = jest.fn();
const mockLoginStart = jest.fn();
const mockLoginStatus = jest.fn();
const mockLoginCancel = jest.fn();
jest.mock('@server/services/ClaudeCodeAuthService', () => ({
  readUsableClaudeCliAuth: (...args: unknown[]) => mockReadUsableClaudeCliAuth(...args),
  syncClaudeCodeCredential: (...args: unknown[]) => mockSyncClaudeCode(...args),
  claudeCodeLoginService: {
    start: (...args: unknown[]) => mockLoginStart(...args),
    status: (...args: unknown[]) => mockLoginStatus(...args),
    cancel: (...args: unknown[]) => mockLoginCancel(...args),
  },
}));

const mockDeleteRepointing = jest.fn();
jest.mock('@server/services/ProviderCredentialService/credentialPins', () => {
  const actual = jest.requireActual('@server/services/ProviderCredentialService/credentialPins');
  return {
    describePinChanges: actual.describePinChanges,
    deleteCredentialRepointingPins: (...args: unknown[]) => mockDeleteRepointing(...args),
  };
});

jest.mock('@server/services/ProviderModelDiscoveryService/persistence', () => ({
  persistDiscoveredModels: (...args: unknown[]) => mockPersistDiscoveredModels(...args),
}));

const mockSuggestConnectedModel = jest.fn();
jest.mock('@server/services/agentDefaultModel', () => ({
  suggestConnectedModel: (...args: unknown[]) => mockSuggestConnectedModel(...args),
}));

jest.mock('@server/services/ProviderService/index.js', () => ({
  providerService: {
    list: (...args: unknown[]) => mockProviderList(...args),
    get: (...args: unknown[]) => mockProviderGet(...args),
    setEnabled: (...args: unknown[]) => mockProviderSetEnabled(...args),
  },
}));

jest.mock('@snaglet/db/tables/providers', () => ({
  Providers: { findById: (...args: unknown[]) => mockProviderFindById(...args) },
}));

jest.mock('@server/services/McpService', () => ({
  mcpService: { syncFromProvider: (...args: unknown[]) => mockSyncFromProvider(...args) },
}));

jest.mock('@server/services/ProviderCredentialService/index.js', () => ({
  providerCredentialService: {
    listSafe: (...args: unknown[]) => mockCredListSafe(...args),
    save: (...args: unknown[]) => mockCredSave(...args),
    edit: (...args: unknown[]) => mockCredEdit(...args),
    remove: (...args: unknown[]) => mockCredRemove(...args),
    provisionProfilesForCredential: (...args: unknown[]) => mockProvisionProfiles(...args),
    getSafeById: (...args: unknown[]) => mockCredGetSafeById(...args),
    syncProfilesForCredentialModels: (...args: unknown[]) =>
      mockSyncProfilesForCredentialModels(...args),
    getFullCredentialById: (...args: unknown[]) => mockCredGetFullById(...args),
  },
}));

jest.mock('@server/services/ProviderChatService/index.js', () => ({
  providerChatService: {
    verify: (...args: unknown[]) => mockVerify(...args),
  },
}));

jest.mock('@snaglet/db/tables/user_provider_credentials', () => ({
  UserProviderCredentials: {
    findById: jest.fn().mockResolvedValue(null),
    updateVerificationStatus: jest.fn(),
  },
}));

jest.mock('@snaglet/db/tables/provider_fallback_credentials', () => ({
  ProviderFallbackCredentials: {
    listByProviderId: jest.fn().mockResolvedValue([]),
    addFallback: jest.fn(),
    removeFallback: jest.fn(),
  },
}));

import providersRouter from '@server/routes/providers';

describe('Providers Routes', () => {
  let app: express.Application;

  beforeAll(() => {
    app = express();
    app.use(express.json());
    app.use('/api/providers', providersRouter);
    app.use(
      (
        err: TestAppError,
        _req: express.Request,
        res: express.Response,
        _next: express.NextFunction
      ) => {
        res
          .status(err.statusCode || err.httpStatus || 500)
          .json({ error: { code: err.code, message: err.message } });
      }
    );
  });

  beforeEach(() => {
    jest.clearAllMocks();
    mockProviderGet.mockImplementation(async (id: string) => ({
      id,
      authTypes: [
        { id: `${id}:api-key`, type: 'api_key' },
        { id: `${id}:none`, type: 'none' },
        ...(id === 'codex' ? [{ id: 'codex:codex-subscription', type: 'oauth' }] : []),
      ],
    }));
  });

  describe('GET /api/providers', () => {
    it('should list providers', async () => {
      mockProviderList.mockResolvedValue([{ id: 'anthropic', name: 'Anthropic' }]);

      const res = await request(app).get('/api/providers');

      expect(res.status).toBe(200);
      expect(res.body.data).toHaveLength(1);
    });
  });

  describe('GET /api/providers/default-model', () => {
    it('returns the model an agent with none would take now', async () => {
      const suggestion = {
        providerId: 'anthropic',
        modelId: 'claude-sonnet-4-5',
        displayName: 'Claude Sonnet 4.5',
      };
      mockSuggestConnectedModel.mockResolvedValue(suggestion);

      const res = await request(app).get('/api/providers/default-model');

      expect(res.status).toBe(200);
      expect(res.body.data).toEqual(suggestion);
      // Not read as a provider id.
      expect(mockProviderGet).not.toHaveBeenCalled();
    });

    it('returns null when nothing usable is connected', async () => {
      mockSuggestConnectedModel.mockResolvedValue(null);

      const res = await request(app).get('/api/providers/default-model');

      expect(res.status).toBe(200);
      expect(res.body.data).toBeNull();
    });
  });

  describe('PATCH /api/providers/:id/enabled', () => {
    it('updates an integration and reconciles its MCP connection', async () => {
      mockProviderFindById.mockResolvedValue({ id: 'notion', type: 'integration' });
      mockProviderSetEnabled.mockResolvedValue({
        id: 'notion',
        type: 'integration',
        enabled: false,
      });

      const res = await request(app)
        .patch('/api/providers/notion/enabled')
        .send({ enabled: false });

      expect(res.status).toBe(200);
      expect(res.body.data.enabled).toBe(false);
      expect(mockProviderSetEnabled).toHaveBeenCalledWith('notion', false);
      expect(mockSyncFromProvider).toHaveBeenCalledWith('notion');
    });

    it('rejects enablement changes for model providers', async () => {
      mockProviderFindById.mockResolvedValue({ id: 'openai', type: 'llm' });

      const res = await request(app)
        .patch('/api/providers/openai/enabled')
        .send({ enabled: false });

      expect(res.status).toBe(400);
      expect(mockProviderSetEnabled).not.toHaveBeenCalled();
    });
  });

  describe('GET /api/providers/credentials', () => {
    it('should list safe credentials', async () => {
      mockCredListSafe.mockResolvedValue([{ id: 'c1', providerId: 'anthropic', hasSecret: true }]);

      const res = await request(app).get('/api/providers/credentials');

      expect(res.status).toBe(200);
      expect(res.body.data[0].hasSecret).toBe(true);
    });
  });

  describe('POST /api/providers/credentials', () => {
    it('should create credential with valid body', async () => {
      mockVerify.mockResolvedValue({ valid: true, message: 'Connected successfully' });
      mockCredSave.mockResolvedValue({ id: 'new', providerId: 'openai', hasSecret: true });

      const res = await request(app).post('/api/providers/credentials').send({
        providerId: 'openai',
        authTypeId: 'openai:api-key',
        authType: 'api_key',
        secret: 'sk-test',
      });

      expect(res.status).toBe(201);
      expect(mockVerify).not.toHaveBeenCalled();
      expect(res.body.data.verificationStatus).toBe('untested');
      expect(UserProviderCredentials.updateVerificationStatus).not.toHaveBeenCalled();
      expect(mockCredSave).toHaveBeenCalledTimes(1);
    });

    it('should return 400 when required fields missing', async () => {
      const res = await request(app).post('/api/providers/credentials').send({
        providerId: 'openai',
      });

      expect(res.status).toBe(400);
    });

    it('should validate Codex subscription requires metadata', async () => {
      const res = await request(app).post('/api/providers/credentials').send({
        providerId: 'codex',
        authTypeId: 'codex:codex-subscription',
        authType: 'oauth',
        secret: codexToken,
        metadata: {},
      });

      expect(res.status).toBe(400);
      expect(res.body.error.message).toContain('refresh_token');
    });

    it('should accept Codex subscription with full metadata', async () => {
      mockVerify.mockResolvedValue({ valid: true, message: 'Connected successfully' });
      mockCredSave.mockResolvedValue({ id: 'new', providerId: 'codex', hasSecret: true });
      mockProvisionProfiles.mockResolvedValue(5);

      const res = await request(app)
        .post('/api/providers/credentials')
        .send({
          providerId: 'codex',
          authTypeId: 'codex:codex-subscription',
          authType: 'oauth',
          secret: codexToken,
          metadata: { refresh_token: 'rt', account_id: 'acct-123' },
        });

      expect(res.status).toBe(201);
      expect(mockVerify).not.toHaveBeenCalled();
      expect(res.body.data.verificationStatus).toBe('untested');
    });

    it('saves format-valid input even when live verification would fail', async () => {
      mockVerify.mockResolvedValue({ valid: false, message: 'Authentication failed' });
      mockCredSave.mockResolvedValue({ id: 'new', providerId: 'openai', hasSecret: true });
      const res = await request(app).post('/api/providers/credentials').send({
        providerId: 'openai',
        authTypeId: 'openai:api-key',
        authType: 'api_key',
        secret: 'sk-invalid-but-formatted',
      });
      expect(res.status).toBe(201);
      expect(mockVerify).not.toHaveBeenCalled();
      expect(res.body.data.verificationStatus).toBe('untested');
    });

    it.each([
      { secret: {} },
      { secret: '   ' },
      { metadata: [] },
      { authTypeId: 'another:api-key' },
      { authType: 'oauth' },
    ])('rejects malformed input %j without any authentication request', async (patch) => {
      const res = await request(app)
        .post('/api/providers/credentials')
        .send({
          providerId: 'openai',
          authTypeId: 'openai:api-key',
          authType: 'api_key',
          secret: 'sk-format',
          ...patch,
        });
      expect(res.status).toBe(400);
      expect(mockCredSave).not.toHaveBeenCalled();
      expect(mockVerify).not.toHaveBeenCalled();
    });

    it('rejects malformed Codex JWTs while allowing expired or invalid signatures', async () => {
      const res = await request(app)
        .post('/api/providers/credentials')
        .send({
          providerId: 'codex',
          authTypeId: 'codex:codex-subscription',
          authType: 'oauth',
          secret: 'not-a-jwt',
          metadata: { refresh_token: 'rt', account_id: 'acct-123' },
        });
      expect(res.status).toBe(400);
      expect(mockCredSave).not.toHaveBeenCalled();
      expect(mockVerify).not.toHaveBeenCalled();
    });

    it('kicks a model-catalog discovery sync for LLM providers', async () => {
      mockVerify.mockResolvedValue({ valid: true, message: 'Connected successfully' });
      mockCredSave.mockResolvedValue({ id: 'new', providerId: 'ollama', hasSecret: true });
      mockProviderFindById.mockResolvedValue({ id: 'ollama', type: 'llm' });
      mockPersistDiscoveredModels.mockResolvedValueOnce({
        providerId: 'ollama',
        discovered: 3,
        imported: 3,
        backfilled: 0,
      });

      const res = await request(app).post('/api/providers/credentials').send({
        providerId: 'ollama',
        authTypeId: 'ollama:none',
        authType: 'none',
        secret: 'local',
      });

      expect(res.status).toBe(201);
      expect(mockPersistDiscoveredModels).toHaveBeenCalledWith('ollama');
      // LLM providers go to catalog sync, not MCP.
      expect(mockSyncFromProvider).not.toHaveBeenCalled();
    });

    it('does not run model discovery for integration providers', async () => {
      mockVerify.mockResolvedValue({ valid: true, message: 'Connected successfully' });
      mockCredSave.mockResolvedValue({ id: 'new', providerId: 'notion', hasSecret: true });
      mockProviderFindById.mockResolvedValue({ id: 'notion', type: 'integration' });

      const res = await request(app).post('/api/providers/credentials').send({
        providerId: 'notion',
        authTypeId: 'notion:api-key',
        authType: 'api_key',
        secret: 'secret_x',
      });

      expect(res.status).toBe(201);
      expect(mockPersistDiscoveredModels).not.toHaveBeenCalled();
      expect(mockSyncFromProvider).toHaveBeenCalledWith('notion');
    });

    it('still returns 201 when the catalog sync fails (best-effort)', async () => {
      mockVerify.mockResolvedValue({ valid: true, message: 'Connected successfully' });
      mockCredSave.mockResolvedValue({ id: 'new', providerId: 'ollama', hasSecret: true });
      mockProviderFindById.mockResolvedValue({ id: 'ollama', type: 'llm' });
      mockPersistDiscoveredModels.mockRejectedValueOnce(new Error('ollama daemon offline'));

      const res = await request(app).post('/api/providers/credentials').send({
        providerId: 'ollama',
        authTypeId: 'ollama:none',
        authType: 'none',
        secret: 'local',
      });

      expect(res.status).toBe(201);
      expect(mockPersistDiscoveredModels).toHaveBeenCalledWith('ollama');
      // Let the fire-and-forget rejection settle inside its .catch — an
      // unhandled rejection here would fail the test run.
      await new Promise((resolve) => setImmediate(resolve));
    });
  });

  describe('POST /api/providers/credentials/import-cli', () => {
    it('imports an expired but well-formed CLI token without a remote test', async () => {
      mockReadCodexCliAuth.mockResolvedValue({
        accessToken: codexToken,
        refreshToken: 'refresh',
        accountId: 'account',
      });
      mockCredListSafe.mockResolvedValue([]);
      mockCredSave.mockResolvedValue({ id: 'imported', providerId: 'codex', hasSecret: true });
      const res = await request(app)
        .post('/api/providers/credentials/import-cli')
        .send({ providerId: 'codex' });
      expect(res.status).toBe(201);
      expect(res.body.data.verificationStatus).toBe('untested');
      expect(mockVerify).not.toHaveBeenCalled();
      expect(UserProviderCredentials.updateVerificationStatus).toHaveBeenCalledWith(
        'imported',
        'untested'
      );
    });

    it('clears the old verification result when replacing a saved CLI token', async () => {
      mockReadCodexCliAuth.mockResolvedValue({
        accessToken: codexToken,
        refreshToken: 'refresh',
        accountId: 'account',
      });
      mockCredListSafe.mockResolvedValue([
        { id: 'existing', providerId: 'codex', authTypeId: 'codex:codex-subscription' },
      ]);
      mockCredEdit.mockResolvedValue({
        id: 'existing',
        providerId: 'codex',
        verificationStatus: 'ok',
      });
      const res = await request(app)
        .post('/api/providers/credentials/import-cli')
        .send({ providerId: 'codex' });
      expect(res.status).toBe(201);
      expect(res.body.data.verificationStatus).toBe('untested');
      expect(mockCredSave).not.toHaveBeenCalled();
      expect(mockVerify).not.toHaveBeenCalled();
      expect(UserProviderCredentials.updateVerificationStatus).toHaveBeenCalledWith(
        'existing',
        'untested'
      );
    });
  });

  describe('POST /api/providers/credentials/import-cli (anthropic)', () => {
    it('mirrors the Claude Code keychain login through the shared sync, untested', async () => {
      mockSyncClaudeCode.mockResolvedValue({
        credential: { id: 'claude', providerId: 'anthropic', verificationStatus: 'untested' },
        verification: 'untested',
        message: 'Imported',
      });
      const res = await request(app)
        .post('/api/providers/credentials/import-cli')
        .send({ providerId: 'anthropic' });
      expect(res.status).toBe(201);
      expect(res.body.data.id).toBe('claude');
      expect(mockSyncClaudeCode).toHaveBeenCalledWith({ verify: false });
      expect(mockVerify).not.toHaveBeenCalled();
      expect(mockPersistDiscoveredModels).toHaveBeenCalledWith('anthropic');
    });

    it('surfaces a 404 when there is no Claude Code login', async () => {
      mockSyncClaudeCode.mockRejectedValue(
        Object.assign(new Error('No Claude Code login found in the macOS keychain'), {
          statusCode: 404,
          code: 'NOT_FOUND',
        })
      );
      const res = await request(app)
        .post('/api/providers/credentials/import-cli')
        .send({ providerId: 'anthropic' });
      expect(res.status).toBe(404);
      expect(res.body.error.message).toContain('No Claude Code login');
    });
  });

  describe('Claude Code sign-in', () => {
    it('registers a session and returns it as 202 without doing keychain or network work inline', async () => {
      mockLoginStart.mockReturnValue({ id: 's1', state: 'checking' });
      const res = await request(app).post('/api/providers/anthropic/claude-code/login');
      expect(res.status).toBe(202);
      expect(res.body.data).toEqual({ id: 's1', state: 'checking' });
      expect(mockLoginStart).toHaveBeenCalledTimes(1);
      expect(mockReadUsableClaudeCliAuth).not.toHaveBeenCalled();
      expect(mockSyncClaudeCode).not.toHaveBeenCalled();
      expect(mockVerify).not.toHaveBeenCalled();
    });

    it('returns the running session for a second start', async () => {
      mockLoginStart.mockReturnValue({ id: 's1', state: 'waiting' });
      const first = await request(app).post('/api/providers/anthropic/claude-code/login');
      const second = await request(app).post('/api/providers/anthropic/claude-code/login');
      expect(first.body.data.id).toBe('s1');
      expect(second.body.data.id).toBe('s1');
    });

    it('polls and cancels sessions by id, 404 for unknown ids, catalog sync on connected', async () => {
      mockLoginStatus.mockReturnValueOnce({ id: 's1', state: 'connected', credentialId: 'claude' });
      const ok = await request(app).get('/api/providers/anthropic/claude-code/login/s1');
      expect(ok.status).toBe(200);
      expect(ok.body.data.state).toBe('connected');
      expect(JSON.stringify(ok.body)).not.toContain('sk-ant-');
      expect(mockPersistDiscoveredModels).toHaveBeenCalledWith('anthropic');

      mockLoginStatus.mockReturnValueOnce(null);
      const missing = await request(app).get('/api/providers/anthropic/claude-code/login/nope');
      expect(missing.status).toBe(404);

      mockLoginCancel.mockReturnValueOnce({ id: 's1', state: 'cancelled' });
      const canceled = await request(app).delete('/api/providers/anthropic/claude-code/login/s1');
      expect(canceled.status).toBe(200);
      expect(canceled.body.data.state).toBe('cancelled');
      mockLoginCancel.mockReturnValueOnce(null);
      expect(
        (await request(app).delete('/api/providers/anthropic/claude-code/login/nope')).status
      ).toBe(404);
    });
  });

  describe('DELETE /api/providers/credentials/:id', () => {
    const repointed = {
      fromCredentialIds: ['c1'],
      toCredential: { id: 'c2', label: 'Test key B' },
      providerPrimary: true,
      agentIds: ['test-agent-a'],
      threadParticipantThreadIds: [],
      summaryOverrideAgentIds: ['test-agent-a'],
      threadSummaryOverrides: [],
    };

    it('deletes through the pin-moving path and says what moved', async () => {
      mockDeleteRepointing.mockResolvedValue({
        deleted: { id: 'c1', providerId: 'anthropic', label: 'Test key A' },
        repointed,
      });

      const res = await request(app).delete('/api/providers/credentials/c1');

      expect(res.status).toBe(200);
      expect(mockDeleteRepointing).toHaveBeenCalledWith('c1');
      expect(mockCredRemove).not.toHaveBeenCalled();
      expect(res.body.data).toEqual({
        deleted: { id: 'c1', providerId: 'anthropic', label: 'Test key A' },
        repointed,
        message: 'Moved the provider primary, 1 agent, 1 summary model to "Test key B".',
      });
      expect(mockSyncFromProvider).toHaveBeenCalledWith('anthropic');
    });

    it('should return 404 when not found', async () => {
      mockDeleteRepointing.mockResolvedValue(null);

      const res = await request(app).delete('/api/providers/credentials/missing');

      expect(res.status).toBe(404);
    });
  });

  describe('POST /api/providers/credentials/:id/test', () => {
    it('should retest a saved credential', async () => {
      mockCredGetFullById.mockResolvedValue({
        id: 'c1',
        providerId: 'codex',
        authType: 'oauth',
        encryptedSecret: 'access-token',
        metadataJson: { refresh_token: 'rt', account_id: 'acct-123' },
      });
      mockVerify.mockResolvedValue({ valid: true, message: 'Connected successfully' });

      const res = await request(app).post('/api/providers/credentials/c1/test').send({});

      expect(res.status).toBe(200);
      expect(mockVerify).toHaveBeenCalledWith('codex', 'access-token', {
        authType: 'oauth',
        metadata: { refresh_token: 'rt', account_id: 'acct-123' },
        credentialId: 'c1',
      });
      expect(res.body.data.valid).toBe(true);
      // A key that works refreshes the provider's catalog.
      expect(mockPersistDiscoveredModels).toHaveBeenCalledWith('codex');
    });

    it('leaves the catalog alone when the retest fails', async () => {
      mockCredGetFullById.mockResolvedValue({
        id: 'c1',
        providerId: 'anthropic',
        authType: 'api_key',
        encryptedSecret: 'sk-ant-bad',
        metadataJson: {},
      });
      mockVerify.mockResolvedValue({ valid: false, message: 'invalid x-api-key' });

      const res = await request(app).post('/api/providers/credentials/c1/test').send({});

      expect(res.status).toBe(200);
      expect(mockPersistDiscoveredModels).not.toHaveBeenCalled();
    });

    it('should return 404 when saved credential is missing', async () => {
      mockCredGetFullById.mockResolvedValue(null);

      const res = await request(app).post('/api/providers/credentials/missing/test').send({});

      expect(res.status).toBe(404);
    });
  });

  describe('POST /api/providers/verify', () => {
    it.each(['ollama', 'lm-studio'])('verifies %s without a secret', async (providerId) => {
      mockVerify.mockResolvedValue({ valid: true, message: 'Connected' });
      for (const payload of [{ providerId }, { providerId, secret: '' }]) {
        const res = await request(app).post('/api/providers/verify').send(payload);
        expect(res.status).toBe(200);
        expect(mockVerify).toHaveBeenCalledWith(providerId, '', {
          authType: undefined,
          metadata: undefined,
        });
      }
    });

    it.each([
      { providerId: 'anthropic' },
      { providerId: 'openai', secret: '' },
      { providerId: 'ollama', secret: 123 },
      { providerId: 'lm-studio', authType: {} },
      { providerId: {}, secret: 'test' },
    ])('rejects missing cloud credentials or malformed input: %j', async (payload) => {
      const res = await request(app).post('/api/providers/verify').send(payload);
      expect(res.status).toBe(400);
      expect(mockVerify).not.toHaveBeenCalled();
    });

    it('should verify credential', async () => {
      mockVerify.mockResolvedValue({ valid: true, message: 'OK' });

      const res = await request(app).post('/api/providers/verify').send({
        providerId: 'anthropic',
        secret: 'sk-ant-test',
      });

      expect(res.status).toBe(200);
      expect(res.body.data.valid).toBe(true);
    });

    it('should return 400 when fields missing', async () => {
      const res = await request(app).post('/api/providers/verify').send({});

      expect(res.status).toBe(400);
    });
  });

  describe('GET /api/providers/:id', () => {
    it('should return provider by id', async () => {
      mockProviderGet.mockResolvedValue({ id: 'anthropic', name: 'Anthropic', authTypes: [] });

      const res = await request(app).get('/api/providers/anthropic');

      expect(res.status).toBe(200);
      expect(res.body.data.id).toBe('anthropic');
    });

    it('should return 404 when not found', async () => {
      mockProviderGet.mockResolvedValue(null);

      const res = await request(app).get('/api/providers/unknown');

      expect(res.status).toBe(404);
    });
  });
});
