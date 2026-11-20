/**
 * thread ops add_agents and remove_agents (threadMembers.ts): who is in a
 * thread, apart from update. add_agents skips agents already in and is
 * attributed to the ambient actor; remove_agents is in-room housekeeping that
 * refuses the caller (op leave), people and agents a person set up there.
 */
const mockThreadFindById = jest.fn();
const mockIsAgentParticipant = jest.fn();
const mockAddParticipant = jest.fn();
const mockListByThread = jest.fn();
const mockRemoveAgentParticipant = jest.fn();
const mockListSkillPicks = jest.fn();
const mockAgentFindById = jest.fn();
const mockEmitParticipantAdded = jest.fn();
const mockEmitThreadUpdated = jest.fn();
const mockHooksEmit = jest.fn();

jest.mock('@snaglet/db/tables/threads', () => ({
  Threads: { findById: mockThreadFindById },
}));
jest.mock('@snaglet/db/tables/thread_participants', () => ({
  ThreadParticipants: {
    isAgentParticipant: mockIsAgentParticipant,
    addParticipant: mockAddParticipant,
    listByThread: mockListByThread,
  },
}));
jest.mock('@snaglet/db/tables/skill_assignments', () => ({
  SkillAssignments: { listForAgent: (...args: unknown[]) => mockListSkillPicks(...args) },
}));
jest.mock('@server/domains/threads/removeAgentParticipant', () => ({
  removeAgentParticipant: (...args: unknown[]) => mockRemoveAgentParticipant(...args),
}));
jest.mock('@snaglet/db/tables/agents', () => ({
  Agents: { findById: mockAgentFindById },
}));
jest.mock('@server/services/SocketService/threadEvents', () => ({
  emitParticipantAddedEvent: (...args: unknown[]) => mockEmitParticipantAdded(...args),
}));
const EXTERNAL_ACTOR = { actorKind: 'external', actorId: 'member-codex', actorName: 'Codex' };
const mockGetCurrentActor = jest.fn((): unknown => EXTERNAL_ACTOR);
jest.mock('@server/realtime/actorContext', () => ({
  getCurrentActor: () => mockGetCurrentActor(),
}));
jest.mock('@server/realtime/surfaces/threads', () => ({
  emitThreadUpdated: mockEmitThreadUpdated,
}));
jest.mock('@server/services/HookService', () => ({
  hooks: { emit: mockHooksEmit },
}));

import {
  threadAddAgents,
  threadRemoveAgents,
} from '@server/services/ToolService/handlers/threads/threadMembers';
import { threadRosterVersion } from '@server/services/SocketService/dispatch/rosterVersion';

const THREAD = {
  id: 'thread-1',
  title: 'Before',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-02T00:00:00.000Z',
};

type AddResult = {
  output: string;
  rawContent: { added_agent_ids: string[]; updated_by: unknown };
};
type RemoveResult = { output: string; rawContent: { removed_agent_ids: string[] } };

