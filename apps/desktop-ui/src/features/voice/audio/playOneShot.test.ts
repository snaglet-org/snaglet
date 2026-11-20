/**
 * playOneShot — decode-and-play-once against a fake AudioContext (same fake
 * shape as PlaybackQueue.test.ts, minus the multi-buffer scheduling this
 * util deliberately doesn't need — see the one-shot-vs-queue comment in
 * playOneShot.ts).
 */
import { describe, expect, it, vi } from 'vitest';
import { playOneShot } from './playOneShot';

interface FakeSource {
  buffer: unknown;
  onended: (() => void) | null;
  started: boolean;
  stopped: boolean;
  connect(): void;
  start(): void;
  stop(): void;
}

function makeFakeCtx() {
  const sources: FakeSource[] = [];
  let closed = false;
  const ctx = {
    decodeAudioData: vi.fn(async (_buf: ArrayBuffer) => ({ length: 100, sampleRate: 22_050 })),
    createBufferSource: (): FakeSource => {
      const s: FakeSource = {
        buffer: null,
        onended: null,
        started: false,
        stopped: false,
        connect() {},
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
    destination: {},
    close: vi.fn(async () => {
      closed = true;
    }),
    get closed() {
      return closed;
    },
  };
  return { ctx, sources };
}

function stubAudioContext(ctx: unknown): void {
  (window as unknown as { AudioContext: unknown }).AudioContext = vi.fn(() => ctx);
}

describe('playOneShot', () => {
  it('decodes, connects, and starts playback, resolving before the clip ends', async () => {
    const { ctx, sources } = makeFakeCtx();
    stubAudioContext(ctx);

    const onEnded = vi.fn();
    const handle = await playOneShot(new ArrayBuffer(8), onEnded);

    expect(ctx.decodeAudioData).toHaveBeenCalledTimes(1);
    expect(sources[0]!.started).toBe(true);
    expect(onEnded).not.toHaveBeenCalled(); // playback hasn't ended yet
    expect(handle).toEqual({ stop: expect.any(Function) });
  });

  it('fires onEnded exactly once when the clip ends naturally', async () => {
    const { ctx, sources } = makeFakeCtx();
    stubAudioContext(ctx);

    const onEnded = vi.fn();
    await playOneShot(new ArrayBuffer(8), onEnded);

    sources[0]!.onended?.();
    expect(onEnded).toHaveBeenCalledTimes(1);
    expect(ctx.close).toHaveBeenCalledTimes(1);

    // A stray second 'ended' firing (shouldn't happen, but be defensive)
    // must not double-invoke the caller's callback.
    sources[0]!.onended?.();
    expect(onEnded).toHaveBeenCalledTimes(1);
  });

  it('stop() ends playback early, fires onEnded once, and fences the native ended event', async () => {
    const { ctx, sources } = makeFakeCtx();
    stubAudioContext(ctx);

    const onEnded = vi.fn();
    const handle = await playOneShot(new ArrayBuffer(8), onEnded);

    handle.stop();
    expect(sources[0]!.stopped).toBe(true);
    expect(onEnded).toHaveBeenCalledTimes(1);

    // The native 'ended' event firing after our own stop() must not re-fire —
    // stop() clears the handler first (PlaybackQueue.flush() idiom).
    expect(sources[0]!.onended).toBeNull();

    // Calling stop() again is a no-op.
    handle.stop();
    expect(onEnded).toHaveBeenCalledTimes(1);
  });
});
