/**
 * ActiveWorkRegistry — in-memory source of truth for "which agents are working
 * on what, right now".
 *
 * Two kinds of work are tracked:
 *   - `thread-run`  : a live agent turn, keyed by its run id. Registered and
 *     unregistered by ActiveRunTracker.start()/finish() — the exact same
 *     pairing the SIGUSR2 restart-defer relies on, so entries share the run
 *     lifecycle's existing always-ends guarantees (the dispatch teardown
 *     finally flushes every leftover run id, and finishSession's thread-lock
 *     release purges any survivor for that thread as a belt-and-braces net).
 *   - `hook-run`    : an executing hook child process, registered/unregistered
 *     inside HookRunner's spawn try/finally (the same finally that releases
 *     the concurrency semaphore, so a timeout/kill/spawn-error can't leak).
 *
 * Deliberately in-memory only: a server restart clears the set, so a crash can
 * never leave phantom "working" rows. Do not persist.
 *
 * Every add/remove is broadcast through the agent-work realtime surface so
 * clients update by push; `snapshot()` seeds late subscribers via
 * `GET /api/agents/active-work`.
 */

import type { ActiveWorkItem } from '@snaglet/shared/types/workspace-events';
import { isoNow } from '@snaglet/shared/utils';
import { emitAgentWorkFinished, emitAgentWorkStarted } from '@server/realtime/surfaces/agentWork';

export interface ThreadRunWorkInput {
  /** The run id — unique per model attempt, shared with the runs table row. */
  id: string;
  agentId: string;
  agentName: string;
  threadId: string;
  threadTitle: string;
}

interface HookRunWorkInput {
  /** Unique per-spawn id (not persisted anywhere else). */
  id: string;
  hookName: string;
  /** Invoking agent, when the hook fired inside an agent's context. */
  agentId?: string;
  agentName?: string;
  threadId?: string;
}

class ActiveWorkRegistry {
  private readonly items = new Map<string, ActiveWorkItem>();

  registerThreadRun(input: ThreadRunWorkInput): void {
    const item: ActiveWorkItem = {
      id: input.id,
      kind: 'thread-run',
      agentId: input.agentId,
      agentName: input.agentName,
      threadId: input.threadId,
      threadTitle: input.threadTitle,
      startedAt: isoNow(),
    };
    this.items.set(item.id, item);
    emitAgentWorkStarted(item);
  }

  registerHookRun(input: HookRunWorkInput): void {
    const item: ActiveWorkItem = {
      id: input.id,
      kind: 'hook-run',
      hookName: input.hookName,
      ...(input.agentId ? { agentId: input.agentId } : {}),
      ...(input.agentName ? { agentName: input.agentName } : {}),
      ...(input.threadId ? { threadId: input.threadId } : {}),
      startedAt: isoNow(),
    };
    this.items.set(item.id, item);
    emitAgentWorkStarted(item);
  }

  /**
   * Remove one work item. Idempotent — double-finishes are normal (the run
   * teardown flush re-finishes already-finished runs), so the removal event is
   * only broadcast when the entry was actually present.
   */
  unregister(id: string): void {
    if (this.items.delete(id)) {
      emitAgentWorkFinished(id);
    }
  }

  /**
   * Safety net: purge every thread-run item for `threadId`. Called when the
   * thread's run lock is released (ActiveRunTracker.finishSession) — by then
   * every run of that dispatch has already been finished individually, so this
   * only fires for entries orphaned by an abnormal unwind (e.g. a reaped
   * zombie run that ignored its abort and never reached its own teardown).
   * Hook runs are untouched: their lifetime is the child process, not the
   * thread lock.
   */
  unregisterThreadRuns(threadId: string): void {
    for (const item of this.items.values()) {
      if (item.kind === 'thread-run' && item.threadId === threadId) {
        this.unregister(item.id);
      }
    }
  }

  /** Copy of the current work set, newest first (registration-time order). */
  snapshot(): ActiveWorkItem[] {
    return Array.from(this.items.values())
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt) || a.id.localeCompare(b.id))
      .map((item) => ({ ...item }));
  }

  get size(): number {
    return this.items.size;
  }

  /** Test seam — wipe without broadcasting. */
  clear(): void {
    this.items.clear();
  }
}

export const activeWorkRegistry = new ActiveWorkRegistry();
