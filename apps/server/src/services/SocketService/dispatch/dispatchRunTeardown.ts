/**
 * finalizeDispatchRun — end-of-run teardown for the dispatch wave loop.
 *
 * Called from the `finally` block of `dispatchToThreadInternal`.
 * Runs on every run end (completion, break, abort, timeout, crash): releases
 * the abort controller, flushes never-finished runs, logs the budget summary,
 * persists any messages still parked in the session queue, releases the run
 * lock, and re-dispatches once for anything this run left unanswered.
 *
 * `redispatch` is threaded in as a callback (the caller passes
 * `redispatchPersistedMessage`) so this module has no static dependency on
 * `dispatchToThread.ts` — keeping the dispatch path's import graph acyclic.
 * The fire-and-forget `void redispatch(...)` and the exact await ordering match
 * the original inline block byte-for-byte.
 */
import { activeRunTracker } from '@server/services/ActiveRunTracker';
import { clearAbortController } from '../abortStore';
import { LogsService } from '@server/services/LogsService';
import { getErrorMessage } from '@snaglet/shared/utils';
import type { ConversationPassKind, ConversationStopReason } from '@snaglet/shared/types';
import { emitConversationEndedEvent } from '../threadEvents';
import type { buildConversationBudget } from '../handlers/chatHandlers/buildConversationBudget';

type RedispatchPersistedMessage = (args: {
  threadId: string;
  threadName: string;
  messageId: string;
  undeliveredCount: number;
  reason: string;
  budgetSeed?: import('@server/services/ConversationBudget').ConversationBudgetSeed;
  coveredMessageIds?: readonly string[];
}) => Promise<void>;

