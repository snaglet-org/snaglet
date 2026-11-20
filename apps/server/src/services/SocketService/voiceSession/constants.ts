/**
 * voiceSession/constants — tunables + fixed strings for the voice session layer.
 *
 * All numbers here are product-tuning knobs surfaced in one place so the audio
 * timing can be adjusted without hunting through the pipeline.
 */

/**
 * Deterministic fallback voice used when an agent has no `voice` configured.
 * Must be a voice id the bundled piper catalog ships (the manifest's own
 * `DEFAULT_VOICE_ID`; a test keeps the two equal). Deterministic — never
 * random — so an unconfigured agent always sounds the same across turns.
 */
export const DEFAULT_VOICE_ID = 'en_US-amy-medium';

/** PCM audio format the whole voice path assumes (client capture + engine). */
export const VOICE_SAMPLE_RATE = 16_000;

// Two-tier STT

/**
 * Quality tier race window: how long the finalize path waits for the offline
 * Moonshine re-decode before falling back to the (normalized) streaming final.
 * Keeps the dispatched final cased+punctuated when the model is warm (~125 ms)
 * without ever stalling a turn on a cold/slow decode. Env-tunable via
 * `SNAGLET_VOICE_QUALITY_DECODE_TIMEOUT_MS`; falls back to 1200 ms.
 */
