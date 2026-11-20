import { beforeEach, describe, expect, it, jest } from '@jest/globals';

const dbQuery = jest.fn();
const transaction = jest.fn();
const pruneTerminal = jest.fn();
const purgeExpiredArchivedNodes = jest.fn();
const loggerError = jest.fn();
const resolveWorkerPolicy = jest.fn();
const onWorkerPolicyChange = jest.fn();
const registerWorker = jest.fn();
const beginSweep = jest.fn();
const endSweep = jest.fn();
const emitHookRunsChanged = jest.fn();
const sweepAllOrphanRepeats = jest.fn();
const retentionTx = { query: jest.fn() };
const NO_TABLES = { dropped: [], kept: [], linked: [], historyActors: [] };

jest.mock('@server/services/ArchivePurge', () => ({
  purgeExpiredArchivedNodes: (...args: unknown[]) => purgeExpiredArchivedNodes(...args),
  ArchivePurgeIncompleteError: class extends Error {
    constructor(readonly progress: unknown) {
      super('Sweep stopped partway: out of shared memory.');
    }
  },
}));

jest.mock('@snaglet/db', () => ({
  getDb: () => ({ query: (...args: unknown[]) => dbQuery(...args) }),
  transaction: (...args: unknown[]) => transaction(...args),
  HookRuns: { pruneTerminal: (...args: unknown[]) => pruneTerminal(...args) },
}));

jest.mock('@server/config/logger', () => ({
  logger: {
    debug: jest.fn(),
    error: (...args: unknown[]) => loggerError(...args),
    info: jest.fn(),
    warn: jest.fn(),
  },
}));

jest.mock('@server/services/workers/workerPolicy', () => ({
  resolveWorkerPolicy: (...args: unknown[]) => resolveWorkerPolicy(...args),
  onWorkerPolicyChange: (...args: unknown[]) => onWorkerPolicyChange(...args),
}));

jest.mock('@server/services/workers/workerStatus', () => ({
  registerWorker: (...args: unknown[]) => registerWorker(...args),
  beginSweep: (...args: unknown[]) => beginSweep(...args),
  endSweep: (...args: unknown[]) => endSweep(...args),
}));

jest.mock('@snaglet/db/tables/table_entries/repeats', () => ({
  sweepAllOrphanRepeats: (...args: unknown[]) => sweepAllOrphanRepeats(...args),
}));

jest.mock('@server/realtime/surfaces/hookRuns', () => ({
  emitHookRunsChanged: (...args: unknown[]) => emitHookRunsChanged(...args),
}));

import { ArchivePurgeIncompleteError } from '@server/services/ArchivePurge';
import {
  archiveTtlSweeper,
  HOOK_RUN_RETENTION_POLICY,
  RETENTION_WORKER_ID,
} from '@server/services/ArchiveTtlSweeper';

const activePolicy = {
  active: true,
  stopped: false,
  effectiveMode: 'balanced',
  hooksEnabled: false,
  embeddingsEnabled: false,
  effectiveSweepIntervalMs: 5_000,
};

describe('ArchiveTtlSweeper retention lanes', () => {
  beforeEach(() => {
    archiveTtlSweeper.stop();
    jest.clearAllMocks();
    resolveWorkerPolicy.mockResolvedValue(activePolicy);
    onWorkerPolicyChange.mockReturnValue(jest.fn());
    sweepAllOrphanRepeats.mockResolvedValue(6);
    transaction.mockImplementation(
      async (operation: (runner: typeof retentionTx) => Promise<unknown>) => operation(retentionTx)
    );
    pruneTerminal.mockResolvedValue({
      deleted: 2,
      ids: ['hook-run-1', 'hook-run-2'],
      hookNames: ['digest'],
    });
    purgeExpiredArchivedNodes.mockResolvedValue({
      deletedContainers: 2,
      deletedOther: 3,
      tables: NO_TABLES,
    });
    dbQuery.mockImplementation(async (sql: string) => {
      if (sql.includes('activity_payload_truncate')) {
        return { rows: [{ activity_payload_truncate: 4 }] };
      }
      return { rows: [{ activity_hard_delete: 5 }] };
    });
  });

  it('runs archive, existing activity retention, and bounded hook history independently of hook/embedding flags', async () => {
    await expect(archiveTtlSweeper.tick()).resolves.toEqual({
      deletedContainers: 2,
      deletedOther: 3,
      activityPayloadsTruncated: 4,
      activityRowsDeleted: 5,
      hookRunsDeleted: 2,
      orphanRepeatsDeleted: 6,
    });
    expect(sweepAllOrphanRepeats).toHaveBeenCalledWith(retentionTx);

    expect(purgeExpiredArchivedNodes).toHaveBeenCalledWith('30 days');
    expect(pruneTerminal).toHaveBeenCalledWith(HOOK_RUN_RETENTION_POLICY, retentionTx);
    expect(emitHookRunsChanged).toHaveBeenCalledWith(['digest'], 'retention');
    expect(endSweep).toHaveBeenCalledWith(RETENTION_WORKER_ID, {
      outcome: 'ok',
      processed: 22,
    });
  });

  it('counts what a sweep that stopped partway deleted, logs it, and runs the other lanes', async () => {
    purgeExpiredArchivedNodes.mockRejectedValueOnce(
      new ArchivePurgeIncompleteError(
        { deletedContainers: 4, deletedOther: 1, tables: NO_TABLES },
        new Error('out of shared memory')
      )
    );

    const result = await archiveTtlSweeper.tick();

    expect(result).toMatchObject({ deletedContainers: 4, deletedOther: 1, hookRunsDeleted: 2 });
    expect(loggerError).toHaveBeenCalledWith(
      expect.stringContaining('archive_ttl_sweep failed'),
      expect.any(Object)
    );
  });

  it('counts nothing deleted when the sweep fails outright', async () => {
    purgeExpiredArchivedNodes.mockRejectedValueOnce(new Error('connection reset'));

    const result = await archiveTtlSweeper.tick();

    expect(result).toMatchObject({ deletedContainers: 0, deletedOther: 0, hookRunsDeleted: 2 });
    expect(loggerError).toHaveBeenCalledWith(
      expect.stringContaining('archive_ttl_sweep failed'),
      expect.any(Object)
    );
  });

  it('skips every retention lane while the master worker mode is paused', async () => {
    resolveWorkerPolicy.mockResolvedValueOnce({
      ...activePolicy,
      active: false,
      stopped: false,
      effectiveMode: 'paused',
    });

    await expect(archiveTtlSweeper.tick()).resolves.toBeNull();

    expect(dbQuery).not.toHaveBeenCalled();
    expect(purgeExpiredArchivedNodes).not.toHaveBeenCalled();
    expect(pruneTerminal).not.toHaveBeenCalled();
    expect(endSweep).toHaveBeenCalledWith(RETENTION_WORKER_ID, { outcome: 'skipped' });
  });

  it('registers status and tears down its fixed timer in off mode', async () => {
    jest.useFakeTimers();
    resolveWorkerPolicy.mockResolvedValueOnce({
      ...activePolicy,
      active: false,
      stopped: true,
      effectiveMode: 'off',
    });

    archiveTtlSweeper.start();
    await Promise.resolve();
    await Promise.resolve();

    expect(registerWorker).toHaveBeenCalledWith(RETENTION_WORKER_ID);
    expect(jest.getTimerCount()).toBe(0);
    archiveTtlSweeper.stop();
    jest.useRealTimers();
  });
});
