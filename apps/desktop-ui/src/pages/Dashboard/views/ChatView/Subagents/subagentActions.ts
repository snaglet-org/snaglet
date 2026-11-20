/**
 * The user's actions on a subagent helper: pause (optionally for a
 * while), resume, remove. The strip and the header follow the result through
 * `subagent:changed`, so a success needs no local state; a failure toasts.
 * There is no confirmation anywhere, and Remove has no undo: it is final.
 */
import type { SubagentSummary } from '@snaglet/shared/types';
import { getErrorMessage } from '@snaglet/shared/utils';
import { FetchError, threadsApi } from '@desktop/utils/api';
import { showToast } from '@desktop/utils/toast';

type HelperRef = Pick<SubagentSummary, 'id' | 'name' | 'parentThreadId'>;

/** `for` ("15m") or `until` (ISO) resumes it on its own; neither = until resumed. */
export interface PauseTiming {
  for?: string;
  until?: string;
}

const ERROR_TOAST_MS = 4000;

function failed(what: string, sub: HelperRef, err: unknown): false {
  showToast(`Couldn't ${what} ${sub.name}: ${getErrorMessage(err)}`, {
    durationMs: ERROR_TOAST_MS,
  });
  return false;
}

export async function pauseHelper(sub: HelperRef, timing: PauseTiming = {}): Promise<boolean> {
  try {
    await threadsApi.pauseSubagent(sub.parentThreadId, sub.id, timing);
    return true;
  } catch (err) {
    return failed('pause', sub, err);
  }
}

export async function resumeHelper(sub: HelperRef): Promise<boolean> {
  try {
    await threadsApi.resumeSubagent(sub.parentThreadId, sub.id);
    return true;
  } catch (err) {
    return failed('resume', sub, err);
  }
}

/** Helpers with a removal on its way, so a second click (chip or header) sends nothing. */
const removing = new Set<string>();

/**
 * Remove a helper. "Removed …" only once the server says it is gone; a
 * helper whose run is still stopping is removed when that run ends. A helper
 * already gone (removed elsewhere) counts as removed, with no second toast.
 */
export async function removeHelper(sub: HelperRef): Promise<boolean> {
  if (removing.has(sub.id)) return false;
  removing.add(sub.id);
  try {
    const { removed } = await threadsApi.removeSubagent(sub.parentThreadId, sub.id);
    showToast(
      removed
        ? `Removed ${sub.name}`
        : `${sub.name} is still stopping; it is removed as soon as its run ends`
    );
    return removed;
  } catch (err) {
    if (err instanceof FetchError && err.status === 404) return true;
    return failed('remove', sub, err);
  } finally {
    removing.delete(sub.id);
  }
}
