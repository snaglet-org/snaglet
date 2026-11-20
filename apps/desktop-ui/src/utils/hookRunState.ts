import { useSyncExternalStore } from 'react';
import type { HookRunRecord } from '@snaglet/shared/types';

const runs = new Map<string, HookRunRecord>();
const hookRevisions = new Map<string, number>();
const listeners = new Set<() => void>();
let snapshot: HookRunRecord[] = [];

function rebuildSnapshot(): void {
  snapshot = Array.from(runs.values())
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt) || b.id.localeCompare(a.id))
    .slice(0, 100);
  const retained = new Set(snapshot.map((run) => run.id));
  for (const id of runs.keys()) {
    if (!retained.has(id)) runs.delete(id);
  }
}

function notify(): void {
  for (const listener of listeners) listener();
}

export function markHookRun(run: HookRunRecord): void {
  runs.set(run.id, run);
  rebuildSnapshot();
  notify();
}

export function seedHookRuns(records: HookRunRecord[]): void {
  runs.clear();
  for (const run of records) runs.set(run.id, run);
  rebuildSnapshot();
  notify();
}

/**
 * Evict stale global rows and bump each hook's detail revision. The global
 * recent snapshot is refetched by the workspace-event bridge, while an open
 * HookRunsPanel observes the revision and reloads its full per-hook ledger.
 */
export function invalidateHookRuns(hookNames: Iterable<string>): void {
  const names = new Set(hookNames);
  if (names.size === 0) return;
  for (const [id, run] of runs) {
    if (names.has(run.hookName)) runs.delete(id);
  }
  for (const hookName of names) {
    hookRevisions.set(hookName, (hookRevisions.get(hookName) ?? 0) + 1);
  }
  rebuildSnapshot();
  notify();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Recent hook executions, newest first, updated by the workspace event bridge. */
export function useHookRuns(): HookRunRecord[] {
  return useSyncExternalStore(subscribe, () => snapshot);
}

/** Revision token used by a hook-detail panel to refetch after clear/delete/retention. */
export function useHookRunsRevision(hookName: string): number {
  return useSyncExternalStore(subscribe, () => hookRevisions.get(hookName) ?? 0);
}
