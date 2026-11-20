import type { HookRunRecord, HookRunsChangedReason } from '@snaglet/shared/types';
import { emitWorkspaceEvent } from '../emit';

export function emitHookRunStarted(run: HookRunRecord): void {
  emitWorkspaceEvent({
    type: 'hook.run_started',
    run,
  });
}

export function emitHookRunFinished(run: HookRunRecord): void {
  emitWorkspaceEvent({
    type: 'hook.run_finished',
    run,
  });
}

export function emitHookRunsChanged(
  hookNames: Iterable<string>,
  reason: HookRunsChangedReason
): void {
  const names = [...new Set(hookNames)].sort();
  if (names.length === 0) return;
  emitWorkspaceEvent({
    type: 'hook.runs_changed',
    hookNames: names,
    reason,
  });
}

/** The registry saw these hooks' build or registration change (see HookRegistryChangedEvent). */
export function emitHookRegistryChanged(hookNames: Iterable<string>): void {
  const names = [...new Set(hookNames)].sort();
  if (names.length === 0) return;
  emitWorkspaceEvent({ type: 'hook.registry_changed', hookNames: names });
}

/** A hook's automatic execution was turned on or off. */
export function emitHookEnabledChanged(hookName: string, enabled: boolean): void {
  emitWorkspaceEvent({
    type: 'hook.enabled_changed',
    hookName,
    enabled,
  });
}
