import { beforeEach, describe, expect, jest, test } from '@jest/globals';
import express from 'express';
import request from 'supertest';
import { AppError } from '@snaglet/shared/utils';
import { ErrorCode } from '@snaglet/shared/types';

const agentsFindById = jest.fn();
jest.mock('@snaglet/db/tables/agents', () => ({ Agents: { findById: agentsFindById } }));
const findByAgent = jest.fn();
const findByUser = jest.fn();
jest.mock('@snaglet/db/tables/members', () => ({ Members: { findByAgent, findByUser } }));
const threadsFindById = jest.fn();
jest.mock('@snaglet/db/tables/threads', () => ({ Threads: { findById: threadsFindById } }));
const getActiveUser = jest.fn();
const getOrCreateLocalUser = jest.fn();
jest.mock('@snaglet/db/tables/users', () => ({ Users: { getActiveUser, getOrCreateLocalUser } }));

const listThreadsForMember = jest.fn();
const findOrCreate = jest.fn();
const markRead = jest.fn();
jest.mock('@server/services/dm/DmService', () => ({
  DmService: { listThreadsForMember, findOrCreate, markRead },
}));

// The aggregate router pulls every thread handler module; stub the ones that
// would reach the database or sockets at import time, and give the `/:id`
// catch-all a sentinel so route order is observable.
jest.mock('@server/domains/threads/handlers/threadCrud', () => ({
  registerThreadCrudRoutes: (router: express.Router) => {
    router.get('/:id', (req, res) => res.json({ crudThreadId: req.params.id }));
  },
}));
for (const [mod, fn] of [
  ['messageHandlers', 'registerMessageRoutes'],
  ['participantHandlers', 'registerParticipantRoutes'],
  ['subagentHandlers', 'registerSubagentRoutes'],
  ['summaryHandlers', 'registerSummaryRoutes'],
  ['trimHandlers', 'registerTrimRoutes'],
  ['threadWorkingDirectory', 'registerThreadWorkingDirectoryRoutes'],
] as const) {
  jest.mock(`@server/domains/threads/handlers/${mod}`, () => ({ [fn]: () => undefined }));
}

import { errorHandler } from '@server/middleware';
import router from '@server/domains/threads/threads.routes';

function app() {
  const application = express();
  application.use(express.json());
  application.use('/api/threads', router);
  application.use(errorHandler);
  return application;
}

const user = { id: 'user-1' };
const userMember = { id: 'member-user' };
const agentMember = { id: 'member-agent-a' };
const summary = {
  id: 'thread-dm-1',
  title: 'Test Agent A ↔ Test User',
  withName: 'Test Agent A',
  withKind: 'agent',
  withAgentId: 'test-agent-a',
  unread: 2,
  lastMessageAt: '2026-01-01T00:00:00.000Z',
};

beforeEach(() => {
  jest.resetAllMocks();
  getActiveUser.mockResolvedValue(user);
  findByUser.mockResolvedValue(userMember);
  findByAgent.mockResolvedValue(agentMember);
  agentsFindById.mockResolvedValue({ id: 'test-agent-a' });
  listThreadsForMember.mockResolvedValue([summary]);
});

describe('GET /api/threads/dm', () => {
  test('is matched before /:id, so "dm" is not a thread id', async () => {
    const response = await request(app()).get('/api/threads/dm');
    expect(response.status).toBe(200);
    expect(response.body).not.toHaveProperty('crudThreadId');
    expect((await request(app()).get('/api/threads/thread-1')).body).toEqual({
      crudThreadId: 'thread-1',
    });
  });

  test("without agentId lists the local user's DM threads", async () => {
    const response = await request(app()).get('/api/threads/dm');
    expect(response.body.data).toEqual({ threads: [summary] });
    expect(findByUser).toHaveBeenCalledWith('user-1');
    expect(listThreadsForMember).toHaveBeenCalledWith('member-user');
  });

  test("with agentId lists that agent's DM threads", async () => {
    const response = await request(app()).get('/api/threads/dm?agentId=test-agent-a');
    expect(response.body.data).toEqual({ threads: [summary] });
    expect(listThreadsForMember).toHaveBeenCalledWith('member-agent-a');
  });

  test('unknown agent is 404', async () => {
    agentsFindById.mockResolvedValue(null);
    const response = await request(app()).get('/api/threads/dm?agentId=missing');
    expect(response.status).toBe(404);
    expect(listThreadsForMember).not.toHaveBeenCalled();
  });
});

describe('POST /api/threads/dm', () => {
  test('finds or creates the user-to-agent thread without posting a message', async () => {
    findOrCreate.mockResolvedValue({ id: 'thread-dm-1', kind: 'dm' });
    const response = await request(app()).post('/api/threads/dm').send({ agentId: 'test-agent-a' });
    expect(response.status).toBe(200);
    expect(response.body.data).toEqual({ thread: { id: 'thread-dm-1', kind: 'dm' } });
    expect(findOrCreate).toHaveBeenCalledWith(
      { kind: 'user', userId: 'user-1' },
      { kind: 'agent', agentId: 'test-agent-a' }
    );
  });

  test('unknown agent is 404', async () => {
    findOrCreate.mockRejectedValue(new AppError('Agent not found', ErrorCode.NOT_FOUND, 404));
    const response = await request(app()).post('/api/threads/dm').send({ agentId: 'missing' });
    expect(response.status).toBe(404);
  });

  test('an agent with DMs turned off is 409', async () => {
    findOrCreate.mockRejectedValue(new AppError('DMs are turned off', ErrorCode.CONFLICT, 409));
    const response = await request(app()).post('/api/threads/dm').send({ agentId: 'test-agent-a' });
    expect(response.status).toBe(409);
  });

  test('a missing agentId is 400', async () => {
    const response = await request(app()).post('/api/threads/dm').send({});
    expect(response.status).toBe(400);
    expect(findOrCreate).not.toHaveBeenCalled();
  });
});

describe('POST /api/threads/:id/dm-read', () => {
  test("marks the local user's cursor on a DM thread", async () => {
    threadsFindById.mockResolvedValue({ id: 'thread-dm-1', kind: 'dm' });
    const response = await request(app()).post('/api/threads/thread-dm-1/dm-read');
    expect(response.status).toBe(200);
    expect(markRead).toHaveBeenCalledWith('thread-dm-1', 'member-user');
  });

  test('a non-DM thread is 404', async () => {
    threadsFindById.mockResolvedValue({ id: 'thread-1', kind: 'chat' });
    const response = await request(app()).post('/api/threads/thread-1/dm-read');
    expect(response.status).toBe(404);
    expect(markRead).not.toHaveBeenCalled();
  });

  test('an unknown thread is 404', async () => {
    threadsFindById.mockResolvedValue(null);
    expect((await request(app()).post('/api/threads/nope/dm-read')).status).toBe(404);
  });
});
