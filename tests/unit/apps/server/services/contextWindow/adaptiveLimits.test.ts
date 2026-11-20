import { describe, expect, it } from '@jest/globals';
import {
  replayRunCapCeiling,
  resultIngestCeilingChars,
  shrinkReplayRunCap,
} from '@server/services/contextWindow/adaptiveLimits';

// A 200k-window model: roughly 112k tokens before the fold; a 32k-window model: 12k.
const LARGE = 112_000;
const SMALL = 12_000;

describe('resultIngestCeilingChars', () => {
  const floorChars = 12_000;

  it('lets a large result through whole on an empty large window', () => {
    const ceiling = resultIngestCeilingChars({
      floorChars,
      tokenThreshold: LARGE,
      usedTokens: 5_000,
    });
    expect(ceiling).toBeGreaterThan(60_000);
    expect(28_767).toBeLessThan(ceiling); // a 28,767-char page fits
  });

  it('shrinks as the context fills, down to the floor', () => {
    const at = (usedTokens: number) =>
      resultIngestCeilingChars({ floorChars, tokenThreshold: LARGE, usedTokens });
    expect(at(10_000)).toBeGreaterThan(at(50_000));
    expect(at(50_000)).toBeGreaterThan(at(100_000));
    expect(at(LARGE)).toBe(floorChars);
    expect(at(LARGE * 2)).toBe(floorChars);
  });

  it('never goes below the configured floor, even on a small window', () => {
    expect(resultIngestCeilingChars({ floorChars, tokenThreshold: SMALL, usedTokens: 0 })).toBe(
      floorChars
    );
  });

  it('honors a raised floor', () => {
    expect(
      resultIngestCeilingChars({ floorChars: 90_000, tokenThreshold: LARGE, usedTokens: 100_000 })
    ).toBe(90_000);
  });
});

describe('replay run cap', () => {
  const floor = 10_000;

  it('is far above the floor on a large window, and at the floor on a small one', () => {
    expect(replayRunCapCeiling(LARGE, floor)).toBeGreaterThan(20_000);
    expect(replayRunCapCeiling(SMALL, floor)).toBe(floor);
  });

  it('keeps the full ceiling while the replay fits the free space', () => {
    const ceiling = replayRunCapCeiling(LARGE, floor);
    expect(shrinkReplayRunCap({ ceiling, floor, freeTokens: 100_000, totalTokens: 60_000 })).toBe(
      ceiling
    );
  });

  it('shrinks in proportion when the replay does not fit, never below the floor', () => {
    const ceiling = replayRunCapCeiling(LARGE, floor);
    const half = shrinkReplayRunCap({ ceiling, floor, freeTokens: 50_000, totalTokens: 100_000 });
    expect(half).toBeLessThan(ceiling);
    expect(half).toBeGreaterThanOrEqual(floor);
    expect(shrinkReplayRunCap({ ceiling, floor, freeTokens: 0, totalTokens: 100_000 })).toBe(floor);
    expect(shrinkReplayRunCap({ ceiling, floor, freeTokens: -5, totalTokens: 100_000 })).toBe(
      floor
    );
  });
});
