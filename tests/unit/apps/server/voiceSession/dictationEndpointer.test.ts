/**
 * dictationEndpointer — when a dictated utterance on Apple's recognizer is over,
 * from frame levels + the recognizer's text alone (no voice-detection model).
 * Driven with synthetic RMS levels: 32 ms frames, 1 s of trailing quiet.
 */

import { describe, expect, it } from '@jest/globals';
import {
  createDictationEndpointer,
  frameRms,
  type DictationEndpointer,
} from '@server/services/SocketService/voiceSession/dictationEndpointer';

const VOICE = 0.1; // ordinary speech level
const QUIET = 0.001; // a quiet room after noise suppression

function endpointer(): DictationEndpointer {
  return createDictationEndpointer({
    frameMs: 32,
    silenceMs: 1000,
    minVoicedMs: 128,
    minRms: 0.008,
    floorRatio: 3,
    loudRms: 0.05,
    floorWindowMs: 3000,
    idleMs: 6000,
    maxUtteranceMs: 60_000,
  });
}

/** Push `frames` frames at `rms`; returns the 1-based frame that ended it (0 = none). */
function push(ep: DictationEndpointer, rms: number, frames: number): number {
  for (let i = 1; i <= frames; i++) if (ep.pushFrame(rms)) return i;
  return 0;
}

describe('dictationEndpointer', () => {
  it('ends an utterance after 1 s of quiet following speech', () => {
    const ep = endpointer();
    expect(push(ep, VOICE, 30)).toBe(0); // ~1 s of speech never ends it
    expect(ep.heard()).toBe(true);
    // 1000 ms / 32 ms → the 32nd quiet frame ends it.
    expect(push(ep, QUIET, 40)).toBe(32);
  });

  it('a natural mid-sentence pause shorter than the window does not end it', () => {
    const ep = endpointer();
    push(ep, VOICE, 20);
    expect(push(ep, QUIET, 20)).toBe(0); // 640 ms pause
    expect(push(ep, VOICE, 20)).toBe(0); // speech resumes → quiet resets
    expect(push(ep, QUIET, 40)).toBe(32);
  });

  it('never ends on silence alone, however long', () => {
    const ep = endpointer();
    expect(push(ep, QUIET, 2000)).toBe(0); // ~64 s of nothing
    expect(ep.heard()).toBe(false);
  });

  it('ignores a click shorter than the voiced minimum', () => {
    const ep = endpointer();
    push(ep, VOICE, 2); // 64 ms click
    expect(push(ep, QUIET, 100)).toBe(0);
  });

  it("counts the recognizer's text as heard, even for speech below the level threshold", () => {
    const ep = endpointer();
    expect(push(ep, 0.005, 40)).toBe(0); // soft speech, under minRms
    ep.noteText('Buy milk tomorrow.');
    expect(ep.heard()).toBe(true);
    // The quiet has already lasted > 1 s, so the next frame ends it.
    expect(push(ep, 0.005, 5)).toBe(1);
  });

  it('speech from the very first frame still counts (loud frames are always voice)', () => {
    const ep = endpointer();
    expect(push(ep, VOICE, 10)).toBe(0);
    expect(ep.heard()).toBe(true);
  });

  it('measures speech against the noise floor, so a steady hum is quiet', () => {
    const ep = endpointer();
    const HUM = 0.02; // above minRms on its own
    expect(push(ep, HUM, 200)).toBe(0); // 6.4 s of hum is not speech
    expect(ep.heard()).toBe(false);
    push(ep, 0.2, 20); // speech well above the hum (10x)
    expect(push(ep, HUM, 40)).toBe(32); // back to the hum = quiet
  });

  it("noisy room: ends once Apple's text stops changing, even if it never goes quiet", () => {
    const ep = endpointer();
    // Babble that swings far above its own floor: always "voice".
    const babble = (i: number) => (i % 2 === 0 ? 0.01 : 0.2);
    let ended = 0;
    ep.noteText('Call the plumber.');
    for (let i = 1; i <= 400 && !ended; i++) if (ep.pushFrame(babble(i))) ended = i;
    // 6000 ms / 32 ms → the 188th frame after the last text change.
    expect(ended).toBe(188);
  });

  it('caps one utterance at the maximum length', () => {
    const ep = endpointer();
    let ended = 0;
    for (let i = 1; i <= 2000 && !ended; i++) {
      if (i % 100 === 0) ep.noteText(`words ${i}`); // keeps changing: no idle end
      if (ep.pushFrame(i % 2 === 0 ? 0.01 : 0.2)) ended = i;
    }
    expect(ended).toBe(Math.ceil(60_000 / 32));
  });

  it('reset starts a fresh utterance', () => {
    const ep = endpointer();
    push(ep, VOICE, 20);
    ep.noteText('first');
    ep.reset();
    expect(ep.heard()).toBe(false);
    expect(push(ep, QUIET, 100)).toBe(0); // nothing heard in the new one yet
  });
});

describe('frameRms', () => {
  it('is the root-mean-square of the samples', () => {
    expect(frameRms(new Float32Array([0.5, -0.5, 0.5, -0.5]))).toBeCloseTo(0.5);
    expect(frameRms(new Float32Array(512))).toBe(0);
    expect(frameRms(new Float32Array(0))).toBe(0);
  });
});
