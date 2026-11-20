import request from 'supertest';
import express from 'express';

// Shape thrown by the routes under test — read by the test error handler below.
interface TestAppError {
  httpStatus?: number;
  statusCode?: number;
  code?: string;
  message?: string;
}

const mockList = jest.fn();
const mockGet = jest.fn();
const mockCreate = jest.fn();
const mockUpdate = jest.fn();
const mockDelete = jest.fn();
const mockCredGetSafeById = jest.fn();

jest.mock('../../../../../apps/server/src/services/AgentService', () => ({
  agentService: {
    list: (...args: unknown[]) => mockList(...args),
    get: (...args: unknown[]) => mockGet(...args),
    create: (...args: unknown[]) => mockCreate(...args),
    update: (...args: unknown[]) => mockUpdate(...args),
    delete: (...args: unknown[]) => mockDelete(...args),
    purge: (...args: unknown[]) => mockDelete(...args),
  },
}));

// The routes derive an agent's provider from its credential row — mock the
// credential service so those lookups never touch the DB. The real (light,
// side-effect-free) normalization module is left unmocked on purpose: the
// alias/lowercase behavior is part of what the tests verify.
jest.mock('../../../../../apps/server/src/services/ProviderCredentialService', () => ({
  providerCredentialService: {
    getSafeById: (...args: unknown[]) => mockCredGetSafeById(...args),
  },
}));

// Mock @snaglet/db to avoid import.meta.url issues
jest.mock('../../../../../packages/db/index.ts', () => ({
  getPool: jest.fn(),
  // Tests mock the engine-agnostic getDb() facade.
  getDb: jest.fn(),
}));

// Roster invalidation is emitted by agentService (mocked here), so the routes
// themselves must not emit — a second emit would double every refetch.
const mockEmitAgentCreated = jest.fn();
const mockEmitAgentDeleted = jest.fn();
const mockEmitAgentUpdated = jest.fn();
jest.mock('../../../../../apps/server/src/realtime/surfaces/agents', () => ({
  emitAgentCreated: (...args: unknown[]) => mockEmitAgentCreated(...args),
  emitAgentDeleted: (...args: unknown[]) => mockEmitAgentDeleted(...args),
  emitAgentUpdated: (...args: unknown[]) => mockEmitAgentUpdated(...args),
}));

import agentsRouter from '@server/domains/agents/agents.routes';

