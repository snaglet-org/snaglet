/**
 * overwriteGrant — the only thing that can authorize replacing a user's file.
 *
 * A human actor plus an `overwrite: true` boolean proves nothing: any request
 * carrying a session could set it. The signed grant is what shows the native
 * dialog asked about replacing. Every test here is a way that claim could be
 * faked.
 */

import { createHmac } from 'crypto';
import {
  canonicalPayload,
  DEFAULT_MAX_TRACKED_NONCES,
  resetSpentNonces,
  setMaxTrackedNoncesForTests,
  spentNonceCount,
  verifyOverwriteGrant,
} from '@server/services/ExportService/overwriteGrant';

const KEY = 'a'.repeat(64);
const TARGET = '/Users/test-user/Desktop/Notes.md';
const NOW = 1_800_000_000_000;

let nonceCounter = 0;
/** Hex, like the Rust side's `Uuid::simple()` — `.` is a structural separator
 *  in the token, so a nonce may never contain one. */
const freshNonce = (): string => `deadbeef${(nonceCounter++).toString(16).padStart(24, '0')}`;

/** Mint the way the Rust shell does, so the test exercises the real format. */
function mint(
  path = TARGET,
  { key = KEY, expiry = NOW + 60_000, nonce = freshNonce() } = {}
): string {
  const mac = createHmac('sha256', key)
    .update(canonicalPayload(expiry, nonce, path), 'utf8')
    .digest('hex');
  return `${expiry}.${nonce}.${mac}`;
}

beforeEach(() => {
  resetSpentNonces();
  process.env.SNAGLET_EXPORT_GRANT_KEY = KEY;
});

afterEach(() => {
  delete process.env.SNAGLET_EXPORT_GRANT_KEY;
});

describe('a genuine grant', () => {
  it('authorizes the exact path it was minted for', () => {
    expect(verifyOverwriteGrant(mint(), TARGET, NOW)).toEqual({ ok: true });
  });

  it('matches the Rust payload format byte for byte', () => {
    // Both sides sign this string. If they ever diverge, overwrite silently
    // stops working — so the shape is pinned here and in export_grant.rs.
    expect(canonicalPayload(123, 'abc', '/tmp/a.md')).toBe('v1|123|abc|9|/tmp/a.md');
  });

  it('length-prefixes the path so a pipe cannot shift the fields', () => {
    // Without the length, "/tmp/a|b" and a crafted nonce could produce the
    // same signed bytes as a different path.
    expect(canonicalPayload(1, 'n', '/tmp/a|b')).toBe('v1|1|n|8|/tmp/a|b');
  });

  it('counts bytes, not characters, for a non-ASCII path', () => {
    // "/tmp/" (5) + "é" (2 bytes in UTF-8) + ".md" (3) = 10, not the 9
    // characters JavaScript would report. Rust signs bytes, so must this.
    expect('/tmp/é.md'.length).toBe(9);
    expect(canonicalPayload(1, 'n', '/tmp/é.md')).toBe('v1|1|n|10|/tmp/é.md');
  });
});

describe('path binding', () => {
  it('refuses a grant minted for a different file', () => {
    const grant = mint('/Users/test-user/Desktop/Other.md');
    expect(verifyOverwriteGrant(grant, TARGET, NOW)).toEqual({
      ok: false,
      reason: 'bad-signature',
    });
  });

  it('refuses a grant for the same name in a different folder', () => {
    const grant = mint('/Users/test-user/Documents/Notes.md');
    expect(verifyOverwriteGrant(grant, TARGET, NOW).ok).toBe(false);
  });

  it('refuses when the resolved target differs only by a trailing component', () => {
    // The server verifies against the path it is about to write, after
    // sanitization — so a sanitized filename invalidates the grant, which is
    // correct: that is not the file the dialog asked about.
    expect(verifyOverwriteGrant(mint(), '/Users/test-user/Desktop/Notes (2).md', NOW).ok).toBe(
      false
    );
  });
});

