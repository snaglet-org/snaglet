import request from 'supertest';
import express from 'express';

const mockListAll = jest.fn();
const mockListByAgent = jest.fn();
const mockListMessages = jest.fn();
const mockHasOlderMessages = jest.fn();
const mockDeleteNodeOfType = jest.fn();
const mockFindById = jest.fn();
const mockFindAgentById = jest.fn();
const mockAddThreadParticipant = jest.fn();
const mockCreateThread = jest.fn();
const mockGetThreadEffectiveModel = jest.fn();
const mockListThreadParticipants = jest.fn();
const mockRemoveThreadParticipant = jest.fn();
const mockUpdateThreadParticipantModel = jest.fn();
const mockUpdateThreadTitle = jest.fn();
const fakePurgeTx = { query: jest.fn() };
const mockWithThreadExecutionPurge = jest.fn(
  async (_threadIds: Iterable<string>, operation: (purge: unknown) => Promise<unknown>) => ({
    deletedActivity: 0,
    deletedRuns: 0,
    value: await operation({ tx: fakePurgeTx, deletedActivity: 0, deletedRuns: 0 }),
  })
);

jest.mock('@snaglet/db/tables/threads', () => ({
  Threads: {
    list: mockListAll,
    listByAgent: mockListByAgent,
    findById: mockFindById,
    create: mockCreateThread,
    getEffectiveModel: mockGetThreadEffectiveModel,
    updateTitle: mockUpdateThreadTitle,
  },
}));

jest.mock('@snaglet/db/tables/messages', () => ({
  Messages: {
    listForThreadRead: mockListMessages,
    hasOlderThan: mockHasOlderMessages,
  },
}));

jest.mock('@snaglet/db/tables/nodes', () => ({
  Nodes: {
    deleteOfType: mockDeleteNodeOfType,
  },
}));

jest.mock('@snaglet/db/tables/agents', () => ({
  Agents: {
    findById: mockFindAgentById,
  },
}));

jest.mock('@snaglet/db/tables/thread_participants', () => ({
  ThreadParticipants: {
    listByThread: mockListThreadParticipants,
    addParticipant: mockAddThreadParticipant,
    removeParticipant: mockRemoveThreadParticipant,
    updateModel: mockUpdateThreadParticipantModel,
    addUserParticipant: jest.fn(),
    hasPrincipal: jest.fn(),
    markRead: jest.fn(),
    listInboxByPrincipal: jest.fn(),
  },
}));

jest.mock('@snaglet/db/tables/memories', () => ({
  Memories: {
    softDeleteByThread: jest.fn(),
  },
}));

jest.mock('@server/services/ThreadExecutionPurgeService', () => ({
  withThreadExecutionPurge: (...args: unknown[]) => mockWithThreadExecutionPurge(...args),
}));

import threadsRouter from '@server/domains/threads/threads.routes';
import { errorHandler } from '@server/middleware/errorHandler';
import { ErrorCode } from '@snaglet/shared/types';
import { AppError, ConflictError } from '@snaglet/shared/utils';
import { HOME_THREAD_DELETE_MESSAGE } from '@server/services/homeThreadGuard';

