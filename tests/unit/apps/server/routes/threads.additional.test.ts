import express from 'express';
import request from 'supertest';

const mockListAll = jest.fn();
const mockListByAgent = jest.fn();
const mockListMessages = jest.fn();
const mockCreateThread = jest.fn();
const mockDeleteThread = jest.fn();
const mockDeleteNodeOfType = jest.fn();
const mockFindThreadById = jest.fn();
const mockFindAgentById = jest.fn();
const mockGetThreadEffectiveModel = jest.fn();
const mockAddThreadParticipant = jest.fn();
const mockAddUserParticipant = jest.fn();
const mockListThreadParticipants = jest.fn();
const mockRemoveThreadParticipant = jest.fn();
const mockUpdateThreadParticipantModel = jest.fn();
const mockUpdateThreadSettings = jest.fn();
const mockUpdateThreadParticipantOverrides = jest.fn();
const mockEmitModelChangedEvent = jest.fn();
const mockEmitDispatchModeChangedEvent = jest.fn();
const mockEmitMaxWavesChangedEvent = jest.fn();
const mockEmitConversationBudgetChangedEvent = jest.fn();
const mockEmitRunTimeLimitChangedEvent = jest.fn();

jest.mock('@snaglet/db/tables/threads', () => ({
  Threads: {
    list: (...args: unknown[]) => mockListAll(...args),
    listByAgent: (...args: unknown[]) => mockListByAgent(...args),
    findById: (...args: unknown[]) => mockFindThreadById(...args),
    create: (...args: unknown[]) => mockCreateThread(...args),
    delete: (...args: unknown[]) => mockDeleteThread(...args),
    getEffectiveModel: (...args: unknown[]) => mockGetThreadEffectiveModel(...args),
    updateSettings: (...args: unknown[]) => mockUpdateThreadSettings(...args),
  },
}));

jest.mock('@snaglet/db/tables/messages', () => ({
  Messages: {
    listForThreadRead: (...args: unknown[]) => mockListMessages(...args),
    hasOlderThan: jest.fn().mockResolvedValue(false),
  },
}));

jest.mock('@snaglet/db/tables/nodes', () => ({
  Nodes: {
    deleteOfType: (...args: unknown[]) => mockDeleteNodeOfType(...args),
  },
}));

jest.mock('@snaglet/db/tables/agents', () => ({
  Agents: {
    findById: (...args: unknown[]) => mockFindAgentById(...args),
  },
}));

jest.mock('@snaglet/db/tables/thread_participants', () => ({
  ThreadParticipants: {
    listByThread: (...args: unknown[]) => mockListThreadParticipants(...args),
    addParticipant: (...args: unknown[]) => mockAddThreadParticipant(...args),
    addUserParticipant: (...args: unknown[]) => mockAddUserParticipant(...args),
    // Removal resolves the participant row first, then deletes by its own PK.
    removeById: (...args: unknown[]) => mockRemoveThreadParticipant(...args),
    updateModel: (...args: unknown[]) => mockUpdateThreadParticipantModel(...args),
    updateOverrides: (...args: unknown[]) => mockUpdateThreadParticipantOverrides(...args),
    hasPrincipal: jest.fn(),
    markRead: jest.fn(),
    listInboxByPrincipal: jest.fn(),
  },
}));

jest.mock('@snaglet/db/tables/agent_activity_log', () => ({
  AgentActivityLog: {
    logActivity: jest.fn(async () => undefined),
  },
}));

jest.mock('@server/services/SocketService/threadEvents', () => ({
  emitParticipantAddedEvent: jest.fn(),
  emitParticipantRemovedEvent: jest.fn(),
  emitModelChangedEvent: (...args: unknown[]) => mockEmitModelChangedEvent(...args),
  emitDispatchModeChangedEvent: (...args: unknown[]) => mockEmitDispatchModeChangedEvent(...args),
  emitMaxWavesChangedEvent: (...args: unknown[]) => mockEmitMaxWavesChangedEvent(...args),
  emitConversationBudgetChangedEvent: (...args: unknown[]) =>
    mockEmitConversationBudgetChangedEvent(...args),
  emitRunTimeLimitChangedEvent: (...args: unknown[]) => mockEmitRunTimeLimitChangedEvent(...args),
}));

jest.mock('@snaglet/db/tables/memories', () => ({
  Memories: {
    softDeleteByThread: jest.fn(),
  },
}));

