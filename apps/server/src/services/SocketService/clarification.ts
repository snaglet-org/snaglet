/**
 * clarification.ts — the blocking primitive behind the `ask` tool.
 *
 * Generalizes the tool-confirmation flow (see confirmation.ts): instead of a
 * boolean approve/deny, it broadcasts a structured question set to the thread,
 * parks a resolve callback, and resolves with the user's answers (or on timeout).
 *
 * Keyed by THREAD, not session, so a clarification survives a UI reload: the
 * page reconnects with a brand-new sessionId, but the parked run and this map
 * live on in the same server process. `session:resume` calls
 * listPendingClarifications() to re-emit the question to the reconnected client.
 * (A server *restart* still loses it — the run itself is in-memory.)
 *
 * Timeout is far longer than confirmation's 60s — a clarification asks the user
 * to make a real decision and they may step away; on expiry it auto-resolves as
 * 'timed_out' so the agent never blocks forever. Stop (the turn's abort signal)
 * cancels it immediately.
 */
import { logger } from '@server/config/logger';
import { announceAsk, announceAskSettled } from './askFeed';
import { wsService } from '../WebSocketService';
import { activeRunTracker } from '@server/services/ActiveRunTracker';
import { notifyClarificationAsk, type AskNotification } from '@server/services/askNotifications';
import type {
  ClarificationAnswer,
  ClarificationRequest,
  ClarificationRequestPayload,
  ClarificationStatus,
} from '@snaglet/shared/types';

export interface ClarificationOutcome {
  status: ClarificationStatus;
  answers: Record<string, ClarificationAnswer>;
}

interface PendingClarificationEntry {
  callId: string;
  agentId: string;
  runId?: string;
  request: ClarificationRequest;
  resolve: (outcome: ClarificationOutcome) => void;
  /** The feed notification announcing this question; dismissed when it settles. */
  notification?: AskNotification;
}

const DEFAULT_TIMEOUT_MS = 10 * 60_000; // 10 minutes
/**
 * While a clarification is parked, re-stamp run progress on this cadence so the
 * zombie reaper never mistakes an intentional human-answer wait for a wedged
 * run. Comfortably shorter than the reaper's stall window (15 min).
 */
const KEEPALIVE_MS = 60_000; // 1 minute
/**
 * The keep-alive never outlives this, whatever timeout a caller passes: past
 * it a still-parked run is left to the reaper like any other silent run.
 */
const MAX_KEEPALIVE_LIFETIME_MS = DEFAULT_TIMEOUT_MS;

const pendingByThread = new Map<string, Map<string, PendingClarificationEntry>>();

function threadMap(threadId: string): Map<string, PendingClarificationEntry> {
  let map = pendingByThread.get(threadId);
  if (!map) {
    map = new Map();
    pendingByThread.set(threadId, map);
  }
  return map;
}

function drop(threadId: string, callId: string): void {
  const map = pendingByThread.get(threadId);
  if (!map) return;
  map.delete(callId);
  if (map.size === 0) pendingByThread.delete(threadId);
}

function toPayload(threadId: string, e: PendingClarificationEntry): ClarificationRequestPayload {
  return { threadId, callId: e.callId, agentId: e.agentId, runId: e.runId, request: e.request };
}

/**
 * Broadcast a clarification request to the thread and block until the user
 * answers (or it times out). Resolves with status='timed_out' on expiry, and
 * with status='dismissed' (clearing the UI's form) when `abortSignal` fires.
 *
 * The question is also a notification (askNotifications), dismissed on each
 * way it settles: answered or dismissed (resolveClarification), the timeout,
 * the run's abort, and cancelClarificationsForThread. All of them run
 * through `cleanup`.
 */