function makeThread(overrides: Record<string, unknown> = {}) {
  return {
    id: 't1',
    agent_id: 'a1',
    title: 'Chat with Venus',
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
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

describe('Threads Routes', () => {
  let app: express.Application;

  beforeAll(() => {
    app = express();
    app.use(express.json());
    app.use('/api/threads', threadsRouter);
    app.use(errorHandler);
  });

  beforeEach(() => jest.clearAllMocks());

  describe('GET /api/threads', () => {
    it('should list all threads when no agentId query', async () => {
      mockListAll.mockResolvedValue([makeThread()]);

      const res = await request(app).get('/api/threads');

      expect(res.status).toBe(200);
      expect(res.body.data).toHaveLength(1);
      expect(mockListAll).toHaveBeenCalledTimes(1);
      expect(mockListByAgent).not.toHaveBeenCalled();
    });

    it('should list threads by agent when agentId provided', async () => {
      mockListByAgent.mockResolvedValue([makeThread()]);

      const res = await request(app).get('/api/threads?agentId=a1');

      expect(res.status).toBe(200);
      expect(mockListByAgent).toHaveBeenCalledWith('a1');
      expect(mockListAll).not.toHaveBeenCalled();
    });
  });

  describe('GET /api/threads/:id/messages', () => {
    it('should return messages for an existing thread', async () => {
      mockFindById.mockResolvedValue(makeThread());
      mockListMessages.mockResolvedValue([
        {
          id: 'm1',
          thread_id: 't1',
          role: 'user',
          content: 'hello',
          created_at: '2026-01-01T00:00:00Z',
        },
      ]);
      mockHasOlderMessages.mockResolvedValue(false);

      const res = await request(app).get('/api/threads/t1/messages');

      expect(res.status).toBe(200);
      expect(res.body.data.messages).toHaveLength(1);
      expect(mockListMessages).toHaveBeenCalledWith('t1', { limit: 50 });
    });

    it('should return 404 when thread not found', async () => {
      mockFindById.mockResolvedValue(null);

      const res = await request(app).get('/api/threads/missing/messages');

      expect(res.status).toBe(404);
      expect(res.body.success).toBe(false);
    });
  });

  describe('DELETE /api/threads/:id', () => {
    it('should delete a non-default thread', async () => {
      mockFindById.mockResolvedValue(makeThread({ id: 'thread-2' }));
      mockFindAgentById.mockResolvedValue(makeAgent());
      mockDeleteNodeOfType.mockResolvedValue(undefined);

      const res = await request(app).delete('/api/threads/thread-2');

      expect(res.status).toBe(200);
      expect(res.body.data).toBeNull();
      expect(mockWithThreadExecutionPurge).toHaveBeenCalledWith(['thread-2'], expect.any(Function));
      expect(mockDeleteNodeOfType).toHaveBeenCalledWith('thread-2', 'thread', fakePurgeTx);
    });

    it('should delete a former default thread through the nodes spine', async () => {
      mockFindById.mockResolvedValue(makeThread({ id: 'default-a1' }));
      mockFindAgentById.mockResolvedValue(makeAgent({ default_thread_id: 'default-a1' }));
      mockDeleteNodeOfType.mockResolvedValue(undefined);

      const res = await request(app).delete('/api/threads/default-a1');

      expect(res.status).toBe(200);
      expect(res.body.data).toBeNull();
      expect(mockDeleteNodeOfType).toHaveBeenCalledWith('default-a1', 'thread', fakePurgeTx);
    });

    it('returns conflict without deleting when execution purge cannot reserve the thread', async () => {
      mockFindById.mockResolvedValue(makeThread({ id: 'thread-active' }));
      mockWithThreadExecutionPurge.mockRejectedValueOnce(
        new ConflictError('Thread thread-active has an active run')
      );

      const res = await request(app).delete('/api/threads/thread-active');

      expect(res.status).toBe(409);
      expect(mockDeleteNodeOfType).not.toHaveBeenCalled();
    });

    it('answers 403 with the Clear hint when the purge refuses a home thread', async () => {
      mockFindById.mockResolvedValue(makeThread({ id: 'thread-home', kind: 'dm' }));
      mockWithThreadExecutionPurge.mockRejectedValueOnce(
        new AppError(HOME_THREAD_DELETE_MESSAGE, ErrorCode.FORBIDDEN, 403, true, {
          threadIds: ['thread-home'],
        })
      );

      const res = await request(app).delete('/api/threads/thread-home');

      expect(res.status).toBe(403);
      expect(res.body).toEqual({
        success: false,
        error: {
          code: 'FORBIDDEN',
          message: "The home thread can't be deleted. Use Clear to remove its messages.",
          details: { threadIds: ['thread-home'] },
        },
      });
      expect(mockDeleteNodeOfType).not.toHaveBeenCalled();
    });
  });

  describe('POST /api/threads/:id/participants', () => {
    it('should add non-owner participants to former default threads', async () => {
      mockFindById.mockResolvedValue(makeThread({ id: 'default-a1', agent_id: 'a1' }));
      mockFindAgentById.mockResolvedValue(makeAgent({ id: 'a2', default_thread_id: 'default-a2' }));
      mockAddThreadParticipant.mockResolvedValue({
        thread_id: 'default-a1',
        agent_id: 'a2',
        role: 'participant',
      });

      const res = await request(app)
        .post('/api/threads/default-a1/participants')
        .send({ agentId: 'a2' });

      expect(res.status).toBe(201);
      expect(res.body.success).toBe(true);
      expect(mockAddThreadParticipant).toHaveBeenCalledWith(
        expect.objectContaining({
          threadId: 'default-a1',
          agentId: 'a2',
        })
      );
    });

    it('should add participant to non-default threads', async () => {
      mockFindById.mockResolvedValue(makeThread({ id: 'thread-2', agent_id: 'a1' }));
      mockFindAgentById
        .mockResolvedValueOnce(makeAgent({ id: 'a1', default_thread_id: 'default-a1' }))
        .mockResolvedValueOnce(makeAgent({ id: 'a2', default_thread_id: 'default-a2' }));
      mockAddThreadParticipant.mockResolvedValue({
        thread_id: 'thread-2',
        agent_id: 'a2',
        role: 'participant',
      });

      const res = await request(app)
        .post('/api/threads/thread-2/participants')
        .send({ agentId: 'a2' });

      expect(res.status).toBe(201);
      expect(res.body.success).toBe(true);
      expect(mockAddThreadParticipant).toHaveBeenCalledWith(
        expect.objectContaining({
          threadId: 'thread-2',
          agentId: 'a2',
        })
      );
    });
  });
});
