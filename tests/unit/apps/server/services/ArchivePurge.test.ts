import { describe, expect, it, jest } from '@jest/globals';

jest.mock('@snaglet/db', () => ({ getDb: jest.fn(), transaction: jest.fn() }));
jest.mock('@server/domains/tables/tableLifecycle', () => ({}));
jest.mock('@server/services/ThreadExecutionPurgeService', () => ({}));

import { ErrorCode } from '@snaglet/shared/types';
import { ConflictError } from '@snaglet/shared/utils';
import {
  ArchivePurgeIncompleteError,
  planSweepCutoffs,
  type ArchivePurgeResult,
} from '@server/services/ArchivePurge';

const group = (due: string, tables: number) => ({ due, tables });

function progress(deletedContainers: number, droppedTables: number): ArchivePurgeResult {
  return {
    deletedContainers,
    deletedOther: 0,
    tables: {
      dropped: Array.from({ length: droppedTables }, (_, index) => ({
        id: `table-1111111111111-${index}`,
      })) as ArchivePurgeResult['tables']['dropped'],
      kept: [],
      linked: [],
      historyActors: [],
    },
  };
}

describe('planSweepCutoffs', () => {
  it('needs no earlier sweep when every table fits in one transaction', () => {
    expect(planSweepCutoffs([group('t1', 10), group('t2', 15)], 25)).toEqual([]);
    expect(planSweepCutoffs([], 25)).toEqual([]);
  });

  it('cuts before the group that would overflow a transaction', () => {
    expect(
      planSweepCutoffs([group('t1', 10), group('t2', 10), group('t3', 10), group('t4', 5)], 25)
    ).toEqual(['t3']);
  });

  it('gives a group larger than a transaction a sweep of its own', () => {
    expect(planSweepCutoffs([group('t1', 5), group('t2', 60), group('t3', 5)], 25)).toEqual([
      't2',
      't3',
    ]);
    expect(planSweepCutoffs([group('t1', 60), group('t2', 1)], 25)).toEqual(['t2']);
  });
});

describe('ArchivePurgeIncompleteError', () => {
  it('says the sweep stopped partway and keeps what it deleted', () => {
    const error = new ArchivePurgeIncompleteError(
      progress(3, 25),
      Object.assign(new Error('out of shared memory'), { code: '53200' })
    );

    expect(error.message).toBe(
      'Sweep stopped partway: out of shared memory. What it deleted stays deleted; sweep again to finish.'
    );
    expect(error.statusCode).toBe(500);
    expect(error.isOperational).toBe(true);
    expect(error.details).toEqual({ deletedContainers: 3, deletedOther: 0, deletedTables: 25 });
    expect(error.progress.deletedContainers).toBe(3);
  });

  it('says nothing was deleted when the first transaction fails, keeping a conflict a conflict', () => {
    const error = new ArchivePurgeIncompleteError(
      progress(0, 0),
      new ConflictError('Thread thread-1 has an active run.')
    );

    expect(error.message).toBe(
      'Sweep failed: Thread thread-1 has an active run. Nothing was deleted.'
    );
    expect(error.statusCode).toBe(409);
    expect(error.code).toBe(ErrorCode.CONFLICT);
  });
});
