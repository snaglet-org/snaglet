/**
 * decimator — DSP proof that the band-limited downsampler does its job:
 * content above the output Nyquist (8 kHz for a 16 kHz target) is rejected,
 * not aliased into the speech band as a plain linear resampler would (aliasing
 * under mild HF noise badly hurts word recall). No STT is involved — everything
 * here is a spectral measurement.
 */

import { describe, expect, it } from '@jest/globals';
import { createDecimator } from '@server/services/voice/decimator';

const IN_RATE = 48_000;
const OUT_RATE = 16_000;

/** A pcm16 sine of `freq` Hz, `n` samples at `rate`, amplitude in [0,1]. */
function sine(freq: number, n: number, rate: number, amp = 0.5): Int16Array {
  const out = new Int16Array(n);
  for (let i = 0; i < n; i++) {
    const v = amp * Math.sin((2 * Math.PI * freq * i) / rate);
    out[i] = v < 0 ? Math.round(v * 32768) : Math.round(v * 32767);
  }
  return out;
}

/** RMS of a pcm16 buffer over [start, end), in float units. */
function rms(pcm: Int16Array, start = 0, end = pcm.length): number {
  let sum = 0;
  const n = end - start;
  for (let i = start; i < end; i++) {
    const f = pcm[i]! / 32768;
    sum += f * f;
  }
  return Math.sqrt(sum / n);
}

/** Goertzel single-bin power estimate at `freq` Hz for a pcm16 signal. */
function goertzelPower(pcm: Int16Array, freq: number, rate: number): number {
  const w = (2 * Math.PI * freq) / rate;
  const coeff = 2 * Math.cos(w);
  let s0 = 0;
  let s1 = 0;
  let s2 = 0;
  for (let i = 0; i < pcm.length; i++) {
    s0 = pcm[i]! / 32768 + coeff * s1 - s2;
    s2 = s1;
    s1 = s0;
  }
  const power = s1 * s1 + s2 * s2 - coeff * s1 * s2;
  return power / (pcm.length * pcm.length);
}

/** dB ratio (20·log10), guarded against log(0). */
function db(ratio: number): number {
  return 20 * Math.log10(Math.max(ratio, 1e-12));
}

