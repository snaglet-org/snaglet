import { beforeEach, describe, expect, it, jest } from '@jest/globals';

const dbQuery = jest.fn();
const txQuery = jest.fn();
const transaction = jest.fn();
const reserveThreadPurge = jest.fn();
const releaseThreadPurge = jest.fn();

jest.mock('@snaglet/db', () => ({
  getDb: () => ({ query: (...args: unknown[]) => dbQuery(...args) }),
  transaction: (...args: unknown[]) => transaction(...args),
}));

jest.mock('@server/services/ActiveRunTracker', () => ({
  activeRunTracker: {
    reserveThreadPurge: (...args: unknown[]) => reserveThreadPurge(...args),
    releaseThreadPurge: (...args: unknown[]) => releaseThreadPurge(...args),
  },
}));

const pruneDeletedOverrides = jest.fn(async (_ids: readonly string[], _tx: unknown) => false);
const forgetCachedOverrides = jest.fn();
jest.mock('@server/services/settings/threadSummaryOverridePrune', () => ({
  pruneDeletedThreadSummaryModelOverrides: (ids: readonly string[], tx: unknown) =>
    pruneDeletedOverrides(ids, tx),
  forgetCachedThreadSummaryModelOverrides: () => forgetCachedOverrides(),
}));

const COLLECTED = {
  residue: 'collected',
  helperThreads: [] as Array<{ threadId: string; id: string }>,
};
const collectResidue = jest.fn(async (_ids: string[], _tx: unknown): Promise<unknown> => COLLECTED);
const removeResidue = jest.fn(
  async (_residue: unknown, _tx: unknown): Promise<unknown> => ({
    removed: true,
  })
);
const announceResidue = jest.fn(async (_removed: unknown) => undefined);
jest.mock('@server/services/threadDeleteResidue', () => ({
  collectThreadResidue: (ids: string[], tx: unknown) => collectResidue(ids, tx),
  removeThreadResidue: (residue: unknown, tx: unknown) => removeResidue(residue, tx),
  announceThreadResidueRemoved: (removed: unknown) => announceResidue(removed),
}));

// The home-thread rule is the guard's own test; here only where it runs.
const assertNoHomeThreads = jest.fn(async (_ids: readonly string[], _tx?: unknown) => undefined);
jest.mock('@server/services/homeThreadGuard', () => ({
  assertNoHomeThreads: (ids: readonly string[], tx?: unknown) => assertNoHomeThreads(ids, tx),
}));

import { ErrorCode } from '@snaglet/shared/types';
import { AppError } from '@snaglet/shared/utils';
import {
  listArchivedThreadIdsBefore,
  listThreadIdsInNodeSubtree,
  lockThreadIdsInNodeSubtree,
  withThreadExecutionPurge,
} from '@server/services/ThreadExecutionPurgeService';

beforeEach(() => {
  jest.clearAllMocks();
  assertNoHomeThreads.mockImplementation(async () => undefined);
  pruneDeletedOverrides.mockImplementation(async () => false);
  collectResidue.mockImplementation(async () => COLLECTED);
  dbQuery.mockResolvedValue({ rows: [] });
  removeResidue.mockImplementation(async () => ({ removed: true }));
  announceResidue.mockImplementation(async () => undefined);
  forgetCachedOverrides.mockImplementation(() => undefined);
  reserveThreadPurge.mockReturnValue(true);
  transaction.mockImplementation(async (callback: (tx: { query: typeof txQuery }) => unknown) =>
    callback({ query: txQuery })
  );
  txQuery
    .mockResolvedValue({ rows: [], rowCount: 0 })
    .mockResolvedValueOnce({ rows: [{ id: 'activity-1' }, { id: 'activity-2' }], rowCount: 2 })
    .mockResolvedValueOnce({ rows: [{ id: 'run-1' }], rowCount: 1 });
});

