// Voice mode wire payloads + audio-controller interfaces. The controllers are
// interfaces (not concrete classes) so the real browser implementations and
// the test fakes conform to the same shape and useVoiceSession can be driven
// deterministically under jsdom.

import type { VoiceMode } from './voiceConstants';

/** Where the user heard up to when they barged in. */
export interface HeardUpTo {
  utteranceId: string;
  /** Estimated character offset into the utterance text (see ESTIMATED_CHARS_PER_SECOND). */
  charOffset: number;
  /**
   * Milliseconds of this utterance's audio actually played. The server owns the
   * utterance text + synthesized duration, so it maps this to a precise, word-
   * snapped charOffset — preferred over the client charOffset estimate.
   */
  playedMs?: number;
}

// Client → server payloads

export interface VoiceSessionStartPayload {
  threadId: string;
  mode: VoiceMode;
  /**
   * Two independent flags. `dictate` = mic capture → STT (a dictate-only
   * transcript lands in the composer as a draft, never auto-sent). `speak` =
   * agent replies spoken aloud. The server treats an absent flag as `true`;
   * the client sends them only when set (see useVoiceSession.start).
   */
  dictate?: boolean;
  speak?: boolean;
  targetAgentIds?: string[];
  /** Image ids attached in the composer, carried so a voice-dictated message
   *  includes the user's attachments (server appends `<image id/>` markers). */
  attachmentImageIds?: string[];
  /** Fresh per start; the server echoes it on the started/error frame that
   *  answers this start, so the client knows which handshake a reply is for. */
  requestId: string;
}
/** Optional frame for live recipient changes; the server may ignore it. */
export interface VoiceTargetsSetPayload {
  voiceSessionId: string;
  targetAgentIds: string[];
}
/** Live sync of the composer's attached image ids mid-session. The initial set
 *  rides voice:session:start.attachmentImageIds. */
export interface VoiceAttachmentsSetPayload {
  voiceSessionId: string;
  attachmentImageIds: string[];
}

// Server → client payloads

export interface VoiceSessionStartedPayload {
  voiceSessionId: string;
  /** Echo of the start's requestId, when the server sends one. */
  requestId?: string;
}
export interface VoicePartialPayload {
  text: string;
  /**
   * STT tier feeding the converging preview: `'live'` = streaming zipformer
   * partial (normalized); `'quality'` = periodic Moonshine re-decode of the
   * utterance so far (authoritative). Absent means `'live'`.
   */
  tier?: 'live' | 'quality';
  /**
   * Per-utterance monotonic key. When it changes, this partial belongs to a new
   * utterance and the preview's tier state resets at once (not on the late
   * voice:final), so the previous utterance's quality tier can't bleed into
   * the current one. When absent, the reset waits for voice:final.
   */
  utteranceSeq?: number;
}
export interface VoiceFinalPayload {
  text: string;
  messageId: string;
  /** Per-utterance key (see VoicePartialPayload.utteranceSeq): a final whose seq
   *  is older than the utterance currently being captured is stale and must not
   *  touch the composer. */
  utteranceSeq?: number;
}
export interface VoiceTtsChunkPayload {
  utteranceId: string;
  agentId: string;
  seq: number;
  /** base64 pcm16 mono at `sampleRate` (piper voices synthesize at 22050 Hz) */
  pcm16: string;
  /** Synthesis sample rate for this chunk; the server sends it on every frame. */
  sampleRate?: number;
}
export interface VoiceTtsEndPayload {
  utteranceId: string;
}
export interface VoiceFloorPayload {
  /** agentId holding the floor, or null when the floor is free. */
  holder: string | null;
}
export interface VoiceErrorPayload {
  message: string;
  /** True when the server also spoke this error aloud (client only cues + shows). */
  speakable: boolean;
  /** Set when the error answers a voice:session:start: the server refused it. */
  requestId?: string;
}
/**
 * The server ended this window's session: another window took over the mic on
 * this thread (thread-level exclusivity), or speech recognition failed. Sent
 * only to this client: revert the toggle to off and toast the message, no
 * reconnect. `voiceSessionId` is the ended session.
 */
export interface VoiceSessionEndedPayload {
  voiceSessionId: string;
  /** 'failed': speech recognition stopped working mid-session (message says why). */
  reason: 'taken-over' | 'failed';
  message: string;
}

// Hook state

/** Coarse session phase; drives the toggle's visual state. */
export type VoicePhase = 'off' | 'connecting' | 'idle' | 'listening' | 'agent-speaking';

// Audio controller interfaces (real impls + test fakes)

/** The capture device changed underfoot while a session was live. */
export interface MicDeviceChange {
  /** `track-ended` = the device was yanked; `devicechange` = the OS default
   *  input switched out from under the live track (e.g. macOS Continuity). */
  reason: 'track-ended' | 'devicechange';
  /** Label of the affected or newly current input device. */
  label: string;
}

export interface MicOptions {
  /**
   * Called ~every 100 ms with a base64 pcm16 chunk (at the capture context's
   * native `sampleRate`, second arg) while capturing. No client-side
   * resampling: the server band-limits when it needs 16 kHz.
   */
  onChunk: (pcm16Base64: string, sampleRate: number) => void;
  /** Recoverable capture degradation (for example AudioWorklet → ScriptProcessor). */
  onWarning?: (err: unknown) => void;
  /** The live input device label (MediaStreamTrack.label), reported once on
   *  start so the UI can show which mic is capturing. */
  onDeviceLabel?: (label: string) => void;
  /** The capture device changed underfoot (track ended, or the OS default input
   *  switched) — surfaced so silent switches (Continuity) become visible. */
  onDeviceChange?: (info: MicDeviceChange) => void;
}
export interface MicController {
  /** Acquire the mic (getUserMedia) and begin emitting chunks. */
  start(): Promise<void>;
  /** Stop emitting and release the mic stream. */
  stop(): void;
}

export interface PlaybackOptions {
  /** Fired when an utterance's audio has fully played out (floor heartbeat). */
  onUtteranceDone: (utteranceId: string) => void;
  now?: () => number;
}
export interface PlaybackController {
  /**
   * Returns whether the chunk was accepted (buffered/scheduled). False when the
   * deadIds fence rejects a straggler for an utterance a flush() already
   * canceled — callers must not treat a fenced chunk as "the agent is now
   * speaking" (see useVoiceSession's ttsChunk handler).
   */
  enqueueChunk(chunk: VoiceTtsChunkPayload): boolean;
  markEnd(utteranceId: string): void;
  /**
   * Instantly stop + flush all audio (barge-in). Returns the heardUpTo of the
   * utterance that was playing, or null if nothing was audible.
   */
  flush(): HeardUpTo | null;
  /** True while any utterance audio is queued or playing. */
  isSpeaking(): boolean;
  /**
   * Open-mic: pause playback without discarding buffered audio, so a
   * backchannel can resume it. Returns heardUpTo (with playedMs) of what was
   * playing. Optional — PTT-only controllers may omit it.
   */
  pause?(): HeardUpTo | null;
  /** Open-mic: resume after a pause() (backchannel over). Optional. */
  resume?(): void;
  /** Stop + release everything (session end / unmount). */
  dispose(): void;
}

export interface EarconController {
  /** Soft "heard you" tick (rate-limited internally). */
  thinkingTick(): void;
  /** Gentle error tone (rate-limited internally). */
  error(): void;
  dispose(): void;
}

export interface VoiceSessionDeps {
  createMic: (opts: MicOptions) => MicController;
  createPlayback: (opts: PlaybackOptions) => PlaybackController;
  createEarcons: () => EarconController;
  now: () => number;
}
