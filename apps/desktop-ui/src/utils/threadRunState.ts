/**
 * Thread run-state store.
 *
 * Module-level set of thread ids that currently have an agent run in
 * progress, fed by `thread.run_started` / `thread.run_finished` workspace
 * events (bridged in useWorkspaceEventBridge) and seeded from
 * `threadsApi.activeRuns()` on connect/reconnect.
 *
 * Consumers subscribe per-thread via `useThreadRunning(threadId)` — the
 * workspace tree uses it to drive the live-run glow dot.
 */

import { useSyncExternalStore } from 'react';

/**
 * How long a thread stays "running" after its run finishes. Mention
 * handoffs (agent A finishes → agent B starts on the same thread) flow
 * through a finish/start gap of up to a few seconds; without the linger
 * the indicator flickers off and on mid-chain.
 */
const OFF_LINGER_MS = 2_000;

const running = new Set<string>();
/** Hidden helper thread id → visible parent thread id. */
const parentThreadByRun = new Map<string, string>();
const offTimers = new Map<string, ReturnType<typeof setTimeout>>();
const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of listeners) listener();
}

function cancelOffTimer(threadId: string): void {
  const timer = offTimers.get(threadId);
  if (timer !== undefined) {
    clearTimeout(timer);
    offTimers.delete(threadId);
  }
}

export function markThreadRunStarted(threadId: string): void {
  cancelOffTimer(threadId);
  if (running.has(threadId)) return;
  running.add(threadId);
  notify();
}

export function markThreadRunFinished(threadId: string): void {
  if (!running.has(threadId)) return;
  cancelOffTimer(threadId);
  offTimers.set(
    threadId,
    setTimeout(() => {
      offTimers.delete(threadId);
      running.delete(threadId);
      notify();
    }, OFF_LINGER_MS)
  );
}

/**
 * Replace the running set with a server snapshot. Threads in a pending
 * off-linger keep their timer (the snapshot may have been taken inside a
 * handoff gap).
 */
export function seedRunningThreads(threadIds: string[]): void {
  const next = new Set(threadIds);
  for (const id of offTimers.keys()) next.add(id);
  let changed = next.size !== running.size;
  if (!changed) {
    for (const id of next) {
      if (!running.has(id)) {
        changed = true;
        break;
      }
    }
  }
  if (!changed) return;
  running.clear();
  for (const id of next) running.add(id);
  notify();
}

/**
 * Project a hidden helper's run onto its visible parent. The helper remains in
 * the raw running set so a later finish retains the same off-linger behavior.
 */
export function setThreadRunParent(threadId: string, parentThreadId: string | null): void {
  const previousParentId = parentThreadByRun.get(threadId);
  if (parentThreadId == null) {
    if (previousParentId === undefined) return;
    parentThreadByRun.delete(threadId);
    if (running.has(threadId)) notify();
    return;
  }
  if (previousParentId === parentThreadId) return;
  parentThreadByRun.set(threadId, parentThreadId);
  if (running.has(threadId)) notify();
}

function isThreadRunning(threadId: string): boolean {
  if (running.has(threadId)) return true;
  for (const sourceThreadId of running) {
    if (parentThreadByRun.get(sourceThreadId) === threadId) return true;
  }
  return false;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** True while `threadId` has an agent run in progress (plus a short linger). */
export function useThreadRunning(threadId: string): boolean {
  return useSyncExternalStore(subscribe, () => isThreadRunning(threadId));
}
