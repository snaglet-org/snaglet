// Unit tests for the thread_create tool.
//
// Covers thread_create's creation-time inputs: (1) a thread system prompt
// written straight to threads.thread_system_prompt, (2) participant agents
// via `agent_ids`, and (3) the automatic human roster — create adds every
// local user, and creates the local user only when none exist. The
// unsupported participant_agent_ids / participant_user_ids / agents params
// fail loudly with guidance naming the params to use.
const mockThreadFindById = jest.fn();
const mockThreadCreate = jest.fn();
const mockThreadUpdateSettings = jest.fn();
const mockNodesGetProjectId = jest.fn();
const mockContainerFindById = jest.fn();
const mockNearestProjectForContainer = jest.fn();
const mockAgentFindById = jest.fn();
const mockListByThread = jest.fn();
const mockUsersList = jest.fn();
const mockGetOrCreateLocalUser = jest.fn();
const mockAddParticipant = jest.fn();
const mockAddUserParticipant = jest.fn();
const mockMessagesCreate = jest.fn();
const mockDispatchToThread = jest.fn();
const mockBroadcastToChannel = jest.fn();
const mockHooksEmit = jest.fn();
const mockEmitThreadCreated = jest.fn();
const mockEmitTreeNodeCreated = jest.fn();

jest.mock('@snaglet/db/tables/threads', () => ({
  Threads: {
    findById: mockThreadFindById,
    create: mockThreadCreate,
    updateSettings: mockThreadUpdateSettings,
  },
}));
jest.mock('@snaglet/db/tables/nodes', () => ({
  Nodes: { getProjectId: mockNodesGetProjectId },
}));
jest.mock('@snaglet/db/tables/containers', () => ({
  Containers: { findById: mockContainerFindById },
}));
jest.mock('@snaglet/db/tables/projects', () => ({
  Projects: { nearestProjectForContainer: mockNearestProjectForContainer },
}));
jest.mock('@snaglet/db/tables/thread_participants', () => ({
  ThreadParticipants: {
    addParticipant: mockAddParticipant,
    addUserParticipant: mockAddUserParticipant,
    listByThread: mockListByThread,
  },
}));
jest.mock('@snaglet/db/tables/agents', () => ({
  Agents: { findById: mockAgentFindById },
}));
jest.mock('@snaglet/db/tables/users', () => ({
  Users: {
    list: mockUsersList,
    getOrCreateLocalUser: mockGetOrCreateLocalUser,
  },
}));
jest.mock('@snaglet/db/tables/messages', () => ({
  Messages: { create: mockMessagesCreate },
}));
jest.mock('@server/services/SocketService/dispatch/dispatchToThread', () => ({
  dispatchToThread: (...args: unknown[]) => mockDispatchToThread(...args),
}));
jest.mock('@server/services/WebSocketService', () => ({
  wsService: {
    broadcastToChannel: (...args: unknown[]) => mockBroadcastToChannel(...args),
  },
}));
jest.mock('@server/services/LogsService', () => ({
  LogsService: {
    socket: { event: jest.fn() },
    error: jest.fn(),
  },
}));
jest.mock('@server/services/HookService', () => ({
  hooks: { emit: mockHooksEmit },
}));
jest.mock('@server/realtime/surfaces/threads', () => ({
  emitThreadCreated: mockEmitThreadCreated,
  snapshotFromThreadNode: (thread: { id: string }) => ({ id: thread.id }),
}));
jest.mock('@server/realtime/surfaces/tree', () => ({
  emitTreeNodeCreated: mockEmitTreeNodeCreated,
  snapshotFromThread: (thread: { id: string }) => ({ id: thread.id }),
}));

import threadCreate from '@server/services/ToolService/handlers/threads/threadCreate';

const ctx = {} as never;

interface ThreadCreateRawContent {
  thread_id: string;
  title: string;
  project_id: string | null;
  dispatch_mode: string;
  system_prompt: string | null;
  agent_ids: string[];
  participant_user_ids: string[];
  initial_message_id: string | null;
}

function fakeThread(id: string, projectId: string | null = null) {
  return {
    id,
    title: 'placeholder',
    projectId,
    sortOrder: 0,
    dispatchMode: 'mentioned',
    maxAgentDispatches: null,
    threadSystemPrompt: null,
    configJson: {},
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: null,
    archived: false,
    archivedAt: null,
  };
}

