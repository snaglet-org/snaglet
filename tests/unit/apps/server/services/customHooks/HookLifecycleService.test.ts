import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { ConflictError } from '@snaglet/shared/utils';

const transaction = jest.fn();
const deleteRuns = jest.fn();
const deleteRegistration = jest.fn();
const removeSchedules = jest.fn();
const notifySchedulesRemoved = jest.fn();
const emitHookRunsChanged = jest.fn();
const stageDelete = jest.fn();
const restoreDelete = jest.fn();
const finalizeDelete = jest.fn();
const finalizeDeleteToTrash = jest.fn();
const workspaceExists = jest.fn();
const beginManagedDelete = jest.fn();
const finishManagedDelete = jest.fn();
const cancelManagedDelete = jest.fn();
const isManagedDelete = jest.fn();

const registry = {
  beginManagedDelete: (...args: unknown[]) => beginManagedDelete(...args),
  finishManagedDelete: (...args: unknown[]) => finishManagedDelete(...args),
  cancelManagedDelete: (...args: unknown[]) => cancelManagedDelete(...args),
  isManagedDelete: (...args: unknown[]) => isManagedDelete(...args),
};

jest.mock('@snaglet/db', () => ({
  transaction: (...args: unknown[]) => transaction(...args),
  HookRuns: { deleteByHookName: (...args: unknown[]) => deleteRuns(...args) },
  HookRegistrations: { deleteByName: (...args: unknown[]) => deleteRegistration(...args) },
}));

jest.mock('@server/services/ScheduleService', () => ({
  scheduleService: {
    removeHookSchedules: (...args: unknown[]) => removeSchedules(...args),
    notifySchedulesRemoved: (...args: unknown[]) => notifySchedulesRemoved(...args),
  },
}));

jest.mock('@server/realtime/surfaces/hookRuns', () => ({
  emitHookRunsChanged: (...args: unknown[]) => emitHookRunsChanged(...args),
}));

jest.mock('@server/services/customHooks/HookRegistryService', () => ({
  getHookRegistry: () => registry,
}));

jest.mock('@server/services/customHooks/HookWorkspaceService', () => ({
  hookWorkspaceService: {
    canonicalName: (name: string) => name.replace(/[^a-zA-Z0-9_-]/g, ''),
    stageDelete: (...args: unknown[]) => stageDelete(...args),
    restoreDelete: (...args: unknown[]) => restoreDelete(...args),
    finalizeDelete: (...args: unknown[]) => finalizeDelete(...args),
    finalizeDeleteToTrash: (...args: unknown[]) => finalizeDeleteToTrash(...args),
    exists: (...args: unknown[]) => workspaceExists(...args),
  },
}));

import { clearHookRunHistory, deleteHook } from '@server/services/customHooks/HookLifecycleService';
import { hookExecutionCoordinator } from '@server/services/customHooks/HookExecutionCoordinator';

const tx = { query: jest.fn() };
const defaultStage = {
  hookName: 'digest',
  sourcePath: '/hooks/digest',
  stagedPath: '/hooks/.snaglet-hook-delete-646967657374--request',
  cleanupPaths: ['/hooks/.snaglet-hook-delete-646967657374--request'],
};

beforeEach(() => {
  jest.clearAllMocks();
  hookExecutionCoordinator.reset();
  transaction.mockImplementation(async (operation: (runner: typeof tx) => Promise<unknown>) =>
    operation(tx)
  );
  deleteRuns.mockResolvedValue({ deleted: 2, ids: ['run-1', 'run-2'], hookNames: ['digest'] });
  deleteRegistration.mockResolvedValue(true);
  removeSchedules.mockResolvedValue(['schedule-1']);
  stageDelete.mockReturnValue(defaultStage);
  finalizeDeleteToTrash.mockResolvedValue({ disposition: 'system-trash', fallbackDir: null });
  workspaceExists.mockReturnValue(true);
  cancelManagedDelete.mockResolvedValue(undefined);
  isManagedDelete.mockReturnValue(false);
});

afterEach(() => hookExecutionCoordinator.reset());

