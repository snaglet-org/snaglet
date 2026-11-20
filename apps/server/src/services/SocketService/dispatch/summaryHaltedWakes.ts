/**
 * summaryHaltedWakes — tool/scheduled wakes a summary-halted thread refused.
 *
 * A halted thread refuses every dispatch (see summaryHalt), but a wake's seed
 * message was already persisted by its caller. Refusing without a record left
 * that message unanswered forever once the halt lifted. Refused wakes are held
 * here per thread, and whoever lifts the halt (the next user send or wake)
 * replays them. In-process, like the halt itself: a restart clears both.
 */

import { getErrorMessage } from '@snaglet/shared/utils';
import { LogsService } from '@server/services/LogsService';
import { clearSummaryHaltIfRepaired } from '@server/services/summary/summaryHalt';
import type { ConversationBudgetSeed } from '@server/services/ConversationBudget';
import type { UnattendedWake, WakeOrigin } from '@snaglet/shared/types';

/** The public dispatchToThread input, held verbatim for replay. */
export interface HeldWake {
  threadId: string;
  senderId: string;
  messageId?: string;
  message: string;
  source: 'tool';
  parallelDispatch?: boolean;
  targetAgentId?: string;
  budgetSeed?: ConversationBudgetSeed;
  wakeOrigin?: WakeOrigin;
  /** Resolved when the wake first arrived, so the replay stays unattended. */
  unattended?: UnattendedWake;
}

/** A halt can outlive many scheduled fires; keep the newest, not all. */
const MAX_HELD_WAKES_PER_THREAD = 50;

const heldByThread = new Map<string, HeldWake[]>();

function isSameWake(a: HeldWake, b: HeldWake): boolean {
  return (
    a.messageId !== undefined && a.messageId === b.messageId && a.targetAgentId === b.targetAgentId
  );
}

/** Hold a wake the halt refused. Repeats of the same seed collapse to one. */
export function holdWakeForSummaryHalt(wake: HeldWake): void {
  const held = heldByThread.get(wake.threadId) ?? [];
  if (held.some((w) => isSameWake(w, wake))) return;
  held.push(wake);
  if (held.length > MAX_HELD_WAKES_PER_THREAD) {
    const dropped = held.splice(0, held.length - MAX_HELD_WAKES_PER_THREAD);
    LogsService.warn('summary-halted thread dropped its oldest held wakes', {
      threadId: wake.threadId,
      dropped: dropped.length,
      kept: held.length,
    });
  }
  heldByThread.set(wake.threadId, held);
}

export function listHeldWakes(threadId: string): HeldWake[] {
  return [...(heldByThread.get(threadId) ?? [])];
}

/** Test-only. */
export function resetHeldWakesForTests(): void {
  heldByThread.clear();
}

/**
 * Replay a thread's held wakes, oldest first, detached from the caller. Each
 * goes back through the public dispatchToThread, so a busy thread records it
 * for a post-run re-dispatch and a re-halted thread holds it again.
 */
function replayHeldWakes(threadId: string): void {
  const wakes = heldByThread.get(threadId);
  if (!wakes || wakes.length === 0) return;
  heldByThread.delete(threadId);
  LogsService.socket.event('replaying wakes held by a summary halt', {
    threadId,
    count: wakes.length,
  });
  void (async () => {
    // Dynamic import: dispatchToThread imports this module.
    const { dispatchToThread } = await import('./dispatchToThread');
    for (const wake of wakes) {
      try {
        const result = await dispatchToThread(wake);
        LogsService.socket.event('held wake replayed', {
          threadId,
          messageId: wake.messageId ?? null,
          reason: result.reason,
        });
      } catch (err) {
        LogsService.warn('held wake replay failed', {
          threadId,
          messageId: wake.messageId ?? null,
          error: getErrorMessage(err),
        });
      }
    }
  })();
}

/**
 * clearSummaryHaltIfRepaired plus the replay of every wake the halt refused.
 * Returns true when the thread may proceed.
 */
export async function liftSummaryHaltAndReplayWakes(threadId: string): Promise<boolean> {
  const proceed = await clearSummaryHaltIfRepaired(threadId).catch(() => false);
  if (proceed) replayHeldWakes(threadId);
  return proceed;
}
