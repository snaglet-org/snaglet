import request from 'supertest';
import express from 'express';
import { beforeEach, describe, expect, it, jest } from '@jest/globals';

const dbQuery = jest.fn();
const txQuery = jest.fn();
const listThreadIdsInNodeSubtree = jest.fn();
const lockThreadIdsInNodeSubtree = jest.fn();
const withThreadExecutionPurge = jest.fn();
const listArchivedAgents = jest.fn();
const purgeAgent = jest.fn();
const purgeExpiredArchivedNodes = jest.fn();
const fakePurgeTx = { query: (...args: unknown[]) => txQuery(...args) };
const dropTablesOfDeletedContainer = jest.fn();
const announceProjectTablesDrop = jest.fn();

jest.mock('@snaglet/db', () => ({
  Containers: { findById: jest.fn() },
  Docs: { findById: jest.fn() },
  getDb: () => ({ query: (...args: unknown[]) => dbQuery(...args) }),
}));

jest.mock('@snaglet/db/tables/threads', () => ({
  Threads: { findById: jest.fn() },
}));

jest.mock('@snaglet/db/tables/agents', () => ({
  Agents: {
    findById: jest.fn(),
    listArchived: (...args: unknown[]) => listArchivedAgents(...args),
  },
}));

jest.mock('@server/services/AgentService', () => ({
  agentService: {
    archive: jest.fn(),
    purge: (...args: unknown[]) => purgeAgent(...args),
    restore: jest.fn(),
  },
}));

jest.mock('@server/services/ArchiveTtlSweeper', () => ({
  archiveTtlSweeper: { tick: jest.fn() },
}));

// Sweep-all delegates archived nodes to the shared batched purge (its own
// transactions, each with its thread purge); see the ArchivePurge tests.
jest.mock('@server/services/ArchivePurge', () => ({
  purgeExpiredArchivedNodes: (...args: unknown[]) => purgeExpiredArchivedNodes(...args),
}));

jest.mock('@server/domains/tables/tableLifecycle', () => ({
  announceProjectTablesDrop: (...args: unknown[]) => announceProjectTablesDrop(...args),
  archiveTableCounts: jest.fn(),
  dropTablesOfDeletedContainer: (...args: unknown[]) => dropTablesOfDeletedContainer(...args),
  listAllArchivedTableFields: jest.fn(async () => []),
  purgeArchivedTable: jest.fn(),
  purgeTableField: jest.fn(),
  archiveTable: jest.fn(),
  restoreTable: jest.fn(),
  customTableRow: jest.fn(),
}));

jest.mock('@server/realtime/surfaces/tree', () => ({
  emitTreeNodeArchived: jest.fn(),
  emitTreeNodeDeleted: jest.fn(),
  emitTreeNodeRestored: jest.fn(),
  snapshotFromContainer: jest.fn(),
  snapshotFromDoc: jest.fn(),
  snapshotFromThread: jest.fn(),
}));

jest.mock('@server/realtime/surfaces/threads', () => ({
  emitThreadDeleted: jest.fn(),
  emitThreadUpdated: jest.fn(),
}));

jest.mock('@server/services/ThreadExecutionPurgeService', () => ({
  listThreadIdsInNodeSubtree: (...args: unknown[]) => listThreadIdsInNodeSubtree(...args),
  lockThreadIdsInNodeSubtree: (...args: unknown[]) => lockThreadIdsInNodeSubtree(...args),
  withThreadExecutionPurge: (...args: unknown[]) => withThreadExecutionPurge(...args),
}));

import { AppError, ConflictError } from '@snaglet/shared/utils';
import { ErrorCode } from '@snaglet/shared/types';
import archiveRouter from '@server/routes/archive';
import { errorHandler } from '@server/middleware/errorHandler';
import { getPanelToken } from '@server/middleware/panelAuth';

/** sweep-all needs the panel token (it purges archived automations too). */
const panel = () => ({ 'X-Snaglet-Panel-Token': getPanelToken() });

const archivedContainer = {
  id: 'container-1',
  type: 'container',
  title: 'Archived project',
  archived: true,
  archived_at: '2026-01-01T00:00:00.000Z',
  container_id: null,
  sort_order: 0,
  created_at: '2026-01-01T00:00:00.000Z',
  updated_at: '2026-01-01T00:00:00.000Z',
};

