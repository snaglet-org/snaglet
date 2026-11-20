/**
 * Per-thread run-ended alerts: what a window decides when a broadcast
 * `thread.run_alert` event arrives. A window showing that thread with focus
 * stays silent ({@link isWatchingThread}), and of several open windows only
 * one alerts ({@link claimRunAlert}). The bridge decides who plays the sound.
 */

/** How long a claim on one run's alert stays valid. */
export const RUN_ALERT_CLAIM_TTL_MS = 30_000;

const CLAIM_PREFIX = 'snaglet.runAlert.';

/**
 * Whether this window is actively watching `threadId`: the active pane's
 * thread is that thread and the window has focus. Pure: the caller passes
 * what it knows about the window.
 */
export function isWatchingThread(params: {
  threadId: string;
  /** The thread the active pane is showing, if any. */
  activeThreadId: string | null;
  /** Whether this window currently has OS focus. */
  windowFocused: boolean;
}): boolean {
  if (!params.windowFocused) return false;
  if (!params.activeThreadId) return false;
  return params.activeThreadId === params.threadId;
}

/** The minimal `localStorage` surface {@link claimRunAlert} needs. */
export interface RunAlertClaimStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/**
 * Claim the right to alert for one run, so only one window of several does.
 * The first caller writes `snaglet.runAlert.<runId>` and gets true; a claim newer
 * than {@link RUN_ALERT_CLAIM_TTL_MS} makes later callers get false.
 * Best effort, not a lock: a lost race costs one duplicate banner. A storage
 * that throws answers true, since alerting twice beats never.
 */
export function claimRunAlert(
  runId: string,
  store: RunAlertClaimStore | null | undefined,
  now = Date.now()
): boolean {
  if (!store) return true;
  const key = `${CLAIM_PREFIX}${runId}`;
  try {
    const raw = store.getItem(key);
    const claimedAt = raw === null ? null : Number.parseInt(raw, 10);
    if (
      claimedAt !== null &&
      Number.isFinite(claimedAt) &&
      now - claimedAt < RUN_ALERT_CLAIM_TTL_MS
    ) {
      return false;
    }
    store.setItem(key, String(now));
    return true;
  } catch {
    return true;
  }
}

/** This window's `localStorage`, or null where there is none (SSR, tests). */
export function runAlertClaimStore(): RunAlertClaimStore | null {
  if (typeof window === 'undefined') return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}
