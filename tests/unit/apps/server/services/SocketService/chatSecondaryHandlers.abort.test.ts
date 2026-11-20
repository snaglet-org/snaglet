type Handler = (
  payload: { sessionId: string; agent_id?: string },
  meta: { clientId: string; externalCaller?: { memberId: string; name: string } }
) => Promise<void>;

let registered: Handler | null = null;
jest.mock('@server/services/WebSocketService', () => ({
  wsService: {
    registerHandler: (_type: string, handler: Handler) => {
      registered = handler;
    },
  },
}));

const getSession = jest.fn();
jest.mock('@server/services/SocketService/store', () => ({
  getSession: (...args: unknown[]) => getSession(...args),
}));

const abortAgentRun = jest.fn();
const abortAllAgentRuns = jest.fn();
jest.mock('@server/services/AbortRunService', () => ({
  AbortRunService: {
    abortAgentRun: (...args: unknown[]) => abortAgentRun(...args),
    abortAllAgentRuns: (...args: unknown[]) => abortAllAgentRuns(...args),
  },
}));

const getActiveUser = jest.fn();
jest.mock('@snaglet/db/tables/users', () => ({
  Users: {
    getActiveUser: (...args: unknown[]) => getActiveUser(...args),
    getOrCreateLocalUser: jest.fn(),
    findById: jest.fn(),
  },
}));

jest.mock('@server/services/ActiveRunTracker', () => ({
  activeRunTracker: {
    snapshot: () => ({ activeThreadCount: 1, activeRunCount: 2 }),
  },
}));
jest.mock('@server/config/logger', () => ({ logger: { info: jest.fn() } }));

const cancelClarificationsForThread = jest.fn();
jest.mock('@server/services/SocketService/clarification', () => ({
  resolveClarification: jest.fn(),
  cancelClarificationsForThread: (...args: unknown[]) => cancelClarificationsForThread(...args),
}));

import { registerChatAbortHandler } from '@server/services/SocketService/handlers/chatSecondaryHandlers';

describe('socket:chat:abort routing', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    registered = null;
    getSession.mockResolvedValue({ id: 'session-1', threadId: 'thread-1' });
    getActiveUser.mockResolvedValue({ id: 'user-1', name: 'Test User' });
    abortAgentRun.mockResolvedValue({ aborted: true, reason: 'aborted' });
    abortAllAgentRuns.mockResolvedValue({ abortedCount: 2 });
    registerChatAbortHandler();
  });

  it('routes a per-agent UI stop through AbortRunService with the user actor', async () => {
    await registered?.({ sessionId: 'session-1', agent_id: 'venus' }, { clientId: 'client-1' });

    expect(abortAgentRun).toHaveBeenCalledWith({
      threadId: 'thread-1',
      agentId: 'venus',
      abortedBy: { actorKind: 'user', actorId: 'user-1', actorName: 'Test User' },
    });
    expect(abortAllAgentRuns).not.toHaveBeenCalled();
  });

  it('keeps absent agent_id backward-compatible as stop-all', async () => {
    await registered?.({ sessionId: 'session-1' }, { clientId: 'client-1' });

    expect(abortAllAgentRuns).toHaveBeenCalledWith({
      threadId: 'thread-1',
      abortedBy: { actorKind: 'user', actorId: 'user-1', actorName: 'Test User' },
    });
    expect(abortAgentRun).not.toHaveBeenCalled();
  });

  it("cancels only the stopped agent's pending clarification", async () => {
    await registered?.({ sessionId: 'session-1', agent_id: 'venus' }, { clientId: 'client-1' });

    expect(cancelClarificationsForThread).toHaveBeenCalledWith('thread-1', 'venus');
  });

  it('cancels every pending clarification on the thread on stop-all, even with no live run', async () => {
    abortAllAgentRuns.mockResolvedValue({ abortedCount: 0 });

    await registered?.({ sessionId: 'session-1' }, { clientId: 'client-1' });

    expect(cancelClarificationsForThread).toHaveBeenCalledWith('thread-1', undefined);
  });

  it('attributes authenticated external websocket callers', async () => {
    await registered?.(
      { sessionId: 'session-1', agent_id: 'venus' },
      { clientId: 'client-1', externalCaller: { memberId: 'member-1', name: 'Codex' } }
    );

    expect(abortAgentRun).toHaveBeenCalledWith(
      expect.objectContaining({
        abortedBy: { actorKind: 'external', actorId: 'member-1', actorName: 'Codex' },
      })
    );
  });
});
