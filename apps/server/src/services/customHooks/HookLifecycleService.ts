import path from 'node:path';
import { HookRegistrations, HookRuns, transaction } from '@snaglet/db';
import { ErrorCode, HTTP_STATUS } from '@snaglet/shared/types';
import { AppError, getErrorMessage } from '@snaglet/shared/utils';
import { emitHookRunsChanged } from '@server/realtime/surfaces/hookRuns';
import { scheduleService } from '@server/services/ScheduleService';
import { getHookRegistry } from './HookRegistryService';
import { hookWorkspaceService, type HookWorkspaceDeleteStage } from './HookWorkspaceService';
import { hookExecutionCoordinator } from './HookExecutionCoordinator';
import { type HookTrashOutcome } from './systemTrash';

export interface ClearHookRunHistoryResult {
  hookName: string;
  deletedRuns: number;
}

export interface DeleteHookResult extends ClearHookRunHistoryResult {
  deletedRegistration: boolean;
  deletedSchedules: number;
  /** Where the hook's physical files went: the system Trash (macOS Finder,
   *  recoverable via "Put Back"), the `<SNAGLET_HOME>/trash` fallback folder, or
   *  `none` when there was nothing left on disk to move. */
  trash: HookTrashOutcome;
}

function cleanupFailure(stage: HookWorkspaceDeleteStage, error: unknown): AppError {
  const artifacts = stage.cleanupPaths.map((candidate) => path.basename(candidate)).join(', ');
  return new AppError(
    `Hook "${stage.hookName}" was deleted from Snaglet, but its files could not be moved to the Trash: ${getErrorMessage(error)}. ` +
      `The recoverable artifact${stage.cleanupPaths.length === 1 ? '' : 's'} ${artifacts || '(unknown)'} remain${stage.cleanupPaths.length === 1 ? 's' : ''} in the hooks folder; retry the same hook deletion to clean up safely.`,
    ErrorCode.INTERNAL_ERROR,
    HTTP_STATUS.INTERNAL_SERVER_ERROR
  );
}

/**
 * Clear one hook's durable execution history while excluding queued/running
 * invocations for the full transaction. No filesystem lookup is performed, so
 * clearing an orphan hook name (no folder on disk) is intentionally idempotent.
 */
export async function clearHookRunHistory(
  requestedHookName: string
): Promise<ClearHookRunHistoryResult> {
  const hookName = hookWorkspaceService.canonicalName(requestedHookName);
  hookExecutionCoordinator.reserveOrThrow(hookName);
  try {
    const deleted = await transaction((tx) => HookRuns.deleteByHookName(hookName, tx));
    emitHookRunsChanged([hookName], 'clear');
    return { hookName, deletedRuns: deleted.deleted };
  } finally {
    hookExecutionCoordinator.release(hookName);
  }
}

/**
 * Delete a hook from Snaglet: every durable ownership record is removed, and the
 * physical files (source folder + generated build output) are moved to the
 * Trash — never permanently destroyed. This is THE deletion path for every
 * surface (desktop UI, browser UI, direct API); restoring the folder from
 * the Trash back into the hooks directory re-registers the hook via the
 * FolderScanner (boot scan + live watch).
 *
 * The source folder is first moved atomically to an exact same-hook hidden
 * sibling. Database history, definition-owned schedules, and registration are
 * then deleted in one transaction. A pre-commit failure restores the folder;
 * a post-commit trash-move failure deliberately leaves the quarantine in
 * place and returns a truthful retryable error instead of pretending DB
 * rollback.
 */
export async function deleteHook(requestedHookName: string): Promise<DeleteHookResult> {
  const hookName = hookWorkspaceService.canonicalName(requestedHookName);
  hookExecutionCoordinator.reserveOrThrow(hookName);

  let registry: ReturnType<typeof getHookRegistry> | null = null;
  let managedDeleteStarted = false;
  let stage: HookWorkspaceDeleteStage | null = null;
  let committed = false;

  try {
    registry = getHookRegistry();
    registry.beginManagedDelete(hookName);
    managedDeleteStarted = true;
    stage = hookWorkspaceService.stageDelete(hookName);
    const outcome = await transaction(async (tx) => {
      const deletedRuns = await HookRuns.deleteByHookName(hookName, tx);
      const scheduleIds = await scheduleService.removeHookSchedules(hookName, {
        runner: tx,
        notify: false,
      });
      const deletedRegistration = await HookRegistrations.deleteByName(hookName, tx);
      return { deletedRuns: deletedRuns.deleted, scheduleIds, deletedRegistration };
    });
    committed = true;

    scheduleService.notifySchedulesRemoved(outcome.scheduleIds);
    emitHookRunsChanged([hookName], 'hook-delete');

    // Move the quarantined source + generated build output to the Trash
    // (system Trash on macOS, `<SNAGLET_HOME>/trash` fallback elsewhere) instead
    // of destroying them — recoverability lives in the file system, not the
    // database. The managed-delete gate is deliberately still held: the
    // Finder path momentarily renames the quarantine back to its real
    // `<hooksDir>/<name>` identity, and the scanner must not observe that as
    // a live hook.
    let trash: HookTrashOutcome;
    try {
      trash = await hookWorkspaceService.finalizeDeleteToTrash(stage);
    } catch (error) {
      throw cleanupFailure(stage, error);
    }

    registry.finishManagedDelete(hookName);
    managedDeleteStarted = false;

    return {
      hookName,
      deletedRuns: outcome.deletedRuns,
      deletedRegistration: outcome.deletedRegistration,
      deletedSchedules: outcome.scheduleIds.length,
      trash,
    };
  } catch (error) {
    if (committed) throw error;

    let compensationError: unknown;
    try {
      if (stage) hookWorkspaceService.restoreDelete(stage);
    } catch (restoreError) {
      compensationError = restoreError;
    }

    if (registry && managedDeleteStarted) {
      try {
        if (hookWorkspaceService.exists(hookName)) {
          await registry.cancelManagedDelete(hookName);
        } else {
          registry.finishManagedDelete(hookName);
        }
        managedDeleteStarted = false;
      } catch (registryError) {
        compensationError ??= registryError;
      }
    }

    if (compensationError) {
      const artifact = stage?.stagedPath ? path.basename(stage.stagedPath) : '(none)';
      throw new AppError(
        `Hook deletion failed before commit (${getErrorMessage(error)}), and filesystem/registry compensation also failed (${getErrorMessage(compensationError)}). ` +
          `The database transaction was rolled back; inspect quarantine artifact ${artifact} before retrying.`,
        ErrorCode.INTERNAL_ERROR,
        HTTP_STATUS.INTERNAL_SERVER_ERROR
      );
    }
    throw error;
  } finally {
    if (registry && managedDeleteStarted) registry.finishManagedDelete(hookName);
    hookExecutionCoordinator.release(hookName);
  }
}
