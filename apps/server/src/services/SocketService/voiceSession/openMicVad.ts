/**
 * openMicVad — server-side silero VAD endpointing for open-mic mode.
 *
 * In open mode the client streams audio continuously (no push-to-talk). The
 * server watches each 512-sample frame's silero speech probability and decides
 * where an utterance begins (speech onset) and ends (a trailing-silence window).
 * That endpoint is exactly a PTT `voice:utterance:end`: finalize STT + dispatch.
 *
 * The endpointer is a tiny deterministic state machine over a probability
 * sequence, so it is unit-tested with synthetic probabilities and needs no audio
 * hardware. Hysteresis (separate onset/offset thresholds) avoids chattering on
 * borderline frames; the reported `voicedMs` (time from onset to the last voiced
 * frame, excluding trailing silence) feeds the backchannel filter.
 */

import {
  OPEN_MIC_MIN_SPEECH_MS,
  OPEN_MIC_SILENCE_MS,
  VAD_FRAME_MS,
  VAD_FRAME_SAMPLES,
  VAD_OFFSET_PROB,
  VAD_ONSET_PROB,
} from './constants';

export interface VadEndpointerOptions {
  /** ms per frame (512 samples @16 kHz = 32 ms). */
  readonly frameMs?: number;
  /** Probability at/above which silence flips to speech. */
  readonly onsetThreshold?: number;
  /** Probability below which a speech frame counts as silence. */
  readonly offsetThreshold?: number;
  /** Trailing silence that ends an utterance (SNAGLET_VOICE_SILENCE_MS). */
  readonly silenceMs?: number;
  /** Voiced audio below this at end = backchannel (not a real utterance). */
  readonly minSpeechMs?: number;
}

export type VadEvent =
  | { readonly type: 'speech-start' }
  | { readonly type: 'speech-end'; readonly voicedMs: number; readonly backchannel: boolean };

export interface VadEndpointer {
  /** Feed one frame's speech probability; returns any endpoint events. */
  push(prob: number): VadEvent[];
  /** True while inside a speech run. */
  inSpeech(): boolean;
  /**
   * Override the trailing-silence window for the current speech run only (reset to
   * the default at the next speech-start / speech-end). Grants a barge-in
   * utterance a more generous finish window so the speaker isn't cut off at the first
   * pause after interrupting a speaker.
   */
  setSilenceForCurrentRun(ms: number): void;
  /** Drop all state (session teardown / barge-in). */
  reset(): void;
}

/** Create a stateful VAD endpointer (one per open-mic session). */
export function createVadEndpointer(opts: VadEndpointerOptions = {}): VadEndpointer {
  const frameMs = opts.frameMs ?? VAD_FRAME_MS;
  const onset = opts.onsetThreshold ?? VAD_ONSET_PROB;
  const offset = opts.offsetThreshold ?? VAD_OFFSET_PROB;
  const silenceMs = opts.silenceMs ?? OPEN_MIC_SILENCE_MS;
  const minSpeechMs = opts.minSpeechMs ?? OPEN_MIC_MIN_SPEECH_MS;

  let speaking = false;
  let voicedMs = 0; // onset → last voiced frame (excludes trailing silence)
  let trailingSilenceMs = 0;
  // Effective silence window for the current run — starts at the default each run
  // and can be raised (barge-in) via setSilenceForCurrentRun.
  let activeSilenceMs = silenceMs;

  return {
    push(prob: number): VadEvent[] {
      if (!speaking) {
        if (prob >= onset) {
          speaking = true;
          voicedMs = frameMs;
          trailingSilenceMs = 0;
          activeSilenceMs = silenceMs; // fresh run → default window (until armed)
          return [{ type: 'speech-start' }];
        }
        return [];
      }

      if (prob >= offset) {
        // Still voiced — extend, reset the trailing-silence timer.
        voicedMs += frameMs;
        trailingSilenceMs = 0;
        return [];
      }

      // Silence within a speech run.
      trailingSilenceMs += frameMs;
      if (trailingSilenceMs < activeSilenceMs) return [];

      const ended: VadEvent = {
        type: 'speech-end',
        voicedMs,
        backchannel: voicedMs < minSpeechMs,
      };
      speaking = false;
      voicedMs = 0;
      trailingSilenceMs = 0;
      activeSilenceMs = silenceMs;
      return [ended];
    },
    inSpeech(): boolean {
      return speaking;
    },
    setSilenceForCurrentRun(ms: number): void {
      activeSilenceMs = ms;
    },
    reset(): void {
      speaking = false;
      voicedMs = 0;
      trailingSilenceMs = 0;
      activeSilenceMs = silenceMs;
    },
  };
}

/**
 * A rolling PCM16 → 512-sample Float32 framer. Open-mic audio chunks are ~100 ms
 * (1600 samples), which is not a whole number of 512-sample VAD frames, so the
 * remainder is carried across chunks here. `push` appends a chunk and returns
 * every complete 512-sample frame it can now emit (in order).
 */
export interface VadFramer {
  push(pcm16: Int16Array): Float32Array[];
  reset(): void;
}

/**
 * Filler tokens that, spoken briefly, are backchannels (acknowledgments) rather
 * than commands — they should not cut an agent off. Stored in the whitespace-
 * and punctuation-stripped form produced by `normalizeBackchannelText`, so
 * "Mm-hmm.", "uh huh", and "Uh-huh" all collapse to a member here.
 */
const BACKCHANNEL_FILLERS = new Set<string>([
  'mhm',
  'mmhmm',
  'uhhuh',
  'yeah',
  'yep',
  'ok',
  'okay',
  'right',
  'sure',
  'hmm',
]);

/**
 * Normalize a transcript for filler matching: lowercase, drop everything but
 * letters/digits, and remove whitespace/hyphens so "Uh-huh" and "uh huh" both
 * become "uhhuh".
 */
export function normalizeBackchannelText(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, '') // strip punctuation (hyphens, periods, …)
    .replace(/\s+/g, ''); // collapse whitespace → "uh huh" ⇒ "uhhuh"
}

/**
 * Backchannel classification (transcript-aware): a burst is a
 * backchannel only when it is both short (voicedMs < minSpeechMs) and its
 * transcript is empty or a known filler. A short but meaningful utterance — a
 * curt "stop" / "no" / "wait" — is not a backchannel and must barge in/dispatch.
 * A long burst is never a backchannel regardless of words.
 */
export function isBackchannelUtterance(
  voicedMs: number,
  transcript: string,
  minSpeechMs: number = OPEN_MIC_MIN_SPEECH_MS
): boolean {
  if (voicedMs >= minSpeechMs) return false;
  const norm = normalizeBackchannelText(transcript);
  return norm === '' || BACKCHANNEL_FILLERS.has(norm);
}

export function createVadFramer(): VadFramer {
  let carry = new Float32Array(0);
  return {
    push(pcm16: Int16Array): Float32Array[] {
      const combined = new Float32Array(carry.length + pcm16.length);
      combined.set(carry, 0);
      for (let i = 0; i < pcm16.length; i++) combined[carry.length + i] = pcm16[i]! / 32768;

      const frames: Float32Array[] = [];
      let offset = 0;
      while (combined.length - offset >= VAD_FRAME_SAMPLES) {
        frames.push(combined.slice(offset, offset + VAD_FRAME_SAMPLES));
        offset += VAD_FRAME_SAMPLES;
      }
      carry = combined.slice(offset);
      return frames;
    },
    reset(): void {
      carry = new Float32Array(0);
    },
  };
}
