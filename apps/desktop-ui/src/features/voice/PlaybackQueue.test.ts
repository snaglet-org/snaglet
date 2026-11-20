/**
 * PlaybackQueue — seq-ordered scheduling, playback-done emission, the
 * charOffset (heardUpTo) approximation, and barge-in flush, driven by a fake
 * AudioContext with a settable clock and manual onended.
 */
import { describe, expect, it, vi } from 'vitest';
import { PlaybackQueue } from './audio/PlaybackQueue';
import { int16ToBase64 } from './audio/pcm';
import type { VoiceTtsChunkPayload } from './voiceTypes';

interface FakeSource {
  buffer: unknown;
  onended: (() => void) | null;
  started: boolean;
  stopped: boolean;
  connect(): void;
  disconnect(): void;
  start(when: number): void;
  stop(): void;
}

function makeFakeCtx() {
  const sources: FakeSource[] = [];
  const ctx = {
    currentTime: 0,
    destination: {},
    createGain: () => ({
      gain: { value: 1, setValueAtTime() {}, exponentialRampToValueAtTime() {} },
      connect() {},
      disconnect() {},
    }),
    createBuffer: (_ch: number, len: number, sr: number) => {
      const data = new Float32Array(len);
      return { length: len, sampleRate: sr, getChannelData: () => data };
    },
    createBufferSource: (): FakeSource => {
      const s: FakeSource = {
        buffer: null,
        onended: null,
        started: false,
        stopped: false,
        connect() {},
        disconnect() {},
        start() {
          this.started = true;
        },
        stop() {
          this.stopped = true;
        },
      };
      sources.push(s);
      return s;
    },
    close: async () => {},
  };
  return { ctx, sources };
}

/** One second of silence at 16 kHz → charOffset math is clean (1s ≈ 15 chars). */
function chunk(utteranceId: string, seq: number): VoiceTtsChunkPayload {
  return { utteranceId, agentId: 'a1', seq, pcm16: int16ToBase64(new Int16Array(16_000)) };
}

function makeQueue() {
  const { ctx, sources } = makeFakeCtx();
  const onUtteranceDone = vi.fn();
  const queue = new PlaybackQueue({
    onUtteranceDone,
    createContext: () => ctx as unknown as AudioContext,
  });
  return { queue, ctx, sources, onUtteranceDone };
}

describe('PlaybackQueue', () => {
  it('builds AudioBuffers at the chunk sampleRate, never the 16k capture rate', () => {
    // Regression pin: piper synthesizes at 22050 Hz; playing those samples at
    // the mic's 16 kHz sounded slowed-down and pitched-deep in the live test.
    const { queue, sources } = makeQueue();
    queue.enqueueChunk({ ...chunk('u1', 0), sampleRate: 22_050 });
    expect((sources[0] as { buffer?: { sampleRate: number } }).buffer?.sampleRate).toBe(22_050);
    // Payload without sampleRate falls back to the TTS default, not 16k.
    queue.enqueueChunk(chunk('u2', 0));
    expect((sources[1] as { buffer?: { sampleRate: number } }).buffer?.sampleRate).toBe(22_050);
  });

  it('schedules out-of-order chunks in seq order once contiguous', () => {
    const { queue, sources } = makeQueue();
    // seq 1 arrives first — nothing can play until seq 0 fills the gap.
    queue.enqueueChunk(chunk('u1', 1));
    expect(sources.length).toBe(0);
    queue.enqueueChunk(chunk('u1', 0));
    // Both scheduled, seq 0 before seq 1.
    expect(sources.length).toBe(2);
  });

  it('emits onUtteranceDone once the stream ends and all buffers finish', () => {
    const { queue, sources, onUtteranceDone } = makeQueue();
    queue.enqueueChunk(chunk('u1', 0));
    queue.enqueueChunk(chunk('u1', 1));
    queue.markEnd('u1');
    expect(onUtteranceDone).not.toHaveBeenCalled(); // audio still "playing"

    sources[0]!.onended?.();
    expect(onUtteranceDone).not.toHaveBeenCalled(); // one buffer left
    sources[1]!.onended?.();
    expect(onUtteranceDone).toHaveBeenCalledTimes(1);
    expect(onUtteranceDone).toHaveBeenCalledWith('u1');
    expect(queue.isSpeaking()).toBe(false);
  });

  it('estimates heardUpTo.charOffset from audio played (~15 chars/s)', () => {
    const { queue, ctx } = makeQueue();
    queue.enqueueChunk(chunk('u1', 0)); // 1s buffer scheduled at t=0
    ctx.currentTime = 0.4; // 0.4s played → ~6 chars
    expect(queue.getHeardUpTo()).toEqual({ utteranceId: 'u1', charOffset: 6, playedMs: 400 });
  });

  it('flush stops sources, returns heardUpTo, and does not fire done', () => {
    const { queue, ctx, sources, onUtteranceDone } = makeQueue();
    queue.enqueueChunk(chunk('u1', 0));
    ctx.currentTime = 0.4;
    const heard = queue.flush();
    expect(heard).toEqual({ utteranceId: 'u1', charOffset: 6, playedMs: 400 });
    expect(sources[0]!.stopped).toBe(true);
    expect(onUtteranceDone).not.toHaveBeenCalled();
    expect(queue.isSpeaking()).toBe(false);
    expect(queue.getHeardUpTo()).toBeNull();
  });

  it('rejects a straggler chunk for a flushed utteranceId (barge-in fence)', () => {
    // The server's abort is checked between synthesis frames, so a chunk in
    // flight when flush() fires can still land afterward. Without the fence a
    // seq-0 straggler would play at once (talk-over) and a later seq would
    // re-create the utterance and flip isSpeaking() to true. Nothing for a dead
    // utteranceId may be scheduled or re-tracked.
    const { queue, sources } = makeQueue();
    expect(queue.enqueueChunk(chunk('u1', 0))).toBe(true); // accepted
    expect(sources.length).toBe(1);
    queue.flush();

    // straggler matching the reset nextSeq — fenced: rejected, not scheduled.
    expect(queue.enqueueChunk(chunk('u1', 0))).toBe(false);
    expect(sources.length).toBe(1); // no new source scheduled for the straggler
    expect(queue.isSpeaking()).toBe(false); // no zombie entry re-tracked

    // an out-of-order straggler too — also fenced.
    expect(queue.enqueueChunk(chunk('u1', 7))).toBe(false);
    expect(sources.length).toBe(1);
    expect(queue.isSpeaking()).toBe(false);
  });
});
