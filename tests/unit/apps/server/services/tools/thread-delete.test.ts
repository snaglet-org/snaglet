import { beforeEach, describe, expect, it, jest } from '@jest/globals';

const findThreadById = jest.fn();
const listHomeThreadIds = jest.fn(async (..._args: unknown[]): Promise<string[]> => []);
const deleteNodeOfType = jest.fn();
const withThreadExecutionPurge = jest.fn();
const emitTreeNodeDeleted = jest.fn();
const emitThreadDeleted = jest.fn();
const fakePurgeTx = { query: jest.fn() };

jest.mock('@snaglet/db/tables/threads', () => ({
  Threads: {
    findById: (...args: unknown[]) => findThreadById(...args),
    listHomeThreadIds: (...args: unknown[]) => listHomeThreadIds(...args),
  },
}));

jest.mock('@snaglet/db/tables/nodes', () => ({
  Nodes: { deleteOfType: (...args: unknown[]) => deleteNodeOfType(...args) },
}));

jest.mock('@server/services/ThreadExecutionPurgeService', () => ({
  withThreadExecutionPurge: (...args: unknown[]) => withThreadExecutionPurge(...args),
}));

jest.mock('@server/realtime/surfaces/tree', () => ({
  emitTreeNodeDeleted: (...args: unknown[]) => emitTreeNodeDeleted(...args),
}));

jest.mock('@server/realtime/surfaces/threads', () => ({
  emitThreadDeleted: (...args: unknown[]) => emitThreadDeleted(...args),
}));

import { ConflictError } from '@snaglet/shared/utils';
import { HOME_THREAD_DELETE_MESSAGE } from '@server/services/homeThreadGuard';
import threadDelete from '@server/services/ToolService/handlers/threads/threadDelete';

describe('thread_delete execution purge', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    findThreadById.mockResolvedValue({ id: 'thread-1', title: 'Thread one', projectId: null });
    deleteNodeOfType.mockResolvedValue(undefined);
    withThreadExecutionPurge.mockImplementation(
      async (_threadIds: Iterable<string>, operation: (context: unknown) => Promise<unknown>) => ({
        deletedActivity: 1,
        deletedRuns: 1,
        value: await operation({ tx: fakePurgeTx, deletedActivity: 1, deletedRuns: 1 }),
      })
    );
  });

  it('permanently deletes only inside the shared execution-purge reservation', async () => {
    await expect(threadDelete({ thread_id: 'thread-1', confirm: true })).resolves.toMatchObject({
      success: true,
      thread_id: 'thread-1',
    });

    expect(withThreadExecutionPurge).toHaveBeenCalledWith(['thread-1'], expect.any(Function));
    expect(deleteNodeOfType).toHaveBeenCalledWith('thread-1', 'thread', fakePurgeTx);
    expect(emitTreeNodeDeleted).toHaveBeenCalledWith('thread-1', 'thread');
    expect(emitThreadDeleted).toHaveBeenCalledWith('thread-1');
  });

  it('does not delete or emit when an active thread cannot be reserved', async () => {
    withThreadExecutionPurge.mockRejectedValueOnce(
      new ConflictError('Thread thread-1 has an active run')
    );

    await expect(threadDelete({ thread_id: 'thread-1', confirm: true })).rejects.toThrow(
      'Failed to delete thread: Thread thread-1 has an active run'
    );

    expect(deleteNodeOfType).not.toHaveBeenCalled();
    expect(emitTreeNodeDeleted).not.toHaveBeenCalled();
    expect(emitThreadDeleted).not.toHaveBeenCalled();
  });
});

describe('thread_delete project scope guard', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    deleteNodeOfType.mockResolvedValue(undefined);
    withThreadExecutionPurge.mockImplementation(
      async (_threadIds: Iterable<string>, operation: (context: unknown) => Promise<unknown>) => ({
        deletedActivity: 0,
        deletedRuns: 0,
        value: await operation({ tx: fakePurgeTx, deletedActivity: 0, deletedRuns: 0 }),
      })
    );
  });

  it("deletes when project_id matches the thread's own project scope", async () => {
    findThreadById.mockResolvedValue({ id: 'thread-1', title: 'Scoped', projectId: 'project-1' });

    await expect(
      threadDelete({ thread_id: 'thread-1', project_id: 'project-1', confirm: true })
    ).resolves.toMatchObject({ success: true });
    expect(deleteNodeOfType).toHaveBeenCalledWith('thread-1', 'thread', fakePurgeTx);
  });

  it('refuses when the thread is scoped to a different project', async () => {
    findThreadById.mockResolvedValue({ id: 'thread-1', title: 'Scoped', projectId: 'project-1' });

    await expect(
      threadDelete({ thread_id: 'thread-1', project_id: 'project-2', confirm: true })
    ).rejects.toThrow('belongs to project project-1, not project-2');
    expect(deleteNodeOfType).not.toHaveBeenCalled();
  });

  it('refuses a flat thread under any project scope', async () => {
    findThreadById.mockResolvedValue({ id: 'thread-1', title: 'Flat', projectId: null });

    await expect(
      threadDelete({ thread_id: 'thread-1', project_id: 'project-1', confirm: true })
    ).rejects.toThrow('belongs to project (none — flat), not project-1');
    expect(deleteNodeOfType).not.toHaveBeenCalled();
  });
});

describe('thread_delete on DM threads', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    listHomeThreadIds.mockResolvedValue([]);
  });

  it("refuses the user's home thread with the same message the user gets", async () => {
    findThreadById.mockResolvedValue({ id: 'thread-home', kind: 'dm', projectId: null });
    listHomeThreadIds.mockResolvedValue(['thread-home']);

    await expect(threadDelete({ thread_id: 'thread-home', confirm: true })).rejects.toThrow(
      HOME_THREAD_DELETE_MESSAGE
    );
    expect(listHomeThreadIds).toHaveBeenCalledWith(['thread-home'], undefined);
    expect(withThreadExecutionPurge).not.toHaveBeenCalled();
    expect(deleteNodeOfType).not.toHaveBeenCalled();
  });

  it('still points an agent-to-agent DM at the dm ops, as before', async () => {
    findThreadById.mockResolvedValue({ id: 'thread-a2a', kind: 'dm', projectId: null });

    await expect(threadDelete({ thread_id: 'thread-a2a', confirm: true })).rejects.toThrow(
      'is a direct-message thread'
    );
    expect(withThreadExecutionPurge).not.toHaveBeenCalled();
  });
});
