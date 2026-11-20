// thread_read with no id reads the calling thread, same window.
const mockThreadFindById = jest.fn();
const mockListForThreadRead = jest.fn();
const mockGetCurrentActor = jest.fn();

jest.mock('@snaglet/db/tables/threads', () => ({ Threads: { findById: mockThreadFindById } }));
jest.mock('@snaglet/db/tables/messages', () => ({
  Messages: { listForThreadRead: mockListForThreadRead },
}));
jest.mock('@server/realtime/actorContext', () => ({
  getCurrentActor: () => mockGetCurrentActor(),
}));

import threadRead from '@server/services/ToolService/handlers/trivial/threadRead';
import threadDelete from '@server/services/ToolService/handlers/threads/threadDelete';

const HERE = { agentId: 'agent-venus', threadId: 'thread-here' } as never;

describe('thread_read default target', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetCurrentActor.mockReturnValue(null);
    mockThreadFindById.mockImplementation(async (id: string) =>
      id === 'thread-here' ? { id, title: 'Ops Room' } : null
    );
    mockListForThreadRead.mockResolvedValue([]);
  });

  it('no id → reads the calling thread with the same default window (50)', async () => {
    const out = JSON.parse(await threadRead({}, {}, HERE));
    expect(out.thread.id).toBe('thread-here');
    expect(mockListForThreadRead).toHaveBeenCalledWith('thread-here', {
      limit: 50,
      before: undefined,
    });
  });

  it('no id keeps limit and before cursor exactly as an explicit id would', async () => {
    await threadRead({ limit: 20, before: '2026-01-01T00:00:00Z' }, {}, HERE);
    await threadRead(
      { thread_id: 'thread-here', limit: 20, before: '2026-01-01T00:00:00Z' },
      {},
      HERE
    );
    expect(mockListForThreadRead.mock.calls[0]).toEqual(mockListForThreadRead.mock.calls[1]);
  });

  it('omits the run-ended UI footer but keeps other thread_event rows', async () => {
    const base = { role: 'user', agentId: null, userId: null, messageType: 'thread_event' };
    mockListForThreadRead.mockResolvedValue([
      {
        ...base,
        id: 'e1',
        content: '[agent run ended · Nova · 4s · 1 tool call]',
        metadata: { event_kind: 'agent_run_ended' },
        createdAt: 't1',
      },
      {
        ...base,
        id: 'e2',
        content: '[dispatch mode changed · all]',
        metadata: { event_kind: 'dispatch_mode_changed' },
        createdAt: 't2',
      },
    ]);
    const out = JSON.parse(await threadRead({}, {}, HERE));
    expect(out.messages.map((m: { id: string }) => m.id)).toEqual(['e2']);
  });

  it("unknown id names the caller's thread", async () => {
    await expect(threadRead({ thread_id: 'thread-guess' }, {}, HERE)).rejects.toThrow(
      'thread_read: thread not found: thread-guess. You are in thread `Ops Room` (`thread-here`)'
    );
  });
});

describe('thread_delete never defaults', () => {
  it('still requires an explicit id from inside a thread', async () => {
    await expect(
      Promise.resolve().then(() => threadDelete({ confirm: true } as never))
    ).rejects.toThrow('thread_id is required');
  });
});
