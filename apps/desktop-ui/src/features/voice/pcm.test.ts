import { describe, expect, it } from 'vitest';
import { base64ToInt16, floatTo16BitPCM, int16ToBase64, int16ToFloat32 } from './audio/pcm';

describe('pcm helpers', () => {
  it('floatTo16BitPCM clamps and scales asymmetrically', () => {
    const out = floatTo16BitPCM(new Float32Array([0, 1, -1, 2, -2, 0.5]));
    expect(out[0]).toBe(0);
    expect(out[1]).toBe(32767); // +full-scale
    expect(out[2]).toBe(-32768); // -full-scale
    expect(out[3]).toBe(32767); // clamped from 2
    expect(out[4]).toBe(-32768); // clamped from -2
    expect(out[5]).toBe(Math.round(0.5 * 0x7fff));
  });

  it('round-trips int16 → base64 → int16', () => {
    const samples = new Int16Array([0, 1, -1, 12345, -12345, 32767, -32768]);
    const b64 = int16ToBase64(samples);
    expect(typeof b64).toBe('string');
    const back = base64ToInt16(b64);
    expect(Array.from(back)).toEqual(Array.from(samples));
  });

  it('int16 → float → int16 stays within one quantization step', () => {
    const samples = new Int16Array([0, 8000, -8000, 32767, -32768]);
    const back = floatTo16BitPCM(int16ToFloat32(samples));
    for (let i = 0; i < samples.length; i++) {
      expect(Math.abs((back[i] ?? 0) - (samples[i] ?? 0))).toBeLessThanOrEqual(1);
    }
  });

  // There is no client-side resampler: the mic captures at its native rate and
  // the server band-limits (services/voice/decimator.ts and its DSP tests).
});