describe('thread_create tool', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockThreadFindById.mockImplementation(async (id: string) => fakeThread(id));
    mockThreadCreate.mockImplementation(async (input: { id: string; projectId: string | null }) =>
      fakeThread(input.id, input.projectId)
    );
    mockThreadUpdateSettings.mockResolvedValue(fakeThread('unused'));
    mockNodesGetProjectId.mockResolvedValue(null);
    mockContainerFindById.mockImplementation(async (id: string) => ({
      id,
      name: id,
      category: id.startsWith('project-') ? 'project' : null,
      archived: false,
    }));
    mockNearestProjectForContainer.mockResolvedValue(null);
    mockAgentFindById.mockResolvedValue({ id: 'agent-1', name: 'Lyra' });
    mockListByThread.mockResolvedValue([]);
    mockUsersList.mockResolvedValue([{ id: 'owner-1', name: 'Test User' }]);
    mockGetOrCreateLocalUser.mockResolvedValue({ id: 'owner-local', name: 'Local' });
    mockAddParticipant.mockResolvedValue({ id: 'tp-1' });
    mockAddUserParticipant.mockResolvedValue({ id: 'tp-2' });
    mockMessagesCreate.mockResolvedValue({ id: 'message-initial' });
    mockDispatchToThread.mockResolvedValue({ ok: true, reason: 'dispatched', wakeCount: 1 });
  });

  describe('minimal call (owner added automatically, no agents)', () => {
    it('produces the expected output and rawContent defaults, with the owner as the human', async () => {
      const result = (await threadCreate({ title: 'Ops Room' }, {}, ctx)) as {
        output: string;
        rawContent: ThreadCreateRawContent;
      };

      const id = result.rawContent.thread_id;
      expect(result.output).toBe(
        [
          `Created thread 'Ops Room' (id=${id})`,
          '  dispatch_mode: mentioned',
          '  project_id:    (none — flat)',
          '  participants:  (none)',
          '  human_participants: owner-1',
        ].join('\n')
      );
      expect(result.rawContent).toEqual({
        thread_id: id,
        title: 'Ops Room',
        project_id: null,
        dispatch_mode: 'mentioned',
        system_prompt: null,
        agent_ids: [],
        participant_user_ids: ['owner-1'],
        initial_message_id: null,
      });

      // No follow-up settings write when system_prompt is absent — the single
      // create call carries everything.
      expect(mockThreadUpdateSettings).not.toHaveBeenCalled();
      expect(mockThreadCreate).toHaveBeenCalledWith(
        expect.objectContaining({ threadSystemPrompt: null }),
        expect.anything()
      );
      // No agent participants, but the owner is added as the human.
      expect(mockAddParticipant).not.toHaveBeenCalled();
      expect(mockAddUserParticipant).toHaveBeenCalledWith(
        { threadId: id, userId: 'owner-1' },
        expect.anything()
      );
    });
  });

  describe('project scope', () => {
    const projectCtx = { threadId: 'thread-caller' } as never;

    it("inherits the calling thread's project when project_id is omitted", async () => {
      mockNodesGetProjectId.mockResolvedValue('project-1');

      const result = (await threadCreate({ title: 'Sub-thread' }, {}, projectCtx)) as {
        output: string;
        rawContent: ThreadCreateRawContent;
      };

      expect(mockNodesGetProjectId).toHaveBeenCalledWith('thread-caller');
      expect(mockThreadCreate).toHaveBeenCalledWith(
        expect.objectContaining({ projectId: 'project-1' }),
        expect.anything()
      );
      expect(result.rawContent.project_id).toBe('project-1');
      expect(result.output).toContain('project_id:    project-1');
    });

    it('a flat caller creates a flat thread', async () => {
      mockNodesGetProjectId.mockResolvedValue(null);

      const result = (await threadCreate({ title: 'Flat' }, {}, projectCtx)) as {
        rawContent: ThreadCreateRawContent;
      };

      expect(mockThreadCreate).toHaveBeenCalledWith(
        expect.objectContaining({ projectId: null }),
        expect.anything()
      );
      expect(result.rawContent.project_id).toBeNull();
    });

    it('an explicit project_id: null creates a flat thread even from a project thread', async () => {
      mockNodesGetProjectId.mockResolvedValue('project-1');

      const result = (await threadCreate({ title: 'Flat', project_id: null }, {}, projectCtx)) as {
        rawContent: ThreadCreateRawContent;
      };

      expect(mockNodesGetProjectId).not.toHaveBeenCalled();
      expect(mockThreadCreate).toHaveBeenCalledWith(
        expect.objectContaining({ projectId: null }),
        expect.anything()
      );
      expect(result.rawContent.project_id).toBeNull();
    });

    it('an explicit project_id wins over the caller thread', async () => {
      mockNodesGetProjectId.mockResolvedValue('project-1');

      const result = (await threadCreate(
        { title: 'Elsewhere', project_id: 'project-2' },
        {},
        projectCtx
      )) as { rawContent: ThreadCreateRawContent };

      expect(mockThreadCreate).toHaveBeenCalledWith(
        expect.objectContaining({ projectId: 'project-2' }),
        expect.anything()
      );
      expect(result.rawContent.project_id).toBe('project-2');
    });

    it('rejects a non-project container, naming the nearest project', async () => {
      mockNearestProjectForContainer.mockResolvedValue('project-1');

      const result = (await threadCreate(
        { title: 'Misfiled', project_id: 'container-folder' },
        {},
        ctx
      )) as { output: string };

      expect(result.output).toContain("'container-folder' is a plain container, not a project");
      expect(result.output).toContain('threads attach to a project, not to any other container');
      expect(result.output).toContain("nearest project above it is 'project-1'");
      expect(mockNearestProjectForContainer).toHaveBeenCalledWith('container-folder');
      expect(mockThreadCreate).not.toHaveBeenCalled();
    });

    it('rejects a non-project container with no enclosing project', async () => {
      const result = (await threadCreate(
        { title: 'Misfiled', project_id: 'container-folder' },
        {},
        ctx
      )) as { output: string };

      expect(result.output).toContain('No project encloses it');
      expect(mockThreadCreate).not.toHaveBeenCalled();
    });

    it('rejects an unknown project_id', async () => {
      mockContainerFindById.mockResolvedValue(null);

      const result = (await threadCreate({ title: 'Lost', project_id: 'project-x' }, {}, ctx)) as {
        output: string;
      };

      expect(result.output).toBe(
        "thread_create: project 'project-x' not found — nothing was created."
      );
      expect(mockThreadCreate).not.toHaveBeenCalled();
    });

    it('surfaces an archived-project refusal from the model as a tool error', async () => {
      mockThreadCreate.mockRejectedValue(
        new Error('Project project-1 is archived; restore it or choose a live project')
      );

      const result = (await threadCreate({ title: 'Stale', project_id: 'project-1' }, {}, ctx)) as {
        output: string;
      };

      expect(result.output).toBe(
        'thread_create: Project project-1 is archived; restore it or choose a live project'
      );
      expect(mockAddParticipant).not.toHaveBeenCalled();
    });

    it('rejects the retired container_id parameter and points at project_id', async () => {
      const result = (await threadCreate(
        { title: 'Old shape', container_id: 'container-1' },
        {},
        ctx
      )) as { output: string };

      expect(result.output).toContain('`container_id` is not a thread parameter');
      expect(result.output).not.toMatch(/\bfolder\b/);
      expect(result.output).toContain('`project_id`');
      expect(mockThreadCreate).not.toHaveBeenCalled();
    });
  });

  describe('initial_message delivery', () => {
    const agentContext = { agentId: 'agent-author' } as never;

    it('posts a mentioned-mode @participant opener through shared delivery after registration', async () => {
      const result = (await threadCreate(
        {
          title: 'Mentioned opener',
          agent_ids: ['agent-1'],
          initial_message: '@Lyra start now',
        },
        {},
        agentContext
      )) as { rawContent: ThreadCreateRawContent };

      const id = result.rawContent.thread_id;
      expect(mockMessagesCreate).toHaveBeenCalledWith({
        id: result.rawContent.initial_message_id,
        threadId: id,
        agentId: 'agent-author',
        content: '@Lyra start now',
        role: 'assistant',
        messageType: 'message',
        // postAgentMessageToThread stamps chain context; null outside a hook chain.
        metadata: null,
      });
      expect(mockAddParticipant.mock.invocationCallOrder[0]).toBeLessThan(
        mockMessagesCreate.mock.invocationCallOrder[0]
      );
      expect(mockDispatchToThread).toHaveBeenCalledWith({
        threadId: id,
        senderId: 'agent-author',
        messageId: result.rawContent.initial_message_id,
        message: '@Lyra start now',
        source: 'tool',
        sender: { kind: 'agent' },
      });
      expect(result.rawContent.initial_message_id).toEqual(expect.any(String));
    });

    it.each(['mentioned', 'all'] as const)(
      'routes a no-mention opener in %s mode through the same delivery path as thread_send',
      async (dispatchMode) => {
        const result = (await threadCreate(
          {
            title: `${dispatchMode} opener`,
            dispatch_mode: dispatchMode,
            agent_ids: ['agent-1'],
            initial_message: 'Start now',
          },
          {},
          agentContext
        )) as { rawContent: ThreadCreateRawContent };

        expect(mockThreadCreate).toHaveBeenCalledWith(
          expect.objectContaining({ dispatchMode }),
          expect.anything()
        );
        expect(mockDispatchToThread).toHaveBeenCalledWith({
          threadId: result.rawContent.thread_id,
          senderId: 'agent-author',
          messageId: result.rawContent.initial_message_id,
          message: 'Start now',
          source: 'tool',
          sender: { kind: 'agent' },
        });
        expect(result.rawContent.initial_message_id).toEqual(expect.any(String));
      }
    );
  });

  describe('initial_message origin footer', () => {
    const ORIGIN_THREAD = 'thread-origin';
    const originContext = { agentId: 'agent-author', threadId: ORIGIN_THREAD } as never;

    /** The content handed to the message store for the initial message. */
    function persistedContent(): string {
      expect(mockMessagesCreate).toHaveBeenCalledTimes(1);
      return (mockMessagesCreate.mock.calls[0][0] as { content: string }).content;
    }

    beforeEach(() => {
      mockThreadFindById.mockImplementation(async (id: string) => ({
        ...fakeThread(id),
        title: id === ORIGIN_THREAD ? 'Ops Room' : 'placeholder',
      }));
      mockAgentFindById.mockImplementation(async (id: string) => ({
        id,
        name: id === 'agent-author' ? 'Test Author' : 'Lyra',
      }));
    });

    it('appends a footer naming the creator, origin chip and exact reply call', async () => {
      await threadCreate(
        { title: 'Child', initial_message: 'Please take this.' },
        {},
        originContext
      );

      expect(persistedContent()).toBe(
        'Please take this.\n\n' +
          `— @Test Author created this thread from [Ops Room](${ORIGIN_THREAD}) and posted this ` +
          `message from there. To reply in that thread, call thread with op:"send" and id:"${ORIGIN_THREAD}".`
      );
    });

    it('dispatches the footered text, so woken agents see the return address', async () => {
      const result = (await threadCreate(
        { title: 'Child', agent_ids: ['agent-1'], initial_message: '@Lyra go' },
        {},
        originContext
      )) as { rawContent: ThreadCreateRawContent };

      expect(mockDispatchToThread).toHaveBeenCalledWith(
        expect.objectContaining({
          threadId: result.rawContent.thread_id,
          message: persistedContent(),
        })
      );
      expect(persistedContent()).toContain(`id:"${ORIGIN_THREAD}"`);
    });

    it('appends no footer when the caller has no thread context', async () => {
      await threadCreate({ title: 'Child', initial_message: 'Please take this.' }, {}, {
        agentId: 'agent-author',
      } as never);

      expect(persistedContent()).toBe('Please take this.');
      expect(mockThreadFindById).not.toHaveBeenCalledWith(ORIGIN_THREAD);
    });

    it('appends nothing when there is no initial_message', async () => {
      await threadCreate({ title: 'Child' }, {}, originContext);

      expect(mockMessagesCreate).not.toHaveBeenCalled();
    });

    it('still creates the thread and posts the message when the origin lookup rejects', async () => {
      // Only the origin lookup fails; delivery still resolves the new thread.
      mockThreadFindById.mockImplementation(async (id: string) => {
        if (id === ORIGIN_THREAD) throw new Error('db down');
        return fakeThread(id);
      });

      const result = (await threadCreate(
        { title: 'Child', initial_message: 'Please take this.' },
        {},
        originContext
      )) as { rawContent: ThreadCreateRawContent };

      expect(result.rawContent.initial_message_id).toEqual(expect.any(String));
      expect(persistedContent()).toContain(
        `created this thread from [Untitled Thread](${ORIGIN_THREAD})`
      );
      expect(persistedContent()).toContain(`id:"${ORIGIN_THREAD}"`);
    });

    it('still creates the thread and posts the message when the agent lookup rejects', async () => {
      // Only the creator lookup fails; participant validation is unaffected.
      mockAgentFindById.mockImplementation(async (id: string) => {
        if (id === 'agent-author') throw new Error('db down');
        return { id, name: 'Lyra' };
      });

      const result = (await threadCreate(
        { title: 'Child', initial_message: 'Please take this.' },
        {},
        originContext
      )) as { rawContent: ThreadCreateRawContent };

      expect(result.rawContent.initial_message_id).toEqual(expect.any(String));
      expect(persistedContent()).toContain('— an agent created this thread from [Ops Room]');
    });
  });

  describe('system_prompt', () => {
    it('is written straight to threads.thread_system_prompt in the create call', async () => {
      const result = (await threadCreate(
        { title: 'Briefing', system_prompt: 'You are terse.' },
        {},
        ctx
      )) as { output: string; rawContent: ThreadCreateRawContent };

      // One write, not create-then-patch: the resolver reads the column, so
      // there is no reason to round-trip through a settings update.
      expect(mockThreadUpdateSettings).not.toHaveBeenCalled();
      expect(mockThreadCreate).toHaveBeenCalledWith(
        expect.objectContaining({ threadSystemPrompt: 'You are terse.' }),
        expect.anything()
      );
      expect(result.rawContent.system_prompt).toBe('You are terse.');
      expect(result.output).toContain('system_prompt: set (14 chars)');
    });

    it('trims whitespace and stores null when blank', async () => {
      const result = (await threadCreate({ title: 'Blank', system_prompt: '   ' }, {}, ctx)) as {
        rawContent: ThreadCreateRawContent;
      };
      expect(mockThreadUpdateSettings).not.toHaveBeenCalled();
      expect(mockThreadCreate).toHaveBeenCalledWith(
        expect.objectContaining({ threadSystemPrompt: null }),
        expect.anything()
      );
      expect(result.rawContent.system_prompt).toBeNull();
    });
  });

  describe('agent_ids', () => {
    it('adds each agent once via ThreadParticipants.addParticipant', async () => {
      mockAgentFindById.mockImplementation(async (id: string) => ({ id, name: id }));

      const result = (await threadCreate(
        { title: 'Pairing', agent_ids: ['agent-a', 'agent-b', 'agent-a'] },
        {},
        ctx
      )) as { rawContent: ThreadCreateRawContent };

      const id = result.rawContent.thread_id;
      expect(mockAddParticipant.mock.calls.map((call) => call[0])).toEqual([
        { threadId: id, agentId: 'agent-a' },
        { threadId: id, agentId: 'agent-b' },
      ]);
      expect(result.rawContent.agent_ids).toEqual(['agent-a', 'agent-b']);
    });

    it('rejects an unknown agent_id — nothing is created (thread included)', async () => {
      mockAgentFindById.mockResolvedValue(null);

      const result = (await threadCreate({ title: 'Ghost', agent_ids: ['ghost'] }, {}, ctx)) as {
        output: string;
      };

      expect(result.output).toBe("thread_create: agent 'ghost' not found — nothing was created.");
      expect(mockThreadCreate).not.toHaveBeenCalled();
      expect(mockAddParticipant).not.toHaveBeenCalled();
    });

    it('rejects a non-array or a non-string entry', async () => {
      const notArray = (await threadCreate({ title: 'X', agent_ids: 'agent-1' }, {}, ctx)) as {
        output: string;
      };
      expect(notArray.output).toContain('`agent_ids` must be an array');
      const badEntry = (await threadCreate({ title: 'X', agent_ids: [42] }, {}, ctx)) as {
        output: string;
      };
      expect(badEntry.output).toContain('empty or non-string entry');
      expect(mockThreadCreate).not.toHaveBeenCalled();
    });
  });

  describe('retired roster params fail loudly (nothing created)', () => {
    it('rejects agents[] and points at agent_ids', async () => {
      const result = (await threadCreate(
        { title: 'Old shape', agents: [{ agent_id: 'agent-1', system_prompt_addendum: 'x' }] },
        {},
        ctx
      )) as { output: string };

      expect(result.output).toContain('`agents` was removed — pass `agent_ids`');
      expect(mockThreadCreate).not.toHaveBeenCalled();
      expect(mockAddParticipant).not.toHaveBeenCalled();
    });

    it('rejects participant_agent_ids and points at agent_ids', async () => {
      const result = (await threadCreate(
        { title: 'Old shape', participant_agent_ids: ['agent-1'] },
        {},
        ctx
      )) as { output: string };

      expect(result.output).toBe(
        'thread_create: `participant_agent_ids` was renamed — pass `agent_ids`.'
      );
      expect(mockThreadCreate).not.toHaveBeenCalled();
      expect(mockAddParticipant).not.toHaveBeenCalled();
    });

    it('rejects participant_user_ids (humans are added automatically)', async () => {
      const result = (await threadCreate(
        { title: 'Old shape', participant_user_ids: [1] },
        {},
        ctx
      )) as { output: string };

      expect(result.output).toContain('`participant_user_ids` was removed');
      expect(mockThreadCreate).not.toHaveBeenCalled();
      expect(mockAddUserParticipant).not.toHaveBeenCalled();
    });
  });

  describe('automatic human roster', () => {
    it('adds every local user, de-duplicated, regardless of the calling thread', async () => {
      mockUsersList.mockResolvedValue([{ id: 'human-7' }, { id: 'human-8' }, { id: 'human-7' }]);
      mockListByThread.mockResolvedValue([{ kind: 'user', userId: 'someone-else' }]);

      const result = (await threadCreate({ title: 'Scoped' }, {}, {
        threadId: 'thread-caller',
      } as never)) as { rawContent: ThreadCreateRawContent };

      const id = result.rawContent.thread_id;
      expect(mockUsersList).toHaveBeenCalledWith({ orderBy: 'id', order: 'ASC' });
      expect(mockListByThread).not.toHaveBeenCalled();
      expect(mockGetOrCreateLocalUser).not.toHaveBeenCalled();
      expect(result.rawContent.participant_user_ids).toEqual(['human-7', 'human-8']);
      expect(mockAddUserParticipant.mock.calls.map((call) => call[0])).toEqual([
        { threadId: id, userId: 'human-7' },
        { threadId: id, userId: 'human-8' },
      ]);
    });

    it('creates the local user only when no users exist', async () => {
      mockUsersList.mockResolvedValue([]);

      const result = (await threadCreate({ title: 'Empty' }, {}, ctx)) as {
        rawContent: ThreadCreateRawContent;
      };

      expect(mockGetOrCreateLocalUser).toHaveBeenCalled();
      expect(result.rawContent.participant_user_ids).toEqual(['owner-local']);
    });
  });

  describe('one transaction', () => {
    it('writes the thread and every participant on the same tx', async () => {
      await threadCreate({ title: 'Atomic', agent_ids: ['agent-1', 'agent-2'] }, {}, ctx);

      const tx = mockThreadCreate.mock.calls[0][1];
      expect(tx).toBeDefined();
      expect(mockAddParticipant.mock.calls.map((call) => call[1])).toEqual([tx, tx]);
      // The auto-resolved owner is written as a human participant on the same tx.
      expect(mockAddUserParticipant.mock.calls[0][1]).toBe(tx);
    });

    it('throws a participant failure (no event) instead of turning it into a tool error', async () => {
      // The owner's human-participant write fails inside the transaction.
      mockAddUserParticipant.mockRejectedValue(new Error('participant write failed'));

      await expect(threadCreate({ title: 'Atomic' }, {}, ctx)).rejects.toThrow(
        'participant write failed'
      );
      expect(mockEmitTreeNodeCreated).not.toHaveBeenCalled();
      expect(mockEmitThreadCreated).not.toHaveBeenCalled();
    });
  });
});
