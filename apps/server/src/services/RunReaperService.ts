/**
 * RunReaperService — independent failsafe for wedged runs.
 *
 * A run blocked inside a never-returning await (a hung tool, a dead provider
 * stream) makes zero observable progress: no completed model call, no tool
 * result. While it holds the thread's run lock, the thread is deaf — inbound
 * messages queue behind it and socket:chat:abort may never unwind it. The
 * reaper sweeps ActiveRunTracker for sessions with no progress for the stall
 * window and force-ends them:
 *
 *   1. fire the run's AbortSignal (abortThread) + kill its shell process trees
 *      — abort is threaded into tool executors, so this usually unwinds the
 *      run cleanly through its own dispatch finally;
 *   2. after a grace window, if the session is still active (truly wedged),
 *      force-release it: persist any queued messages, clear the tracker entry,
 *      broadcast socket:chat:aborted, and re-dispatch undelivered messages so
 *      the thread answers them on the next wave.
 *
 * Everything is loud — a reap is always a bug somewhere else.
 */

import { getErrorMessage } from '@snaglet/shared/utils';
import { activeRunTracker } from './ActiveRunTracker';
import { cancelClarificationsForThread } from './SocketService/clarification';
import { cancelToolConfirmationsForThread } from './SocketService/confirmation';
import { readEnvInt } from './ToolService/lib/executionGuards';
import { LogsService } from './LogsService';
import { AbortRunService } from './AbortRunService';
import { wsService } from './WebSocketService';

export interface RunReaperConfig {
  /** Zero-progress window that marks a run as wedged. */
  stallMs: number;
  /** How often the reaper scans for stalled sessions. */
  sweepIntervalMs: number;
  /** How long a reaped run gets to unwind via its own abort path before the
   *  tracker entry is force-cleared. */
  graceMs: number;
}

/**
 * Env: SNAGLET_RUN_REAPER_STALL_MS (default 15 min; clamp 1min..2h).
 *
 * The default sits comfortably above the longest sanctioned tool hard-timeout
 * (get_clarification's 11 min in executionGuards) plus margin. The reaper is a
 * failsafe for runs that ignore their own timeouts — it must never fire before
 * a legitimate tool wait resolves (or that tool's own hard timeout does).
 * Human-interactive waits (get_clarification / tool confirmation) additionally
 * stamp noteProgress on issue and periodically while parked, so a user who
 * steps away to answer a question never counts against this clock at all.
 * So do long shell waits (runKeepAlive), which may legitimately block for
 * up to the command's lifetime (configurable to 4 h).
 */
const DEFAULT_CONFIG: RunReaperConfig = {
  stallMs: readEnvInt('SNAGLET_RUN_REAPER_STALL_MS', 15 * 60_000, 60_000, 2 * 60 * 60_000),
  sweepIntervalMs: 30_000,
  graceMs: 20_000,
};

/** Resolved default stall window — exported so the buffer-over-tool-timeouts
 *  invariant can be asserted in tests. */
export const REAPER_STALL_DEFAULT_MS = DEFAULT_CONFIG.stallMs;

let sweepTimer: ReturnType<typeof setInterval> | null = null;
let activeConfig: RunReaperConfig = DEFAULT_CONFIG;
/** Sessions already mid-reap so a later sweep can't double-fire on them. */
const reapingInFlight = new Set<string>();

/**
 * `runToken` pins the release to the exact run the sweep found stalled: socket
 * session ids are reused, so between the sweep and the grace expiry the wedged
 * run may have unwound and a NEW run started on the same session id. Releasing
 * by sessionId alone would tear down that healthy run's lock and queue.
 */