describe('withThreadExecutionPurge', () => {
  it('reserves first, reads the residue, deletes activity before runs, removes the residue, then releases', async () => {
    const events: string[] = [];
    reserveThreadPurge.mockImplementation((threadId: string) => {
      events.push(`reserve:${threadId}`);
      return true;
    });
    collectResidue.mockImplementation(async (ids, tx) => {
      // Before the purge: it lists the runs the purge deletes.
      events.push(`collect:residue:${ids.join(',')}`);
      expect(tx).toEqual({ query: txQuery });
      return COLLECTED;
    });
    removeResidue.mockImplementation(async (residue, tx) => {
      events.push('remove:residue');
      expect(residue).toBe(COLLECTED);
      expect(tx).toEqual({ query: txQuery });
      return { removed: true };
    });
    announceResidue.mockImplementation(async (removed) => {
      events.push('announce:residue');
      expect(removed).toEqual({ removed: true });
    });
    transaction.mockImplementation(async (callback: (tx: { query: typeof txQuery }) => unknown) => {
      const result = await callback({ query: txQuery });
      events.push('commit');
      return result;
    });
    txQuery.mockReset();
    txQuery.mockImplementation(async (sql: string) => {
      if (sql.includes('agent_activity_log')) {
        events.push('delete:activity');
        return { rows: [{ id: 'activity-1' }], rowCount: 1 };
      }
      if (sql.includes('thread_summaries')) {
        events.push('delete:folds');
        // A fold is replayed as the first message, so it goes with the runs and activity.
        expect(sql).toContain('compaction IS NOT NULL');
        return { rows: [], rowCount: 0 };
      }
      events.push('delete:runs');
      return { rows: [{ id: 'run-1' }], rowCount: 1 };
    });
    releaseThreadPurge.mockImplementation((threadId: string) => {
      events.push(`release:${threadId}`);
    });

    const result = await withThreadExecutionPurge(['thread-1'], async (context) => {
      events.push('delete:owner');
      expect(context).toMatchObject({ deletedActivity: 1, deletedRuns: 1 });
      expect(context.tx.query).toBe(txQuery);
      return 'done';
    });

    expect(result).toEqual({ deletedActivity: 1, deletedRuns: 1, value: 'done' });
    expect(events).toEqual([
      'reserve:thread-1',
      'collect:residue:thread-1',
      'delete:activity',
      'delete:runs',
      'delete:folds',
      'delete:owner',
      'remove:residue',
      'commit',
      'announce:residue',
      'release:thread-1',
    ]);
    expect(transaction).toHaveBeenCalledTimes(1);
  });

  it("prunes deleted threads' summary-model overrides after the mutation, then drops the cache", async () => {
    const events: string[] = [];
    pruneDeletedOverrides.mockImplementation(async (ids, tx) => {
      events.push(`prune:${ids.join(',')}`);
      expect(tx).toEqual({ query: txQuery });
      return true;
    });
    forgetCachedOverrides.mockImplementation(() => events.push('forget-cache'));
    transaction.mockImplementation(async (callback: (tx: { query: typeof txQuery }) => unknown) => {
      const result = await callback({ query: txQuery });
      events.push('commit');
      return result;
    });

    await withThreadExecutionPurge(['thread-b', 'thread-a'], async () => {
      events.push('delete:owner');
    });

    expect(events).toEqual(['delete:owner', 'prune:thread-a,thread-b', 'commit', 'forget-cache']);
  });

  it('leaves the override cache alone when nothing was pruned', async () => {
    await withThreadExecutionPurge(['thread-1'], async () => 'cleared');

    expect(pruneDeletedOverrides).toHaveBeenCalledWith(['thread-1'], { query: txQuery });
    expect(forgetCachedOverrides).not.toHaveBeenCalled();
  });

  it('reserves the helper threads a delete takes with it, and a running helper refuses it', async () => {
    dbQuery.mockResolvedValueOnce({
      rows: [{ id: 'thread-helper', parentId: 'thread-1' }],
    });
    reserveThreadPurge.mockImplementation((threadId: string) => threadId !== 'thread-helper');
    const operation = jest.fn();

    await expect(withThreadExecutionPurge(['thread-1'], operation)).rejects.toMatchObject({
      statusCode: 409,
      message: expect.stringContaining('Thread thread-1 has a subagent that is still running'),
    });

    expect(dbQuery).toHaveBeenCalledWith(expect.stringContaining('parent_thread_id = ANY'), [
      ['thread-1'],
    ]);
    expect(reserveThreadPurge.mock.calls).toEqual([['thread-1'], ['thread-helper']]);
    expect(releaseThreadPurge).toHaveBeenCalledWith('thread-1');
    expect(transaction).not.toHaveBeenCalled();
    expect(operation).not.toHaveBeenCalled();
  });

  it('holds idle helper threads through the delete and releases them after', async () => {
    dbQuery.mockResolvedValueOnce({ rows: [{ id: 'thread-helper', parentId: 'thread-1' }] });
    collectResidue.mockImplementation(async () => ({
      ...COLLECTED,
      helperThreads: [{ threadId: 'thread-1', id: 'thread-helper' }],
    }));

    await withThreadExecutionPurge(['thread-1'], async () => 'deleted');

    expect(reserveThreadPurge.mock.calls).toEqual([['thread-1'], ['thread-helper']]);
    expect(releaseThreadPurge.mock.calls).toEqual([['thread-1'], ['thread-helper']]);
  });

  it('aborts when a helper appears that was not reserved', async () => {
    collectResidue.mockImplementation(async () => ({
      ...COLLECTED,
      helperThreads: [{ threadId: 'thread-1', id: 'thread-new-helper' }],
    }));
    const operation = jest.fn();

    await expect(withThreadExecutionPurge(['thread-1'], operation)).rejects.toMatchObject({
      statusCode: 409,
    });
    expect(operation).not.toHaveBeenCalled();
    expect(removeResidue).not.toHaveBeenCalled();
  });

  it('leaves helpers alone when the operation keeps the threads (a clear)', async () => {
    collectResidue.mockImplementation(async () => ({
      ...COLLECTED,
      helperThreads: [{ threadId: 'thread-1', id: 'thread-helper' }],
    }));

    await withThreadExecutionPurge(['thread-1'], async () => 'cleared', { keepsThreads: true });

    expect(dbQuery).not.toHaveBeenCalled();
    expect(reserveThreadPurge.mock.calls).toEqual([['thread-1']]);
  });

  it('reports the delete as done when the post-commit announcements fail', async () => {
    announceResidue.mockRejectedValueOnce(new Error('broadcast failed'));

    await expect(withThreadExecutionPurge(['thread-1'], async () => 'deleted')).resolves.toEqual(
      expect.objectContaining({ value: 'deleted' })
    );
    expect(releaseThreadPurge).toHaveBeenCalledWith('thread-1');
  });

  it('rejects an active/reserved cohort before any transaction and releases earlier reservations', async () => {
    reserveThreadPurge.mockImplementation((threadId: string) => threadId !== 'thread-b');
    const operation = jest.fn();

    await expect(
      withThreadExecutionPurge(['thread-b', 'thread-a'], operation)
    ).rejects.toMatchObject({ statusCode: 409 });

    // IDs are normalized/sorted, so thread-a was acquired then released when b conflicted.
    expect(reserveThreadPurge.mock.calls).toEqual([['thread-a'], ['thread-b']]);
    expect(releaseThreadPurge).toHaveBeenCalledWith('thread-a');
    expect(transaction).not.toHaveBeenCalled();
    expect(operation).not.toHaveBeenCalled();
  });

  it('releases the reservation when the transaction fails', async () => {
    transaction.mockRejectedValueOnce(new Error('db failed'));

    await expect(withThreadExecutionPurge(['thread-1'], jest.fn())).rejects.toThrow('db failed');

    expect(releaseThreadPurge).toHaveBeenCalledWith('thread-1');
  });

  it('rejects and releases when the owner mutation fails inside the transaction', async () => {
    const ownerFailure = new Error('owner delete failed');

    await expect(
      withThreadExecutionPurge(['thread-1'], async () => {
        throw ownerFailure;
      })
    ).rejects.toBe(ownerFailure);

    expect(transaction).toHaveBeenCalledTimes(1);
    // activity, runs and folds; the residue is read but never removed or announced.
    expect(txQuery).toHaveBeenCalledTimes(3);
    expect(collectResidue).toHaveBeenCalledTimes(1);
    expect(removeResidue).not.toHaveBeenCalled();
    expect(announceResidue).not.toHaveBeenCalled();
    expect(releaseThreadPurge).toHaveBeenCalledWith('thread-1');
  });

  it('aborts before either delete when the locked cohort differs from the reserved cohort', async () => {
    const operation = jest.fn();
    const lockAndListThreadIds = jest.fn(async () => ['thread-new']);

    await expect(
      withThreadExecutionPurge(['thread-old'], operation, { lockAndListThreadIds })
    ).rejects.toMatchObject({ statusCode: 409 });

    expect(lockAndListThreadIds).toHaveBeenCalledWith(expect.objectContaining({ query: txQuery }));
    expect(txQuery).not.toHaveBeenCalled();
    expect(collectResidue).not.toHaveBeenCalled();
    expect(operation).not.toHaveBeenCalled();
    expect(releaseThreadPurge).toHaveBeenCalledWith('thread-old');
  });
});

