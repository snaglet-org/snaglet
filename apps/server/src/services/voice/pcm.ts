/**
 * pcm — main-thread PCM sample conversion helpers.
 *
 * `f32ToI16` already exists inside `voiceEngine.ts`, but that module is loaded
 * only inside the sherpa/onnx worker thread (it statically imports the native
 * addons) — importing it from the main thread would drag the ~75 MB native
 * addon onto the event loop, and the helper isn't exported anyway. So the Apple
 * TTS engine (which runs on the main thread) uses this tiny standalone copy.
 * Deliberate duplication of a 6-line pure function over an unsafe import — see
 * the worker-only note atop voiceEngine.ts.
 */

/** float32 in [-1, 1] → pcm16 (clamped). Byte-identical to voiceEngine.f32ToI16. */
export function f32ToI16(samples: Float32Array): Int16Array {
  const out = new Int16Array(samples.length);
  for (let i = 0; i < samples.length; i++) {
    const v = Math.max(-1, Math.min(1, samples[i]!));
    out[i] = v < 0 ? Math.round(v * 32768) : Math.round(v * 32767);
  }
  return out;
}
