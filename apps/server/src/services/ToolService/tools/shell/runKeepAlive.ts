import { activeRunTracker } from '@server/services/ActiveRunTracker';

/** How often a parked shell wait stamps progress for its run. */
const KEEPALIVE_MS = 60_000;

/**
 * Keep the calling run off the zombie reaper's stall clock (15 min by
 * default) while a shell call deliberately blocks: a long `yield_time_ms`, or
 * the shell_exec alias contract waiting for the command to exit. The wait is
 * bounded by the session's own lifetime, so this is not a way to hang a run.
 *
 * Pinned to the run that holds the thread now, like get_clarification's
 * keep-alive, so it can never mask a newer, stuck run. Returns the stop
 * function; a call outside a thread (or on an idle thread) is a no-op.
 */
export function keepRunAlive(
  threadId: string | null | undefined,
  intervalMs: number = KEEPALIVE_MS
): () => void {
  if (!threadId) return () => {};
  const ownerSession = activeRunTracker.getActiveSessionForThread(threadId);
  if (ownerSession === undefined) return () => {};
  const ownerRun = activeRunTracker.sessionRunToken(ownerSession);
  if (ownerRun === undefined) return () => {};
  activeRunTracker.noteProgress(ownerSession);
  const timer = setInterval(() => {
    if (!activeRunTracker.isSessionRun(ownerSession, ownerRun)) {
      clearInterval(timer);
      return;
    }
    activeRunTracker.noteProgress(ownerSession);
  }, intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}
