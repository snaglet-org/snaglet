// Thread tools default to the calling thread; errors name it.
const mockThreadFindById = jest.fn();
const mockGetCurrentActor = jest.fn();

jest.mock('@snaglet/db/tables/threads', () => ({
  Threads: { findById: mockThreadFindById },
}));
jest.mock('@server/realtime/actorContext', () => ({
  getCurrentActor: () => mockGetCurrentActor(),
}));

import {
  resolveTargetThreadId,
  threadNotFoundError,
} from '@server/services/ToolService/lib/targetThread';

const HERE = { threadId: 'thread-here' };

describe('resolveTargetThreadId', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetCurrentActor.mockReturnValue(null);
    mockThreadFindById.mockResolvedValue({ id: 'thread-here', title: 'Ops Room' });
  });

  it('an explicit thread_id wins over the calling thread', async () => {
    await expect(resolveTargetThreadId({ thread_id: ' thread-x ' }, HERE, 't')).resolves.toBe(
      'thread-x'
    );
  });

  it('no id → the calling thread', async () => {
    await expect(resolveTargetThreadId({}, HERE, 't')).resolves.toBe('thread-here');
    await expect(resolveTargetThreadId({ thread_id: '  ' }, HERE, 't')).resolves.toBe(
      'thread-here'
    );
  });

  it('external MCP callers must pass an id, even with a context thread', async () => {
    mockGetCurrentActor.mockReturnValue({ actorKind: 'external', actorId: 'm1' });
    await expect(resolveTargetThreadId({}, HERE, 'thread_send')).rejects.toThrow(
      'thread_send: thread id is required for external callers.'
    );
    await expect(resolveTargetThreadId({ thread_id: 'thread-x' }, undefined, 't')).resolves.toBe(
      'thread-x'
    );
  });

  it('no id and no calling thread → says to pass the id', async () => {
    await expect(resolveTargetThreadId({}, undefined, 'thread_read')).rejects.toThrow(
      'thread_read: no thread to target. No calling thread is available, so pass the thread id explicitly.'
    );
  });
});

describe('threadNotFoundError', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockThreadFindById.mockResolvedValue({ id: 'thread-here', title: 'Ops Room' });
  });

  it("names the caller's own thread by title and id", async () => {
    const error = await threadNotFoundError('thread_send', 'thread-guess', HERE);
    expect(error.message).toBe(
      'thread_send: thread not found: thread-guess. You are in thread `Ops Room` (`thread-here`); omit the id to target it.'
    );
  });

  it('degrades to Untitled Thread when the lookup rejects', async () => {
    mockThreadFindById.mockRejectedValue(new Error('db down'));
    const error = await threadNotFoundError('thread_read', 'x', HERE);
    expect(error.message).toContain('`Untitled Thread` (`thread-here`)');
  });
});
