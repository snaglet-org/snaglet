/**
 * Agent-work store.
 *
 * Module-level map of in-flight agent work items (live runs + executing
 * hooks), fed by `agent.work_started` / `agent.work_finished` workspace
 * events (bridged in useWorkspaceEventBridge) and seeded from
 * `agentsApi.activeWork()` on connect/reconnect.
 *
 * Consumers subscribe via `useAgentWork()` — the status bar's active-agents
 * indicator uses it for the count chip and the popover list. Same shape as
 * the sibling threadRunState store.
 */

import { useSyncExternalStore } from 'react';
import type { ActiveWorkItem } from '@snaglet/shared/types/workspace-events';

const items = new Map<string, ActiveWorkItem>();
const listeners = new Set<() => void>();

/** Cached, sorted (newest first) snapshot — stable identity between changes. */
let snapshot: ActiveWorkItem[] = [];

function rebuildSnapshot(): void {
  snapshot = Array.from(items.values()).sort(
    (a, b) => b.startedAt.localeCompare(a.startedAt) || a.id.localeCompare(b.id)
  );
}

function notify(): void {
  for (const listener of listeners) listener();
}

export function markAgentWorkStarted(item: ActiveWorkItem): void {
  items.set(item.id, item);
  rebuildSnapshot();
  notify();
}

export function markAgentWorkFinished(id: string): void {
  if (!items.delete(id)) return;
  rebuildSnapshot();
  notify();
}

/** Replace the set with a server snapshot (connect/reconnect seeding). */
export function seedAgentWork(list: ActiveWorkItem[]): void {
  items.clear();
  for (const item of list) items.set(item.id, item);
  rebuildSnapshot();
  notify();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** All in-flight agent work, newest first. */
export function useAgentWork(): ActiveWorkItem[] {
  return useSyncExternalStore(subscribe, () => snapshot);
}

/**
 * Number of active agent execution instances, not distinct identities. Hook executions have their
 * own status-bar surface and do not count as agents.
 */
export function countActiveAgentProcesses(work: ActiveWorkItem[]): number {
  return new Set(work.filter((item) => item.kind === 'thread-run').map((item) => item.id)).size;
}
