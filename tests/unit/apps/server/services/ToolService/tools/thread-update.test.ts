const mockThreadFindById = jest.fn();
const mockThreadUpdateSettings = jest.fn();
const mockSetWorkingDirectory = jest.fn();
const mockFindProjectAncestor = jest.fn();
const mockValidateWorkingDirectory = jest.fn();
const mockDescribeAgentCwd = jest.fn();
const mockIsAgentParticipant = jest.fn();
const mockAddParticipant = jest.fn();
const mockListByThread = jest.fn();
const mockRemoveAgentParticipant = jest.fn();
const mockListSkillPicks = jest.fn();
const mockAgentFindById = jest.fn();
const mockEmitParticipantAdded = jest.fn();
const mockEmitThreadUpdated = jest.fn();
const mockEmitTreeNodeUpdated = jest.fn();
const mockHooksEmit = jest.fn();

jest.mock('@snaglet/db/tables/threads', () => ({
  Threads: {
    findById: mockThreadFindById,
    updateSettings: mockThreadUpdateSettings,
    setWorkingDirectory: mockSetWorkingDirectory,
  },
}));
jest.mock('@server/services/ToolService/lib/findProjectAncestor', () => ({
  findProjectAncestor: (...args: unknown[]) => mockFindProjectAncestor(...args),
}));
jest.mock('@server/services/ToolService/lib/threadWorkingDirectory', () => ({
  validateThreadWorkingDirectory: (...args: unknown[]) => mockValidateWorkingDirectory(...args),
}));
jest.mock('@server/services/ToolService/lib/resolveAgentCwd', () => ({
  describeAgentCwd: (...args: unknown[]) => mockDescribeAgentCwd(...args),
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
jest.mock('@server/realtime/surfaces/tree', () => ({
  emitTreeNodeUpdated: mockEmitTreeNodeUpdated,
}));
jest.mock('@server/services/HookService', () => ({
  hooks: { emit: mockHooksEmit },
}));

import threadUpdate from '@server/services/ToolService/handlers/threads/threadUpdate';
import { threadRosterVersion } from '@server/services/SocketService/dispatch/rosterVersion';

const THREAD = {
  id: 'thread-1',
  title: 'Before',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-02T00:00:00.000Z',
};
const UPDATED_THREAD = { ...THREAD, title: 'After', updatedAt: '2026-01-03T00:00:00.000Z' };

type UpdateResult = {
  output: string;
  rawContent: { updated_by: unknown; changed: string[]; added_agent_ids: string[] };
};

describe('thread_update tool', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockThreadFindById.mockResolvedValue(THREAD);
    mockThreadUpdateSettings.mockResolvedValue(UPDATED_THREAD);
    mockIsAgentParticipant.mockResolvedValue(false);
    mockAddParticipant.mockResolvedValue({ id: 'participant-1' });
    mockAgentFindById.mockImplementation(async (id: string) => ({ id, name: `Name ${id}` }));
  });

  it('composes thread settings and attributes the actor', async () => {
    const result = (await threadUpdate(
      {
        thread_id: 'thread-1',
        thread: {
          title: 'After',
          dispatch_mode: 'mentioned',
          system_prompt: 'Coordinate carefully.',
          max_waves: -1,
          max_total_output_tokens: 9000,
          max_agent_dispatches: 4,
          tool_access_mode: 'deny_list',
          tool_access_deny_list: ['shell_exec'],
        },
      },
      {},
      {} as never
    )) as UpdateResult;

    expect(mockThreadUpdateSettings).toHaveBeenCalledWith('thread-1', {
      title: 'After',
      dispatchMode: 'mentioned',
      threadSystemPrompt: 'Coordinate carefully.',
      maxWaves: -1,
      maxTotalOutputTokens: 9000,
      maxAgentDispatches: 4,
      toolAccessMode: 'deny_list',
      toolAccessDenyList: ['shell_exec'],
    });
    expect(mockAddParticipant).not.toHaveBeenCalled();
    expect(mockHooksEmit).toHaveBeenCalledWith(
      'thread:update',
      expect.objectContaining({
        id: 'thread-1',
        updatedBy: { kind: 'external', id: 'member-codex' },
        participantAgentIds: [],
        removedAgentIds: [],
      })
    );
    expect(result.rawContent.updated_by).toEqual({ kind: 'external', id: 'member-codex' });
    expect(result.rawContent.changed).toEqual(expect.arrayContaining(['thread.title']));
    expect(mockEmitTreeNodeUpdated).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'thread-1', title: 'After' })
    );
    expect(mockEmitThreadUpdated).toHaveBeenCalled();
  });

  it('leaves omitted fields untouched', async () => {
    await threadUpdate(
      { thread_id: 'thread-1', thread: { max_total_output_tokens: null } },
      {},
      {} as never
    );

    expect(mockThreadUpdateSettings).toHaveBeenCalledWith('thread-1', {
      maxTotalOutputTokens: null,
    });
    expect(mockAddParticipant).not.toHaveBeenCalled();
    expect(mockEmitParticipantAdded).not.toHaveBeenCalled();
  });

  it.each([
    [
      'invalid dispatch mode',
      { thread: { title: 'Must not persist', dispatch_mode: 'random' } },
      /dispatch_mode/,
    ],
    ['zero max_waves', { thread: { title: 'Must not persist', max_waves: 0 } }, /max_waves/],
    [
      'non-positive output budget',
      { thread: { title: 'Must not persist', max_total_output_tokens: -1 } },
      /max_total_output_tokens/,
    ],
  ])('rejects %s before writing', async (_name, partial, message) => {
    await expect(
      threadUpdate({ thread_id: 'thread-1', ...partial }, {}, {} as never)
    ).rejects.toThrow(message as RegExp);
    expect(mockThreadUpdateSettings).not.toHaveBeenCalled();
    expect(mockAddParticipant).not.toHaveBeenCalled();
  });

  it('requires thread fields', async () => {
    await expect(threadUpdate({ thread_id: 'thread-1' }, {}, {} as never)).rejects.toThrow(
      /provide `thread` fields to change/
    );
    expect(mockThreadUpdateSettings).not.toHaveBeenCalled();
    expect(mockAddParticipant).not.toHaveBeenCalled();
  });

  describe('membership is not an update field', () => {
    it.each([['agent_ids'], ['remove_agent_ids']])(
      'rejects %s and points at add_agents / remove_agents / leave, writing nothing',
      async (field) => {
        await expect(
          threadUpdate(
            { thread_id: 'thread-1', thread: { title: 'Must not persist' }, [field]: ['agent-1'] },
            {},
            {} as never
          )
        ).rejects.toThrow(/op "add_agents".*op "remove_agents".*op "leave"/);
        expect(mockThreadUpdateSettings).not.toHaveBeenCalled();
        expect(mockAddParticipant).not.toHaveBeenCalled();
        expect(mockRemoveAgentParticipant).not.toHaveBeenCalled();
      }
    );

    it('rejects `participants` and names add_agents', async () => {
      await expect(
        threadUpdate(
          {
            thread_id: 'thread-1',
            thread: { title: 'Must not persist' },
            participants: [{ agent_id: 'agent-1', model: 'gpt-test' }],
          },
          {},
          {} as never
        )
      ).rejects.toThrow(/op "add_agents"/);

      expect(mockThreadUpdateSettings).not.toHaveBeenCalled();
      expect(mockAddParticipant).not.toHaveBeenCalled();
    });

    it('rejects an empty `participants` array too', async () => {
      await expect(
        threadUpdate({ thread_id: 'thread-1', participants: [] }, {}, {} as never)
      ).rejects.toThrow(/add_agents/);
    });

    it('rejects unknown top-level fields', async () => {
      await expect(
        threadUpdate({ thread_id: 'thread-1', agent_id: 'agent-1' }, {}, {} as never)
      ).rejects.toThrow(/unknown field\(s\): agent_id\b/);
    });
  });
});

