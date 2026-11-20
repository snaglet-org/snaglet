import express from 'express';
import request from 'supertest';

const mockFindThread = jest.fn();
const mockFindLive = jest.fn();
const mockUpdate = jest.fn();
const mockVerify = jest.fn();
const mockFindAgent = jest.fn();
const mockSkills = jest.fn();
const mockRemove = jest.fn();
const mockAdd = jest.fn();
jest.mock('@snaglet/db/tables/threads', () => ({
  Threads: { findById: (...args: unknown[]) => mockFindThread(...args) },
}));
jest.mock('@snaglet/db/tables/subagents', () => ({
  Subagents: { findLiveByThreadId: (...args: unknown[]) => mockFindLive(...args) },
}));
jest.mock('@snaglet/db/tables/agents', () => ({
  Agents: { findById: (...args: unknown[]) => mockFindAgent(...args) },
}));
jest.mock('@snaglet/db/tables/users', () => ({ Users: {} }));
jest.mock('@snaglet/db/tables/thread_participants', () => ({
  ThreadParticipants: {
    updateOverrides: (...args: unknown[]) => mockUpdate(...args),
    updateModel: (...args: unknown[]) => mockUpdate(...args),
    listByThread: async () => [{ id: 'participant-1', kind: 'agent', agentId: 'test-helper' }],
    removeById: (...args: unknown[]) => mockRemove(...args),
    addParticipant: (...args: unknown[]) => mockAdd(...args),
    addUserParticipant: (...args: unknown[]) => mockAdd(...args),
  },
}));
jest.mock('@snaglet/db/tables/agent_activity_log', () => ({ AgentActivityLog: {} }));
jest.mock('@server/services/skills/SkillAssignmentService', () => ({
  SkillAssignmentService: { updateThread: (...args: unknown[]) => mockSkills(...args) },
}));
jest.mock('@server/services/subagents/helperModelSync', () => ({ syncHelperModel: jest.fn() }));
jest.mock('@server/services/SocketService/threadEvents', () => ({
  emitParticipantRemovedEvent: jest.fn(),
}));
jest.mock('@server/middleware/panelAuth', () => ({
  verifyChildDispatchToken: (...args: unknown[]) => mockVerify(...args),
}));

import { registerParticipantRoutes } from '@server/domains/threads/handlers/participantHandlers';
import { errorHandler } from '@server/middleware';
import { runWithActor } from '@server/realtime/actorContext';
import { assertHelperParticipantEdit } from '@server/domains/threads/helperParticipantPolicy';

const DENIED =
  "thread_update: this is a subagent's thread; only the agent that started that subagent can change its settings.";
const THREAD = { id: 'thread-1', parentThreadId: 'thread-parent' };
function app(actor?: string) {
  const result = express();
  result.use(express.json());
  if (actor)
    result.use((_req, _res, next) => runWithActor({ actorKind: 'agent', actorId: actor }, next));
  const router = express.Router();
  registerParticipantRoutes(router);
  result.use('/threads', router);
  result.use(errorHandler);
  return result;
}
const path = '/threads/thread-1/participants/test-helper';

