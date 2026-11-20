import { describe, expect, it } from '@jest/globals';
import {
  DEFAULT_DIGEST_TOKEN_THRESHOLD,
  estimateNewConversationTokens,
  resolveDigestTokenThreshold,
} from '@server/services/summary/digestTrigger';

describe('resolveDigestTokenThreshold', () => {
  it('defaults to 20,000 tokens and takes a per-model override', () => {
    expect(DEFAULT_DIGEST_TOKEN_THRESHOLD).toBe(20_000);
    expect(resolveDigestTokenThreshold(undefined)).toBe(20_000);
    expect(resolveDigestTokenThreshold({})).toBe(20_000);
    expect(resolveDigestTokenThreshold({ tokenThreshold: 5_000 })).toBe(5_000);
  });

  it('ignores a value that is not a positive whole number', () => {
    for (const bad of [0, -3, 1.5, Number.NaN, '9000' as never]) {
      expect(resolveDigestTokenThreshold({ tokenThreshold: bad })).toBe(20_000);
    }
  });
});

describe('estimateNewConversationTokens', () => {
  const est = (messageTexts: string[], toolChars = 0) =>
    estimateNewConversationTokens({ messageTexts, toolChars, provider: 'anthropic' });

  it('thirty short lines are nowhere near the threshold', () => {
    const lines = Array.from({ length: 30 }, (_, i) => `ok, doing step ${i}`);
    expect(est(lines)).toBeLessThan(DEFAULT_DIGEST_TOKEN_THRESHOLD / 10);
  });

  it('one tool-heavy run reaches it without a single long message', () => {
    expect(est(['run the audit'], 70_000)).toBeLessThan(DEFAULT_DIGEST_TOKEN_THRESHOLD);
    expect(est(['run the audit'], 82_000)).toBeGreaterThanOrEqual(DEFAULT_DIGEST_TOKEN_THRESHOLD);
  });

  it('long messages count by their text', () => {
    expect(est(['word '.repeat(30_000)])).toBeGreaterThanOrEqual(DEFAULT_DIGEST_TOKEN_THRESHOLD);
  });
});
