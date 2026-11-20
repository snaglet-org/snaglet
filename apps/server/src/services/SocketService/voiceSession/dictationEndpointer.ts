/**
 * dictationEndpointer — decides when a dictated utterance is over, for open-mic
 * dictation on Apple's recognizer. It stands in for the local voice-detection
 * model (silero) there, so dictation on macOS needs no Snaglet model download.
 *
 * Two signals, both cheap and deterministic:
 *   - the audio LEVEL of each 32 ms frame (RMS), against a noise floor that is
 *     the quietest frame of the last few seconds, so a fan or a hum doesn't
 *     count as speech;
 *   - the recognizer's own text: a partial means Apple heard words, even ones
 *     spoken too softly to clear the level threshold.
 *
 * An utterance that has been heard ends after `silenceMs` of quiet. In a room
 * too noisy ever to go quiet it ends once Apple's text has stopped changing for
 * `idleMs` (Apple re-reports at least every ~4 s while words keep coming), and
 * never runs past `maxUtteranceMs`. Apple's own phrase commits are too late to
 * end an utterance on (1-4 s after speech, sometimes never until FINALIZE), so
 * they only count as text here.
 *
 * Pure state machine: unit-tested with synthetic levels, no audio hardware.
 */

import {
  DICTATION_FLOOR_RATIO,
  DICTATION_FLOOR_WINDOW_MS,
  DICTATION_IDLE_MS,
  DICTATION_LOUD_RMS,
  DICTATION_MAX_UTTERANCE_MS,
  DICTATION_MIN_RMS,
  DICTATION_MIN_VOICED_MS,
  OPEN_MIC_SILENCE_MS,
  VAD_FRAME_MS,
} from './constants';

export interface DictationEndpointerOptions {
  /** ms per frame (512 samples @16 kHz = 32 ms). */
  readonly frameMs?: number;
  /** Trailing quiet that ends a heard utterance. */
  readonly silenceMs?: number;
  /** Voiced audio needed (without recognizer text) before quiet can end it. */
  readonly minVoicedMs?: number;
  /** Absolute RMS floor for a voiced frame. */
  readonly minRms?: number;
  /** A voiced frame is also at least this many times the noise floor… */
  readonly floorRatio?: number;
  /** …unless it is this loud: then it is voice whatever the floor estimate. */
  readonly loudRms?: number;
  /** Window over which the noise floor (quietest frame) is tracked. */
  readonly floorWindowMs?: number;
  /** Recognizer text unchanged this long (while heard) ends the utterance. */
  readonly idleMs?: number;
  /** An utterance never runs longer than this. */
  readonly maxUtteranceMs?: number;
}

export interface DictationEndpointer {
  /** One frame's RMS level in [0, 1]; true when the utterance should end now. */
  pushFrame(rms: number): boolean;
  /** The recognizer's latest partial text for the current utterance. */
  noteText(text: string): void;
  /** True once this utterance has voice or recognizer text. */
  heard(): boolean;
  /** Begin the next utterance (the noise-floor estimate carries over). */
  reset(): void;
}

/** Root-mean-square level of one float frame (samples in [-1, 1]). */
export function frameRms(frame: Float32Array): number {
  if (frame.length === 0) return 0;
  let sum = 0;
  for (let i = 0; i < frame.length; i++) sum += frame[i]! * frame[i]!;
  return Math.sqrt(sum / frame.length);
}

export function createDictationEndpointer(
  opts: DictationEndpointerOptions = {}
): DictationEndpointer {
  const frameMs = opts.frameMs ?? VAD_FRAME_MS;
  const silenceMs = opts.silenceMs ?? OPEN_MIC_SILENCE_MS;
  const minVoicedMs = opts.minVoicedMs ?? DICTATION_MIN_VOICED_MS;
  const minRms = opts.minRms ?? DICTATION_MIN_RMS;
  const floorRatio = opts.floorRatio ?? DICTATION_FLOOR_RATIO;
  const loudRms = opts.loudRms ?? DICTATION_LOUD_RMS;
  const idleMs = opts.idleMs ?? DICTATION_IDLE_MS;
  const maxUtteranceMs = opts.maxUtteranceMs ?? DICTATION_MAX_UTTERANCE_MS;

  // Noise floor: the quietest frame over the window (until it fills, the
  // quietest frame so far), so a steady hum is quiet from the first frames on.
  const window = new Float64Array(
    Math.max(1, Math.round((opts.floorWindowMs ?? DICTATION_FLOOR_WINDOW_MS) / frameMs))
  ).fill(Infinity);
  let windowPos = 0;

  let voicedMs = 0;
  let quietMs = 0;
  let utteranceMs = 0;
  let text = '';
  let textIdleMs = 0;

  const heard = (): boolean => voicedMs >= minVoicedMs || text.length > 0;

  return {
    pushFrame(rms: number): boolean {
      window[windowPos] = rms;
      windowPos = (windowPos + 1) % window.length;
      let floor = Infinity;
      for (let i = 0; i < window.length; i++) floor = Math.min(floor, window[i]!);

      utteranceMs += frameMs;
      textIdleMs += frameMs;
      if (rms >= Math.max(minRms, Math.min(loudRms, floor * floorRatio))) {
        voicedMs += frameMs;
        quietMs = 0;
      } else {
        quietMs += frameMs;
      }

      if (!heard()) return false;
      if (quietMs >= silenceMs) return true;
      if (text.length > 0 && textIdleMs >= idleMs) return true;
      return utteranceMs >= maxUtteranceMs;
    },
    noteText(next: string): void {
      const trimmed = next.trim();
      if (trimmed === text) return;
      text = trimmed;
      textIdleMs = 0;
    },
    heard,
    reset(): void {
      voicedMs = 0;
      quietMs = 0;
      utteranceMs = 0;
      text = '';
      textIdleMs = 0;
    },
  };
}
