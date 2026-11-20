// Voice mode shared constants: WS message types, audio params, and the
// fallback voice catalog (ids match the piper voices in ~/.snaglet/models/tts/<id>).
// The wire contract lives here and nowhere else.

/** Wire-level capture mode. The release UI always starts `open`. */
export type VoiceMode = 'ptt' | 'open';

/** Client → server voice frame types (pinned to the server contract). */
export const VOICE_C2S = {
  sessionStart: 'voice:session:start',
  audioChunk: 'voice:audio:chunk',
  utteranceEnd: 'voice:utterance:end',
  playbackDone: 'voice:playback:done',
  bargein: 'voice:bargein',
  sessionStop: 'voice:session:stop',
  // Per-utterance recipient changes. The server may ignore it; the
  // authoritative selection rides voice:session:start.targetAgentIds.
  targetsSet: 'voice:targets:set',
  // Live sync of the composer's attached image ids so a voice-dictated message
  // carries the user's attachments; the initial set also rides
  // voice:session:start.attachmentImageIds. The server appends the same
  // <image id="…"/> markers the manual composer send uses.
  attachmentsSet: 'voice:attachments:set',
} as const;

/** Server → client voice frame types (pinned to the server contract). */
export const VOICE_S2C = {
  sessionStarted: 'voice:session:started',
  partial: 'voice:partial',
  final: 'voice:final',
  ttsChunk: 'voice:tts:chunk',
  ttsEnd: 'voice:tts:end',
  floor: 'voice:floor',
  error: 'voice:error',
  // Open-mic: server VAD heard the user start over an agent — pause
  // playback instantly. Server then resumes (backchannel) or applies barge-in.
  interrupt: 'voice:interrupt',
  // Another window took over the mic on this thread. Sent only to the
  // displaced client: revert the toggle to off with a toast, no reconnect.
  sessionEnded: 'voice:session:ended',
} as const;

/** Existing chat status frame the "heard-you" earcon rides (agent thinking). */
export const CHAT_AGENT_STATUS = 'socket:agent:status';

/** Voice REST preview endpoint (agent detail picker). */
export const VOICE_PREVIEW_PATH = '/voice/preview';

/** Voice REST per-message re-listen endpoint (BubbleActions' listen button). */
export const VOICE_SPEAK_MESSAGE_PATH = '/voice/speak-message';

/**
 * Voice capabilities endpoint: the live selectable-voice catalog (piper +
 * installed Apple on-device voices). The VoicePicker falls back to
 * VOICE_CATALOG below when the request fails.
 */
export const VOICE_CAPABILITIES_PATH = '/voice/capabilities';

/**
 * A voice as returned by GET /voice/capabilities. `id` is the namespaced value
 * to store on the agent (piper ids are bare, Apple ids are `apple:`-prefixed) —
 * the server engine router dispatches on it. `quality` badges the tier so the
 * picker can nudge that Apple premium/enhanced voices need a System-Settings
 * download; piper's bundled voices are `'standard'`.
 */
export interface VoiceCapability {
  id: string;
  engine: 'apple' | 'piper';
  name: string;
  quality: 'standard' | 'default' | 'enhanced' | 'premium';
  lang: string;
}

/** Audio capture params — mono 16 kHz pcm16, per the server contract. */
export const VOICE_SAMPLE_RATE = 16_000;

/**
 * Fallback playback rate for TTS chunks whose payload omits sampleRate.
 * Piper vits voices synthesize at 22050 Hz, not the 16 kHz capture rate;
 * playing 22050 Hz samples at 16 kHz sounds slowed and pitched-down.
 */
export const VOICE_TTS_DEFAULT_SAMPLE_RATE = 22_050;

/**
 * PTT pre-roll ring depth. The hot mic keeps this many trailing ~100 ms chunks
 * (≈300 ms) while idle; on press they are flushed ahead of live audio so speech
 * that starts a breath before the press isn't clipped. Open-mic streams
 * continuously and never uses the ring.
 */
export const VOICE_PREROLL_CHUNKS = 3;

/**
 * Milliseconds to wait for the server to answer `voice:session:start` (with
 * `voice:session:started` or a `voice:error`) before giving up, toasting, and
 * reverting the toggle. The server loads the voice engine and its detection
 * model before it answers, which can take seconds on a cold start, so this is
 * a safety net rather than the usual way a start fails.
 */
export const VOICE_START_TIMEOUT_MS = 10_000;

/**
 * Milliseconds to wait for the microphone to start once the session is live.
 * getUserMedia can wait indefinitely (a permission prompt nobody answers, a
 * webview that never settles the request); past this the session ends with a
 * message instead of claiming to listen.
 */
export const VOICE_MIC_START_TIMEOUT_MS = 15_000;

/** How long voice error toasts stay up — long enough to read the fix they name. */
export const VOICE_ERROR_TOAST_MS = 6_000;

/**
 * How long the composer settles on the dispatched final text after a voice
 * message sends before restoring the user's stashed pre-capture draft — long
 * enough to read what was sent, short enough not to block typing (~600-800ms).
 */
export const VOICE_SETTLE_MS = 700;

/**
 * Rough spoken-character rate used to turn "audio played" into a
 * `heardUpTo.charOffset` estimate for barge-in. TTS chunks carry no text, so
 * charOffset ≈ secondsPlayed × this constant (piper medium voices speak about
 * 15 chars/s).
 */
export const ESTIMATED_CHARS_PER_SECOND = 15;

interface VoiceCatalogEntry {
  /** Wire id; must match a piper voice id the engine fetches. */
  id: string;
  /** Human label for the picker. */
  label: string;
  /** Short tone hint (UI only). */
  description?: string;
}

/**
 * Starter voice pack, used when the capabilities endpoint is unavailable. Ids
 * must match the piper voices the engine fetches.
 */
export const VOICE_CATALOG: VoiceCatalogEntry[] = [
  { id: 'en_US-amy-medium', label: 'Amy', description: 'US · warm' },
  { id: 'en_US-ryan-medium', label: 'Ryan', description: 'US · steady' },
  { id: 'en_GB-alan-medium', label: 'Alan', description: 'GB · calm' },
  { id: 'en_US-joe-medium', label: 'Joe', description: 'US · deep' },
];

/** Deterministic fallback voice when an agent has no `voice` configured. */
export const DEFAULT_VOICE_ID = 'en_US-amy-medium';

/** Sample sentence spoken by the agent-detail preview button. */
export const VOICE_PREVIEW_SENTENCE = "Hi, this is how I'll sound when we talk.";