describe('thread op add_agents', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetCurrentActor.mockImplementation(() => EXTERNAL_ACTOR);
    mockThreadFindById.mockResolvedValue(THREAD);
    mockIsAgentParticipant.mockResolvedValue(false);
    mockAddParticipant.mockResolvedValue({ id: 'participant-1' });
    mockAgentFindById.mockImplementation(async (id: string) => ({ id, name: `Name ${id}` }));
  });

  it('adds agents in order, drops duplicates, emits a roster event each, and attributes the actor', async () => {
    const result = (await threadAddAgents(
      { thread_id: 'thread-1', agent_ids: ['agent-b', 'agent-a', 'agent-b', ' agent-a '] },
      {},
      {} as never
    )) as AddResult;

    expect(mockAddParticipant.mock.calls).toEqual([
      [{ threadId: 'thread-1', agentId: 'agent-b' }],
      [{ threadId: 'thread-1', agentId: 'agent-a' }],
    ]);
    expect(mockEmitParticipantAdded.mock.calls).toEqual([
      ['thread-1', 'agent-b', 'Name agent-b'],
      ['thread-1', 'agent-a', 'Name agent-a'],
    ]);
    expect(result.rawContent.added_agent_ids).toEqual(['agent-b', 'agent-a']);
    expect(result.rawContent.updated_by).toEqual({ kind: 'external', id: 'member-codex' });
    expect(result.output).toContain('agent-b, agent-a');
    expect(mockHooksEmit).toHaveBeenCalledWith('thread:update', {
      id: 'thread-1',
      updatedBy: { kind: 'external', id: 'member-codex' },
      changed: ['add_agents'],
      participantAgentIds: ['agent-b', 'agent-a'],
      removedAgentIds: [],
    });
    expect(mockEmitThreadUpdated).toHaveBeenCalledWith({
      id: 'thread-1',
      updatedAt: THREAD.updatedAt,
    });
  });

  it('falls back to the calling thread when no id is given (an agent caller)', async () => {
    mockGetCurrentActor.mockImplementation(() => ({ actorKind: 'agent', actorId: 'agent-venus' }));
    mockThreadFindById.mockResolvedValue({ ...THREAD, id: 'thread-current' });
    await threadAddAgents({ agent_ids: ['agent-1'] }, {}, { threadId: 'thread-current' } as never);
    expect(mockThreadFindById).toHaveBeenCalledWith('thread-current');
    expect(mockAddParticipant).toHaveBeenCalledWith({
      threadId: 'thread-current',
      agentId: 'agent-1',
    });
  });

  it('requires an id from an external caller', async () => {
    await expect(
      threadAddAgents({ agent_ids: ['agent-1'] }, {}, { threadId: 'thread-here' } as never)
    ).rejects.toThrow('thread op:add_agents: thread id is required for external callers.');
  });

  it('is idempotent: agents already in the thread are skipped without events', async () => {
    mockIsAgentParticipant.mockImplementation(
      async (_threadId: string, agentId: string) => agentId === 'agent-present'
    );
    const result = (await threadAddAgents(
      { thread_id: 'thread-1', agent_ids: ['agent-present', 'agent-new'] },
      {},
      {} as never
    )) as AddResult;
    expect(mockAddParticipant).toHaveBeenCalledTimes(1);
    expect(mockAddParticipant).toHaveBeenCalledWith({ threadId: 'thread-1', agentId: 'agent-new' });
    expect(mockEmitParticipantAdded).toHaveBeenCalledTimes(1);
    expect(result.rawContent.added_agent_ids).toEqual(['agent-new']);
  });

  it('reports nothing changed, and announces nothing, when every agent is already in', async () => {
    mockIsAgentParticipant.mockResolvedValue(true);
    const result = (await threadAddAgents(
      { thread_id: 'thread-1', agent_ids: ['agent-1'] },
      {},
      {} as never
    )) as AddResult;
    expect(mockAddParticipant).not.toHaveBeenCalled();
    expect(mockHooksEmit).not.toHaveBeenCalled();
    expect(result.rawContent.added_agent_ids).toEqual([]);
    expect(result.output).toContain('Nothing changed');
  });

  it('lists every unknown agent and performs no writes', async () => {
    mockAgentFindById.mockImplementation(async (id: string) =>
      id === 'agent-real' ? { id, name: 'Real' } : null
    );
    await expect(
      threadAddAgents(
        { thread_id: 'thread-1', agent_ids: ['ghost-a', 'agent-real', 'ghost-b'] },
        {},
        {} as never
      )
    ).rejects.toThrow(/agent\(s\) not found: ghost-a, ghost-b — nothing was changed/);
    expect(mockAddParticipant).not.toHaveBeenCalled();
    expect(mockEmitParticipantAdded).not.toHaveBeenCalled();
  });

  it("refuses a subagent's thread and a DM thread", async () => {
    mockThreadFindById.mockResolvedValue({ ...THREAD, parentThreadId: 'thread-0' });
    await expect(
      threadAddAgents({ thread_id: 'thread-1', agent_ids: ['agent-1'] }, {}, {} as never)
    ).rejects.toThrow("agents can't be added to a subagent's thread");
    mockThreadFindById.mockResolvedValue({ ...THREAD, kind: 'dm' });
    await expect(
      threadAddAgents({ thread_id: 'thread-1', agent_ids: ['agent-1'] }, {}, {} as never)
    ).rejects.toThrow(/direct-message thread/);
    expect(mockAddParticipant).not.toHaveBeenCalled();
  });

  it('errors when the thread is not found, before touching agents', async () => {
    mockThreadFindById.mockResolvedValue(null);
    await expect(
      threadAddAgents({ thread_id: 'thread-x', agent_ids: ['agent-1'] }, {}, {} as never)
    ).rejects.toThrow(/thread not found: thread-x/);
    expect(mockAddParticipant).not.toHaveBeenCalled();
  });

  it('rejects a missing, empty or malformed list and unknown fields', async () => {
    for (const bad of [undefined, [], 'agent-1', ['agent-1', '  ']]) {
      await expect(
        threadAddAgents({ thread_id: 'thread-1', agent_ids: bad }, {}, {} as never)
      ).rejects.toThrow(/`agent_ids` must be a non-empty array of agent id strings/);
    }
    await expect(
      threadAddAgents(
        { thread_id: 'thread-1', agent_ids: ['a'], thread: { title: 'x' } },
        {},
        {} as never
      )
    ).rejects.toThrow(/unknown field\(s\): thread/);
    expect(mockAddParticipant).not.toHaveBeenCalled();
  });

  it('works from outside the thread', async () => {
    mockGetCurrentActor.mockImplementation(() => ({ actorKind: 'agent', actorId: 'outsider' }));
    await expect(
      threadAddAgents({ thread_id: 'thread-1', agent_ids: ['agent-vega'] }, {}, {
        agentId: 'agent-outsider',
        threadId: 'thread-other',
      } as never)
    ).resolves.toBeDefined();
    expect(mockAddParticipant).toHaveBeenCalledWith({
      threadId: 'thread-1',
      agentId: 'agent-vega',
    });
  });

  it('in the thread the caller runs in: says to mention them and bumps the roster', async () => {
    mockGetCurrentActor.mockImplementation(() => ({ actorKind: 'agent', actorId: 'agent-lead' }));
    const before = threadRosterVersion('thread-1');
    const result = (await threadAddAgents({ agent_ids: ['agent-nova', 'agent-vega'] }, {}, {
      agentId: 'agent-lead',
      threadId: 'thread-1',
    } as never)) as AddResult;
    expect(result.output).toContain(
      'Mention @Name agent-nova, @Name agent-vega in your reply to wake them.'
    );
    // A run going on in the thread re-reads its roster before routing mentions.
    expect(threadRosterVersion('thread-1')).toBeGreaterThan(before);
  });

  it('says nothing of the kind when the thread is another one', async () => {
    mockGetCurrentActor.mockImplementation(() => ({ actorKind: 'agent', actorId: 'agent-lead' }));
    const result = (await threadAddAgents(
      { thread_id: 'thread-1', agent_ids: ['agent-nova'] },
      {},
      {
        agentId: 'agent-lead',
        threadId: 'thread-elsewhere',
      } as never
    )) as AddResult;
    expect(result.output).not.toContain('in your reply to wake them');
  });
});