describe('withThreadExecutionPurge and the home thread', () => {
  const refusal = new AppError(
    "The home thread can't be deleted. Use Clear to remove its messages.",
    ErrorCode.FORBIDDEN,
    403
  );

  it('refuses a delete that would take a home thread before deleting anything', async () => {
    assertNoHomeThreads.mockRejectedValueOnce(refusal);
    const operation = jest.fn();

    await expect(withThreadExecutionPurge(['thread-b', 'thread-a'], operation)).rejects.toBe(
      refusal
    );

    // The whole cohort, sorted, checked inside the transaction.
    expect(assertNoHomeThreads).toHaveBeenCalledWith(['thread-a', 'thread-b'], {
      query: txQuery,
    });
    expect(txQuery).not.toHaveBeenCalled();
    expect(collectResidue).not.toHaveBeenCalled();
    expect(operation).not.toHaveBeenCalled();
    expect(releaseThreadPurge).toHaveBeenCalledWith('thread-a');
    expect(releaseThreadPurge).toHaveBeenCalledWith('thread-b');
  });

  it('never checks a clear, which keeps the thread', async () => {
    await withThreadExecutionPurge(['thread-1'], async () => 'cleared', { keepsThreads: true });
    expect(assertNoHomeThreads).not.toHaveBeenCalled();
  });

  it('lets a caller that may take home threads (the agent delete) through', async () => {
    await expect(
      withThreadExecutionPurge(['thread-1'], async () => 'deleted', { allowsHomeThreads: true })
    ).resolves.toMatchObject({ value: 'deleted' });
    expect(assertNoHomeThreads).not.toHaveBeenCalled();
  });
});

