/**
 * twoTierStt — the finalize fallback matrix: prefer the cased
 * Moonshine re-decode, fall back to the normalized streaming final on timeout /
 * failure / empty / no-model. Driven with a mocked quality decoder + fake timers.
 */

import { describe, expect, it, jest, beforeEach, afterEach } from '@jest/globals';
import { resolveTwoTierFinal } from '@server/services/SocketService/voiceSession/twoTierStt';

const ZIPFORMER = 'THE QUICK BROWN FOX JUMPS OVER THE LAZY DOG';
const MOONSHINE = 'The quick brown fox jumps over the lazy dog.';
const pcm = Int16Array.from([1, 2, 3, 4]);

describe('resolveTwoTierFinal — quality wins', () => {
  it('dispatches the (normalized, already-cased) quality text', async () => {
    const qualityDecode = jest.fn(async () => MOONSHINE);
    const r = await resolveTwoTierFinal({
      streamingText: ZIPFORMER,
      pcm,
      qualityDecode,
      timeoutMs: 1200,
    });
    expect(r.tier).toBe('quality');
    expect(r.text).toBe(MOONSHINE);
    expect(r.qualityText).toBe(MOONSHINE);
    // The streaming tier is still normalized (kept for fallback/logging).
    expect(r.streamingText).toBe('The quick brown fox jumps over the lazy dog');
    expect(r.timedOut).toBe(false);
    expect(qualityDecode).toHaveBeenCalledWith(pcm);
  });
});

describe('resolveTwoTierFinal — fallbacks to the normalized streaming final', () => {
  it('when there is no quality decoder', async () => {
    const r = await resolveTwoTierFinal({ streamingText: ZIPFORMER, pcm, timeoutMs: 1200 });
    expect(r.tier).toBe('streaming');
    expect(r.text).toBe('The quick brown fox jumps over the lazy dog');
    expect(r.qualityDecodeMs).toBe(0);
  });

  it('when there is no pcm to re-decode', async () => {
    const qualityDecode = jest.fn(async () => MOONSHINE);
    const r = await resolveTwoTierFinal({
      streamingText: ZIPFORMER,
      pcm: null,
      qualityDecode,
      timeoutMs: 1200,
    });
    expect(r.tier).toBe('streaming');
    expect(qualityDecode).not.toHaveBeenCalled();
  });

  it('when the quality decode rejects (model missing / worker error)', async () => {
    const qualityDecode = jest.fn(async () => {
      throw new Error('quality model unavailable');
    });
    const r = await resolveTwoTierFinal({
      streamingText: ZIPFORMER,
      pcm,
      qualityDecode,
      timeoutMs: 1200,
    });
    expect(r.tier).toBe('streaming');
    expect(r.text).toBe('The quick brown fox jumps over the lazy dog');
  });

  it('when the quality decode returns empty text', async () => {
    const qualityDecode = jest.fn(async () => '   ');
    const r = await resolveTwoTierFinal({
      streamingText: ZIPFORMER,
      pcm,
      qualityDecode,
      timeoutMs: 1200,
    });
    expect(r.tier).toBe('streaming');
    expect(r.qualityText).toBe('');
  });
});

describe('resolveTwoTierFinal — timeout fallback', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('falls back to the streaming final when the quality decode exceeds the timeout', async () => {
    let resolveQuality!: (t: string) => void;
    const qualityDecode = jest.fn(() => new Promise<string>((res) => (resolveQuality = res)));

    const p = resolveTwoTierFinal({
      streamingText: ZIPFORMER,
      pcm,
      qualityDecode,
      timeoutMs: 1200,
    });

    // Fire the timeout before the decode ever resolves.
    await jest.advanceTimersByTimeAsync(1200);
    const r = await p;

    expect(r.timedOut).toBe(true);
    expect(r.tier).toBe('streaming');
    expect(r.text).toBe('The quick brown fox jumps over the lazy dog');

    // A late resolve is harmless (already fell back).
    resolveQuality(MOONSHINE);
  });

  it('uses the quality text when it resolves before the timeout', async () => {
    const qualityDecode = jest.fn(async () => MOONSHINE);
    const p = resolveTwoTierFinal({
      streamingText: ZIPFORMER,
      pcm,
      qualityDecode,
      timeoutMs: 1200,
    });
    await jest.advanceTimersByTimeAsync(0); // let the resolved decode win the race
    const r = await p;
    expect(r.timedOut).toBe(false);
    expect(r.tier).toBe('quality');
    expect(r.text).toBe(MOONSHINE);
  });
});