describe('forgery', () => {
  it('refuses a grant signed with the wrong key', () => {
    const grant = mint(TARGET, { key: 'b'.repeat(64) });
    expect(verifyOverwriteGrant(grant, TARGET, NOW)).toEqual({
      ok: false,
      reason: 'bad-signature',
    });
  });

  it('refuses a tampered MAC', () => {
    const grant = mint();
    const tampered = `${grant.slice(0, -1)}${grant.endsWith('0') ? '1' : '0'}`;
    expect(verifyOverwriteGrant(tampered, TARGET, NOW)).toEqual({
      ok: false,
      reason: 'bad-signature',
    });
  });

  it('refuses an extended expiry re-stamped onto a real MAC', () => {
    // The classic attempt: keep a valid signature, move the deadline.
    const [, nonce, mac] = mint().split('.');
    const restamped = `${NOW + 60_000_000}.${nonce}.${mac}`;
    expect(verifyOverwriteGrant(restamped, TARGET, NOW).ok).toBe(false);
  });

  it.each([
    ['empty', ''],
    ['whitespace', '   '],
    ['two parts', '123.abc'],
    ['four parts', '1.2.3.4'],
    ['non-numeric expiry', `abc.n.${'0'.repeat(64)}`],
    ['short mac', '9999999999999.n.beef'],
    ['non-hex mac', `9999999999999.n.${'z'.repeat(64)}`],
    ['empty nonce', `9999999999999..${'0'.repeat(64)}`],
    // `.` separates the token's fields, so a nonce containing one produces
    // four parts and can never be valid.
    ['dotted nonce', `9999999999999.a.b.${'0'.repeat(64)}`],
  ])('refuses a %s grant', (_label, grant) => {
    expect(verifyOverwriteGrant(grant, TARGET, NOW).ok).toBe(false);
  });

  it('refuses an absent grant', () => {
    expect(verifyOverwriteGrant(undefined, TARGET, NOW)).toEqual({ ok: false, reason: 'absent' });
    expect(verifyOverwriteGrant(null, TARGET, NOW)).toEqual({ ok: false, reason: 'absent' });
  });
});

describe('expiry', () => {
  it('refuses an expired grant', () => {
    const grant = mint(TARGET, { expiry: NOW - 1 });
    expect(verifyOverwriteGrant(grant, TARGET, NOW)).toEqual({ ok: false, reason: 'expired' });
  });

  it('refuses a grant whose expiry is implausibly far out even if it verifies', () => {
    // A correctly-signed grant good for a year would mean the minting side is
    // not the shell we think it is, or a clock is badly wrong. Not honored.
    const grant = mint(TARGET, { expiry: NOW + 365 * 24 * 3600 * 1000 });
    expect(verifyOverwriteGrant(grant, TARGET, NOW)).toEqual({
      ok: false,
      reason: 'implausible-expiry',
    });
  });

  it('accepts a grant right up to its deadline', () => {
    const grant = mint(TARGET, { expiry: NOW + 1 });
    expect(verifyOverwriteGrant(grant, TARGET, NOW).ok).toBe(true);
  });
});

describe('replay', () => {
  it('consumes the nonce, so the same grant cannot be used twice', () => {
    const grant = mint();
    expect(verifyOverwriteGrant(grant, TARGET, NOW).ok).toBe(true);
    // Without single use, one captured token is a standing license to clobber
    // that path for the whole TTL.
    expect(verifyOverwriteGrant(grant, TARGET, NOW)).toEqual({ ok: false, reason: 'replayed' });
  });

  it('does not consume the nonce when verification fails', () => {
    const grant = mint();
    expect(verifyOverwriteGrant(grant, '/elsewhere/Notes.md', NOW).ok).toBe(false);
    // A failed attempt against the wrong path must not burn a grant the user
    // is about to use legitimately.
    expect(verifyOverwriteGrant(grant, TARGET, NOW).ok).toBe(true);
  });

  it('forgets nonces once they expire, so the cache cannot grow forever', () => {
    const grant = mint(TARGET, { expiry: NOW + 1_000, nonce: 'sweep-me' });
    expect(verifyOverwriteGrant(grant, TARGET, NOW).ok).toBe(true);

    // Long after expiry, a fresh grant still works and the expired nonce is gone.
    const later = NOW + 10_000;
    const fresh = mint(TARGET, { expiry: later + 1_000, nonce: 'fresh' });
    expect(verifyOverwriteGrant(fresh, TARGET, later).ok).toBe(true);
    // The expired one is refused on expiry rather than lingering as replayed.
    expect(verifyOverwriteGrant(grant, TARGET, later)).toEqual({ ok: false, reason: 'expired' });
  });
});

