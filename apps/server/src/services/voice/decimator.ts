/**
 * decimator — a band-limited downsampler for the voice capture chain.
 *
 * Why: a linear resampler is not band-limited — it aliases energy above the
 * output Nyquist back into the speech band, which badly hurts recognition under
 * mild high-frequency noise. So the client captures at the AudioContext's native
 * rate, and where a 16 kHz stream is needed server-side (local ONNX STT, silero
 * VAD) this down-converts with a real low-pass FIR that removes >8 kHz content
 * before decimating.
 *
 * Design: a stateful windowed-sinc (Blackman-Harris) fractional resampler,
 * realized as a precomputed polyphase filter bank so the hot path is pure
 * multiply-accumulate (no trig per sample). At construction we tabulate the
 * low-pass sinc kernel — cutoff at the output Nyquist (0.5·outRate), windowed by
 * Blackman-Harris (~-92 dB side-lobes) — at a fine grid of fractional phases and
 * DC-normalize each phase to unity gain. Each output sample then selects the
 * nearest phase and dots its kernel with the surrounding input samples.
 *
 * Streaming: input-sample history is carried in `tail` and the read cursor in
 * `outIndex`, so a signal split into arbitrary chunks decimates identically to
 * decimating it whole (no per-chunk phase reset).
 */

/** A stateful streaming decimator. Feed native-rate pcm16, get output-rate pcm16. */
export interface Decimator {
  /** Source sample rate this decimator was built for. */
  readonly inRate: number;
  /** Target sample rate (typically 16 kHz). */
  readonly outRate: number;
  /** Down-convert one contiguous pcm16 chunk; returns the output-rate pcm16. */
  process(input: Int16Array): Int16Array;
  /** Drop carried history (start of an unrelated stream). */
  reset(): void;
}

/**
 * Half-width of the sinc kernel, in OUTPUT samples. The full kernel spans
 * 2·HALF_TAPS_OUT output periods; wider = sharper transition + deeper stopband.
 * 32 output periods at 16 kHz ≈ 2 ms of context — clears 40 dB well before 9 kHz
 * with a Blackman-Harris window, still cheap.
 */
const HALF_TAPS_OUT = 32;

/** Fractional-phase quantization of the polyphase bank. */
const NUM_PHASES = 1024;

/** Blackman-Harris window, argument x in [-1, 1] (0 outside). */
function blackmanHarris(x: number): number {
  if (x <= -1 || x >= 1) return 0;
  const t = Math.PI * (x + 1); // map [-1,1] → [0, 2π]
  return 0.35875 - 0.48829 * Math.cos(t) + 0.14128 * Math.cos(2 * t) - 0.01168 * Math.cos(3 * t);
}

/** Normalized sinc: sinc(x) = sin(πx)/(πx), sinc(0) = 1. */
function sinc(x: number): number {
  if (x === 0) return 1;
  const px = Math.PI * x;
  return Math.sin(px) / px;
}

class PolyphaseDecimator implements Decimator {
  readonly inRate: number;
  readonly outRate: number;
  /** inRate / outRate: input samples advanced per output sample (> 1 downsampling). */
  private readonly step: number;
  /** Kernel half-width in INPUT samples (taps span [-half+1 .. +half]). */
  private readonly half: number;
  private readonly taps: number;
  /** Precomputed, DC-normalized kernel weights: phase-major, [NUM_PHASES][taps]. */
  private readonly bank: Float32Array;
  /** Carried input-sample history (float). */
  private tail: Float32Array = new Float32Array(0);
  /** Global input index of tail[0]. */
  private tailStart = 0;
  /** Next output index to emit. */
  private outIndex = 0;

  constructor(inRate: number, outRate: number) {
    this.inRate = inRate;
    this.outRate = outRate;
    this.step = inRate / outRate;
    // Kernel spans HALF_TAPS_OUT output periods each side → in input samples.
    this.half = Math.max(8, Math.ceil((HALF_TAPS_OUT * inRate) / outRate));
    this.taps = 2 * this.half; // taps at k = -half+1 .. +half relative to base
    this.bank = this.buildBank();
  }

