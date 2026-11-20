import express from 'express';
import request from 'supertest';

const mockFindThreadById = jest.fn();
const mockListThreadParticipants = jest.fn();
const mockRemoveById = jest.fn();
const mockLogActivity = jest.fn();

jest.mock('@snaglet/db/tables/threads', () => ({
  Threads: {
    findById: (...args: unknown[]) => mockFindThreadById(...args),
    updateSettings: jest.fn(),
  },
}));

// Agents/Users are imported by participantHandlers for the add-participant
// path; the DELETE path does not use them (removal is open to any actor),
// so these mocks exist only so the module loads.
jest.mock('@snaglet/db/tables/agents', () => ({ Agents: { findById: jest.fn() } }));
jest.mock('@snaglet/db/tables/users', () => ({ Users: { findById: jest.fn() } }));

jest.mock('@snaglet/db/tables/thread_participants', () => ({
  ThreadParticipants: {
    listByThread: (...args: unknown[]) => mockListThreadParticipants(...args),
    // The DELETE route resolves the participant row, then removes it by its own
    // primary key — never by a derived agent id.
    removeById: (...args: unknown[]) => mockRemoveById(...args),
  },
}));

jest.mock('@snaglet/db/tables/agent_activity_log', () => ({
  AgentActivityLog: {
    logActivity: (...args: unknown[]) => mockLogActivity(...args),
    listThreadActivity: jest.fn(),
  },
}));

jest.mock('@snaglet/db/tables/messages', () => ({ Messages: {} }));
jest.mock('@snaglet/db/tables/memories', () => ({ Memories: {} }));

import threadsRouter from '@server/domains/threads/threads.routes';

function makeThread(overrides: Record<string, unknown> = {}) {
  return { id: 'thread-1', agent_id: 'owner-1', title: 'Thread 1', config_json: {}, ...overrides };
}

describe('Thread participant removal (open to any actor)', () => {
  let app: express.Application;

  beforeAll(() => {
    app = express();
    app.use(express.json());
    app.use('/api/threads', threadsRouter);
  });

  beforeEach(() => {
    jest.clearAllMocks();
    mockLogActivity.mockResolvedValue({ id: 'log-1' });
  });

  it('removes a participant for an actor with no admin role / no actor id', async () => {
    mockFindThreadById.mockResolvedValue(makeThread());
    mockListThreadParticipants.mockResolvedValue([
      { id: 'tp-2', threadId: 'thread-1', memberId: 'mem-2', kind: 'agent', agentId: 'a2' },
    ]);
    mockRemoveById.mockResolvedValue(true);

    // No actorAgentId, no x-snaglet-actor-id header — anonymous removal is allowed.
    const res = await request(app).delete('/api/threads/thread-1/participants/a2');

    expect(res.status).toBe(200);
    // Removal targets the participant row's own primary key.
    expect(mockRemoveById).toHaveBeenCalledWith('tp-2');
    expect(mockLogActivity).not.toHaveBeenCalled();
  });

  it('logs the removal activity when an actor agent id is supplied', async () => {
    mockFindThreadById.mockResolvedValue(makeThread());
    mockListThreadParticipants.mockResolvedValue([
      { id: 'tp-2', threadId: 'thread-1', memberId: 'mem-2', kind: 'agent', agentId: 'a2' },
    ]);
    mockRemoveById.mockResolvedValue(true);

    const res = await request(app).delete(
      '/api/threads/thread-1/participants/a2?actorAgentId=anyone'
    );

    expect(res.status).toBe(200);
    expect(mockRemoveById).toHaveBeenCalledWith('tp-2');
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.objectContaining({
        actionType: 'tool_call',
        tool: 'threads.remove_participant',
      })
    );
  });

  it('returns 404 when the participant is not in the thread', async () => {
    mockFindThreadById.mockResolvedValue(makeThread());
    mockListThreadParticipants.mockResolvedValue([
      { id: 'tp-1', threadId: 'thread-1', memberId: 'mem-1', kind: 'agent', agentId: 'a1' },
    ]);

    const res = await request(app).delete(
      '/api/threads/thread-1/participants/a2?actorAgentId=anyone'
    );

    expect(res.status).toBe(404);
    expect(mockRemoveById).not.toHaveBeenCalled();
  });
});