export function waitForClarification(
  threadId: string,
  callId: string,
  agentId: string,
  runId: string | undefined,
  request: ClarificationRequest,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
  keepAliveMs: number = KEEPALIVE_MS,
  abortSignal?: AbortSignal
): Promise<ClarificationOutcome> {
  return new Promise<ClarificationOutcome>((resolve) => {
    // Zombie-reaper safety: a run parked for a human answer IS making progress.
    // Stamp it on issue, then keep stamping while parked so an intentional wait
    // never counts against the reaper's stall clock. The keep-alive is pinned
    // to the run that asked — it stops once that run no longer holds the
    // thread, so an orphaned question can never mask a newer, stuck run.
    activeRunTracker.noteProgressForThread(threadId);
    const ownerSession = activeRunTracker.getActiveSessionForThread(threadId);
    const ownerRun =
      ownerSession !== undefined ? activeRunTracker.sessionRunToken(ownerSession) : undefined;
    const keepAliveUntil = Date.now() + Math.min(timeoutMs, MAX_KEEPALIVE_LIFETIME_MS);
    const keepAlive = setInterval(() => {
      const stillOwned =
        ownerSession !== undefined &&
        ownerRun !== undefined &&
        activeRunTracker.isSessionRun(ownerSession, ownerRun);
      if (!stillOwned || Date.now() >= keepAliveUntil) {
        clearInterval(keepAlive);
        return;
      }
      activeRunTracker.noteProgress(ownerSession);
    }, keepAliveMs);
    keepAlive.unref?.();
    let notification: AskNotification | null = null;
    const cleanup = (): void => {
      announceAskSettled(callId);
      clearTimeout(timeout);
      clearInterval(keepAlive);
      abortSignal?.removeEventListener('abort', onAbort);
      void notification?.settle();
    };
    const onAbort = (): void => {
      if (pendingByThread.get(threadId)?.get(callId) !== entry) return;
      drop(threadId, callId);
      wsService.broadcastToChannel(threadId, {
        type: 'socket:clarification:timeout',
        payload: { callId },
      });
      entry.resolve({ status: 'dismissed', answers: {} });
    };

    const timeout = setTimeout(() => {
      cleanup();
      drop(threadId, callId);
      logger.warn(`[tool:clarify] timed out [thread=${threadId}] [callId=${callId}]`, {
        threadId,
        callId,
        eventType: 'tool_clarification_timeout',
      });
      wsService.broadcastToChannel(threadId, {
        type: 'socket:clarification:timeout',
        payload: { callId },
      });
      resolve({ status: 'timed_out', answers: {} });
    }, timeoutMs);

    const entry: PendingClarificationEntry = {
      callId,
      agentId,
      runId,
      request,
      resolve: (outcome) => {
        cleanup();
        resolve(outcome);
      },
    };
    // Stopped before the question was ever shown: nothing to clear in the UI.
    if (abortSignal?.aborted) {
      entry.resolve({ status: 'dismissed', answers: {} });
      return;
    }
    threadMap(threadId).set(callId, entry);
    abortSignal?.addEventListener('abort', onAbort, { once: true });
    notification = notifyClarificationAsk({ threadId, callId, agentId, runId, request });
    entry.notification = notification;

    const requestFrame = {
      type: 'socket:clarification:request',
      payload: toPayload(threadId, entry),
    };
    wsService.broadcastToChannel(threadId, requestFrame);
    announceAsk(requestFrame);
  });
}

/** Resolve a parked clarification (answer/dismiss). No-op if already gone. */
export function resolveClarification(
  threadId: string | undefined,
  callId: string | undefined,
  outcome: ClarificationOutcome
): void {
  if (!threadId || !callId) return;
  const entry = pendingByThread.get(threadId)?.get(callId);
  if (!entry) return;
  drop(threadId, callId);
  entry.resolve(outcome);
}

/**
 * Cancel every clarification still parked on a thread — or only one agent's,
 * when `agentId` is given: unblock each parked run with a 'timed_out' outcome
 * and clear the UI's Q/A form via socket:clarification:timeout. Returns the
 * count canceled. Called when a run is force-aborted or stopped so a pending
 * question can't be stranded or let a user's about-to-submit answer resolve
 * into a dead run.
 */
export function cancelClarificationsForThread(threadId: string, agentId?: string): number {
  const map = pendingByThread.get(threadId);
  if (!map || map.size === 0) return 0;
  const entries = Array.from(map.values()).filter((e) => !agentId || e.agentId === agentId);
  for (const entry of entries) drop(threadId, entry.callId);
  for (const entry of entries) {
    wsService.broadcastToChannel(threadId, {
      type: 'socket:clarification:timeout',
      payload: { callId: entry.callId },
    });
    // resolve() clears the entry's own timeout + keepalive (see the wrapper).
    entry.resolve({ status: 'timed_out', answers: {} });
  }
  return entries.length;
}

/**
 * Snapshot of a thread's still-pending clarifications, as request payloads —
 * re-emitted to a client that just (re)connected so a reloaded page gets its
 * question back.
 */
export function listPendingClarifications(threadId: string): ClarificationRequestPayload[] {
  const map = pendingByThread.get(threadId);
  return map ? Array.from(map.values()).map((e) => toPayload(threadId, e)) : [];
}

/** Every still-pending clarification across all threads (the global ask feed's snapshot). */
export function listAllPendingClarifications(): ClarificationRequestPayload[] {
  const out: ClarificationRequestPayload[] = [];
  for (const [threadId, map] of pendingByThread) {
    for (const entry of map.values()) out.push(toPayload(threadId, entry));
  }
  return out;
}