function makeAgent(overrides: Record<string, unknown> = {}) {
  return {
    id: 'a1',
    name: 'Venus',
    role: 'CTO',
    provider: 'anthropic',
    model: 'claude-sonnet-4-5',
    systemPrompt: 'You are Venus.',
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

describe('Agents Routes', () => {
  let app: express.Application;

  beforeAll(() => {
    app = express();
    app.use(express.json());
    app.use('/api/agents', agentsRouter);
    // Simple error handler for AppError
    app.use(
      (
        err: TestAppError,
        _req: express.Request,
        res: express.Response,
        _next: express.NextFunction
      ) => {
        res.status(err.statusCode || 500).json({ error: { code: err.code, message: err.message } });
      }
    );
  });

  beforeEach(() => jest.clearAllMocks());

  describe('GET /api/agents', () => {
    it('should return list of agents', async () => {
      mockList.mockResolvedValue([makeAgent(), makeAgent({ id: 'a2', name: 'Clio' })]);

      const res = await request(app).get('/api/agents');

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data).toHaveLength(2);
    });
  });

  describe('GET /api/agents/:id', () => {
    it('should return agent when found', async () => {
      mockGet.mockResolvedValue(makeAgent());

      const res = await request(app).get('/api/agents/a1');

      expect(res.status).toBe(200);
      expect(res.body.data.name).toBe('Venus');
    });

    it('should return 404 when not found', async () => {
      mockGet.mockResolvedValue(undefined);

      const res = await request(app).get('/api/agents/missing');

      expect(res.status).toBe(404);
    });
  });

  describe('POST /api/agents', () => {
    it('should create agent with valid body', async () => {
      const newAgent = makeAgent({ id: 'new' });
      mockCreate.mockResolvedValue(newAgent);

      const res = await request(app).post('/api/agents').send({
        name: 'Venus',
        model: 'claude-sonnet-4-5',
        provider: 'anthropic',
        systemPrompt: 'You are Venus.',
      });

      expect(res.status).toBe(201);
      expect(res.body.success).toBe(true);
      expect(mockCreate).toHaveBeenCalledTimes(1);
      expect(mockEmitAgentCreated).not.toHaveBeenCalled();
    });

    it('should return 400 when required fields missing', async () => {
      const res = await request(app).post('/api/agents').send({});

      expect(res.status).toBe(400);
      expect(mockEmitAgentCreated).not.toHaveBeenCalled();
    });

    it('defaults the strict-advertisement flag to false on create, like its siblings', async () => {
      mockCreate.mockResolvedValue(makeAgent({ id: 'new' }));

      const res = await request(app).post('/api/agents').send({ name: 'Nova' });

      expect(res.status).toBe(201);
      expect(mockCreate).toHaveBeenCalledWith(
        expect.objectContaining({ toolAccessMode: null, toolAccessAdvertiseAllowedOnly: false })
      );
    });

    it('forwards voice to agentService.create and returns it', async () => {
      mockCreate.mockResolvedValue(makeAgent({ id: 'new', voice: 'en_US-amy-medium' }));

      const res = await request(app)
        .post('/api/agents')
        .send({ name: 'Nova', voice: 'en_US-amy-medium' });

      expect(res.status).toBe(201);
      expect(mockCreate).toHaveBeenCalledWith(
        expect.objectContaining({ voice: 'en_US-amy-medium' })
      );
      expect(res.body.data.voice).toBe('en_US-amy-medium');
    });

    it('derives provider from the credential when none is sent', async () => {
      mockCredGetSafeById.mockResolvedValue({ id: 'cred-1', providerId: 'ollama' });
      mockCreate.mockResolvedValue(makeAgent({ id: 'new', provider: 'ollama' }));

      const res = await request(app)
        .post('/api/agents')
        .send({ name: 'Qwen', credentialId: 'cred-1', modelId: 'qwen3:4b' });

      expect(res.status).toBe(201);
      expect(mockCredGetSafeById).toHaveBeenCalledWith('cred-1');
      expect(mockCreate).toHaveBeenCalledWith(
        expect.objectContaining({ provider: 'ollama', credentialId: 'cred-1', modelId: 'qwen3:4b' })
      );
    });

    it('accepts an explicit provider that matches the credential (normalized)', async () => {
      mockCredGetSafeById.mockResolvedValue({ id: 'cred-1', providerId: 'ollama' });
      mockCreate.mockResolvedValue(makeAgent({ id: 'new', provider: 'ollama' }));

      const res = await request(app)
        .post('/api/agents')
        .send({ name: 'Qwen', credentialId: 'cred-1', modelId: 'qwen3:4b', provider: ' Ollama ' });

      expect(res.status).toBe(201);
      expect(mockCreate).toHaveBeenCalledWith(expect.objectContaining({ provider: 'ollama' }));
    });

    it('rejects an explicit provider that mismatches the credential with 400', async () => {
      mockCredGetSafeById.mockResolvedValue({ id: 'cred-1', providerId: 'ollama' });

      const res = await request(app)
        .post('/api/agents')
        .send({ name: 'Qwen', credentialId: 'cred-1', modelId: 'qwen3:4b', provider: 'openai' });

      expect(res.status).toBe(400);
      expect(res.body.error.message).toContain('does not match credential');
      expect(mockCreate).not.toHaveBeenCalled();
    });

    it('rejects an unknown credentialId with 400', async () => {
      mockCredGetSafeById.mockResolvedValue(null);

      const res = await request(app)
        .post('/api/agents')
        .send({ name: 'Qwen', credentialId: 'nope', modelId: 'qwen3:4b' });

      expect(res.status).toBe(400);
      expect(res.body.error.message).toContain("'nope' not found");
      expect(mockCreate).not.toHaveBeenCalled();
    });

    it('still creates without a credential — empty provider preserved', async () => {
      mockCreate.mockResolvedValue(makeAgent({ id: 'new' }));

      const res = await request(app).post('/api/agents').send({ name: 'Bare' });

      expect(res.status).toBe(201);
      expect(mockCredGetSafeById).not.toHaveBeenCalled();
      expect(mockCreate).toHaveBeenCalledWith(expect.objectContaining({ provider: '' }));
    });

    it('accepts an explicit provider without a credential (normalized pass-through)', async () => {
      mockCreate.mockResolvedValue(makeAgent({ id: 'new', provider: 'anthropic' }));

      const res = await request(app)
        .post('/api/agents')
        .send({ name: 'Sol', provider: 'Anthropic', modelId: 'claude-sonnet-4-5' });

      expect(res.status).toBe(201);
      expect(mockCredGetSafeById).not.toHaveBeenCalled();
      expect(mockCreate).toHaveBeenCalledWith(expect.objectContaining({ provider: 'anthropic' }));
    });
  });

  describe('PATCH /api/agents/:id', () => {
    it('should update agent', async () => {
      mockUpdate.mockResolvedValue(makeAgent({ name: 'Updated' }));

      const res = await request(app).patch('/api/agents/a1').send({ name: 'Updated' });

      expect(res.status).toBe(200);
      expect(res.body.data.name).toBe('Updated');
      expect(mockEmitAgentUpdated).not.toHaveBeenCalled();
    });

    it('should return 404 when agent not found', async () => {
      mockUpdate.mockResolvedValue(null);

      const res = await request(app).patch('/api/agents/missing').send({ name: 'X' });

      expect(res.status).toBe(404);
    });

    it('updates voice and returns the updated value', async () => {
      mockUpdate.mockResolvedValue(makeAgent({ voice: 'en_GB-alan-medium' }));

      const res = await request(app).patch('/api/agents/a1').send({ voice: 'en_GB-alan-medium' });

      expect(res.status).toBe(200);
      expect(mockUpdate).toHaveBeenCalledWith(
        'a1',
        expect.objectContaining({ voice: 'en_GB-alan-medium' })
      );
      expect(res.body.data.voice).toBe('en_GB-alan-medium');
    });

    it('passes the strict-advertisement flag through like its tool-access siblings', async () => {
      mockUpdate.mockResolvedValue(makeAgent({ toolAccessAdvertiseAllowedOnly: true }));

      const res = await request(app)
        .patch('/api/agents/a1')
        .send({ toolAccessAdvertiseAllowedOnly: true });

      expect(res.status).toBe(200);
      expect(mockUpdate).toHaveBeenCalledWith(
        'a1',
        expect.objectContaining({ toolAccessAdvertiseAllowedOnly: true })
      );
      expect(res.body.data.toolAccessAdvertiseAllowedOnly).toBe(true);
    });

    it('derives provider when a credential is assigned without provider', async () => {
      mockCredGetSafeById.mockResolvedValue({ id: 'cred-1', providerId: 'ollama' });
      mockUpdate.mockResolvedValue(makeAgent({ provider: 'ollama' }));

      const res = await request(app).patch('/api/agents/a1').send({ credentialId: 'cred-1' });

      expect(res.status).toBe(200);
      expect(mockUpdate).toHaveBeenCalledWith(
        'a1',
        expect.objectContaining({ credentialId: 'cred-1', provider: 'ollama' })
      );
    });

    it('rejects a credential/provider mismatch with 400 and never writes', async () => {
      mockCredGetSafeById.mockResolvedValue({ id: 'cred-1', providerId: 'ollama' });

      const res = await request(app)
        .patch('/api/agents/a1')
        .send({ credentialId: 'cred-1', provider: 'openai' });

      expect(res.status).toBe(400);
      expect(mockUpdate).not.toHaveBeenCalled();
    });

    it('leaves provider alone when the PATCH carries no credentialId', async () => {
      mockUpdate.mockResolvedValue(makeAgent({ role: 'Ops' }));

      const res = await request(app).patch('/api/agents/a1').send({ role: 'Ops' });

      expect(res.status).toBe(200);
      expect(mockCredGetSafeById).not.toHaveBeenCalled();
      expect(mockUpdate).toHaveBeenCalledWith(
        'a1',
        expect.not.objectContaining({ provider: expect.anything() })
      );
    });
  });

  describe('DELETE /api/agents/:id', () => {
    it('should purge the agent (ghost delete)', async () => {
      // DELETE routes through agentService.purge: memories/summaries/facts
      // destroyed, kept references repointed to ghost, agent row deleted for real.
      mockDelete.mockResolvedValue({ originalName: 'Bill', repointedMessages: 3 });

      const res = await request(app).delete('/api/agents/a1');

      expect(res.status).toBe(200);
      expect(res.body.data).toBeNull();
      expect(mockEmitAgentDeleted).not.toHaveBeenCalled();
    });

    it('should return 404 when agent not found (or already deleted)', async () => {
      mockDelete.mockResolvedValue(null);

      const res = await request(app).delete('/api/agents/missing');

      expect(res.status).toBe(404);
    });

    it('rejects deleting ghost with 403 (route-layer guard, never calls purge)', async () => {
      const res = await request(app).delete('/api/agents/ghost');

      expect(res.status).toBe(403);
      expect(mockDelete).not.toHaveBeenCalled();
    });
  });

  describe('PATCH /api/agents/:id — trustedToolCalls', () => {
    beforeEach(() => {
      mockGet.mockResolvedValue(makeAgent({ id: 'a1' }));
      mockUpdate.mockResolvedValue(makeAgent({ id: 'a1', trustedToolCalls: true }));
    });

    it('forwards a boolean flag to agentService.update', async () => {
      const res = await request(app).patch('/api/agents/a1').send({ trustedToolCalls: true });

      expect(res.status).toBe(200);
      expect(mockUpdate).toHaveBeenCalledWith(
        'a1',
        expect.objectContaining({ trustedToolCalls: true })
      );
      expect(res.body.data.trustedToolCalls).toBe(true);
    });

    it.each([['yes'], [1], [null], [{}]])(
      'rejects a non-boolean flag (%p) with 400 instead of coercing it',
      async (value) => {
        const res = await request(app).patch('/api/agents/a1').send({ trustedToolCalls: value });

        expect(res.status).toBe(400);
        expect(res.body.error.message).toContain('trustedToolCalls must be a boolean');
        expect(mockUpdate).not.toHaveBeenCalled();
      }
    );
  });

  describe('PATCH /api/agents/:id — dmEnabled', () => {
    beforeEach(() => {
      mockGet.mockResolvedValue(makeAgent({ id: 'a1' }));
      mockUpdate.mockResolvedValue(makeAgent({ id: 'a1', dmEnabled: false }));
    });

    it('forwards a boolean to agentService.update', async () => {
      const res = await request(app).patch('/api/agents/a1').send({ dmEnabled: false });

      expect(res.status).toBe(200);
      expect(mockUpdate).toHaveBeenCalledWith('a1', expect.objectContaining({ dmEnabled: false }));
    });

    it.each([['no'], [0], [null], [{}]])('rejects a non-boolean (%p) with 400', async (value) => {
      const res = await request(app).patch('/api/agents/a1').send({ dmEnabled: value });

      expect(res.status).toBe(400);
      expect(res.body.error.message).toContain('dmEnabled must be a boolean');
      expect(mockUpdate).not.toHaveBeenCalled();
    });
  });
});