describe('helper participant edit access', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockFindThread.mockResolvedValue(THREAD);
    mockFindLive.mockResolvedValue({ orchestratorAgentId: 'test-agent-a' });
    mockUpdate.mockResolvedValue({ id: 'participant-1' });
    mockSkills.mockResolvedValue({});
    mockRemove.mockResolvedValue(true);
    mockFindAgent.mockResolvedValue(null);
  });

  it.each([undefined, 'test-agent-a'])('allows person/orchestrator %s', async (actor) => {
    const res = await request(app(actor))
      .patch(`${path}/overrides`)
      .send({ systemPromptAddendum: 'New instructions' });
    expect(res.status).toBe(200);
    expect(mockUpdate).toHaveBeenCalledTimes(1);
  });

  it.each(['test-agent-b', 'test-helper'])(
    'refuses other agent/helper %s with the shared tool error',
    async (actor) => {
      const res = await request(app(actor))
        .patch(`${path}/overrides`)
        .send({ systemPromptAddendum: 'Changed' });
      expect(res.status).toBe(403);
      expect(res.body.error).toMatchObject({ code: 'FORBIDDEN', message: DENIED });
      expect(mockUpdate).not.toHaveBeenCalled();
      await expect(assertHelperParticipantEdit(THREAD, actor)).rejects.toThrow(DENIED);
    }
  );

  it('leaves non-helper threads unchanged', async () => {
    mockFindThread.mockResolvedValue({ id: 'thread-1' });
    const res = await request(app('test-agent-b'))
      .patch(`${path}/overrides`)
      .send({ autoRespond: false });
    expect(res.status).toBe(200);
    expect(mockFindLive).not.toHaveBeenCalled();
  });

  it.each(['model', 'overrides', 'skills', 'delete'])(
    'guards %s mutations before writes',
    async (route) => {
      const client = request(app('test-agent-b'));
      const res =
        route === 'delete'
          ? await client.delete(path)
          : route === 'skills'
            ? await client.put(`${path}/skills`).send({ mode: 'inherit' })
            : await client
                .patch(`${path}/${route}`)
                .send(route === 'model' ? { modelId: 'test-model' } : { autoRespond: false });
      expect(res.status).toBe(403);
      expect(res.body.error.message).toBe(DENIED);
      expect(mockUpdate).not.toHaveBeenCalled();
      expect(mockSkills).not.toHaveBeenCalled();
      expect(mockRemove).not.toHaveBeenCalled();
    }
  );

  it('guards participant additions to helper threads', async () => {
    const res = await request(app('test-agent-b'))
      .post('/threads/thread-1/participants')
      .send({ agentId: 'test-agent-c' });
    expect(res.status).toBe(403);
    expect(res.body.error.message).toBe(DENIED);
  });

  it('returns an atomic-save conflict without claiming a successful edit', async () => {
    mockUpdate.mockResolvedValue(null);
    const res = await request(app()).patch(`${path}/overrides`).send({
      systemPromptAddendum: 'Draft',
      expectedSystemPromptAddendum: 'Earlier',
    });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('CONFLICT');
    expect(mockUpdate).toHaveBeenCalledWith('thread-1', 'test-helper', {
      systemPromptAddendum: 'Draft',
      expectedSystemPromptAddendum: 'Earlier',
    });
  });

  it('uses the verified child token ahead of a declared person', async () => {
    mockVerify.mockReturnValue({ agentId: 'test-agent-b' });
    const res = await request(app())
      .patch(`${path}/overrides`)
      .set('x-snaglet-child-dispatch-token', 'test-token')
      .set('x-snaglet-actor-id', '1')
      .send({ autoRespond: false });
    expect(res.status).toBe(403);
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it('allows the verified orchestrator', async () => {
    mockVerify.mockReturnValue({ agentId: 'test-agent-a' });
    const res = await request(app())
      .patch(`${path}/overrides`)
      .set('x-snaglet-child-dispatch-token', 'test-token')
      .send({ autoRespond: false });
    expect(res.status).toBe(200);
  });

  it('does not fall back to person for an invalid child token', async () => {
    mockVerify.mockReturnValue(null);
    const res = await request(app())
      .patch(`${path}/overrides`)
      .set('x-snaglet-child-dispatch-token', 'invalid')
      .send({ autoRespond: false });
    expect(res.status).toBe(403);
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it('recognizes an agent id declared through the desktop actor header', async () => {
    mockFindAgent.mockResolvedValue({ id: 'test-agent-b' });
    const res = await request(app())
      .patch(`${path}/overrides`)
      .set('x-snaglet-actor-id', 'test-agent-b')
      .send({ autoRespond: false });
    expect(res.status).toBe(403);
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it('recognizes legacy audit agent identity on delete', async () => {
    const res = await request(app()).delete(`${path}?actorAgentId=test-agent-b`);
    expect(res.status).toBe(403);
    expect(mockRemove).not.toHaveBeenCalled();
  });

  it('refuses an agent when the helper record no longer exists', async () => {
    mockFindLive.mockResolvedValue(null);
    const res = await request(app('test-agent-a'))
      .patch(`${path}/overrides`)
      .send({ autoRespond: false });
    expect(res.status).toBe(403);
  });
});

describe('DM thread participants', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockFindThread.mockResolvedValue({ id: 'thread-dm-1', kind: 'dm', parentThreadId: null });
    mockFindAgent.mockResolvedValue({ id: 'test-agent-c' });
  });

  it.each([{ agentId: 'test-agent-c' }, { userId: 'user-1' }])(
    'refuses adding %o to a DM thread, which is exactly its two parties',
    async (body) => {
      const res = await request(app()).post('/threads/thread-dm-1/participants').send(body);
      expect(res.status).toBe(409);
      expect(res.body.error.message).toMatch(/DM/);
      expect(mockAdd).not.toHaveBeenCalled();
    }
  );

  it('refuses removing a party from a DM thread, which would leave the pair one member', async () => {
    mockRemove.mockResolvedValue(true);
    const res = await request(app()).delete('/threads/thread-dm-1/participants/test-helper');
    expect(res.status).toBe(409);
    expect(res.body.error.message).toMatch(/DM/);
    expect(mockRemove).not.toHaveBeenCalled();
  });
});
