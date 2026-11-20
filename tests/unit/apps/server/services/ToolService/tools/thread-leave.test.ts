/**
 * thread op `leave`: the calling agent takes itself out of a thread through
 * the same removal as the app's Remove button, and is refused in a DM, a
 * subagent's thread, a thread it is not in, and a thread where it is the only
 * agent.
 */
const mockThreadFindById = jest.fn();
const mockListByThread = jest.fn();
const mockRemoveAgentParticipant = jest.fn();
const mockListSkillPicks = jest.fn();
const mockGetCurrentActor = jest.fn((): unknown => ({ actorKind: 'agent', actorId: 'agent-nova' }));

jest.mock('@snaglet/db/tables/threads', () => ({
  Threads: { findById: (...args: unknown[]) => mockThreadFindById(...args) },
}));
jest.mock('@snaglet/db/tables/thread_participants', () => ({
  ThreadParticipants: { listByThread: (...args: unknown[]) => mockListByThread(...args) },
}));
jest.mock('@snaglet/db/tables/skill_assignments', () => ({
  SkillAssignments: { listForAgent: (...args: unknown[]) => mockListSkillPicks(...args) },
}));
jest.mock('@server/domains/threads/removeAgentParticipant', () => ({
  removeAgentParticipant: (...args: unknown[]) => mockRemoveAgentParticipant(...args),
}));
jest.mock('@server/realtime/actorContext', () => ({
  getCurrentActor: () => mockGetCurrentActor(),
}));

import threadLeave from '@server/services/ToolService/handlers/threads/threadLeave';

type LeaveResult = { output: string; rawContent: { thread_id: string; left: boolean } };

const THREAD = { id: 'thread-1', title: 'Pricing review', kind: 'chat', parentThreadId: null };
const agentRow = (agentId: string) => ({ id: `tp-${agentId}`, kind: 'agent', agentId });
const PERSON = { id: 'tp-user', kind: 'user', agentId: null, userId: 'user-robin' };
const HERE = { agentId: 'agent-nova', threadId: 'thread-1' } as never;

beforeEach(() => {
  jest.clearAllMocks();
  mockThreadFindById.mockResolvedValue(THREAD);
  mockListByThread.mockResolvedValue([agentRow('agent-lead'), agentRow('agent-nova'), PERSON]);
  mockRemoveAgentParticipant.mockResolvedValue(true);
  mockListSkillPicks.mockResolvedValue([]);
});