describe('decimator — band-limited downsampling (48k → 16k)', () => {
  it('rejects a tone above the 8 kHz output Nyquist by ≥40 dB', () => {
    // 10 kHz is 2 kHz into the stopband; a linear resampler would fold it to
    // 6 kHz at full amplitude (right in the speech band). Ours must kill it.
    const input = sine(10_000, IN_RATE, IN_RATE, 0.5); // 1 s
    const dec = createDecimator(IN_RATE, OUT_RATE);
    const out = dec.process(input);

    // Measure steady-state (skip filter edges).
    const guard = 400;
    const inRms = rms(input, IN_RATE / 4, (IN_RATE * 3) / 4);
    const outRms = rms(out, guard, out.length - guard);
    const attenDb = db(inRms / outRms);

    console.log(`[decimator] 10kHz tone attenuation: ${attenDb.toFixed(1)} dB`);
    expect(attenDb).toBeGreaterThanOrEqual(40);
  });

  it('rejects a 9 kHz tone (just above Nyquist) by ≥40 dB', () => {
    const input = sine(9_000, IN_RATE, IN_RATE, 0.5);
    const dec = createDecimator(IN_RATE, OUT_RATE);
    const out = dec.process(input);
    const inRms = rms(input, IN_RATE / 4, (IN_RATE * 3) / 4);
    const outRms = rms(out, 400, out.length - 400);
    const attenDb = db(inRms / outRms);
    console.log(`[decimator] 9kHz tone attenuation: ${attenDb.toFixed(1)} dB`);
    expect(attenDb).toBeGreaterThanOrEqual(40);
  });

  it('passes recognition-band tones (300 Hz–3 kHz) with < 1.5 dB loss', () => {
    for (const freq of [300, 1_000, 3_000]) {
      const input = sine(freq, IN_RATE, IN_RATE, 0.5);
      const dec = createDecimator(IN_RATE, OUT_RATE);
      const out = dec.process(input);
      const inRms = rms(input, IN_RATE / 4, (IN_RATE * 3) / 4);
      const outRms = rms(out, 400, out.length - 400);
      const lossDb = db(inRms / outRms);
      console.log(`[decimator] ${freq}Hz passband loss: ${lossDb.toFixed(2)} dB`);
      expect(Math.abs(lossDb)).toBeLessThan(1.5);
    }
  });

  it('keeps speech-band content intact while rejecting HF noise', () => {
    // Signal = a 1 kHz speech-band tone + a strong tone at 11 kHz standing in for
    // out-of-band energy. A linear resampler aliases the 11 kHz tone down to 5 kHz
    // (16k - 11k), polluting the speech band. The band-limited decimator must keep
    // the 1 kHz tone and leave the 5 kHz alias image absent.
    const n = IN_RATE; // 1 s
    const tone1k = sine(1_000, n, IN_RATE, 0.4);
    const hf = sine(11_000, n, IN_RATE, 0.4);
    const mixed = new Int16Array(n);
    for (let i = 0; i < n; i++) mixed[i] = Math.max(-32768, Math.min(32767, tone1k[i]! + hf[i]!));

    const dec = createDecimator(IN_RATE, OUT_RATE);
    const out = dec.process(mixed);
    const mid = out.subarray(400, out.length - 400);

    // Reference: the 1 kHz tone decimated alone (what "intact" looks like).
    const ref = createDecimator(IN_RATE, OUT_RATE)
      .process(tone1k)
      .subarray(400, tone1k.length / 3);

    const p1kMixed = goertzelPower(mid, 1_000, OUT_RATE);
    const p1kRef = goertzelPower(ref, 1_000, OUT_RATE);
    const pAlias = goertzelPower(mid, 5_000, OUT_RATE); // where 11 kHz would fold to

    const speechPreservedDb = db(Math.sqrt(p1kMixed / p1kRef));
    const aliasVsSignalDb = db(Math.sqrt(pAlias / p1kMixed));
    console.log(
      `[decimator] HF-noise test: 1kHz preserved ${speechPreservedDb.toFixed(2)} dB vs clean, ` +
        `5kHz alias image ${aliasVsSignalDb.toFixed(1)} dB below the 1kHz tone`
    );

    // The 1 kHz tone survives essentially unchanged despite the HF neighbor…
    expect(Math.abs(speechPreservedDb)).toBeLessThan(1.0);
    // …and the aliased image the HF tone would have produced is ≥40 dB down.
    expect(aliasVsSignalDb).toBeLessThanOrEqual(-40);
  });

  it('44.1k → 16k (non-integer ratio) also rejects >8 kHz by ≥40 dB', () => {
    const input = sine(10_000, 44_100, 44_100, 0.5);
    const dec = createDecimator(44_100, OUT_RATE);
    const out = dec.process(input);
    const inRms = rms(input, 44_100 / 4, (44_100 * 3) / 4);
    const outRms = rms(out, 400, out.length - 400);
    const attenDb = db(inRms / outRms);
    console.log(`[decimator] 44.1k→16k 10kHz attenuation: ${attenDb.toFixed(1)} dB`);
    expect(attenDb).toBeGreaterThanOrEqual(40);
  });

  it('streams identically whether fed whole or in arbitrary chunks', () => {
    const input = sine(1_000, IN_RATE / 4, IN_RATE, 0.5);
    const whole = createDecimator(IN_RATE, OUT_RATE).process(input);

    const chunked = createDecimator(IN_RATE, OUT_RATE);
    const parts: Int16Array[] = [];
    for (let off = 0; off < input.length; off += 777) {
      parts.push(chunked.process(input.subarray(off, Math.min(off + 777, input.length))));
    }
    const joined = new Int16Array(parts.reduce((n, p) => n + p.length, 0));
    let o = 0;
    for (const p of parts) {
      joined.set(p, o);
      o += p.length;
    }

    // Same length (±1) and sample-for-sample agreement on the common prefix.
    expect(Math.abs(joined.length - whole.length)).toBeLessThanOrEqual(1);
    const cmp = Math.min(joined.length, whole.length);
    let maxDiff = 0;
    for (let i = 0; i < cmp; i++) maxDiff = Math.max(maxDiff, Math.abs(joined[i]! - whole[i]!));
    expect(maxDiff).toBeLessThanOrEqual(1);
  });

  it('is a zero-cost pass-through when rates are equal', () => {
    const dec = createDecimator(OUT_RATE, OUT_RATE);
    const input = sine(1_000, 1_000, OUT_RATE, 0.5);
    expect(dec.process(input)).toBe(input);
  });
});
