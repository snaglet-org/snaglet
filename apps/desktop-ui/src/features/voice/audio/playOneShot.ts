// Decode and play a single WAV ArrayBuffer via WebAudio, with no queueing.
// Used by the voice preview button (VoicePicker) and the per-message re-listen
// button (BubbleActions). PlaybackQueue handles streamed, seq-ordered chunks;
// a whole WAV needs only one AudioBufferSourceNode, and the returned `stop()`
// handle lets a caller cut it off early.

export interface OneShotHandle {
  /**
   * Stop playback immediately. Safe to call after the clip has already
   * ended. Calling it fires `onEnded` exactly once (mirrors
   * PlaybackQueue.flush(), which clears `onended` before calling `stop()` so
   * the native 'ended' event never double-fires the caller's callback).
   */
  stop: () => void;
}

/**
 * Decode `buffer` as audio and play it once. Resolves once playback has
 * started (matches the original playWav timing — callers don't await the
 * full clip). `onEnded` fires when the clip finishes naturally or is
 * stopped early via the returned handle.
 */
export async function playOneShot(
  buffer: ArrayBuffer,
  onEnded: () => void
): Promise<OneShotHandle> {
  const Ctor: typeof AudioContext =
    window.AudioContext ??
    (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
  const ctx = new Ctor();
  // decodeAudioData detaches its input in some engines — pass a copy.
  const audio = await ctx.decodeAudioData(buffer.slice(0));
  const src = ctx.createBufferSource();
  src.buffer = audio;
  src.connect(ctx.destination);

  let ended = false;
  const finish = (): void => {
    if (ended) return;
    ended = true;
    void ctx.close().catch((err: unknown) => {
      console.error('playOneShot: failed to close AudioContext', err);
    });
    onEnded();
  };

  src.onended = finish;
  src.start();

  return {
    stop: () => {
      if (ended) return;
      // Clear the handler before calling stop(), the same idiom as
      // PlaybackQueue.flush() — so the native 'ended' event (which stop()
      // triggers) can't also invoke finish() and double-fire onEnded.
      src.onended = null;
      try {
        src.stop();
      } catch {
        // already stopped/ended
      }
      finish();
    },
  };
}