export async function finalizeDispatchRun(params: {
  sessionId: string;
  threadId: string;
  threadName: string;
  isGroup: boolean;
  activeRunIds: Set<string>;
  convBudget: Awaited<ReturnType<typeof buildConversationBudget>>;
  /** Why the conversation ended. */
  stopReason: ConversationStopReason;
  /** Per-agent final pass kinds, for the structured ending log. */
  passKinds: ReadonlyMap<string, ConversationPassKind>;
  /** Agents that actually ran — 0 means no conversation happened. */
  wakeCount: number;
  redispatch: RedispatchPersistedMessage;
  /**
   * This run's session-level abort controller. Session ids are reused across
   * runs, so only this exact controller is unregistered — never a newer run's.
   */
  abortController?: AbortController;
  /**
   * The ActiveRunTracker run generation captured when this dispatch started
   * (undefined when the caller held no tracker session). If the session no
   * longer carries it, the lock was already released out from under this run
   * (reaper force-release) and possibly re-acquired by a newer run on the same
   * session id — every session-scoped step (queue flush, skipped seeds, lock
   * release, undelivered re-dispatch) is then skipped: the reaper already did
   * them, and doing them again would tear down the newer run.
   */
  runToken?: number;
}): Promise<void> {
  const {
    sessionId,
    threadId,
    threadName,
    isGroup,
    activeRunIds,
    convBudget,
    stopReason,
    passKinds,
    wakeCount,
    redispatch,
    abortController,
    runToken,
  } = params;

  // Clean up the abort controller for this session (ownership-checked).
  clearAbortController(sessionId, abortController);

  // Flush any runs that were never properly finished
  for (const id of activeRunIds) {
    activeRunTracker.finish(id);
  }

  // Structured ending line: every conversation end logs its reason,
  // wave count, budget consumption, and how each agent left.
  const bs = convBudget.summary();
  LogsService.socket.event('conversation ended', {
    threadName,
    threadId,
    stopReason,
    waves: bs.waves,
    tokensOut: bs.totalOutputTokens,
    exhaustedReason: bs.exhaustedReason ?? 'natural end',
    wakeCount,
    passKinds: Object.fromEntries(passKinds),
  });

  // Persisted, UI-visible ending line — with three deliberate suppressions:
  //  - nothing ran (wakeCount 0): there is no conversation to narrate;
  //  - solo natural endings: a 1:1 chat "ending" after every answer is noise;
  //    abnormal solo endings (budget/cap/error) still narrate;
  //  - aborts (user or reaper): AbortRunService already persists an
  //    attributed "[actor] aborted [agent]" narration — a second line would
  //    say the same thing twice. Same for a summary halt, whose own
  //    "[summary model …]" line already says why and how to fix it.
  const soloNatural = !isGroup && (stopReason === 'all-passed' || stopReason === 'stagnation');
  const abortNarrated =
    stopReason === 'user-abort' ||
    stopReason === 'reaper' ||
    stopReason === 'summary-model-unavailable';
  if (wakeCount > 0 && !soloNatural && !abortNarrated) {
    await emitConversationEndedEvent(threadId, {
      stopReason,
      waves: bs.waves,
      totalOutputTokens: bs.totalOutputTokens,
    });
  }

  // Re-evaluated right before every session-keyed step: each await above or
  // between them is a window in which a reaper release plus a newer run on
  // the same (reused) session id can take the session over.
  const lostSession = (): boolean => {
    if (runToken === undefined || activeRunTracker.isSessionRun(sessionId, runToken)) return false;
    LogsService.warn(
      'dispatch ended after its run lock was already released — skipping session teardown',
      {
        threadName,
        threadId,
        sessionId,
        stopReason,
      }
    );
    return true;
  };
  if (lostSession()) return;

  // Persist any messages still parked in the session queue before the
  // queue dies with the session — the client was already ack'd with
  // "queued", so ending a run must never silently destroy them. (Runs
  // whose final iteration had no tool calls, and non-all-mode groups,
  // have no other drain seam.) The drained leftovers feed the undelivered
  // re-dispatch below: these messages never reached this run's context, so
  // the next wave must answer them.
  let undeliveredLeftovers: Array<{ id: string }> = [];
  try {
    const { flushAbandonedSessionMessages } = await import('../handlers/chatPhases/midRunMessages');
    // The drain is keyed by session id alone — never drain a newer run's queue.
    if (lostSession()) return;
    undeliveredLeftovers = await flushAbandonedSessionMessages({
      sessionId,
      threadId,
      threadName,
    });
  } catch (err) {
    LogsService.warn('failed to flush queued messages at run end', {
      threadName,
      threadId,
      sessionId,
      error: getErrorMessage(err),
    });
  }

  // Release the session lock so subsequent sends are allowed. finishSession
  // drains-and-deletes the queue atomically and hands back anything that
  // raced in during the flush's DB awaits above (the flush-vs-delete window);
  // persist those too so a message acked "queued" is never dropped — it is
  // either persisted here or (arriving after release) starts a fresh run.
  const { persistStragglers } = await import('../handlers/chatPhases/midRunMessages');
  // Capture skipped-seed ids before finishSession (which clears them). These
  // are tool-dispatch wakes that arrived while this run held the lock; the
  // seed is already persisted, so it needs a re-dispatch (a wake), not another
  // persist. Take them here, release the lock, then re-dispatch once below so
  // a wake landing in the run's final iteration is never silently lost.
  const skippedSeedIds = activeRunTracker.takeSkippedSeeds(sessionId, runToken);
  const racedMessages = activeRunTracker.finishSession(sessionId, runToken);
  await persistStragglers(sessionId, racedMessages, { threadId, threadName });
  const lockSnapshot = activeRunTracker.snapshot();
  LogsService.socket.event('run lock released', {
    threadName,
    threadId,
    sessionId,
    activeThreads: lockSnapshot.activeThreadCount,
    activeRuns: lockSnapshot.activeRunCount,
  });

  // Re-dispatch once for anything this run left unanswered:
  //  - tool wakes skipped while the run held the lock (skipped seeds);
  //  - mid-run user messages that were persisted on receipt but
  //    never drained into this run's context (undelivered leftovers + the
  //    stragglers finishSession handed back).
  // All of these are already persisted rows, so a single wake keyed on the
  // newest id covers every one of them — a fresh run rebuilds full thread
  // context. Runs on every run end (completion, abort, timeout, crash, reap)
  // so a wedged run can delay delivery but never swallow it.
  const undeliveredIds = [
    ...skippedSeedIds,
    ...undeliveredLeftovers.map((m) => m.id),
    ...racedMessages.map((m) => m.id),
  ];
  if (undeliveredIds.length > 0) {
    const newestMessageId = undeliveredIds[undeliveredIds.length - 1]!;
    void redispatch({
      threadId,
      threadName,
      messageId: newestMessageId,
      // Every undelivered id, so @mentions in the earlier ones still wake
      // their targets (seeding on the newest alone dropped them).
      coveredMessageIds: undeliveredIds,
      undeliveredCount: undeliveredIds.length,
      reason:
        skippedSeedIds.length > 0
          ? 'skipped tool wake(s) at run end'
          : 'undelivered mid-run message(s) at run end',
      // The redispatch continues this conversation — it inherits the spend
      // already consumed, so a wedge→redispatch cycle cannot restart the
      // budget meters.
      budgetSeed: convBudget.seedSnapshot(),
    });
  }
}