describe('thread_update target thread', () => {
  afterEach(() => mockGetCurrentActor.mockImplementation(() => EXTERNAL_ACTOR));
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetCurrentActor.mockImplementation(() => ({ actorKind: 'agent', actorId: 'agent-venus' }));
    mockThreadUpdateSettings.mockResolvedValue(UPDATED_THREAD);
    mockThreadFindById.mockImplementation(async (id: string) =>
      id === 'thread-here' ? { id, title: 'Ops Room' } : null
    );
  });

  it("no thread_id → the calling thread; unknown id → names the caller's thread", async () => {
    await expect(
      threadUpdate({ thread: { title: 'x' } }, {}, { threadId: 'thread-here' } as never)
    ).resolves.toBeDefined();
    expect(mockThreadFindById).toHaveBeenCalledWith('thread-here');

    await expect(
      threadUpdate({ thread_id: 'thread-guess', thread: { title: 'x' } }, {}, {
        threadId: 'thread-here',
      } as never)
    ).rejects.toThrow('You are in thread `Ops Room` (`thread-here`)');
  });

  it('no thread_id and no calling thread → asks for the id', async () => {
    await expect(threadUpdate({ thread: { title: 'x' } }, {}, {} as never)).rejects.toThrow(
      'thread_update: no thread to target.'
    );
  });
});

