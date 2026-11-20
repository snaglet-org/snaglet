/**
 * Trim plan tokens.
 *
 * The token is the stale-preview guard: it binds "the plan a human reviewed"
 * to "the thread state it was measured against". These tests pin the two
 * properties `apply` relies on — a token cannot be forged or edited, and a
 * thread whose shape moved produces a different revision.
 */

import { describe, expect, it } from '@jest/globals';
import {
  assertTokenFresh,
  computeImpactDigest,
  computeThreadRevision,
  issueTrimToken,
  verifyTrimToken,
  TRIM_TOKEN_TTL_MS,
  type TrimPlanTokenPayload,
} from '@server/domains/threads/trim/threadTrimToken';
import type { ThreadTimelineShape } from '@server/domains/threads/trim/threadTrimQueries';

const shape = (over: Partial<ThreadTimelineShape> = {}): ThreadTimelineShape => ({
  messageCount: 10,
  firstKey: { createdAt: '2026-01-01T00:00:00.000Z', id: 'message-a' },
  lastKey: { createdAt: '2026-01-02T00:00:00.000Z', id: 'message-z' },
  runCount: 3,
  activityCount: 12,
  summaryCount: 2,
  ...over,
});

const payload = (over: Partial<TrimPlanTokenPayload> = {}): TrimPlanTokenPayload => ({
  t: 'thread-1',
  r: computeThreadRevision(shape()),
  f: 'message-f',
  l: 'message-l',
  s: false,
  d: computeImpactDigest([1, 2, 3]),
  i: Date.now(),
  ...over,
});

describe('computeThreadRevision', () => {
  it('is stable for an unchanged thread', () => {
    expect(computeThreadRevision(shape())).toBe(computeThreadRevision(shape()));
  });

  it('changes when a message is appended', () => {
    const before = computeThreadRevision(shape());
    const after = computeThreadRevision(
      shape({
        messageCount: 11,
        lastKey: { createdAt: '2026-01-03T00:00:00.000Z', id: 'message-new' },
      })
    );
    expect(after).not.toBe(before);
  });

  it('changes when only the message count moves', () => {
    expect(computeThreadRevision(shape({ messageCount: 11 }))).not.toBe(
      computeThreadRevision(shape())
    );
  });

  it('changes when the oldest message is removed', () => {
    expect(
      computeThreadRevision(
        shape({ firstKey: { createdAt: '2026-01-01T06:00:00.000Z', id: 'message-b' } })
      )
    ).not.toBe(computeThreadRevision(shape()));
  });

  it('changes when a run, activity row, or summary appears', () => {
    const base = computeThreadRevision(shape());
    expect(computeThreadRevision(shape({ runCount: 4 }))).not.toBe(base);
    expect(computeThreadRevision(shape({ activityCount: 13 }))).not.toBe(base);
    expect(computeThreadRevision(shape({ summaryCount: 3 }))).not.toBe(base);
  });

  it('handles an empty thread without throwing', () => {
    expect(
      computeThreadRevision(shape({ messageCount: 0, firstKey: null, lastKey: null }))
    ).toEqual(expect.any(String));
  });
});

describe('computeImpactDigest', () => {
  it('is order sensitive, so removed/remaining cannot be transposed unnoticed', () => {
    expect(computeImpactDigest([1, 2])).not.toBe(computeImpactDigest([2, 1]));
  });

  it('changes when any single figure changes', () => {
    expect(computeImpactDigest([50, 2, 10])).not.toBe(computeImpactDigest([51, 2, 10]));
  });
});

describe('issueTrimToken / verifyTrimToken', () => {
  it('round-trips a payload intact', () => {
    const p = payload();
    expect(verifyTrimToken(issueTrimToken(p))).toEqual(p);
  });

  it('rejects a token whose payload was edited', () => {
    const token = issueTrimToken(payload());
    const [encoded, signature] = token.split('.');
    const decoded = JSON.parse(Buffer.from(encoded!, 'base64url').toString('utf8'));
    decoded.f = 'message-somewhere-else';
    const tampered = `${Buffer.from(JSON.stringify(decoded), 'utf8').toString('base64url')}.${signature}`;
    expect(verifyTrimToken(tampered)).toBeNull();
  });

  it('rejects a token whose signature was edited', () => {
    const token = issueTrimToken(payload());
    const [encoded, signature] = token.split('.');
    const flipped = signature!.slice(0, -1) + (signature!.endsWith('A') ? 'B' : 'A');
    expect(verifyTrimToken(`${encoded}.${flipped}`)).toBeNull();
  });

  it('rejects unsigned, empty, and structurally wrong tokens', () => {
    expect(verifyTrimToken('')).toBeNull();
    expect(verifyTrimToken('nodot')).toBeNull();
    expect(verifyTrimToken('.sig')).toBeNull();
    expect(
      verifyTrimToken(`${Buffer.from('{"t":"x"}', 'utf8').toString('base64url')}.deadbeef`)
    ).toBeNull();
  });

  it('rejects a correctly signed token whose payload is missing fields', () => {
    // Signed with the real key but shaped wrong — the field guards must catch it.
    const partial = issueTrimToken({ t: 'thread-1' } as unknown as TrimPlanTokenPayload);
    expect(verifyTrimToken(partial)).toBeNull();
  });
});

describe('assertTokenFresh', () => {
  it('accepts a token inside its review window', () => {
    const now = Date.now();
    expect(() => assertTokenFresh(payload({ i: now - 1000 }), now)).not.toThrow();
  });

  it('rejects a token past its TTL', () => {
    const now = Date.now();
    expect(() => assertTokenFresh(payload({ i: now - TRIM_TOKEN_TTL_MS - 1 }), now)).toThrow(
      /expired/i
    );
  });
});
