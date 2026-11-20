const abortAgentRun = jest.fn();
jest.mock('@server/services/AbortRunService', () => ({
  AbortRunService: { abortAgentRun: (...args: unknown[]) => abortAgentRun(...args) },
}));

const findAgent = jest.fn();
jest.mock('@snaglet/db/tables/agents', () => ({
  Agents: { findById: (...args: unknown[]) => findAgent(...args) },
}));

const getCurrentActor = jest.fn();
jest.mock('@server/realtime/actorContext', () => ({
  getCurrentActor: () => getCurrentActor(),
}));

import tool from '@server/services/ToolService/handlers/agents/abortAgentRun';

describe('abort_agent_run tool', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    findAgent.mockResolvedValue({ id: 'agent-a', name: 'Aster' });
  });

  it('lets the calling agent abort its own run with authoritative identity', async () => {
    abortAgentRun.mockResolvedValue({ aborted: true, reason: 'aborted' });

    const output = await tool(
      { thread_id: 'thread-1', agent_id: 'agent-a' },
      {},
      { agentId: 'agent-a' }
    );

    expect(abortAgentRun).toHaveBeenCalledWith({
      threadId: 'thread-1',
      agentId: 'agent-a',
      abortedBy: { actorKind: 'agent', actorId: 'agent-a', actorName: 'Aster' },
    });
    expect(JSON.parse(output as string)).toEqual({ aborted: true, reason: 'aborted' });
  });

  it('rejects an agent caller attempting to abort a different agent', async () => {
    await expect(
      tool({ thread_id: 'thread-1', agent_id: 'agent-b' }, {}, { agentId: 'agent-a' })
    ).rejects.toThrow('Agent callers may only abort their own active run');

    expect(abortAgentRun).not.toHaveBeenCalled();
  });

  it('uses the authenticated external MCP member identity', async () => {
    getCurrentActor.mockReturnValue({
      actorKind: 'external',
      actorId: 'member-1',
      actorName: 'Codex',
    });
    abortAgentRun.mockResolvedValue({ aborted: false, reason: 'agent_not_active' });

    const output = await tool({ thread_id: 'thread-1', agent_id: 'venus' }, {}, {});

    expect(abortAgentRun).toHaveBeenCalledWith(
      expect.objectContaining({
        abortedBy: { actorKind: 'external', actorId: 'member-1', actorName: 'Codex' },
      })
    );
    expect(JSON.parse(output as string)).toEqual({
      aborted: false,
      reason: 'agent_not_active',
    });
  });

  it('requires explicit thread and agent ids', async () => {
    await expect(tool({}, {}, { agentId: 'agent-a' })).rejects.toThrow('thread_id is required');
    await expect(tool({ thread_id: 'thread-1' }, {}, { agentId: 'agent-a' })).rejects.toThrow(
      'agent_id is required'
    );
    expect(abortAgentRun).not.toHaveBeenCalled();
  });
});