describe('thread_update external caller without an id', () => {
  it('is refused even when a calling thread exists', async () => {
    await expect(
      threadUpdate({ thread: { title: 'x' } }, {}, { threadId: 'thread-here' } as never)
    ).rejects.toThrow('thread_update: thread id is required for external callers.');
  });
});

describe('thread_update thread.working_directory', () => {
  const WORKTREE = '/projects/test/.snaglet/worktrees/one';
  const ctx = { threadId: 'thread-1' } as never;

  beforeEach(() => {
    jest.clearAllMocks();
    mockGetCurrentActor.mockReturnValue({ actorKind: 'agent', actorId: 'agent-test-a' });
    mockThreadFindById.mockResolvedValue(THREAD);
    mockThreadUpdateSettings.mockResolvedValue(UPDATED_THREAD);
    mockFindProjectAncestor.mockResolvedValue({ folderPath: '/projects/test' });
    mockValidateWorkingDirectory.mockResolvedValue(WORKTREE);
    mockSetWorkingDirectory.mockResolvedValue({ ...THREAD, workingDirectory: WORKTREE });
    mockDescribeAgentCwd.mockResolvedValue({ path: WORKTREE, source: 'thread' });
  });
  afterAll(() => mockGetCurrentActor.mockReturnValue(EXTERNAL_ACTOR));

  it('checks the folder against the thread’s project folder, saves it and says where agents start', async () => {
    const result = (await threadUpdate(
      { thread: { working_directory: WORKTREE } },
      {},
      ctx
    )) as unknown as UpdateResult & { rawContent: { starts_in: string } };

    expect(mockFindProjectAncestor).toHaveBeenCalledWith('thread-1');
    expect(mockValidateWorkingDirectory).toHaveBeenCalledWith(WORKTREE, '/projects/test');
    expect(mockSetWorkingDirectory).toHaveBeenCalledWith('thread-1', WORKTREE);
    // Only the folder changed: the general settings write is not made.
    expect(mockThreadUpdateSettings).not.toHaveBeenCalled();
    expect(result.rawContent.changed).toEqual(['thread.working_directory']);
    expect(result.rawContent.starts_in).toBe(WORKTREE);
    expect(result.output).toContain(`Agents in this thread now start in: ${WORKTREE}`);
  });

  it('null clears it without checking a folder, and reports the default agents get', async () => {
    mockDescribeAgentCwd.mockResolvedValue({ path: '/projects/test', source: 'project' });
    const result = (await threadUpdate(
      { thread: { working_directory: null } },
      {},
      ctx
    )) as unknown as UpdateResult;

    expect(mockValidateWorkingDirectory).not.toHaveBeenCalled();
    expect(mockSetWorkingDirectory).toHaveBeenCalledWith('thread-1', null);
    expect(result.output).toContain('now start in: /projects/test');
  });

  it('refuses a folder the checks reject, naming the reason, and writes nothing', async () => {
    mockValidateWorkingDirectory.mockRejectedValue(
      new Error('Thread working directory must be inside the project folder')
    );
    await expect(
      threadUpdate({ thread: { title: 'x', working_directory: '/elsewhere' } }, {}, ctx)
    ).rejects.toThrow(
      'thread_update: thread.working_directory: Thread working directory must be inside the project folder'
    );
    expect(mockSetWorkingDirectory).not.toHaveBeenCalled();
    expect(mockThreadUpdateSettings).not.toHaveBeenCalled();
  });

  it('a thread with no project folder cannot take one (the check says a project folder is needed)', async () => {
    mockFindProjectAncestor.mockResolvedValue(null);
    mockValidateWorkingDirectory.mockRejectedValue(
      new Error('A project folder is required to validate the thread working directory')
    );
    await expect(
      threadUpdate({ thread: { working_directory: WORKTREE } }, {}, ctx)
    ).rejects.toThrow('A project folder is required');
    expect(mockValidateWorkingDirectory).toHaveBeenCalledWith(WORKTREE, null);
  });

  it('rejects an empty or non-string folder', async () => {
    for (const bad of ['', '   ', 5]) {
      await expect(threadUpdate({ thread: { working_directory: bad } }, {}, ctx)).rejects.toThrow(
        'thread.working_directory must be a non-empty string or null'
      );
    }
    expect(mockSetWorkingDirectory).not.toHaveBeenCalled();
  });

  it('can be combined with other settings in one update', async () => {
    await threadUpdate({ thread: { title: 'After', working_directory: WORKTREE } }, {}, ctx);
    expect(mockThreadUpdateSettings).toHaveBeenCalledWith('thread-1', { title: 'After' });
    expect(mockSetWorkingDirectory).toHaveBeenCalledWith('thread-1', WORKTREE);
  });
});