describe('archive route thread execution purge', () => {
  const app = express().use(express.json()).use('/api/archive', archiveRouter).use(errorHandler);

  beforeEach(() => {
    jest.clearAllMocks();
    dbQuery.mockResolvedValue({ rows: [archivedContainer], rowCount: 1 });
    txQuery.mockResolvedValue({ rows: [], rowCount: 1 });
    listThreadIdsInNodeSubtree.mockResolvedValue(['thread-child']);
    lockThreadIdsInNodeSubtree.mockResolvedValue(['thread-child']);
    listArchivedAgents.mockResolvedValue([]);
    purgeExpiredArchivedNodes.mockResolvedValue({
      deletedContainers: 0,
      deletedOther: 0,
      tables: { dropped: [], kept: [], linked: [], historyActors: [] },
    });
    dropTablesOfDeletedContainer.mockResolvedValue({
      dropped: [],
      kept: [],
      linked: [],
      historyActors: [],
    });
    withThreadExecutionPurge.mockImplementation(
      async (
        _threadIds: Iterable<string>,
        operation: (context: unknown) => Promise<unknown>,
        options?: { lockAndListThreadIds?: (tx: typeof fakePurgeTx) => Promise<Iterable<string>> }
      ) => {
        await options?.lockAndListThreadIds?.(fakePurgeTx);
        return {
          deletedActivity: 1,
          deletedRuns: 1,
          value: await operation({ tx: fakePurgeTx, deletedActivity: 1, deletedRuns: 1 }),
        };
      }
    );
  });

  it('refuses sweep-all without the panel token, before touching anything', async () => {
    const response = await request(app).post('/api/archive/sweep-all');

    expect(response.status).toBeGreaterThanOrEqual(401);
    expect(response.status).toBeLessThan(404);
    expect(purgeExpiredArchivedNodes).not.toHaveBeenCalled();
  });

  it('sweeps every archived node with a zero retention and reports what went', async () => {
    purgeExpiredArchivedNodes.mockResolvedValueOnce({
      deletedContainers: 2,
      deletedOther: 3,
      tables: {
        dropped: [{ id: 'table-1111111111111-aaaaaaaa' }],
        kept: [],
        linked: [],
        historyActors: [],
      },
    });

    const response = await request(app).post('/api/archive/sweep-all').set(panel());

    expect(response.status).toBe(200);
    expect(purgeExpiredArchivedNodes).toHaveBeenCalledWith('0 seconds');
    expect(response.body.data.result).toMatchObject({
      deletedContainers: 2,
      deletedOther: 3,
      deletedTables: 1,
    });
  });

  it('returns the error of a sweep that stopped partway and runs nothing after it', async () => {
    listArchivedAgents.mockResolvedValue([{ id: 'test-agent-a' }]);
    purgeExpiredArchivedNodes.mockRejectedValueOnce(
      new AppError(
        'Sweep stopped partway: out of shared memory. What it deleted stays deleted; sweep again to finish.',
        ErrorCode.INTERNAL_ERROR,
        500,
        true,
        { deletedContainers: 3, deletedOther: 0, deletedTables: 25 }
      )
    );

    const response = await request(app).post('/api/archive/sweep-all').set(panel());

    expect(response.status).toBe(500);
    expect(response.body.error).toMatchObject({
      message:
        'Sweep stopped partway: out of shared memory. What it deleted stays deleted; sweep again to finish.',
      details: { deletedContainers: 3, deletedTables: 25 },
    });
    expect(listArchivedAgents).not.toHaveBeenCalled();
    expect(purgeAgent).not.toHaveBeenCalled();
  });

  it('hard-deletes an archived node subtree inside the shared reserved transaction', async () => {
    const response = await request(app).delete('/api/archive/container-1');

    expect(response.status).toBe(200);
    expect(listThreadIdsInNodeSubtree).toHaveBeenCalledWith('container-1');
    // The cohort is re-listed under lock inside the transaction, as the
    // containers delete does, so a thread scoped in meanwhile aborts it.
    expect(withThreadExecutionPurge).toHaveBeenCalledWith(
      ['thread-child'],
      expect.any(Function),
      expect.objectContaining({ lockAndListThreadIds: expect.any(Function) })
    );
    expect(lockThreadIdsInNodeSubtree).toHaveBeenCalledWith('container-1', fakePurgeTx);
    expect(txQuery).toHaveBeenCalledWith('DELETE FROM nodes WHERE id = $1', ['container-1']);
    expect(dropTablesOfDeletedContainer).toHaveBeenCalledWith(
      'container-1',
      { clearReferences: false },
      fakePurgeTx
    );
  });

  it('fails the sweep instead of reporting 0 agents when archived agents cannot be listed', async () => {
    listArchivedAgents.mockRejectedValueOnce(new Error('connection reset'));

    const response = await request(app).post('/api/archive/sweep-all').set(panel());

    expect(response.status).toBe(500);
    expect(purgeAgent).not.toHaveBeenCalled();
  });

  it('skips an archived agent whose DM threads cannot be deleted and sweeps the others', async () => {
    listArchivedAgents.mockResolvedValueOnce([
      { id: 'test-agent-a' },
      { id: 'test-agent-b' },
      { id: 'test-agent-c' },
    ]);
    purgeAgent.mockImplementation(async (id: unknown) => {
      if (id === 'test-agent-b') throw new ConflictError('Thread thread-dm-1 has an active run');
      return { originalName: String(id) };
    });

    const response = await request(app).post('/api/archive/sweep-all').set(panel());

    expect(response.status).toBe(200);
    expect(purgeAgent.mock.calls.map(([id]) => id)).toEqual([
      'test-agent-a',
      'test-agent-b',
      'test-agent-c',
    ]);
    expect(response.body.data.result).toMatchObject({
      deletedAgents: 2,
      skippedAgents: ['test-agent-b'],
    });
  });

  it('fails the sweep when an agent purge fails for a reason other than a conflict', async () => {
    listArchivedAgents.mockResolvedValueOnce([{ id: 'test-agent-a' }]);
    purgeAgent.mockRejectedValueOnce(new Error('connection reset'));

    const response = await request(app).post('/api/archive/sweep-all').set(panel());

    expect(response.status).toBe(500);
  });

  it('returns conflict without deleting an archive subtree when reservation fails', async () => {
    withThreadExecutionPurge.mockRejectedValueOnce(
      new ConflictError('Thread thread-child has an active run')
    );

    const response = await request(app).delete('/api/archive/container-1');

    expect(response.status).toBe(409);
    expect(txQuery).not.toHaveBeenCalled();
  });
});