export const QUALITY_DECODE_TIMEOUT_MS = ((): number => {
  const raw = Number(process.env.SNAGLET_VOICE_QUALITY_DECODE_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : 1200;
})();

/**
 * Cap on the pcm16 retained per utterance for the quality re-decode + capture
 * audit — ~60 s at 16 kHz. Past this the retained buffer stops growing (the
 * quality decode still runs on the capped audio) so a stuck-open mic can't leak
 * unbounded memory.
 */
export const QUALITY_DECODE_MAX_SAMPLES = VOICE_SAMPLE_RATE * 60;

/**
 * Converging preview cadence: while an utterance is captured, the quality
 * (Moonshine) tier re-decodes the accumulated pcm every this-many ms and emits
 * `voice:partial {tier:'quality'}`, so the live preview matches the dispatched
 * final. Between upgrades streaming partials flow as `tier:'live'`.
 *
 * Env-tunable via `SNAGLET_VOICE_PREVIEW_DECODE_MS`; `0` disables the cadence.
 * Default 1200 ms. Read per session (not at module load) so tests can toggle it.
 */
export function previewDecodeMs(): number {
  const raw = Number(process.env.SNAGLET_VOICE_PREVIEW_DECODE_MS);
  return Number.isFinite(raw) && raw >= 0 ? raw : 1200;
}

/**
 * Hard cap on the pcm fed to one preview re-decode — the last ~20 s. Long
 * dictation stays cheap: each preview only re-decodes the recent tail, while the
 * final decode at end-of-utterance still sees the whole retained buffer.
 */
export const PREVIEW_DECODE_MAX_SAMPLES = VOICE_SAMPLE_RATE * 20;

/**
 * Live-partial emit throttle: ~8 per second (125 ms), so the streaming zipformer
 * preview keeps up with speech. Only gates the tier:'live' stream; the quality
 * re-decode keeps its own (slower) cadence — see `previewDecodeMs` (1200 ms).
 */
export const PARTIAL_THROTTLE_MS = 125;

/**
 * Floor heartbeat: if the holder's client never sends voice:playback:done, the
 * arbiter auto-advances after this window so one vanished client cannot wedge
 * every parked speaker behind it.
 */
export const FLOOR_HEARTBEAT_TIMEOUT_MS = 30_000;

// Open-mic mode

/** silero v5 frame size @16 kHz: 512 samples (32 ms). */
export const VAD_FRAME_SAMPLES = 512;
/** Milliseconds of audio in one 512-sample @16 kHz VAD frame. */
export const VAD_FRAME_MS = 32;

/**
 * Trailing-silence window that ends an open-mic utterance. Env-tunable via
 * `SNAGLET_VOICE_SILENCE_MS`; falls back to 1000 ms when unset/invalid.
 *
 * 1000 ms rather than a short (~300 ms) window: 300 ms is a comma, not a
 * finished thought — a natural mid-sentence pause would endpoint and dispatch a
 * half-formed utterance. 1 s lets a normal pause
 * ride through while still ending a genuinely finished utterance promptly.
 */
export const OPEN_MIC_SILENCE_MS = ((): number => {
  const raw = Number(process.env.SNAGLET_VOICE_SILENCE_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : 1000;
})();

/**
 * Barge-in finish window: the trailing-silence window for an utterance that
 * interrupted a speaking agent. The interrupt itself fires instantly on onset;
 * the longer endpoint lets the speaker finish the thought instead of dispatching
 * their first fragment. Env-tunable via `SNAGLET_VOICE_BARGEIN_SILENCE_MS` (default
 * 1300 ms); never shorter than the normal window. A short filler still resumes
 * the paused speaker.
 */
export const OPEN_MIC_BARGEIN_SILENCE_MS = ((): number => {
  const raw = Number(process.env.SNAGLET_VOICE_BARGEIN_SILENCE_MS);
  const bargeIn = Number.isFinite(raw) && raw > 0 ? raw : 1300;
  return Math.max(OPEN_MIC_SILENCE_MS, bargeIn);
})();

/**
 * Backchannel filter: the voiced-audio floor below which an utterance
 * may be a backchannel. Duration alone does not decide it — a short burst is a
 * backchannel only if its transcript is empty or a filler ("mhm", "yeah", …); a
 * short curt command ("stop", "no", "wait") still barges in (see openMicVad
 * `isBackchannelUtterance`). Env-tunable via `SNAGLET_VOICE_MIN_SPEECH_MS`; falls back
 * to 500 ms when unset/invalid.
 */
export const OPEN_MIC_MIN_SPEECH_MS = ((): number => {
  const raw = Number(process.env.SNAGLET_VOICE_MIN_SPEECH_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : 500;
})();

/**
 * VAD-chain backlog bound: if silero VAD can't keep pace with
 * realtime audio, unprocessed frames (each retaining a pcm16 buffer) would pile
 * up without limit. Past this many pending frames (~100 × 32 ms ≈ 3.2 s of audio)
 * the incoming frame is dropped instead of enqueued, and the session warns once.
 */
export const OPEN_MIC_MAX_PENDING_FRAMES = 100;

/** VAD speech-onset / speech-offset probability thresholds (hysteresis). */
export const VAD_ONSET_PROB = 0.5;
export const VAD_OFFSET_PROB = 0.35;

/** How many recent audio chunks to keep as onset pre-roll (feeds STT the
 *  lead-in that precedes VAD onset so the first word isn't clipped). */
export const OPEN_MIC_PREROLL_CHUNKS = 3;

// Open-mic dictation on Apple's recognizer (no VAD)
//
// Apple's recognizer commits a phrase on its own only 1-4 s after speech stops
// (it analyzes ~4 s windows), and sometimes not until it is told the input
// ended. So the session ends the utterance itself once the mic has gone quiet,
// and FINALIZE makes Apple flush its text at once (~30 ms). The quiet that
// ends an utterance is OPEN_MIC_SILENCE_MS (SNAGLET_VOICE_SILENCE_MS), as on the VAD
// path. See dictationEndpointer.ts.

/** Voiced audio needed before a quiet spell ends the utterance (skips clicks). */
export const DICTATION_MIN_VOICED_MS = 128;
/** A frame counts as voice at this RMS level or above (about -42 dBFS)… */
export const DICTATION_MIN_RMS = 0.008;
/** …and only when it is this many times the room's noise floor (about +9.5 dB)… */
export const DICTATION_FLOOR_RATIO = 3;
/** …unless it is this loud (about -26 dBFS): then it is voice whatever the floor. */
export const DICTATION_LOUD_RMS = 0.05;
/** The noise floor is the quietest frame over this window. */
export const DICTATION_FLOOR_WINDOW_MS = 3_000;
/** Noisy-room fallback: Apple's text unchanged for this long ends the utterance. */
export const DICTATION_IDLE_MS = 6_000;
/** Hard cap on one dictated utterance. */
export const DICTATION_MAX_UTTERANCE_MS = 60_000;

/**
 * Barge-in redispatch (mid-speech): after aborting the interrupted run, wait up
 * to this long for its thread run-lock to release before redispatching the
 * user's utterance as a fresh run — otherwise the send would enqueue as a
 * mid-run injection against the run we just aborted.
 */
export const BARGE_IN_TEARDOWN_TIMEOUT_MS = 2_000;

/**
 * The per-turn ephemeral voice profile block. Rides composeTurnContextData (the
 * turn-context tail) only while a voice session is active for the thread — it is
 * behavior, not durable state, so it never persists (the toggle thread_event
 * carries the durable "voice is on" fact). Kept compact: it sits behind the
 * message-tail cache breakpoint, and the system prefix stays byte-identical.
 *
 * Content contract: short replies, acknowledge-before-work, bounded narration
 * frequency, summon aloud.
 */
export const VOICE_PROFILE_BLOCK = [
  '**Voice mode is ON for this thread — you are being spoken aloud.**',
  '- Keep spoken replies short: 1-3 sentences.',
  '- Your replies are spoken aloud automatically — never play speech yourself (no shell `say`, no `text_to_speech`).',
  '- Before any tool work, say one short sentence about what you are about to do.',
  '- Speak at the start, at the finish, and on notable changes; work silently in between — never narrate every tool step (you are a colleague, not a screen reader).',
  '- To bring in a teammate, say `@Name` out loud in your reply — a name only in your private reasoning summons no one.',
].join('\n');