const mockHooksEmit = jest.fn();
const mockEmitTreeNodeUpdated = jest.fn();
const mockEmitThreadUpdated = jest.fn();
jest.mock('@server/services/HookService', () => ({
  ...jest.requireActual<object>('@server/services/HookService'),
  hooks: { emit: (...args: unknown[]) => mockHooksEmit(...args) },
}));
jest.mock('@server/realtime/surfaces/tree', () => ({
  ...jest.requireActual<object>('@server/realtime/surfaces/tree'),
  emitTreeNodeUpdated: (...args: unknown[]) => mockEmitTreeNodeUpdated(...args),
}));
jest.mock('@server/realtime/surfaces/threads', () => ({
  ...jest.requireActual<object>('@server/realtime/surfaces/threads'),
  emitThreadUpdated: (...args: unknown[]) => mockEmitThreadUpdated(...args),
}));

import threadsRouter from '@server/domains/threads/threads.routes';
import { errorHandler } from '@server/middleware/errorHandler';

function makeThread(overrides: Record<string, unknown> = {}) {
  return {
    id: 'thread-1',
    agent_id: 'a1',
    title: 'Thread',
    ...overrides,
  };
}

function makeAgent(overrides: Record<string, unknown> = {}) {
  return {
    id: 'a1',
    name: 'Venus',
    default_thread_id: 'default-a1',
    ...overrides,
  };
}