async function forceReleaseSession(
  sessionId: string,
  threadId: string,
  runToken: number | undefined
): Promise<void> {
  const leftovers = activeRunTracker.finishSession(sessionId, runToken);
  const threadName = threadId;
  try {
    const { persistLeftoverQueuedMessages } =
      await import('./SocketService/handlers/chatPhases/midRunMessages');
    await persistLeftoverQueuedMessages(leftovers, { threadId, threadName });
  } catch (err) {
    LogsService.warn('[reaper] failed to persist queued messages of reaped run', {
      threadId,
      sessionId,
      error: getErrorMessage(err),
    });
  }
  // The attributed abort path normally clears each agent's UI immediately.
  // This frame is the last-resort session terminal for inconsistent states
  // where the tracker is still live but no agent controller emitted one.
  wsService.broadcastToChannel(threadId, {
    type: 'socket:chat:aborted',
    payload: { sessionId, threadId, abortedCount: 1, reaped: true },
  });
  // Undelivered messages are all in the DB now (persist-first wrote them on
  // receipt; the flush above covered any non-persisted stragglers) — wake the thread
  // once so they're answered instead of sitting silent until the next send.
  if (leftovers.length > 0) {
    const newest = leftovers[leftovers.length - 1];
    try {
      const { redispatchPersistedMessage } =
        await import('./SocketService/dispatch/dispatchToThread');
      void redispatchPersistedMessage({
        threadId,
        threadName,
        messageId: newest.id,
        coveredMessageIds: leftovers.map((m) => m.id),
        undeliveredCount: leftovers.length,
        reason: 'run reaped with undelivered mid-run messages',
      });
    } catch (err) {
      LogsService.warn('[reaper] re-dispatch of undelivered messages failed', {
        threadId,
        sessionId,
        error: getErrorMessage(err),
      });
    }
  }
}

function reapSession(stalled: {
  sessionId: string;
  threadId: string;
  stalledMs: number;
  runToken: number | undefined;
}): void {
  const { sessionId, threadId, stalledMs, runToken } = stalled;
  if (reapingInFlight.has(sessionId)) return;
  reapingInFlight.add(sessionId);

  LogsService.error(
    '[reaper] ZOMBIE RUN: zero progress — force-aborting',
    new Error(`run stalled ${Math.round(stalledMs / 1000)}s with no iteration or tool result`),
    { threadId, sessionId, stalledMs }
  );
  const abortPromise = AbortRunService.abortAllAgentRuns({
    threadId,
    abortedBy: { actorKind: 'system', actorId: 'watchdog', actorName: 'watchdog' },
  });
  // Reconcile any parked clarifications so a reap can't strand the UI's Q/A
  // form (or leave a queued answer resolving into a dead run). With the stall
  // buffer + noteProgress-on-issue above this should never fire mid-legitimate
  // wait, but if it ever does, clear them loudly rather than silently.
  const canceledClarifications = cancelClarificationsForThread(threadId);
  const canceledToolConfirmations = cancelToolConfirmationsForThread(threadId);
  void abortPromise
    .then(({ abortedCount }) => {
      LogsService.warn('[reaper] abort signaled to wedged run', {
        threadId,
        sessionId,
        abortedCount,
        canceledClarifications,
        canceledToolConfirmations,
      });
    })
    .catch((err) => {
      LogsService.error('[reaper] attributed abort failed', err, { threadId, sessionId });
    });

  const grace = setTimeout(() => {
    void (async () => {
      try {
        // Same run still holding the lock? (A newer run on a reused session id
        // is healthy and must be left alone.)
        const stillWedged =
          runToken !== undefined
            ? activeRunTracker.isSessionRun(sessionId, runToken)
            : activeRunTracker.hasActiveSession(sessionId);
        if (stillWedged) {
          LogsService.error(
            '[reaper] wedged run ignored abort — force-clearing its tracker entry',
            new Error('run did not unwind within the reaper grace window'),
            { threadId, sessionId }
          );
          await forceReleaseSession(sessionId, threadId, runToken);
        } else {
          LogsService.socket.event('[reaper] reaped run unwound cleanly via abort', {
            threadId,
            sessionId,
          });
        }
      } catch (err) {
        LogsService.error('[reaper] force-release failed', err, { threadId, sessionId });
      } finally {
        reapingInFlight.delete(sessionId);
      }
    })();
  }, activeConfig.graceMs);
  grace.unref?.();
}

function sweep(): void {
  const stalledSessions = activeRunTracker.listStalledSessions(activeConfig.stallMs);
  for (const stalled of stalledSessions) reapSession(stalled);
}

export function startRunReaper(overrides?: Partial<RunReaperConfig>): void {
  if (sweepTimer) return;
  activeConfig = { ...DEFAULT_CONFIG, ...overrides };
  sweepTimer = setInterval(sweep, activeConfig.sweepIntervalMs);
  sweepTimer.unref?.();
  LogsService.socket.event('run reaper started', {
    stallMs: activeConfig.stallMs,
    sweepIntervalMs: activeConfig.sweepIntervalMs,
    graceMs: activeConfig.graceMs,
  });
}

export function stopRunReaper(): void {
  if (!sweepTimer) return;
  clearInterval(sweepTimer);
  sweepTimer = null;
  reapingInFlight.clear();
}

/** Test seam: run one sweep synchronously (timers stay untouched). */
export function runReaperSweepOnce(): void {
  sweep();
}
