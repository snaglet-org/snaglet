// Pure pcm16 <-> base64 <-> float helpers. No Web Audio / DOM dependency, so
// they run identically in the browser and under jsdom, and are unit-tested
// directly.

/** Clamp + convert Float32 samples in [-1, 1] to signed 16-bit PCM. */
export function floatTo16BitPCM(input: Float32Array): Int16Array {
  const out = new Int16Array(input.length);
  for (let i = 0; i < input.length; i++) {
    const s = Math.max(-1, Math.min(1, input[i] ?? 0));
    // Asymmetric scale: negative full-scale is -32768, positive is +32767.
    out[i] = s < 0 ? Math.round(s * 0x8000) : Math.round(s * 0x7fff);
  }
  return out;
}

/** Convert signed 16-bit PCM back to Float32 in [-1, 1). */
export function int16ToFloat32(input: Int16Array): Float32Array {
  const out = new Float32Array(input.length);
  for (let i = 0; i < input.length; i++) out[i] = (input[i] ?? 0) / 0x8000;
  return out;
}

/** Base64-encode the raw little-endian bytes of an Int16Array. */
export function int16ToBase64(samples: Int16Array): string {
  const bytes = new Uint8Array(samples.buffer, samples.byteOffset, samples.byteLength);
  let binary = '';
  // Chunk the String.fromCharCode spread to stay under call-stack limits.
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

/** Decode a base64 pcm16 payload into an Int16Array (little-endian). */
export function base64ToInt16(b64: string): Int16Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  // pcm16 is always an even byte count; truncate a stray trailing byte rather
  // than throw on a malformed frame.
  const usableSamples = Math.floor(bytes.length / 2);
  const view = new DataView(bytes.buffer);
  const out = new Int16Array(usableSamples);
  for (let i = 0; i < usableSamples; i++) out[i] = view.getInt16(i * 2, true);
  return out;
}

// There is deliberately no client-side linear resampler: it is not band-limited
// and aliases high-frequency noise into the speech band, which hurts
// recognition. The mic captures at the AudioContext's native rate and the
// server band-limits when it needs 16 kHz (services/voice/decimator.ts).