describe('Threads Routes (additional coverage)', () => {
  let app: express.Application;

  beforeAll(() => {
    app = express();
    app.use(express.json());
    app.use('/api/threads', threadsRouter);
    app.use(errorHandler);
  });

  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('POST /api/threads', () => {
    it('creates a loose thread when agentId is missing', async () => {
      mockCreateThread.mockResolvedValue(makeThread({ title: 'x' }));

      const res = await request(app).post('/api/threads').send({ title: 'x' });

      expect(res.status).toBe(201);
      expect(mockCreateThread).toHaveBeenCalledWith(
        expect.objectContaining({
          title: 'x',
          projectId: null,
        }),
        expect.anything()
      );
      expect(mockFindAgentById).not.toHaveBeenCalled();
      expect(mockAddThreadParticipant).not.toHaveBeenCalled();
    });

    it('returns 404 when agent does not exist', async () => {
      mockFindAgentById.mockResolvedValue(null);

      const res = await request(app).post('/api/threads').send({ agentId: 'missing' });

      expect(res.status).toBe(404);
      expect(res.body.error.message).toContain('Agent not found');
      expect(mockCreateThread).not.toHaveBeenCalled();
    });

    it('creates thread and defaults title to agent name', async () => {
      mockFindAgentById.mockResolvedValue(makeAgent({ id: 'a1', name: 'Default Name' }));
      mockCreateThread.mockResolvedValue(makeThread({ title: 'Default Name' }));

      const res = await request(app).post('/api/threads').send({ agentId: 'a1' });

      expect(res.status).toBe(201);
      expect(mockCreateThread).toHaveBeenCalledWith(
        expect.objectContaining({
          title: 'Default Name',
          id: expect.stringMatching(/^thread-\d+-[a-z0-9]+$/),
          projectId: null,
        }),
        expect.anything()
      );
      expect(mockAddThreadParticipant).toHaveBeenCalledWith(
        {
          threadId: expect.stringMatching(/^thread-\d+-[a-z0-9]+$/),
          agentId: 'a1',
        },
        expect.anything()
      );
      // The thread and its participant are written on one transaction.
      expect(mockAddThreadParticipant.mock.calls[0][1]).toBe(mockCreateThread.mock.calls[0][1]);
    });

    it('scopes the thread to project_id', async () => {
      mockCreateThread.mockResolvedValue(makeThread({ projectId: 'container-project' }));

      const res = await request(app)
        .post('/api/threads')
        .send({ title: 'x', project_id: 'container-project' });

      expect(res.status).toBe(201);
      expect(mockCreateThread).toHaveBeenCalledWith(
        expect.objectContaining({ title: 'x', projectId: 'container-project' }),
        expect.anything()
      );
    });

    it('refuses a folder placement and names project_id instead', async () => {
      const res = await request(app)
        .post('/api/threads')
        .send({ title: 'x', container_id: 'container-1' });

      expect(res.status).toBe(400);
      expect(res.body.error.message).toMatch(/container_id/);
      expect(res.body.error.message).toMatch(/project_id/);
      expect(mockCreateThread).not.toHaveBeenCalled();
    });

    it.each([['sort_order'], ['sortOrder']])(
      'refuses %s: a new thread always starts at the top of its list',
      async (key) => {
        const res = await request(app)
          .post('/api/threads')
          .send({ title: 'x', [key]: 2 });

        expect(res.status).toBe(400);
        expect(res.body.error.message).toContain(key);
        expect(res.body.error.message).toMatch(/top of that list/);
        expect(mockCreateThread).not.toHaveBeenCalled();
      }
    );
  });

  describe('GET /api/threads/:id/model', () => {
    it('returns 404 when effective model is missing', async () => {
      mockGetThreadEffectiveModel.mockResolvedValue(null);

      const res = await request(app).get('/api/threads/thread-1/model?agentId=a1');

      expect(res.status).toBe(404);
      expect(res.body.error.message).toContain('Thread not found or no model configured');
    });

    it('returns effective model and forwards optional agentId', async () => {
      mockGetThreadEffectiveModel.mockResolvedValue({
        provider_id: 'openai',
        model_id: 'gpt-5',
      });

      const res = await request(app).get('/api/threads/thread-1/model?agentId=a2');

      expect(res.status).toBe(200);
      expect(res.body.data.model_id).toBe('gpt-5');
      expect(mockGetThreadEffectiveModel).toHaveBeenCalledWith('thread-1', 'a2');
    });
  });

  describe('GET /api/threads/:id/participants', () => {
    it('returns 404 when thread does not exist', async () => {
      mockFindThreadById.mockResolvedValue(null);

      const res = await request(app).get('/api/threads/thread-1/participants');

      expect(res.status).toBe(404);
      expect(mockListThreadParticipants).not.toHaveBeenCalled();
    });

    it('returns participants for existing thread', async () => {
      mockFindThreadById.mockResolvedValue(makeThread());
      mockListThreadParticipants.mockResolvedValue([{ thread_id: 'thread-1', agent_id: 'a2' }]);

      const res = await request(app).get('/api/threads/thread-1/participants');

      expect(res.status).toBe(200);
      expect(res.body.data).toHaveLength(1);
      expect(mockListThreadParticipants).toHaveBeenCalledWith('thread-1');
    });
  });

  describe('POST /api/threads/:id/participants', () => {
    it('returns 404 when thread does not exist', async () => {
      mockFindThreadById.mockResolvedValue(null);

      const res = await request(app)
        .post('/api/threads/missing/participants')
        .send({ agentId: 'a2' });

      expect(res.status).toBe(404);
      expect(mockAddThreadParticipant).not.toHaveBeenCalled();
    });

    it('returns 400 when agentId is missing', async () => {
      mockFindThreadById.mockResolvedValue(makeThread());
      mockFindAgentById.mockResolvedValue(makeAgent({ id: 'a1', default_thread_id: 'default-a1' }));

      const res = await request(app).post('/api/threads/thread-1/participants').send({});

      expect(res.status).toBe(400);
      expect(res.body.error.message).toContain('Exactly one of agentId or userId is required');
    });

    it('allows adding the owner to a former default thread', async () => {
      mockFindThreadById.mockResolvedValue(makeThread({ id: 'default-a1', agent_id: 'a1' }));
      mockFindAgentById.mockResolvedValue(makeAgent({ id: 'a1', default_thread_id: 'default-a1' }));
      mockAddThreadParticipant.mockResolvedValue({
        thread_id: 'default-a1',
        agent_id: 'a1',
        role: 'participant',
      });

      const res = await request(app)
        .post('/api/threads/default-a1/participants')
        .send({ agentId: 'a1' });

      expect(res.status).toBe(201);
      expect(mockAddThreadParticipant).toHaveBeenCalledWith(
        expect.objectContaining({ threadId: 'default-a1', agentId: 'a1' })
      );
    });

    it('returns 404 when participant agent does not exist', async () => {
      mockFindThreadById.mockResolvedValue(makeThread({ id: 'thread-2', agent_id: 'a1' }));
      mockFindAgentById.mockResolvedValue(null);

      const res = await request(app)
        .post('/api/threads/thread-2/participants')
        .send({ agentId: 'a9' });

      expect(res.status).toBe(404);
      expect(res.body.error.message).toContain('Agent not found');
      expect(mockAddThreadParticipant).not.toHaveBeenCalled();
    });
  });

  describe('DELETE /api/threads/:id/participants/:agentId', () => {
    it('returns 404 when participant mapping is missing', async () => {
      mockFindThreadById.mockResolvedValue(makeThread({ id: 'thread-1', agent_id: 'a1' }));
      mockFindAgentById.mockResolvedValue(makeAgent({ id: 'a1', default_thread_id: 'default-a1' }));
      mockListThreadParticipants.mockResolvedValue([
        { id: 'tp-1', thread_id: 'thread-1', agent_id: 'a1', role: 'owner' },
      ]);
      mockRemoveThreadParticipant.mockResolvedValue(false);

      const res = await request(app).delete(
        '/api/threads/thread-1/participants/a2?actorAgentId=a1'
      );

      expect(res.status).toBe(404);
    });

    it('removes existing participant', async () => {
      mockFindThreadById.mockResolvedValue(makeThread({ id: 'thread-1', agent_id: 'a1' }));
      mockFindAgentById.mockResolvedValue(makeAgent({ id: 'a1', role: 'admin' }));
      mockListThreadParticipants.mockResolvedValue([
        { id: 'tp-1', thread_id: 'thread-1', agent_id: 'a1', role: 'owner' },
        { id: 'tp-2', thread_id: 'thread-1', agent_id: 'a2', role: 'participant' },
      ]);
      mockRemoveThreadParticipant.mockResolvedValue(true);

      const res = await request(app).delete(
        '/api/threads/thread-1/participants/a2?actorAgentId=a1'
      );

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      // Removal is by the resolved participant row's own PK, not (thread, agent).
      expect(mockRemoveThreadParticipant).toHaveBeenCalledWith('tp-2');
    });
  });

  describe('PATCH /api/threads/:id/participants/:agentId/model', () => {
    it('returns 404 when thread does not exist', async () => {
      mockFindThreadById.mockResolvedValue(null);

      const res = await request(app).patch('/api/threads/missing/participants/a2/model').send({});

      expect(res.status).toBe(404);
      expect(mockUpdateThreadParticipantModel).not.toHaveBeenCalled();
    });

    it('returns 404 when participant does not exist', async () => {
      mockFindThreadById.mockResolvedValue(makeThread());
      mockUpdateThreadParticipantModel.mockResolvedValue(null);

      const res = await request(app).patch('/api/threads/thread-1/participants/a2/model').send({});

      expect(res.status).toBe(404);
    });

    it('updates participant model settings via credentialId/modelId/providerId', async () => {
      mockFindThreadById.mockResolvedValue(makeThread());
      mockGetThreadEffectiveModel
        .mockResolvedValueOnce({
          providerId: 'anthropic',
          modelId: 'claude-sonnet-4-5',
          credentialId: 'old-credential',
          source: 'thread_participant',
        })
        .mockResolvedValueOnce({
          providerId: 'openai',
          modelId: 'gpt-5',
          credentialId: 'c1',
          source: 'thread_participant',
        });
      mockUpdateThreadParticipantModel.mockResolvedValue({
        thread_id: 'thread-1',
        agent_id: 'a2',
        credential_id: 'c1',
        model_id: 'gpt-5',
        provider_id: 'openai',
      });

      const res = await request(app)
        .patch('/api/threads/thread-1/participants/a2/model')
        .send({ credentialId: 'c1', modelId: 'gpt-5', providerId: 'openai' });

      expect(res.status).toBe(200);
      expect(mockUpdateThreadParticipantModel).toHaveBeenCalledWith('thread-1', 'a2', {
        credentialId: 'c1',
        modelId: 'gpt-5',
        providerId: 'openai',
      });
      expect(mockEmitModelChangedEvent).toHaveBeenCalledWith(
        'thread-1',
        'a2',
        expect.objectContaining({ providerId: 'anthropic', modelId: 'claude-sonnet-4-5' }),
        expect.objectContaining({ providerId: 'openai', modelId: 'gpt-5' })
      );
    });

    it('does not narrate when the effective provider/model is unchanged', async () => {
      mockFindThreadById.mockResolvedValue(makeThread());
      const effectiveModel = {
        providerId: 'openai',
        modelId: 'gpt-5',
        credentialId: 'old-credential',
        source: 'thread_participant',
      };
      mockGetThreadEffectiveModel
        .mockResolvedValueOnce(effectiveModel)
        .mockResolvedValueOnce({ ...effectiveModel, credentialId: 'new-credential' });
      mockUpdateThreadParticipantModel.mockResolvedValue({
        thread_id: 'thread-1',
        agent_id: 'a2',
        credential_id: 'new-credential',
        model_id: 'gpt-5',
        provider_id: 'openai',
      });

      const res = await request(app)
        .patch('/api/threads/thread-1/participants/a2/model')
        .send({ credentialId: 'new-credential' });

      expect(res.status).toBe(200);
      expect(mockEmitModelChangedEvent).not.toHaveBeenCalled();
    });

    it('does not narrate when the participant update fails', async () => {
      mockFindThreadById.mockResolvedValue(makeThread());
      mockGetThreadEffectiveModel.mockResolvedValue({
        providerId: 'anthropic',
        modelId: 'claude-sonnet-4-5',
      });
      mockUpdateThreadParticipantModel.mockResolvedValue(null);

      const res = await request(app)
        .patch('/api/threads/thread-1/participants/a2/model')
        .send({ modelId: 'gpt-5', providerId: 'openai' });

      expect(res.status).toBe(404);
      expect(mockGetThreadEffectiveModel).toHaveBeenCalledTimes(1);
      expect(mockEmitModelChangedEvent).not.toHaveBeenCalled();
    });
  });

  describe('PATCH /api/threads/:id', () => {
    it('returns 400 when title is missing or blank', async () => {
      const res = await request(app).patch('/api/threads/thread-1').send({ title: '   ' });

      expect(res.status).toBe(400);
      expect(mockUpdateThreadSettings).not.toHaveBeenCalled();
    });

    it('returns 404 when thread is missing', async () => {
      mockUpdateThreadSettings.mockResolvedValue(null);

      const res = await request(app).patch('/api/threads/thread-1').send({ title: 'New title' });

      expect(res.status).toBe(404);
    });

    it('trims title and updates thread', async () => {
      mockUpdateThreadSettings.mockResolvedValue(makeThread({ title: 'New title' }));

      const res = await request(app)
        .patch('/api/threads/thread-1')
        .send({ title: '  New title  ' });

      expect(res.status).toBe(200);
      expect(mockUpdateThreadSettings).toHaveBeenCalledWith('thread-1', { title: 'New title' });
    });
  });

  // Settings an agent reasons over must be narrated as persisted thread_events,
  // not silently mutated underneath it.
  describe('PATCH /api/threads/:id — settings narration', () => {
    it('narrates a max-dispatch-waves change with the prior value', async () => {
      mockFindThreadById.mockResolvedValue(makeThread({ maxWaves: null }));
      mockUpdateThreadSettings.mockResolvedValue(makeThread({ maxWaves: 12 }));

      const res = await request(app).patch('/api/threads/thread-1').send({ max_waves: 12 });

      expect(res.status).toBe(200);
      expect(mockEmitMaxWavesChangedEvent).toHaveBeenCalledWith('thread-1', null, 12);
    });

    it('narrates the -1 unbounded sentinel as a real change', async () => {
      mockFindThreadById.mockResolvedValue(makeThread({ maxWaves: 12 }));
      mockUpdateThreadSettings.mockResolvedValue(makeThread({ maxWaves: -1 }));

      await request(app).patch('/api/threads/thread-1').send({ max_waves: -1 });

      expect(mockEmitMaxWavesChangedEvent).toHaveBeenCalledWith('thread-1', 12, -1);
    });

    it('narrates a conversation output-token budget change', async () => {
      mockFindThreadById.mockResolvedValue(makeThread({ maxTotalOutputTokens: null }));
      mockUpdateThreadSettings.mockResolvedValue(makeThread({ maxTotalOutputTokens: 50000 }));

      const res = await request(app)
        .patch('/api/threads/thread-1')
        .send({ max_total_output_tokens: 50000 });

      expect(res.status).toBe(200);
      expect(mockEmitConversationBudgetChangedEvent).toHaveBeenCalledWith('thread-1', null, 50000);
    });

    it('stays silent on a no-op PATCH that re-sends the stored values', async () => {
      mockFindThreadById.mockResolvedValue(
        makeThread({ maxWaves: 12, maxTotalOutputTokens: 50000, dispatchMode: 'all' })
      );
      mockUpdateThreadSettings.mockResolvedValue(
        makeThread({ maxWaves: 12, maxTotalOutputTokens: 50000, dispatchMode: 'all' })
      );

      const res = await request(app)
        .patch('/api/threads/thread-1')
        .send({ max_waves: 12, max_total_output_tokens: 50000, dispatch_mode: 'all' });

      expect(res.status).toBe(200);
      expect(mockEmitMaxWavesChangedEvent).not.toHaveBeenCalled();
      expect(mockEmitConversationBudgetChangedEvent).not.toHaveBeenCalled();
      expect(mockEmitDispatchModeChangedEvent).not.toHaveBeenCalled();
    });

    it('refuses a routing change on a DM / home thread, which has no routing', async () => {
      mockFindThreadById.mockResolvedValue(makeThread({ kind: 'dm', dispatchMode: 'mentioned' }));

      const res = await request(app).patch('/api/threads/thread-1').send({ dispatch_mode: 'all' });

      expect(res.status).toBe(400);
      expect(JSON.stringify(res.body)).toContain('a DM or home thread has no routing');
      expect(mockUpdateThreadSettings).not.toHaveBeenCalled();
      expect(mockEmitDispatchModeChangedEvent).not.toHaveBeenCalled();
    });

    it('still changes other settings on a DM / home thread', async () => {
      mockFindThreadById.mockResolvedValue(makeThread({ kind: 'dm', maxWaves: null }));
      mockUpdateThreadSettings.mockResolvedValue(makeThread({ kind: 'dm', maxWaves: 3 }));

      const res = await request(app).patch('/api/threads/thread-1').send({ max_waves: 3 });

      expect(res.status).toBe(200);
      expect(mockUpdateThreadSettings).toHaveBeenCalledWith('thread-1', { maxWaves: 3 });
    });

    it('does not narrate the unused max_agent_dispatches knob', async () => {
      // The dispatch loop does not read it, so an event would describe a
      // setting that does nothing.
      mockFindThreadById.mockResolvedValue(makeThread());
      mockUpdateThreadSettings.mockResolvedValue(makeThread());

      await request(app).patch('/api/threads/thread-1').send({ max_agent_dispatches: 4 });

      expect(mockEmitMaxWavesChangedEvent).not.toHaveBeenCalled();
      expect(mockEmitConversationBudgetChangedEvent).not.toHaveBeenCalled();
    });

    it('still returns 200 when the narration emitter throws', async () => {
      mockFindThreadById.mockResolvedValue(makeThread({ maxWaves: null }));
      mockUpdateThreadSettings.mockResolvedValue(makeThread({ maxWaves: 5 }));
      mockEmitMaxWavesChangedEvent.mockImplementation(() => {
        throw new Error('narration exploded');
      });

      const res = await request(app).patch('/api/threads/thread-1').send({ max_waves: 5 });

      expect(res.status).toBe(200);
    });
  });

  describe('PATCH /api/threads/:id/participants/:agentId/overrides — run time limit', () => {
    beforeEach(() => {
      mockFindThreadById.mockResolvedValue(makeThread());
      mockUpdateThreadParticipantOverrides.mockResolvedValue({ id: 'tp-1', agentId: 'a1' });
    });

    it('narrates a run time limit change with the prior value', async () => {
      mockListThreadParticipants.mockResolvedValue([
        { id: 'tp-1', agentId: 'a1', maxDurationSeconds: null },
      ]);

      const res = await request(app)
        .patch('/api/threads/thread-1/participants/a1/overrides')
        .send({ maxDurationSeconds: 900 });

      expect(res.status).toBe(200);
      expect(mockEmitRunTimeLimitChangedEvent).toHaveBeenCalledWith('thread-1', 'a1', null, 900);
    });

    it('narrates clearing the limit back to unlimited', async () => {
      mockListThreadParticipants.mockResolvedValue([
        { id: 'tp-1', agentId: 'a1', maxDurationSeconds: 900 },
      ]);

      await request(app)
        .patch('/api/threads/thread-1/participants/a1/overrides')
        .send({ maxDurationSeconds: null });

      expect(mockEmitRunTimeLimitChangedEvent).toHaveBeenCalledWith('thread-1', 'a1', 900, null);
    });

    it('stays silent when the limit is unchanged, or when the field is absent', async () => {
      mockListThreadParticipants.mockResolvedValue([
        { id: 'tp-1', agentId: 'a1', maxDurationSeconds: 900 },
      ]);

      await request(app)
        .patch('/api/threads/thread-1/participants/a1/overrides')
        .send({ maxDurationSeconds: 900 });
      await request(app)
        .patch('/api/threads/thread-1/participants/a1/overrides')
        .send({ maxToolCallsPerTurn: 40 });

      expect(mockEmitRunTimeLimitChangedEvent).not.toHaveBeenCalled();
    });

    it('still returns 200 when the narration emitter rejects', async () => {
      mockListThreadParticipants.mockResolvedValue([
        { id: 'tp-1', agentId: 'a1', maxDurationSeconds: null },
      ]);
      mockEmitRunTimeLimitChangedEvent.mockRejectedValue(new Error('db down'));

      const res = await request(app)
        .patch('/api/threads/thread-1/participants/a1/overrides')
        .send({ maxDurationSeconds: 60 });

      expect(res.status).toBe(200);
      expect(mockUpdateThreadParticipantOverrides).toHaveBeenCalled();
    });
  });

  // A thread is scoped by project_id (a project container, or null for flat)
  // and never placed in a folder. A project change rides the model's moveTo
  // and announces itself on the hook, tree and thread surfaces.
  describe('PATCH /api/threads/:id — project scope', () => {
    it.each([['container_id'], ['containerId']])(
      'rejects %s with a 400 that names project_id',
      async (key) => {
        const res = await request(app)
          .patch('/api/threads/thread-1')
          .send({ [key]: 'container-1', sort_order: 0 });

        expect(res.status).toBe(400);
        expect(res.body.error.message).toContain(key);
        expect(res.body.error.message).toMatch(/project_id/);
        expect(mockUpdateThreadSettings).not.toHaveBeenCalled();
      }
    );

    it('rejects a non-string project_id', async () => {
      const res = await request(app).patch('/api/threads/thread-1').send({ project_id: 7 });

      expect(res.status).toBe(400);
      expect(res.body.error.message).toMatch(/project_id/);
      expect(mockUpdateThreadSettings).not.toHaveBeenCalled();
    });

    it('moves a flat thread into a project and emits thread:move with both field pairs', async () => {
      mockFindThreadById.mockResolvedValue(makeThread({ projectId: null, sortOrder: 4 }));
      mockUpdateThreadSettings.mockResolvedValue(
        makeThread({
          projectId: 'container-project',
          sortOrder: 0,
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-02T00:00:00.000Z',
        })
      );

      const res = await request(app)
        .patch('/api/threads/thread-1')
        .send({ project_id: 'container-project' });

      expect(res.status).toBe(200);
      expect(mockUpdateThreadSettings).toHaveBeenCalledWith('thread-1', {
        projectId: 'container-project',
      });
      expect(mockHooksEmit).toHaveBeenCalledWith('thread:move', {
        id: 'thread-1',
        fromProjectId: null,
        toProjectId: 'container-project',
        fromContainerId: null,
        toContainerId: 'container-project',
      });
      // No slot sent: the model puts it at the top of the new project's list.
      expect(mockEmitTreeNodeUpdated).toHaveBeenCalledWith({
        id: 'thread-1',
        kind: 'thread',
        parentId: 'container-project',
        sortKey: '0',
        updatedAt: '2026-01-02T00:00:00.000Z',
      });
      expect(mockEmitThreadUpdated).toHaveBeenCalledWith({
        id: 'thread-1',
        projectId: 'container-project',
        updatedAt: '2026-01-02T00:00:00.000Z',
      });
    });

    it('project_id: null moves a project thread out to the flat list', async () => {
      mockFindThreadById.mockResolvedValue(makeThread({ projectId: 'container-project' }));
      mockUpdateThreadSettings.mockResolvedValue(makeThread({ projectId: null }));

      const res = await request(app).patch('/api/threads/thread-1').send({ projectId: null });

      expect(res.status).toBe(200);
      expect(mockUpdateThreadSettings).toHaveBeenCalledWith('thread-1', { projectId: null });
      expect(mockHooksEmit).toHaveBeenCalledWith(
        'thread:move',
        expect.objectContaining({ fromProjectId: 'container-project', toProjectId: null })
      );
      expect(mockEmitTreeNodeUpdated).toHaveBeenCalledWith(
        expect.objectContaining({ kind: 'thread', parentId: null })
      );
    });

    it('a move to the project the thread is already in is a no-op that emits nothing', async () => {
      mockFindThreadById.mockResolvedValue(makeThread({ projectId: 'container-project' }));
      mockUpdateThreadSettings.mockResolvedValue(makeThread({ projectId: 'container-project' }));

      const res = await request(app)
        .patch('/api/threads/thread-1')
        .send({ project_id: 'container-project' });

      expect(res.status).toBe(200);
      expect(mockUpdateThreadSettings).toHaveBeenCalledWith('thread-1', {});
      expect(mockHooksEmit).not.toHaveBeenCalledWith('thread:move', expect.anything());
      expect(mockEmitTreeNodeUpdated).not.toHaveBeenCalled();
      expect(mockEmitThreadUpdated).not.toHaveBeenCalled();
    });

    it('returns 404 for a missing thread before touching the model', async () => {
      mockFindThreadById.mockResolvedValue(null);

      const res = await request(app)
        .patch('/api/threads/missing')
        .send({ project_id: 'container-project' });

      expect(res.status).toBe(404);
      expect(mockUpdateThreadSettings).not.toHaveBeenCalled();
      expect(mockHooksEmit).not.toHaveBeenCalledWith('thread:move', expect.anything());
    });
  });

  // sort_order is the thread's slot in its project's list (0 = top). A
  // reorder is a tree-only change: it carries the new slot as sortKey so
  // other windows reload, and the thread surface hears nothing.
  describe('PATCH /api/threads/:id — manual order', () => {
    it.each([['sort_order'], ['sortOrder']])(
      'reorders within the current project with %s',
      async (key) => {
        mockUpdateThreadSettings.mockResolvedValue(
          makeThread({
            projectId: 'container-project',
            sortOrder: 2,
            createdAt: '2026-01-01T00:00:00.000Z',
            updatedAt: null,
          })
        );

        const res = await request(app)
          .patch('/api/threads/thread-1')
          .send({ [key]: 2 });

        expect(res.status).toBe(200);
        expect(mockUpdateThreadSettings).toHaveBeenCalledWith('thread-1', { sortOrder: 2 });
        expect(mockFindThreadById).not.toHaveBeenCalled();
        expect(mockEmitTreeNodeUpdated).toHaveBeenCalledWith({
          id: 'thread-1',
          kind: 'thread',
          sortKey: '2',
          updatedAt: '2026-01-01T00:00:00.000Z',
        });
        expect(mockEmitThreadUpdated).not.toHaveBeenCalled();
        expect(mockHooksEmit).not.toHaveBeenCalledWith('thread:move', expect.anything());
      }
    );

    it('moves to another project at an explicit slot', async () => {
      mockFindThreadById.mockResolvedValue(makeThread({ projectId: null, sortOrder: 0 }));
      mockUpdateThreadSettings.mockResolvedValue(
        makeThread({
          projectId: 'container-project',
          sortOrder: 3,
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-02T00:00:00.000Z',
        })
      );

      const res = await request(app)
        .patch('/api/threads/thread-1')
        .send({ project_id: 'container-project', sort_order: 3 });

      expect(res.status).toBe(200);
      expect(mockUpdateThreadSettings).toHaveBeenCalledWith('thread-1', {
        projectId: 'container-project',
        sortOrder: 3,
      });
      expect(mockEmitTreeNodeUpdated).toHaveBeenCalledWith({
        id: 'thread-1',
        kind: 'thread',
        parentId: 'container-project',
        sortKey: '3',
        updatedAt: '2026-01-02T00:00:00.000Z',
      });
      expect(mockEmitThreadUpdated).toHaveBeenCalledWith({
        id: 'thread-1',
        projectId: 'container-project',
        updatedAt: '2026-01-02T00:00:00.000Z',
      });
      expect(mockHooksEmit).toHaveBeenCalledWith(
        'thread:move',
        expect.objectContaining({ fromProjectId: null, toProjectId: 'container-project' })
      );
    });

    it('re-sending the current project with a slot is a reorder there', async () => {
      mockFindThreadById.mockResolvedValue(makeThread({ projectId: 'container-project' }));
      mockUpdateThreadSettings.mockResolvedValue(
        makeThread({ projectId: 'container-project', sortOrder: 1 })
      );

      const res = await request(app)
        .patch('/api/threads/thread-1')
        .send({ project_id: 'container-project', sort_order: 1 });

      expect(res.status).toBe(200);
      expect(mockUpdateThreadSettings).toHaveBeenCalledWith('thread-1', { sortOrder: 1 });
      expect(mockEmitTreeNodeUpdated).toHaveBeenCalledWith(
        expect.objectContaining({ sortKey: '1' })
      );
      expect(mockEmitTreeNodeUpdated.mock.calls[0]?.[0]).not.toHaveProperty('parentId');
      expect(mockHooksEmit).not.toHaveBeenCalledWith('thread:move', expect.anything());
    });

    it.each([[-1], [1.5], ['3'], [null], [Number.MAX_SAFE_INTEGER + 1]])(
      'rejects sort_order %p with a 400',
      async (value) => {
        const res = await request(app).patch('/api/threads/thread-1').send({ sort_order: value });

        expect(res.status).toBe(400);
        expect(res.body.error.message).toMatch(/sort_order must be a non-negative integer/);
        expect(mockUpdateThreadSettings).not.toHaveBeenCalled();
      }
    );

    it('returns 404 when the model finds no thread to reorder', async () => {
      mockUpdateThreadSettings.mockResolvedValue(null);

      const res = await request(app).patch('/api/threads/missing').send({ sort_order: 0 });

      expect(res.status).toBe(404);
      expect(mockEmitTreeNodeUpdated).not.toHaveBeenCalled();
    });
  });

  describe('DELETE /api/threads/:id', () => {
    it('returns 404 when thread is missing', async () => {
      mockFindThreadById.mockResolvedValue(null);

      const res = await request(app).delete('/api/threads/missing');

      expect(res.status).toBe(404);
      expect(mockDeleteThread).not.toHaveBeenCalled();
    });
  });
});
