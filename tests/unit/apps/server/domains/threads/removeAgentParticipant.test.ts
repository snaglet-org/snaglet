/**
 * removeAgentParticipant: the one removal behind the app's Remove button and
 * the thread tool's leave / remove_agents. It removes the participant row
 * by its own key, logs only when an acting agent is known, and narrates the
 * "left the thread" roster line the open chat reloads on.
 */
const mockListByThread = jest.fn();
const mockRemoveById = jest.fn();
const mockLogActivity = jest.fn();
const mockEmitRemoved = jest.fn();

jest.mock('@snaglet/db/tables/thread_participants', () => ({
  ThreadParticipants: {
    listByThread: (...args: unknown[]) => mockListByThread(...args),
    removeById: (...args: unknown[]) => mockRemoveById(...args),
  },
}));
jest.mock('@snaglet/db/tables/agent_activity_log', () => ({
  AgentActivityLog: { logActivity: (...args: unknown[]) => mockLogActivity(...args) },
}));
jest.mock('@server/services/SocketService/threadEvents', () => ({
  emitParticipantRemovedEvent: (...args: unknown[]) => mockEmitRemoved(...args),
}));

import { removeAgentParticipant } from '@server/domains/threads/removeAgentParticipant';
import { threadRosterVersion } from '@server/services/SocketService/dispatch/rosterVersion';

beforeEach(() => {
  jest.clearAllMocks();
  mockListByThread.mockResolvedValue([
    { id: 'tp-1', kind: 'agent', agentId: 'agent-lead' },
    { id: 'tp-2', kind: 'agent', agent_id: 'agent-nova' },
  ]);
  mockRemoveById.mockResolvedValue(true);
  mockLogActivity.mockResolvedValue({ id: 'log-1' });
});

describe('removeAgentParticipant', () => {
  it('removes the row by its own key, narrates the change and bumps the thread roster', async () => {
    const before = threadRosterVersion('thread-1');
    await expect(
      removeAgentParticipant({ threadId: 'thread-1', agentId: 'agent-nova' })
    ).resolves.toBe(true);
    expect(mockRemoveById).toHaveBeenCalledWith('tp-2');
    expect(mockEmitRemoved).toHaveBeenCalledWith('thread-1', 'agent-nova');
    expect(mockLogActivity).not.toHaveBeenCalled();
    // A run going on in the thread stops routing mentions to the removed agent.
    expect(threadRosterVersion('thread-1')).toBe(before + 1);
  });

  it('logs the removal when an acting agent is known', async () => {
    await removeAgentParticipant({
      threadId: 'thread-1',
      agentId: 'agent-nova',
      actorAgentId: 'agent-lead',
      actorUserId: 'user-1',
    });
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: 'agent-lead',
        tool: 'threads.remove_participant',
        toolInput: expect.objectContaining({ removedAgentId: 'agent-nova', actorUserId: 'user-1' }),
      })
    );
  });

  it('returns false, and does nothing, for an agent that is not a participant', async () => {
    const before = threadRosterVersion('thread-1');
    await expect(
      removeAgentParticipant({ threadId: 'thread-1', agentId: 'agent-ghost' })
    ).resolves.toBe(false);
    expect(threadRosterVersion('thread-1')).toBe(before);
    expect(mockRemoveById).not.toHaveBeenCalled();
    expect(mockEmitRemoved).not.toHaveBeenCalled();
  });

  it('returns false without narrating when the row was already gone', async () => {
    mockRemoveById.mockResolvedValue(false);
    await expect(
      removeAgentParticipant({ threadId: 'thread-1', agentId: 'agent-lead' })
    ).resolves.toBe(false);
    expect(mockEmitRemoved).not.toHaveBeenCalled();
  });
});