describe('thread cohort discovery', () => {
  it('lists thread descendants for a root node delete', async () => {
    dbQuery.mockResolvedValueOnce({ rows: [{ id: 'thread-a' }, { id: 'thread-b' }] });

    await expect(listThreadIdsInNodeSubtree('container-1')).resolves.toEqual([
      'thread-a',
      'thread-b',
    ]);
    expect(dbQuery).toHaveBeenCalledWith(expect.stringContaining('WITH RECURSIVE subtree'), [
      'container-1',
    ]);
    // Threads scoped to a project container in the subtree go with it too.
    expect(dbQuery).toHaveBeenCalledWith(expect.stringContaining('n.project_id IN'), [
      'container-1',
    ]);
  });

  it('locks a subtree top-down and returns its sorted authoritative thread cohort', async () => {
    txQuery.mockReset();
    txQuery
      .mockResolvedValueOnce({ rows: [{ id: 'root', type: 'container' }], rowCount: 1 })
      .mockResolvedValueOnce({
        rows: [
          { id: 'child', type: 'container' },
          { id: 'thread-z', type: 'thread' },
        ],
        rowCount: 2,
      })
      .mockResolvedValueOnce({
        rows: [
          { id: 'doc', type: 'doc' },
          { id: 'thread-a', type: 'thread' },
        ],
        rowCount: 2,
      })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 });

    await expect(lockThreadIdsInNodeSubtree('root', { query: txQuery })).resolves.toEqual([
      'thread-a',
      'thread-z',
    ]);

    expect(txQuery).toHaveBeenCalledTimes(4);
    expect(txQuery.mock.calls[0]).toEqual([expect.stringContaining('WHERE id = $1'), ['root']]);
    expect(txQuery.mock.calls[1]).toEqual([
      expect.stringContaining('container_id = ANY'),
      [['root']],
    ]);
    expect(txQuery.mock.calls[2]).toEqual([
      expect.stringContaining('container_id = ANY'),
      [['child', 'thread-z']],
    ]);
    expect(txQuery.mock.calls[3]).toEqual([
      expect.stringContaining('container_id = ANY'),
      [['doc', 'thread-a']],
    ]);
    expect(txQuery.mock.calls.every(([sql]) => String(sql).includes('FOR UPDATE'))).toBe(true);
    // Each level also locks the threads scoped to the level's project containers.
    expect(
      txQuery.mock.calls.slice(1).every(([sql]) => String(sql).includes('project_id = ANY'))
    ).toBe(true);
  });

  it('lists archived threads using the exact sweep cutoff', async () => {
    dbQuery.mockResolvedValueOnce({ rows: [{ id: 'thread-expired' }] });
    const cutoff = '2026-01-01 00:00:00.123456+00';

    await expect(listArchivedThreadIdsBefore(cutoff)).resolves.toEqual(['thread-expired']);
    expect(dbQuery).toHaveBeenCalledWith(expect.stringContaining('archived_at < $1::timestamptz'), [
      cutoff,
    ]);
  });
});