  /** Low-pass cutoff in cycles/input-sample = 0.5·outRate/inRate (≤ 0.5). */
  private buildBank(): Float32Array {
    const fc = Math.min(0.5, (0.5 * this.outRate) / this.inRate);
    const twoFc = 2 * fc;
    const bank = new Float32Array(NUM_PHASES * this.taps);
    for (let p = 0; p < NUM_PHASES; p++) {
      const frac = p / NUM_PHASES; // fractional input-sample offset of the output
      let sum = 0;
      const base = p * this.taps;
      for (let j = 0; j < this.taps; j++) {
        const k = j - this.half + 1; // tap position relative to floor(centerIn)
        const dx = k - frac; // distance from output center, in input samples
        const h = twoFc * sinc(twoFc * dx) * blackmanHarris(dx / this.half);
        bank[base + j] = h;
        sum += h;
      }
      // DC-normalize this phase to unity gain (exact 0 dB passband).
      if (sum !== 0) {
        const inv = 1 / sum;
        for (let j = 0; j < this.taps; j++) bank[base + j]! *= inv;
      }
    }
    return bank;
  }

  reset(): void {
    this.tail = new Float32Array(0);
    this.tailStart = 0;
    this.outIndex = 0;
  }

  process(input: Int16Array): Int16Array {
    if (input.length === 0) return new Int16Array(0);

    // buf = carried history ++ this chunk (float), spanning global indices
    // [tailStart, tailStart + buf.length).
    const buf = new Float32Array(this.tail.length + input.length);
    buf.set(this.tail, 0);
    for (let i = 0; i < input.length; i++) buf[this.tail.length + i] = input[i]! / 32768;
    const bufStart = this.tailStart;
    const bufEnd = bufStart + buf.length;

    const out: number[] = [];
    for (;;) {
      const centerIn = this.outIndex * this.step; // output center in input samples
      const baseF = Math.floor(centerIn);
      const frac = centerIn - baseF;
      const phase = Math.round(frac * NUM_PHASES) % NUM_PHASES;
      // Taps cover input indices [baseF - half + 1, baseF + half].
      const firstIdx = baseF - this.half + 1;
      const lastIdx = baseF + this.half;
      if (lastIdx >= bufEnd) break; // need more input before this output is complete
      if (firstIdx < bufStart) {
        // Only at the very start, before any history exists — skip the leading
        // edge whose kernel would read before sample 0.
        this.outIndex++;
        continue;
      }
      const kbase = phase * this.taps;
      let acc = 0;
      const off = firstIdx - bufStart;
      for (let j = 0; j < this.taps; j++) acc += this.bank[kbase + j]! * buf[off + j]!;
      out.push(acc);
      this.outIndex++;
    }

    // Keep the trailing kernel window (+ slack) as history for the next chunk.
    const keep = Math.min(buf.length, this.taps + 2);
    this.tail = buf.slice(buf.length - keep);
    this.tailStart = bufEnd - this.tail.length;

    const pcm = new Int16Array(out.length);
    for (let i = 0; i < out.length; i++) {
      const v = Math.max(-1, Math.min(1, out[i]!));
      pcm[i] = v < 0 ? Math.round(v * 32768) : Math.round(v * 32767);
    }
    return pcm;
  }
}

/**
 * Build a streaming band-limited decimator from `inRate` down to `outRate`.
 * Requires inRate ≥ outRate (this is a DOWNsampler). When the rates are equal the
 * returned decimator is a zero-cost pass-through.
 */
export function createDecimator(inRate: number, outRate: number): Decimator {
  if (inRate === outRate) {
    return { inRate, outRate, process: (input) => input, reset: () => {} };
  }
  if (inRate < outRate) {
    throw new Error(`createDecimator: inRate ${inRate} < outRate ${outRate} (not a downsampler)`);
  }
  return new PolyphaseDecimator(inRate, outRate);
}