describe('clearHookRunHistory', () => {
  it('is folder-independent and publishes only after the transaction succeeds', async () => {
    const order: string[] = [];
    transaction.mockImplementationOnce(
      async (operation: (runner: typeof tx) => Promise<unknown>) => {
        order.push('tx-begin');
        const value = await operation(tx);
        order.push('tx-commit');
        return value;
      }
    );
    deleteRuns.mockImplementationOnce(async () => {
      order.push('runs-delete');
      return { deleted: 0, ids: [], hookNames: [] };
    });
    emitHookRunsChanged.mockImplementationOnce(() => order.push('event'));

    await expect(clearHookRunHistory('digest')).resolves.toEqual({
      hookName: 'digest',
      deletedRuns: 0,
    });
    expect(order).toEqual(['tx-begin', 'runs-delete', 'tx-commit', 'event']);
    expect(deleteRuns).toHaveBeenCalledWith('digest', tx);
  });

  it('returns a conflict without opening a transaction when work is queued or active', async () => {
    hookExecutionCoordinator.begin('digest');

    await expect(clearHookRunHistory('digest')).rejects.toBeInstanceOf(ConflictError);
    expect(transaction).not.toHaveBeenCalled();
    expect(emitHookRunsChanged).not.toHaveBeenCalled();
  });
});

describe('deleteHook', () => {
  it('holds the reservation through quarantine and one ownership transaction', async () => {
    stageDelete.mockImplementationOnce(() => {
      expect(hookExecutionCoordinator.begin('digest')).toBe(false);
      return defaultStage;
    });
    const order: string[] = [];
    finalizeDeleteToTrash.mockImplementationOnce(async () => {
      order.push('trash');
      return { disposition: 'system-trash', fallbackDir: null };
    });
    finishManagedDelete.mockImplementationOnce(() => order.push('finish-managed-delete'));

    await expect(deleteHook('digest')).resolves.toEqual({
      hookName: 'digest',
      deletedRuns: 2,
      deletedRegistration: true,
      deletedSchedules: 1,
      trash: { disposition: 'system-trash', fallbackDir: null },
    });

    expect(beginManagedDelete).toHaveBeenCalledWith('digest');
    expect(deleteRuns).toHaveBeenCalledWith('digest', tx);
    expect(removeSchedules).toHaveBeenCalledWith('digest', { runner: tx, notify: false });
    expect(deleteRegistration).toHaveBeenCalledWith('digest', tx);
    expect(finishManagedDelete).toHaveBeenCalledWith('digest');
    expect(notifySchedulesRemoved).toHaveBeenCalledWith(['schedule-1']);
    expect(emitHookRunsChanged).toHaveBeenCalledWith(['digest'], 'hook-delete');
    expect(finalizeDeleteToTrash).toHaveBeenCalledWith(defaultStage);
    // The permanent-remove finalize never runs: every deletion is a trash move.
    expect(finalizeDelete).not.toHaveBeenCalled();
    // The managed-delete gate must outlive the trash move: the Finder path
    // momentarily restores `<hooksDir>/<name>`, which the scanner must not
    // observe as a live hook.
    expect(order).toEqual(['trash', 'finish-managed-delete']);
    expect(hookExecutionCoordinator.begin('digest')).toBe(true);
  });

  it('rolls back ownership, restores the folder, and emits nothing on a pre-commit failure', async () => {
    deleteRegistration.mockRejectedValueOnce(new Error('registration delete failed'));

    await expect(deleteHook('digest')).rejects.toThrow('registration delete failed');

    expect(restoreDelete).toHaveBeenCalledWith(defaultStage);
    expect(cancelManagedDelete).toHaveBeenCalledWith('digest');
    expect(finalizeDeleteToTrash).not.toHaveBeenCalled();
    expect(notifySchedulesRemoved).not.toHaveBeenCalled();
    expect(emitHookRunsChanged).not.toHaveBeenCalled();
  });

  it('reports committed trash-move failure truthfully and safely reconciles it on retry', async () => {
    finalizeDeleteToTrash.mockRejectedValueOnce(new Error('disk busy'));

    await expect(deleteHook('digest')).rejects.toThrow(/was deleted from Snaglet.*disk busy/i);
    expect(emitHookRunsChanged).toHaveBeenCalledWith(['digest'], 'hook-delete');
    expect(restoreDelete).not.toHaveBeenCalled();

    const retryStage = {
      ...defaultStage,
      stagedPath: null,
      cleanupPaths: defaultStage.cleanupPaths,
    };
    stageDelete.mockReturnValueOnce(retryStage);
    deleteRuns.mockResolvedValueOnce({ deleted: 0, ids: [], hookNames: [] });
    deleteRegistration.mockResolvedValueOnce(false);
    removeSchedules.mockResolvedValueOnce([]);

    await expect(deleteHook('digest')).resolves.toMatchObject({
      deletedRuns: 0,
      deletedRegistration: false,
      deletedSchedules: 0,
      trash: { disposition: 'system-trash', fallbackDir: null },
    });
    expect(finalizeDeleteToTrash).toHaveBeenLastCalledWith(retryStage);
  });
});
