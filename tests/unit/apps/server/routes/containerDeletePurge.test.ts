import request from 'supertest';
import express from 'express';
import { beforeEach, describe, expect, it, jest } from '@jest/globals';

const deleteContainer = jest.fn();
const listThreadIdsInNodeSubtree = jest.fn();
const lockThreadIdsInNodeSubtree = jest.fn();
const withThreadExecutionPurge = jest.fn();
const emitTreeNodeDeleted = jest.fn();
const fakePurgeTx = { query: jest.fn() };
const NO_TABLES = { dropped: [], kept: [], linked: [], historyActors: [] };
const dropTablesOfDeletedContainer = jest.fn();
const announceProjectTablesDrop = jest.fn();

jest.mock('@snaglet/db', () => ({
  Containers: {
    delete: (...args: unknown[]) => deleteContainer(...args),
  },
}));

jest.mock('@server/services/ThreadExecutionPurgeService', () => ({
  listThreadIdsInNodeSubtree: (...args: unknown[]) => listThreadIdsInNodeSubtree(...args),
  lockThreadIdsInNodeSubtree: (...args: unknown[]) => lockThreadIdsInNodeSubtree(...args),
  withThreadExecutionPurge: (...args: unknown[]) => withThreadExecutionPurge(...args),
}));

jest.mock('@server/realtime/actorContext', () => ({
  getCurrentActor: jest.fn(),
}));

jest.mock('@server/realtime/surfaces/tree', () => ({
  emitTreeNodeCreated: jest.fn(),
  emitTreeNodeDeleted: (...args: unknown[]) => emitTreeNodeDeleted(...args),
  emitTreeNodeUpdated: jest.fn(),
  snapshotFromContainer: jest.fn(),
}));

jest.mock('@server/services/HookService', () => ({
  hooks: { emit: jest.fn() },
}));

jest.mock('@server/config/logger', () => ({
  logger: { error: jest.fn() },
}));

jest.mock('@server/domains/tables/tableLifecycle', () => ({
  dropTablesOfDeletedContainer: (...args: unknown[]) => dropTablesOfDeletedContainer(...args),
  announceProjectTablesDrop: (...args: unknown[]) => announceProjectTablesDrop(...args),
}));

jest.mock('@server/domains/containers/ContainerTreeService', () => ({
  buildContainerTree: jest.fn(),
}));

import { ConflictError } from '@snaglet/shared/utils';
import containersRouter from '@server/domains/containers/containers.routes';
import { errorHandler } from '@server/middleware/errorHandler';

describe('DELETE /api/containers/:id thread execution purge', () => {
  const app = express()
    .use(express.json())
    .use('/api/containers', containersRouter)
    .use(errorHandler);

  beforeEach(() => {
    jest.clearAllMocks();
    listThreadIdsInNodeSubtree.mockResolvedValue(['thread-a', 'thread-b']);
    lockThreadIdsInNodeSubtree.mockResolvedValue(['thread-a', 'thread-b']);
    deleteContainer.mockResolvedValue(true);
    dropTablesOfDeletedContainer.mockResolvedValue(NO_TABLES);
    withThreadExecutionPurge.mockImplementation(
      async (
        _threadIds: Iterable<string>,
        operation: (context: unknown) => Promise<unknown>,
        options?: { lockAndListThreadIds?: (tx: typeof fakePurgeTx) => Promise<Iterable<string>> }
      ) => {
        await options?.lockAndListThreadIds?.(fakePurgeTx);
        return {
          deletedActivity: 2,
          deletedRuns: 2,
          value: await operation({ tx: fakePurgeTx, deletedActivity: 2, deletedRuns: 2 }),
        };
      }
    );
  });

  it('preflights every descendant thread and deletes the owner inside the purge transaction', async () => {
    const response = await request(app).delete('/api/containers/container-root');

    expect(response.status).toBe(200);
    expect(response.body.data).toBeNull();
    expect(listThreadIdsInNodeSubtree).toHaveBeenCalledWith('container-root');
    expect(withThreadExecutionPurge).toHaveBeenCalledWith(
      ['thread-a', 'thread-b'],
      expect.any(Function),
      expect.objectContaining({ lockAndListThreadIds: expect.any(Function) })
    );
    expect(lockThreadIdsInNodeSubtree).toHaveBeenCalledWith('container-root', fakePurgeTx);
    expect(deleteContainer).toHaveBeenCalledWith('container-root', fakePurgeTx);
    // The project tables go in the same transaction, before the owner row.
    expect(dropTablesOfDeletedContainer).toHaveBeenCalledWith(
      'container-root',
      { clearReferences: false },
      fakePurgeTx
    );
    expect(dropTablesOfDeletedContainer.mock.invocationCallOrder[0]).toBeLessThan(
      deleteContainer.mock.invocationCallOrder[0]!
    );
    expect(announceProjectTablesDrop).toHaveBeenCalledWith(NO_TABLES);
    expect(emitTreeNodeDeleted).toHaveBeenCalledWith('container-root', 'container');
    expect(listThreadIdsInNodeSubtree.mock.invocationCallOrder[0]).toBeLessThan(
      withThreadExecutionPurge.mock.invocationCallOrder[0]!
    );
  });

  it('returns conflict with no owner delete or tree event when any descendant cannot reserve', async () => {
    withThreadExecutionPurge.mockRejectedValueOnce(
      new ConflictError('Thread thread-b has an active run')
    );

    const response = await request(app).delete('/api/containers/container-root');

    expect(response.status).toBe(409);
    expect(deleteContainer).not.toHaveBeenCalled();
    expect(emitTreeNodeDeleted).not.toHaveBeenCalled();
  });

  it('preserves 404 semantics and emits nothing when the owner is missing', async () => {
    listThreadIdsInNodeSubtree.mockResolvedValueOnce([]);
    deleteContainer.mockResolvedValueOnce(false);

    const response = await request(app).delete('/api/containers/missing');

    expect(response.status).toBe(404);
    expect(deleteContainer).toHaveBeenCalledWith('missing', fakePurgeTx);
    expect(emitTreeNodeDeleted).not.toHaveBeenCalled();
  });

  it('emits no tree event when the transactional owner delete throws', async () => {
    deleteContainer.mockRejectedValueOnce(new Error('owner delete failed'));

    const response = await request(app).delete('/api/containers/container-root');

    expect(response.status).toBe(500);
    expect(emitTreeNodeDeleted).not.toHaveBeenCalled();
  });
});