describe('nonce-cache saturation fails closed', () => {
  const CAPACITY = 4;

  beforeEach(() => {
    setMaxTrackedNoncesForTests(CAPACITY);
  });

  /** Spend `count` distinct valid grants, returning their tokens. */
  function fill(count: number, at = NOW): string[] {
    const used: string[] = [];
    for (let i = 0; i < count; i += 1) {
      const grant = mint(TARGET, { nonce: freshNonce() });
      expect(verifyOverwriteGrant(grant, TARGET, at).ok).toBe(true);
      used.push(grant);
    }
    return used;
  }

  it('keeps every spent nonce replay-rejected once full', () => {
    const used = fill(CAPACITY);
    expect(spentNonceCount()).toBe(CAPACITY);

    // Evicting the oldest live entries here would be wrong: forgetting a spent
    // nonce is exactly what makes replaying it succeed.
    for (const grant of used) {
      expect(verifyOverwriteGrant(grant, TARGET, NOW)).toEqual({ ok: false, reason: 'replayed' });
    }
  });

  it('refuses a new valid grant rather than making room for it', () => {
    fill(CAPACITY);

    const fresh = mint(TARGET, { nonce: freshNonce() });
    expect(verifyOverwriteGrant(fresh, TARGET, NOW)).toEqual({ ok: false, reason: 'saturated' });
  });

  it('does not record the refused grant, so capacity is unchanged', () => {
    fill(CAPACITY);
    const fresh = mint(TARGET, { nonce: 'aaaa0000000000000000000000000001' });
    verifyOverwriteGrant(fresh, TARGET, NOW);

    expect(spentNonceCount()).toBe(CAPACITY);
    // And it is refused as saturated, not as replayed — it was never stored.
    expect(verifyOverwriteGrant(fresh, TARGET, NOW)).toEqual({ ok: false, reason: 'saturated' });
  });

  it('reports a known nonce as replayed even while saturated', () => {
    const used = fill(CAPACITY);
    // Saturation must not start disguising real replay attempts as a resource
    // problem — the two are different findings.
    expect(verifyOverwriteGrant(used[0], TARGET, NOW)).toEqual({ ok: false, reason: 'replayed' });
  });

  it('recovers once the spent nonces expire and are swept', () => {
    fill(CAPACITY);
    expect(spentNonceCount()).toBe(CAPACITY);

    // Past every seeded expiry (mint defaults to now + 60s).
    const later = NOW + 120_000;
    const fresh = mint(TARGET, { expiry: later + 30_000, nonce: freshNonce() });

    expect(verifyOverwriteGrant(fresh, TARGET, later)).toEqual({ ok: true });
    // The sweep dropped the four expired entries and kept only the new one.
    expect(spentNonceCount()).toBe(1);
  });

  it('invalid grants never consume capacity', () => {
    const wrongKey = mint(TARGET, { key: 'b'.repeat(64), nonce: freshNonce() });
    const wrongPath = mint('/elsewhere/Notes.md', { nonce: freshNonce() });
    const expired = mint(TARGET, { expiry: NOW - 1, nonce: freshNonce() });

    expect(verifyOverwriteGrant(wrongKey, TARGET, NOW).ok).toBe(false);
    expect(verifyOverwriteGrant(wrongPath, TARGET, NOW).ok).toBe(false);
    expect(verifyOverwriteGrant(expired, TARGET, NOW).ok).toBe(false);
    expect(verifyOverwriteGrant('garbage', TARGET, NOW).ok).toBe(false);

    // Otherwise a flood of forged tokens would be a denial-of-service against
    // the user's own ability to overwrite their files.
    expect(spentNonceCount()).toBe(0);
    // Capacity is genuinely intact: real grants still work.
    fill(CAPACITY);
    expect(spentNonceCount()).toBe(CAPACITY);
  });
});

describe('the production capacity is not caller-configurable', () => {
  it('defaults to 10k', () => {
    expect(DEFAULT_MAX_TRACKED_NONCES).toBe(10_000);
  });

  it('refuses the test seam outside the test environment', () => {
    const original = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      expect(() => setMaxTrackedNoncesForTests(1)).toThrow(/test-only/);
    } finally {
      process.env.NODE_ENV = original;
    }
  });
});

describe('no key configured', () => {
  beforeEach(() => {
    delete process.env.SNAGLET_EXPORT_GRANT_KEY;
  });

  it('refuses everything, including a well-formed grant', () => {
    // Dev runs and browser sessions have no packaged shell, so there is no
    // key — and therefore no overwrite authority at all. Fail closed.
    expect(verifyOverwriteGrant(mint(), TARGET, NOW)).toEqual({ ok: false, reason: 'no-key' });
  });

  it('refuses an empty key as firmly as a missing one', () => {
    process.env.SNAGLET_EXPORT_GRANT_KEY = '   ';
    expect(verifyOverwriteGrant(mint(), TARGET, NOW)).toEqual({ ok: false, reason: 'no-key' });
  });
});
