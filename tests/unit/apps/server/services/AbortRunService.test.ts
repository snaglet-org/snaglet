const signalAgentRun = jest.fn();
const abortThread = jest.fn();
const listActiveAgentRuns = jest.fn();
jest.mock('@server/services/SocketService/abortStore', () => ({
  abortAgentRun: (...args: unknown[]) => signalAgentRun(...args),
  abortThread: (...args: unknown[]) => abortThread(...args),
  listActiveAgentRuns: (...args: unknown[]) => listActiveAgentRuns(...args),
}));

const killShellSessionsForAgent = jest.fn();
jest.mock('@server/services/ToolService/tools/shell/codex-shell-sessions', () => ({
  killShellSessionsForAgent: (...args: unknown[]) => killShellSessionsForAgent(...args),
}));

const findAgent = jest.fn();
jest.mock('@snaglet/db/tables/agents', () => ({
  Agents: { findById: (...args: unknown[]) => findAgent(...args) },
}));

const createEvent = jest.fn();
jest.mock('@snaglet/db/tables/messages', () => ({
  Messages: { createEvent: (...args: unknown[]) => createEvent(...args) },
}));

const broadcastToChannel = jest.fn();
jest.mock('@server/services/WebSocketService', () => ({
  wsService: { broadcastToChannel: (...args: unknown[]) => broadcastToChannel(...args) },
}));

import { AbortRunService } from '@server/services/AbortRunService';

describe('AbortRunService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    findAgent.mockResolvedValue({ id: 'venus', name: 'Venus' });
    createEvent.mockResolvedValue({ id: 'event-1', createdAt: '2026-07-13T00:00:00.000Z' });
    killShellSessionsForAgent.mockReturnValue(1);
  });

  it.each([
    [{ actorKind: 'user', actorId: 'user-1', actorName: 'Test User' }, 'Test User'],
    [{ actorKind: 'agent', actorId: 'agent-a', actorName: 'Aster' }, 'Aster'],
    [{ actorKind: 'external', actorId: 'member-1', actorName: 'Codex' }, 'Codex'],
    [{ actorKind: 'system', actorId: 'watchdog', actorName: 'watchdog' }, 'watchdog'],
  ] as const)('persists and broadcasts attribution for %s', async (abortedBy, label) => {
    signalAgentRun.mockReturnValue({ aborted: true, sessionId: 'session-1' });

    await expect(
      AbortRunService.abortAgentRun({ threadId: 'thread-1', agentId: 'venus', abortedBy })
    ).resolves.toMatchObject({ aborted: true, killedShells: 1 });

    expect(killShellSessionsForAgent).toHaveBeenCalledWith('thread-1', 'venus');
    expect(createEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        threadId: 'thread-1',
        content: `[${label}] aborted [Venus]`,
        metadata: expect.objectContaining({
          aborted_by_kind: abortedBy.actorKind,
          aborted_by_name: label,
          target_agent_id: 'venus',
        }),
      })
    );
    expect(broadcastToChannel).toHaveBeenCalledWith(
      'thread-1',
      expect.objectContaining({
        type: 'socket:chat:aborted',
        payload: expect.objectContaining({ agentId: 'venus', abortedBy }),
      })
    );
  });

  it('returns a clean no-op for an inactive target', async () => {
    signalAgentRun.mockReturnValue({ aborted: false });

    await expect(
      AbortRunService.abortAgentRun({
        threadId: 'thread-1',
        agentId: 'venus',
        abortedBy: { actorKind: 'user', actorId: 'user-1', actorName: 'Test User' },
      })
    ).resolves.toEqual({ aborted: false, reason: 'agent_not_active' });
    expect(killShellSessionsForAgent).not.toHaveBeenCalled();
    expect(createEvent).not.toHaveBeenCalled();
    expect(broadcastToChannel).not.toHaveBeenCalled();
  });

  it('stop-all routes each live agent through abortAgentRun and trips the parent signal', async () => {
    listActiveAgentRuns.mockReturnValue([
      { agentId: 'agent-a', sessionId: 'session-1' },
      { agentId: 'agent-b', sessionId: 'session-1' },
    ]);
    signalAgentRun.mockImplementation((_threadId: string, agentId: string) => ({
      aborted: true,
      sessionId: `session-${agentId}`,
    }));

    await expect(
      AbortRunService.abortAllAgentRuns({
        threadId: 'thread-1',
        abortedBy: { actorKind: 'user', actorId: 'user-1', actorName: 'Test User' },
      })
    ).resolves.toEqual({ abortedCount: 2 });
    expect(createEvent).toHaveBeenCalledTimes(2);
    expect(abortThread).toHaveBeenCalledWith('thread-1', {
      kind: 'agent_run_abort',
      targetAgentId: '*',
      abortedBy: { actorKind: 'user', actorId: 'user-1', actorName: 'Test User' },
    });
  });
});