describe('thread op leave', () => {
  it('removes the caller from the thread it is in and tells it to stop', async () => {
    const result = (await threadLeave({}, {}, HERE)) as LeaveResult;

    expect(mockRemoveAgentParticipant).toHaveBeenCalledWith({
      threadId: 'thread-1',
      agentId: 'agent-nova',
    });
    expect(result.rawContent).toEqual({
      thread_id: 'thread-1',
      left: true,
      agent_id: 'agent-nova',
    });
    expect(result.output).toContain("You left thread 'Pricing review'");
    expect(result.output).toContain('Nothing you write after this posts there');
  });

  it('can leave another thread by id, without the end-your-turn line', async () => {
    const result = (await threadLeave({ thread_id: 'thread-1' }, {}, {
      agentId: 'agent-nova',
      threadId: 'thread-elsewhere',
    } as never)) as LeaveResult;

    expect(mockThreadFindById).toHaveBeenCalledWith('thread-1');
    expect(mockRemoveAgentParticipant).toHaveBeenCalledWith({
      threadId: 'thread-1',
      agentId: 'agent-nova',
    });
    expect(result.output).not.toContain('Nothing you write');
  });

  it('refuses a caller that is not a participant', async () => {
    mockListByThread.mockResolvedValue([agentRow('agent-lead'), agentRow('agent-orion'), PERSON]);
    await expect(threadLeave({}, {}, HERE)).rejects.toThrow(
      'you are not a participant of thread thread-1'
    );
    expect(mockRemoveAgentParticipant).not.toHaveBeenCalled();
  });

  it('refuses the only agent in the thread (people do not count)', async () => {
    mockListByThread.mockResolvedValue([agentRow('agent-nova'), PERSON]);
    await expect(threadLeave({}, {}, HERE)).rejects.toThrow(
      /you are the only agent in thread thread-1, and a thread keeps at least one/
    );
    expect(mockRemoveAgentParticipant).not.toHaveBeenCalled();
  });

  it('refuses a DM thread', async () => {
    mockThreadFindById.mockResolvedValue({ ...THREAD, kind: 'dm' });
    await expect(threadLeave({}, {}, HERE)).rejects.toThrow(/direct-message thread/);
    expect(mockListByThread).not.toHaveBeenCalled();
    expect(mockRemoveAgentParticipant).not.toHaveBeenCalled();
  });

  it("refuses a subagent's (helper) thread", async () => {
    mockThreadFindById.mockResolvedValue({ ...THREAD, parentThreadId: 'thread-0' });
    await expect(threadLeave({}, {}, HERE)).rejects.toThrow(/subagent's thread/);
    expect(mockRemoveAgentParticipant).not.toHaveBeenCalled();
  });

  it('refuses a call with no agent behind it', async () => {
    await expect(threadLeave({ thread_id: 'thread-1' }, {}, {} as never)).rejects.toThrow(
      /only an agent can leave a thread/
    );
    expect(mockRemoveAgentParticipant).not.toHaveBeenCalled();
  });

  it('names the caller’s own thread when the id is wrong', async () => {
    mockThreadFindById.mockImplementation(async (id: string) =>
      id === 'thread-1' ? THREAD : null
    );
    await expect(threadLeave({ thread_id: 'thread-guess' }, {}, HERE)).rejects.toThrow(
      'You are in thread `Pricing review` (`thread-1`)'
    );
  });

  it('rejects fields it does not take', async () => {
    await expect(threadLeave({ agent_ids: ['agent-lead'] }, {}, HERE)).rejects.toThrow(
      /unknown field\(s\): agent_ids/
    );
  });

  it('reports a removal that raced (already gone) as not a participant', async () => {
    mockRemoveAgentParticipant.mockResolvedValue(false);
    await expect(threadLeave({}, {}, HERE)).rejects.toThrow(/not a participant/);
  });

  it.each([
    ['a model', { modelId: 'claude-x' }, 'model'],
    ['fallback off', { disableModelFallback: true }, 'model'],
    ['tool access', { toolAccessAllowList: ['search'] }, 'tool access'],
    ['instructions', { systemPromptAddendum: 'Only review pricing.' }, 'instructions'],
    ['a skill mode', { skillMode: 'add' }, 'skills'],
    ['a run time limit', { maxDurationSeconds: 900 }, 'limits'],
    ['auto-respond off', { autoRespond: false }, 'auto-respond off'],
  ])('refuses an agent a person set up here (%s) and changes nothing', async (_n, setup, label) => {
    mockListByThread.mockResolvedValue([
      agentRow('agent-lead'),
      { ...agentRow('agent-nova'), ...setup },
      PERSON,
    ]);
    await expect(threadLeave({}, {}, HERE)).rejects.toThrow(
      `You have per-thread settings here (${label}); stay, a person removes you in the app`
    );
    expect(mockRemoveAgentParticipant).not.toHaveBeenCalled();
  });

  it('names thread skill picks too, with every other setting', async () => {
    mockListByThread.mockResolvedValue([
      agentRow('agent-lead'),
      { ...agentRow('agent-nova'), credentialId: 'cred-1', maxToolCallsPerTurn: 5 },
    ]);
    mockListSkillPicks.mockImplementation(async (agentId: string, threadId: string | null) =>
      agentId === 'agent-nova' && threadId === 'thread-1' ? [{ skillId: 'skill-1' }] : []
    );
    await expect(threadLeave({}, {}, HERE)).rejects.toThrow(
      'You have per-thread settings here (model, skills, limits)'
    );
    expect(mockRemoveAgentParticipant).not.toHaveBeenCalled();
  });

  it('leaves when every per-thread value is a default', async () => {
    mockListByThread.mockResolvedValue([
      agentRow('agent-lead'),
      {
        ...agentRow('agent-nova'),
        modelId: null,
        providerId: null,
        credentialId: null,
        disableModelFallback: false,
        systemPromptAddendum: '',
        toolAccessMode: null,
        toolAccessAllowList: null,
        toolAccessDenyList: [],
        toolOverrides: {},
        maxToolCallsPerTurn: null,
        maxDurationSeconds: null,
        autoRespond: true,
        skillMode: 'inherit',
      },
    ]);
    await expect(threadLeave({}, {}, HERE)).resolves.toBeDefined();
    expect(mockRemoveAgentParticipant).toHaveBeenCalledWith({
      threadId: 'thread-1',
      agentId: 'agent-nova',
    });
  });
});
