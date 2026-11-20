/**
 * Google OAuth `state` ledger: the CSRF gate for the consent round-trip.
 * Without a record of issued states the callback would accept any `?code=` an
 * attacker gets the browser to load (login CSRF: Snaglet would exchange the
 * attacker's code and the Google tools would write to their account). Each
 * entry also pins the consent URL's redirect URI, which Google checks again at
 * token exchange. Entries live in process memory, are single-use and expire:
 * consuming one removes it, so a replayed callback is rejected, and a restart
 * only costs another click on Connect.
 */

import { randomUUID } from 'crypto';

/**
 * How long an issued state stays redeemable. Long enough to sign in, pick an
 * account, and read the consent screen; short enough that a leaked URL in a
 * browser history or proxy log is worthless by the time it is found.
 */
export const GOOGLE_OAUTH_STATE_TTL_MS = 10 * 60 * 1000; // 10 minutes

/**
 * Hard cap so a script hammering `/oauth/start` cannot grow the map without
 * bound. Oldest entries are evicted first; a user with one browser tab open
 * never comes close to this.
 */
const MAX_PENDING_STATES = 32;

interface PendingState {
  /** Redirect URI baked into the consent URL this state was issued for. */
  redirectUri: string;
  /** Unix ms after which the entry is no longer redeemable. */
  expiresAt: number;
}

const pending = new Map<string, PendingState>();

/** Drop everything already past its TTL. Called on every issue/consume. */
function prune(now: number): void {
  for (const [state, entry] of pending) {
    if (entry.expiresAt <= now) pending.delete(state);
  }
}

/**
 * Mint a single-use state bound to the redirect URI the consent URL will
 * carry. Return value goes into the Google authorization request.
 */
export function issueGoogleOAuthState(redirectUri: string): string {
  const now = Date.now();
  prune(now);
  // Map preserves insertion order, so the first key is the oldest entry.
  while (pending.size >= MAX_PENDING_STATES) {
    const oldest = pending.keys().next();
    if (oldest.done) break;
    pending.delete(oldest.value);
  }
  const state = randomUUID();
  pending.set(state, { redirectUri, expiresAt: now + GOOGLE_OAUTH_STATE_TTL_MS });
  return state;
}

/**
 * Redeem a state returned by Google. Returns the pinned redirect URI on
 * success and `null` for a state that is missing, unknown, expired, or
 * already used — the caller must treat every `null` the same way (reject the
 * callback) rather than distinguishing them to the browser, since the
 * difference is only useful to someone probing.
 */
export function consumeGoogleOAuthState(state: string): { redirectUri: string } | null {
  const now = Date.now();
  prune(now);
  if (!state) return null;
  const entry = pending.get(state);
  if (!entry) return null;
  // Single use: redeeming removes it, so a replayed callback finds nothing.
  pending.delete(state);
  if (entry.expiresAt <= now) return null;
  return { redirectUri: entry.redirectUri };
}

/** Test seam — forget every issued state. */
export function resetGoogleOAuthStates(): void {
  pending.clear();
}

/** Test seam — how many states are currently redeemable. */
export function pendingGoogleOAuthStateCount(): number {
  prune(Date.now());
  return pending.size;
}
