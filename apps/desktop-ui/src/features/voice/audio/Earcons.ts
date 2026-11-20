// Tiny WebAudio-oscillator earcons — no audio assets. A soft high tick as the
// "heard you" cue when an agent starts thinking, and a gentle two-note descent
// on voice:error. Volume is deliberately low and each cue is rate-limited so a
// burst of status frames can't turn into a machine-gun of beeps.
//
// AudioContext is created lazily on first cue and injectable for tests.

import type { EarconController } from '../voiceTypes';

const TICK_MIN_INTERVAL_MS = 700;
const ERROR_MIN_INTERVAL_MS = 1_500;
const TICK_GAIN = 0.04;
const ERROR_GAIN = 0.06;

export interface EarconsOptions {
  createContext?: () => AudioContext;
  now?: () => number;
}

export class Earcons implements EarconController {
  private readonly createContext: () => AudioContext;
  private readonly now: () => number;
  private ctx: AudioContext | null = null;
  private lastTickAt = 0;
  private lastErrorAt = 0;

  constructor(opts: EarconsOptions = {}) {
    this.createContext =
      opts.createContext ??
      (() => {
        const Ctor: typeof AudioContext =
          window.AudioContext ??
          (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
        return new Ctor();
      });
    this.now = opts.now ?? (() => Date.now());
  }

  private ensureCtx(): AudioContext {
    if (!this.ctx) this.ctx = this.createContext();
    return this.ctx;
  }

  /** One short sine blip: freq (Hz), duration (s), peak gain. */
  private blip(freq: number, durationSec: number, peak: number, startOffset = 0): void {
    const ctx = this.ensureCtx();
    const t0 = ctx.currentTime + startOffset;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.value = freq;
    // Quick attack + exponential release so it reads as a soft tick, not a beep.
    gain.gain.setValueAtTime(0.0001, t0);
    gain.gain.exponentialRampToValueAtTime(peak, t0 + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + durationSec);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(t0);
    osc.stop(t0 + durationSec + 0.02);
  }

  thinkingTick(): void {
    const t = this.now();
    if (t - this.lastTickAt < TICK_MIN_INTERVAL_MS) return;
    this.lastTickAt = t;
    try {
      this.blip(880, 0.08, TICK_GAIN);
    } catch {
      // audio unavailable — earcons are non-essential
    }
  }

  error(): void {
    const t = this.now();
    if (t - this.lastErrorAt < ERROR_MIN_INTERVAL_MS) return;
    this.lastErrorAt = t;
    try {
      this.blip(440, 0.14, ERROR_GAIN);
      this.blip(330, 0.18, ERROR_GAIN, 0.12);
    } catch {
      // audio unavailable — earcons are non-essential
    }
  }

  dispose(): void {
    if (this.ctx) {
      void this.ctx.close().catch((err: unknown) => {
        console.error('Earcons: failed to close AudioContext', err);
      });
      this.ctx = null;
    }
  }
}