describe('thread op remove_agents', () => {
  const ctx = { agentId: 'agent-lead', threadId: 'thread-1' } as never;
  const agentRow = (agentId: string) => ({ id: `tp-${agentId}`, kind: 'agent', agentId });
  const ROSTER = [
    agentRow('agent-lead'),
    agentRow('agent-nova'),
    agentRow('agent-orion'),
    {
      id: 'tp-user',
      kind: 'user',
      agentId: null,
      userId: 'user-robin',
      memberId: 'member-robin',
    },
  ];

  beforeEach(() => {
    jest.clearAllMocks();
    mockGetCurrentActor.mockReturnValue({ actorKind: 'agent', actorId: 'agent-lead' });
    mockThreadFindById.mockResolvedValue(THREAD);
    mockListByThread.mockResolvedValue(ROSTER);
    mockRemoveAgentParticipant.mockResolvedValue(true);
    mockListSkillPicks.mockResolvedValue([]);
  });
  afterAll(() => mockGetCurrentActor.mockImplementation(() => EXTERNAL_ACTOR));

  it('removes each agent through the shared removal and reports it', async () => {
    const result = (await threadRemoveAgents(
      { agent_ids: ['agent-nova', 'agent-orion', 'agent-nova'] },
      {},
      ctx
    )) as RemoveResult;
    expect(mockRemoveAgentParticipant.mock.calls).toEqual([
      [{ threadId: 'thread-1', agentId: 'agent-nova' }],
      [{ threadId: 'thread-1', agentId: 'agent-orion' }],
    ]);
    expect(result.rawContent.removed_agent_ids).toEqual(['agent-nova', 'agent-orion']);
    expect(result.output).toContain('agent-nova, agent-orion');
    expect(mockHooksEmit).toHaveBeenCalledWith(
      'thread:update',
      expect.objectContaining({
        changed: ['remove_agents'],
        participantAgentIds: [],
        removedAgentIds: ['agent-nova', 'agent-orion'],
      })
    );
  });

  it('refuses a list with the caller in it and points at op leave, removing no one', async () => {
    await expect(
      threadRemoveAgents({ agent_ids: ['agent-nova', 'agent-lead'] }, {}, ctx)
    ).rejects.toThrow(/can't remove yourself.*op "leave"/);
    expect(mockRemoveAgentParticipant).not.toHaveBeenCalled();
  });

  it.each([['user-robin'], ['member-robin'], ['tp-user']])(
    'refuses to remove a person (%s) and writes nothing',
    async (personId) => {
      await expect(threadRemoveAgents({ agent_ids: [personId] }, {}, ctx)).rejects.toThrow(
        /a person, not an agent.*nothing was changed/
      );
      expect(mockRemoveAgentParticipant).not.toHaveBeenCalled();
    }
  );

  it('refuses an agent that is not in the thread, naming it, and writes nothing', async () => {
    await expect(
      threadRemoveAgents({ agent_ids: ['agent-nova', 'agent-ghost'] }, {}, ctx)
    ).rejects.toThrow(/agent-ghost: not an agent in this thread — nothing was changed/);
    expect(mockRemoveAgentParticipant).not.toHaveBeenCalled();
  });

  it('refuses a caller that is not in the thread (removal is in-room housekeeping)', async () => {
    mockListByThread.mockResolvedValue([
      agentRow('agent-nova'),
      agentRow('agent-orion'),
      ROSTER[3],
    ]);
    await expect(
      threadRemoveAgents({ thread_id: 'thread-1', agent_ids: ['agent-nova'] }, {}, {
        agentId: 'agent-lead',
        threadId: 'thread-other',
      } as never)
    ).rejects.toThrow(/you can only remove agents from a thread you are in/);
    expect(mockRemoveAgentParticipant).not.toHaveBeenCalled();
  });

  it.each([
    ['a model', { modelId: 'claude-x', providerId: 'anthropic' }, 'model'],
    ['tool access', { toolAccessMode: 'deny_list', toolAccessDenyList: ['shell'] }, 'tool access'],
    ['instructions', { systemPromptAddendum: 'Only review pricing.' }, 'instructions'],
    ['a skill mode', { skillMode: 'override' }, 'skills'],
    ['limits', { maxDurationSeconds: 600 }, 'limits'],
    ['auto-respond off', { autoRespond: false }, 'auto-respond off'],
  ])(
    'refuses an agent a person set up here (%s), naming the setting',
    async (_name, setup, label) => {
      mockListByThread.mockResolvedValue([
        agentRow('agent-lead'),
        { ...agentRow('agent-nova'), ...setup },
        ROSTER[3],
      ]);
      await expect(threadRemoveAgents({ agent_ids: ['agent-nova'] }, {}, ctx)).rejects.toThrow(
        `agent-nova has per-thread settings here (${label}); a person removes them in the app`
      );
      expect(mockRemoveAgentParticipant).not.toHaveBeenCalled();
    }
  );

  it('names every setting, including thread skill picks, and changes nothing', async () => {
    mockListByThread.mockResolvedValue([
      agentRow('agent-lead'),
      { ...agentRow('agent-nova'), credentialId: 'cred-1', systemPromptAddendum: 'Be brief.' },
      agentRow('agent-orion'),
    ]);
    mockListSkillPicks.mockImplementation(async (agentId: string, threadId: string | null) =>
      agentId === 'agent-nova' && threadId === 'thread-1' ? [{ skillId: 'skill-1' }] : []
    );
    await expect(
      threadRemoveAgents({ agent_ids: ['agent-orion', 'agent-nova'] }, {}, ctx)
    ).rejects.toThrow('agent-nova has per-thread settings here (model, instructions, skills)');
    expect(mockRemoveAgentParticipant).not.toHaveBeenCalled();
  });

  it('removes an agent with only default per-thread values', async () => {
    mockListByThread.mockResolvedValue([
      agentRow('agent-lead'),
      {
        ...agentRow('agent-nova'),
        modelId: null,
        providerId: null,
        credentialId: null,
        systemPromptAddendum: '  ',
        toolAccessMode: null,
        toolAccessAllowList: [],
        toolAccessDenyList: null,
        toolOverrides: {},
        maxToolCallsPerTurn: null,
        maxDurationSeconds: null,
        autoRespond: true,
        disableModelFallback: false,
        skillMode: 'inherit',
      },
    ]);
    await threadRemoveAgents({ agent_ids: ['agent-nova'] }, {}, ctx);
    expect(mockRemoveAgentParticipant).toHaveBeenCalledWith({
      threadId: 'thread-1',
      agentId: 'agent-nova',
    });
  });

  it('refuses a call with no agent behind it', async () => {
    await expect(
      threadRemoveAgents({ thread_id: 'thread-1', agent_ids: ['agent-nova'] }, {}, {} as never)
    ).rejects.toThrow(/only an agent in the thread can remove agents/);
    expect(mockRemoveAgentParticipant).not.toHaveBeenCalled();
  });

  it("refuses a subagent's thread", async () => {
    mockThreadFindById.mockResolvedValue({ ...THREAD, parentThreadId: 'thread-0' });
    await expect(threadRemoveAgents({ agent_ids: ['agent-nova'] }, {}, ctx)).rejects.toThrow(
      "agents can't be removed from a subagent's thread"
    );
    expect(mockRemoveAgentParticipant).not.toHaveBeenCalled();
  });

  it('refuses a DM thread', async () => {
    mockThreadFindById.mockResolvedValue({ ...THREAD, kind: 'dm' });
    await expect(
      threadRemoveAgents({ thread_id: 'thread-1', agent_ids: ['agent-nova'] }, {}, {
        agentId: 'agent-lead',
        threadId: 'thread-other',
      } as never)
    ).rejects.toThrow(/direct-message thread/);
    expect(mockRemoveAgentParticipant).not.toHaveBeenCalled();
  });

  it('a removal that races (already gone) is left out of the report', async () => {
    mockRemoveAgentParticipant.mockImplementation(
      async ({ agentId }: { agentId: string }) => agentId !== 'agent-orion'
    );
    const result = (await threadRemoveAgents(
      { agent_ids: ['agent-nova', 'agent-orion'] },
      {},
      ctx
    )) as RemoveResult;
    expect(result.rawContent.removed_agent_ids).toEqual(['agent-nova']);
  });
});
