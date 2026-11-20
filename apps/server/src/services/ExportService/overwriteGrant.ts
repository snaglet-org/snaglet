/**
 * overwriteGrant — verifying that a NATIVE save dialog chose this exact path.
 *
 * Replacing a user's file is the only irreversible thing export does, so it
 * needs evidence rather than a claim. An `overwrite: true` field is a claim:
 * the endpoint is reachable from the webview, from a browser against the dev
 * server, and from anything holding a session, all of which can set a boolean.
 * "The OS already asked" is not something the server can check, and an
 * unverifiable assertion is not authorization.
 *
 * A grant is an HMAC-SHA256 minted by the Rust shell in `pick_save_file`,
 * after the dialog has run, over the canonical path it returned. The key
 * (`SNAGLET_EXPORT_GRANT_KEY`) is generated per boot and passed only through the
 * sidecar's environment. It is deliberately not the sidecar or panel token:
 * those are injected into `window.__SNAGLET_DESKTOP__`, so anything the page can
 * read it can also replay, which would prove "a webview asked" — precisely
 * the thing an overwrite grant must not be able to mean.
 *
 * Fail-closed everywhere. No key (dev, browser, tests), no grant, a forged or
 * expired one, a reused nonce, or a grant for a different path: all mean
 * no-clobber. There is no configuration that turns the boolean back into
 * authority.
 */

import { createHmac, timingSafeEqual } from 'crypto';

/** Matches the Rust `GRANT_TTL_MS`; a dialog is answered in seconds. */
const MAX_TTL_MS = 120_000;

type GrantRejection =
  | 'no-key'
  | 'absent'
  | 'malformed'
  | 'expired'
  | 'implausible-expiry'
  | 'bad-signature'
  | 'replayed'
  | 'saturated';

export type GrantVerdict = { ok: true } | { ok: false; reason: GrantRejection };

/**
 * Nonces already spent, with the expiry that lets them be dropped.
 *
 * A grant is single-use: without this, one captured token would be a standing
 * license to overwrite that path for its whole lifetime.
 */
const spentNonces = new Map<string, number>();

export const DEFAULT_MAX_TRACKED_NONCES = 10_000;
let maxTrackedNonces = DEFAULT_MAX_TRACKED_NONCES;

/**
 * Drop only entries that have actually expired.
 *
 * An earlier cut evicted the oldest LIVE entries once the map grew past its
 * cap. That failed OPEN: forgetting a spent nonce is precisely what makes a
 * replay of it succeed, so the cache stopped being a replay defense at exactly
 * the moment something was hammering it. Under pressure the correct answer is
 * to stop issuing new authority, never to forget authority already spent.
 */
function sweepExpired(now: number): void {
  for (const [nonce, expiry] of spentNonces) {
    if (expiry <= now) spentNonces.delete(nonce);
  }
}

/** Test-only: forget spent nonces so cases do not leak into each other. */
export function resetSpentNonces(): void {
  spentNonces.clear();
  maxTrackedNonces = DEFAULT_MAX_TRACKED_NONCES;
}

/**
 * Test-only capacity override, so saturation can be exercised without minting
 * ten thousand grants. Refuses to run outside the test environment — the
 * production ceiling is not configurable by any caller, by design.
 */
export function setMaxTrackedNoncesForTests(limit: number): void {
  if (process.env.NODE_ENV !== 'test') {
    throw new Error('setMaxTrackedNoncesForTests is test-only');
  }
  maxTrackedNonces = limit;
}

/** Live (unexpired) spent-nonce count. Exposed for assertions and diagnostics. */
export function spentNonceCount(): number {
  return spentNonces.size;
}

/**
 * The exact bytes both sides sign. Must stay byte-identical to
 * `export_grant::canonical_payload` in the Rust shell — a divergence disables
 * overwrite rather than weakening it, but it would be a silent regression, so
 * both sides carry tests over the same fixture.
 *
 * The path is length-prefixed so a filename containing `|` cannot shift the
 * field boundaries and make one path's signature validate another's.
 */
export function canonicalPayload(expiryMs: number, nonce: string, canonicalPath: string): string {
  return `v1|${expiryMs}|${nonce}|${Buffer.byteLength(canonicalPath, 'utf8')}|${canonicalPath}`;
}

function currentKey(): string {
  return process.env.SNAGLET_EXPORT_GRANT_KEY?.trim() ?? '';
}

/**
 * Does `grant` authorize overwriting `resolvedTarget`?
 *
 * `resolvedTarget` must be the absolute path the caller is ABOUT TO WRITE,
 * after symlink resolution and filename sanitization. Verifying against the
 * requested path instead of the resolved one would let a grant for a harmless
 * name authorize a write somewhere else.
 *
 * On success the nonce is consumed, so the same grant cannot be replayed.
 */
export function verifyOverwriteGrant(
  grant: string | undefined | null,
  resolvedTarget: string,
  now: number = Date.now()
): GrantVerdict {
  const key = currentKey();
  // No key means this is not a packaged desktop run. Dev and browser sessions
  // get no overwrite authority at all, which is the intended degradation.
  if (!key) return { ok: false, reason: 'no-key' };
  if (!grant?.trim()) return { ok: false, reason: 'absent' };

  const parts = grant.trim().split('.');
  if (parts.length !== 3) return { ok: false, reason: 'malformed' };
  const [expiryRaw, nonce, macHex] = parts;

  const expiry = Number(expiryRaw);
  if (!Number.isSafeInteger(expiry) || !nonce || !/^[0-9a-f]{64}$/.test(macHex)) {
    return { ok: false, reason: 'malformed' };
  }
  if (expiry <= now) return { ok: false, reason: 'expired' };
  // A far-future expiry is not a valid grant even if it verifies: it would
  // mean the minting side is not the shell we think it is, or that a clock is
  // badly wrong. Either way it is not something to honor.
  if (expiry - now > MAX_TTL_MS) return { ok: false, reason: 'implausible-expiry' };

  const expected = createHmac('sha256', key)
    .update(canonicalPayload(expiry, nonce, resolvedTarget), 'utf8')
    .digest();
  const supplied = Buffer.from(macHex, 'hex');
  // Both are fixed 32 bytes by construction, so the length guard below is for
  // safety rather than a real branch — timingSafeEqual throws on a mismatch.
  if (supplied.length !== expected.length) return { ok: false, reason: 'malformed' };
  if (!timingSafeEqual(supplied, expected)) return { ok: false, reason: 'bad-signature' };

  // Only a grant that has already proven authentic gets this far, so a forged,
  // wrong-path, or expired token can never consume capacity.
  sweepExpired(now);

  // Replay is checked before capacity: a nonce we have already seen must come
  // back as `replayed` whatever the map's size, otherwise saturation would
  // start disguising real replay attempts as a resource problem.
  if (spentNonces.has(nonce)) return { ok: false, reason: 'replayed' };

  if (spentNonces.size >= maxTrackedNonces) {
    // Fail closed. Recording this would exceed the bound; not recording it but
    // authorizing anyway would hand out an un-tracked, replayable grant. The
    // only safe answer is to refuse the new authority and keep every spent
    // nonce we already hold. Reaching this means grants are being minted far
    // faster than a human can answer a save dialog.
    return { ok: false, reason: 'saturated' };
  }

  spentNonces.set(nonce, expiry);
  return { ok: true };
}
