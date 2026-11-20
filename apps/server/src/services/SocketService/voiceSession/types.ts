/**
 * voiceSession/types — the voice session layer's own contracts.
 *
 * Engine seam: `VoiceEngineApi` is defined here. Nothing in this directory
 * imports `@server/services/voice` directly — only `engineAdapter.ts` does,
 * behind this interface. That keeps the audio-engine layer and the
 * session/protocol layer decoupled: swap the adapter, everything else is
 * unchanged.
 */

/** A live streaming speech-to-text session, one per active utterance capture. */
export interface SttSession {
  /**
   * Push one mono PCM16 frame into the recognizer. The rate is the session's
   * declared capture rate: the local engine wants 16 kHz (the session layer
   * band-limits to it); an Apple session sets {@link wantsNativeRate} and is fed
   * native-rate audio, which the sidecar down-converts internally.
   */
  feed(pcm16: Int16Array): void;
  /** Subscribe to interim (partial) transcripts as they decode. */
  onPartial(cb: (text: string) => void): void;
  /** End of speech: resolve the final transcript for the utterance. */
  finalize(): Promise<string>;
  /** Release recognizer resources (called on utterance end + session teardown). */
  close(): void;
  /**
   * Called once if the recognizer cannot serve this session (the Apple
   * sidecar didn't start or crashed). The message is plain language naming the
   * fix. Optional: the local engine reports failures through finalize instead.
   */
  onError?(cb: (err: Error) => void): void;
  /**
   * When true, the session layer feeds native-rate pcm straight through (no
   * server-side decimation) — the engine down-converts itself (Apple sidecar).
   * Absent/false → the session layer band-limits to 16 kHz before feeding.
   */
  readonly wantsNativeRate?: boolean;
}

/** One synthesized audio frame streamed down for playback. */
export interface TtsChunk {
  readonly pcm16: Int16Array;
  readonly sampleRate: number;
}

/**
 * A selectable voice surfaced by the capabilities endpoint (piper catalog +
 * installed Apple voices). `id` is the namespaced id the agent voice setting
 * stores and the engine router dispatches on — piper ids are bare (see
 * voiceIdNamespace), Apple ids are `apple:`-prefixed.
 */
export interface VoiceInfo {
  readonly id: string;
  readonly engine: 'apple' | 'piper';
  /** Human label for the picker. */
  readonly name: string;
  /**
   * Quality tier — a nudge in the picker that premium/enhanced Apple voices need
   * a System-Settings download. Piper's bundled voices are `'standard'`; Apple
   * reports `'default'` | `'enhanced'` | `'premium'`.
   */
  readonly quality: 'standard' | 'default' | 'enhanced' | 'premium';
  /** BCP-47-ish language tag (e.g. `en-US`). */
  readonly lang: string;
}

/** A server-side silero VAD stream (its own recurrent state + context). */
export interface VadSession {
  /** Speech probability in [0, 1] for one 512-sample (32 ms @16 kHz) frame. */
  process(frame: Float32Array): Promise<number>;
  /** Release the VAD stream. */
  close(): Promise<void>;
}

/** Which models a session's warmup loads (see VoiceEngineApi.warmup). */
export interface WarmupNeeds {
  readonly stt: boolean;
  readonly tts: boolean;
  readonly vad: boolean;
}

/**
 * The audio engine surface the session layer depends on. VoiceEngineService is
 * adapted to this shape in engineAdapter.ts (the single integration point).
 */
export interface VoiceEngineApi {
  /** Stop owned external sidecars; safe to call during session/server teardown. */
  shutdown?(): Promise<void>;
  /**
   * Open a streaming STT session (feed → partials → final). `sampleRate` is the
   * client's native capture rate; the Apple engine spawns its sidecar at that
   * rate, the local engine ignores it (the session layer feeds it 16 kHz).
   */
  createSttSession(opts?: { sampleRate?: number }): SttSession;
  /**
   * Which STT tier the streaming partials represent. The local zipformer emits
   * uppercased draft text → `'live'` (upgraded by the periodic quality re-decode).
   * Apple's SpeechAnalyzer partials are already cased + punctuated and phrase-
   * gated → `'quality'` (its final is the quality result; no re-decode cadence).
   * Absent → treated as `'live'`.
   */
  readonly sttTier?: 'live' | 'quality';
  /**
   * Who transcribes: `'apple'` = macOS's built-in on-device recognizer (the
   * sidecar; needs no Snaglet model download), `'local'` = Snaglet's bundled ONNX models.
   * Open-mic dictation on Apple ends utterances from the audio level and
   * Apple's own results instead of the local voice-detection model (see
   * appleDictation.ts). Absent → `'local'`.
   */
  readonly sttEngine?: 'apple' | 'local';
  /**
   * Check that speech-to-text can run before a session relies on it (Apple:
   * the sidecar's warmup, which also sets up the on-device model). Rejects
   * with a plain-language reason that names the fix. Optional.
   */
  prepareStt?(): Promise<void>;
  /**
   * Set when Apple's built-in recognizer was wanted (macOS) but can't be used,
   * so STT fell back to Snaglet's local models: the plain-language reason, for the
   * message shown when the local models then fail too.
   */
  readonly sttFallbackReason?: string;
  /**
   * Quality tier: re-decode a whole finalized utterance's pcm16 with a
   * cased + punctuated offline model (Moonshine). Its text is the dispatched
   * final; the streaming session above still owns live partials. Optional so
   * engines that only stream still satisfy the interface — when
   * absent, the pipeline dispatches the normalized streaming final. Rejects if
   * the quality model is unavailable; callers race it against a timeout and fall
   * back to the streaming final.
   */
  qualityDecode?(pcm16: Int16Array): Promise<string>;
  /**
   * Synthesize `text` in `voiceId`, yielding PCM frames as they render. In the
   * hybrid engine the router dispatches by voiceId namespace (`apple:` → Apple
   * sidecar, `piper:`/bare → local piper) — see voiceIdNamespace.
   */
  synthesize(text: string, voiceId: string): AsyncIterable<TtsChunk>;
  /**
   * List the selectable voices for the capabilities endpoint: the piper catalog
   * (always) plus any installed Apple voices (hybrid engine only). Optional so
   * engines that only stream still satisfy the interface — when
   * absent the route falls back to the static piper catalog.
   */
  listVoices?(): Promise<VoiceInfo[]>;
  /**
   * Open a server-side VAD stream for open-mic endpointing. Optional so
   * engines that only do STT+TTS still satisfy the interface.
   */
  createVadSession?(): Promise<VadSession>;
  /**
   * Pre-load the models a session will use (one silent dummy synth for TTS) so
   * the first real utterance skips the ~1.7s cold model load. `needs` limits
   * it to those parts (all of them when absent), so a dictate-only session
   * never loads a voice it won't speak with. Optional.
   */
  warmup?(voiceId?: string, needs?: WarmupNeeds): Promise<void>;
}

// WS contract payloads: base64 pcm16 mono 16k in JSON on the audio-carrying frames.

type VoiceCaptureMode = 'ptt' | 'open';

/** C→S: begin a voice session bound to a thread. */
export interface VoiceSessionStartPayload {
  readonly threadId: string;
  readonly mode: VoiceCaptureMode;
  readonly targetAgentIds?: readonly string[];
  /**
   * Two independent behaviors; each defaults to `true` in VoiceSessionService.start().
   *   - `dictate`: mic capture → STT (mic-open, STT init, open-mic VAD). A
   *     dictate-only finalized transcript is never auto-dispatched; it lands in
   *     the composer as an editable draft.
   *   - `speak`: agent replies spoken aloud. Gates the TTS sink, the floor,
   *     the voice-mode event (and so VOICE_PROFILE_BLOCK), floor-gated
   *     generation and barge-in tracking; none of these assume the mic is live.
   */
  readonly dictate?: boolean;
  readonly speak?: boolean;
  /**
   * Image ids currently attached in the composer, carried so a voice-dictated
   * message includes the user's attachments — the dispatched content gets the
   * same `<image id="…"/>` markers the manual composer send appends. Kept in
   * sync mid-session via voice:attachments:set; consumed (cleared) on dispatch.
   */
  readonly attachmentImageIds?: readonly string[];
  /**
   * Client-chosen id for this handshake, echoed on the voice:session:started or
   * voice:error that answers it. Lets the client match the reply to the start
   * it is waiting on, and stop a session whose start it already gave up on.
   */
  readonly requestId?: string;
}

/** C→S: one captured audio frame. `pcm16` is base64-encoded little-endian PCM16. */
export interface VoiceAudioChunkPayload {
  readonly voiceSessionId: string;
  readonly seq: number;
  readonly pcm16: string;
  /**
   * The client's native AudioContext sample rate for this frame. The client
   * does not resample (a linear resample aliases high-frequency energy into the
   * speech band); the server band-limits to 16 kHz for the local STT + silero
   * VAD, and streams native-rate straight through to the Apple sidecar. Absent →
   * treated as 16 kHz.
   */
  readonly sampleRate?: number;
}

/** C→S: PTT release / client VAD endpoint — finalize the utterance. */
export interface VoiceUtteranceEndPayload {
  readonly voiceSessionId: string;
  /**
   * Esc bail-out: still finalize STT and emit voice:final back, but suppress
   * the auto-dispatch — the client drops the transcript into the composer as an
   * editable draft instead of sending it.
   */
  readonly cancelDispatch?: boolean;
}

/** C→S: floor heartbeat — playback of one utterance's audio finished. */
export interface VoicePlaybackDonePayload {
  readonly voiceSessionId: string;
  readonly utteranceId: string;
}

/**
 * Where the user's ears actually got to when they cut in. Two shapes accepted:
 * a client `charOffset`, or `playedMs` (ms of audio actually played) —
 * prefer `playedMs`, since the server owns the utterance text + synthesized
 * audio duration and can compute a precise, word-snapped offset from it.
 */
export interface VoiceHeardUpTo {
  readonly utteranceId: string;
  readonly charOffset?: number;
  readonly playedMs?: number;
}

/** C→S: user barge-in (preemption). */
export interface VoiceBargeInPayload {
  readonly voiceSessionId: string;
  readonly heardUpTo?: VoiceHeardUpTo;
}

/** C→S: end the voice session. `voiceSessionId` optional (falls back to the client's). */
export interface VoiceSessionStopPayload {
  readonly voiceSessionId?: string;
}

/**
 * C→S `voice:targets:set` (consumed by the pill row): live
 * re-targeting mid-session. The finalized transcript appends `@Name` for each
 * selected agent before it is sent (mentioned-mode routing does the rest).
 * `targetAgentIds` also arrives on voice:session:start for the initial selection.
 */
export interface VoiceTargetsPayload {
  readonly voiceSessionId: string;
  readonly targetAgentIds: readonly string[];
}

/**
 * C→S `voice:attachments:set`: live sync of the composer's attached image ids
 * mid-session. Before a finalized transcript is dispatched, the server appends
 * the same `<image id="…"/>` markers the manual composer send uses, so a
 * voice-dictated message carries the user's attachments too. The initial set
 * also rides voice:session:start.attachmentImageIds. Consumed (cleared) on each
 * dispatch so the same images aren't re-sent on the next utterance.
 */
export interface VoiceAttachmentsPayload {
  readonly voiceSessionId: string;
  readonly attachmentImageIds: readonly string[];
}

// S→C payloads

export interface VoiceTtsChunkPayload {
  readonly utteranceId: string;
  readonly agentId: string;
  readonly seq: number;
  /** base64-encoded little-endian PCM16. */
  readonly pcm16: string;
  readonly sampleRate: number;
}
export interface VoiceTtsEndPayload {
  readonly utteranceId: string;
}

/**
 * One-shot barge-in routing override: route the next finalized utterance only to
 * `agentId`, with no pill mentions. `awaitTeardown` marks the mid-speech case
 * where the run was aborted and the redispatch must wait for the run-lock to
 * release (so it starts a fresh run, not a mid-run injection).
 */
export interface BargeInTarget {
  agentId: string;
  heardUpTo?: VoiceHeardUpTo;
  awaitTeardown?: boolean;
}

/** Per-session open-mic (VAD endpointing) runtime — present only in mode 'open'. */
export interface OpenMicRuntime {
  readonly vad: VadSession;
  /** Endpointer state machine (typed loosely to avoid an import cycle). */
  readonly endpointer: import('./openMicVad').VadEndpointer;
  /** Rolling PCM16 → 512-sample Float32 framer. */
  readonly framer: import('./openMicVad').VadFramer;
  /** Serializes async VAD frame processing so frames stay in order. */
  chain: Promise<void>;
  /**
   * Serializes dispatch (finalize → send) per session so utterances send in
   * order — but off the VAD `chain`, so VAD frame processing never waits on
   * waitForThreadRelease/processChatSend (which can take seconds).
   */
  dispatchChain: Promise<void>;
  /** VAD `chain` links enqueued but not yet processed (backlog bound). */
  pending: number;
  /** Frames dropped because the VAD chain was saturated (diagnostics/log). */
  droppedFrames: number;
  /** True once the saturation warning has fired (warn once per session). */
  dropWarned: boolean;
  /** True once a failed frame has been reported to the user (once per session). */
  frameErrorReported: boolean;
  /**
   * Recent chunks kept to feed STT the pre-onset lead-in. Each holds both the
   * native-rate pcm (fed to an Apple session) and the 16 kHz-decimated pcm (fed
   * to the local engine + retained for the quality re-decode), so the pre-roll
   * flush matches the live feed regardless of engine.
   */
  preRoll: Array<{ native: Int16Array; pcm16k: Int16Array }>;
  /** True between a speech-start and its speech-end. */
  inSpeech: boolean;
  /**
   * Set on VAD onset while an agent held the floor: voice:interrupt was sent and
   * the client paused. Resolved at speech-end (backchannel → resume; real →
   * barge-in). heardUpTo is filled from an optional client voice:bargein report.
   */
  tentativeBargeIn: {
    agentId: string;
    utteranceId: string | null;
    heardUpTo?: VoiceHeardUpTo;
  } | null;
}

/**
 * Per-session runtime for open-mic dictation on Apple's recognizer — present
 * only for a dictate-only open-mic session whose engine is Apple. Audio streams
 * continuously into one recognizer session; the endpointer decides when the
 * utterance is over, FINALIZE flushes Apple's text, and the next audio opens the
 * next utterance. No local voice-detection model is involved.
 */
export interface AppleDictationRuntime {
  /** Ends utterances from frame levels + the recognizer's text (pure). */
  readonly endpointer: import('./dictationEndpointer').DictationEndpointer;
  /** Rolling PCM16 → 512-sample Float32 framer (level measurement only). */
  readonly framer: import('./openMicVad').VadFramer;
  /** Serializes feed → endpoint → finalize so utterances never interleave. */
  chain: Promise<void>;
  /** Chain links enqueued but not yet processed (backlog bound). */
  pending: number;
  /** True once the backlog warning has fired (warn once per session). */
  dropWarned: boolean;
  /** True once the recognizer failed; the session is being ended. */
  failed: boolean;
  /** Ends the session with the failure's plain-language reason (called once). */
  readonly onFailure: (err: Error) => void;
}

/** Per-client voice session state held in-memory by VoiceSessionService. */
export interface VoiceSessionState {
  readonly voiceSessionId: string;
  readonly clientId: string;
  readonly threadId: string;
  /** Chat session created for this voice session — the send/dispatch identity. */
  readonly chatSessionId: string;
  readonly mode: VoiceCaptureMode;
  /** Resolved (defaulted) dictate/speak flags for this session — see
   *  VoiceSessionStartPayload. Read at every gate: audioChunk/utteranceEnd
   *  (dictate), and the sink/floor/enabled-event/disabled-event gates (speak). */
  readonly dictate: boolean;
  readonly speak: boolean;
  readonly participantAgentIds: readonly string[];
  /** Standing pill selection; compiled to @mentions on each finalized utterance. */
  targetAgentIds: readonly string[];
  /**
   * Composer image attachments to append as `<image id="…"/>` markers on the
   * next dispatched utterance (same format the manual composer send uses).
   * Synced from the client via session:start + voice:attachments:set; consumed
   * (cleared) on send so images aren't re-attached to the following utterance.
   */
  attachmentImageIds: readonly string[];
  /** Active STT session for the in-flight utterance (null between utterances). */
  stt: SttSession | null;
  /**
   * True when the active STT session wants native-rate audio (Apple sidecar) —
   * the session layer feeds it the un-decimated pcm. False → feed 16 kHz.
   */
  sttWantsNativeRate: boolean;
  /**
   * The client's native capture sample rate (from voice:audio:chunk.sampleRate;
   * default 16 kHz). Builds the band-limiting decimator and opens Apple STT
   * sessions at the right rate.
   */
  captureSampleRate: number;
  /** Band-limiting decimator (native → 16 kHz), lazily built when rate ≠ 16 kHz. */
  decimator: import('@server/services/voice/decimator').Decimator | null;
  /**
   * Tier tag for streaming partials from this engine: `'live'` (local zipformer,
   * upgraded by the quality re-decode) or `'quality'` (Apple, already cased +
   * punctuated). Set from the engine's `sttTier` at session start.
   */
  partialTier: 'live' | 'quality';
  /**
   * Monotonic per-utterance counter (prevents cross-utterance bleed). Incremented
   * at the start of each captured utterance (PTT stt-open / open-mic speech-start)
   * and stamped on every voice:partial + voice:final so the client can key its
   * converging-preview state per utterance and drop stale previews/finals whose
   * utterance a newer one has superseded.
   */
  utteranceSeq: number;
  /**
   * Retained pcm16 chunks of the in-flight utterance, fed to the two-tier quality
   * re-decode (Moonshine) at finalize and to the capture-audit dump. Reset at the
   * start of each utterance and consumed (cleared) at finalize; capped at
   * QUALITY_DECODE_MAX_SAMPLES so a stuck mic can't leak memory.
   */
  utterancePcm: Int16Array[];
  utterancePcmSamples: number;
  /**
   * One-shot barge-in routing override set by voice:bargein and consumed by the
   * next finalized utterance: route only to `agentId`, no pill mentions.
   */
  bargeInTarget: BargeInTarget | null;
  /** Open-mic (mode 'open') VAD endpointing runtime, or null in PTT mode. */
  openMic: OpenMicRuntime | null;
  /** Open-mic dictation on Apple's recognizer (no VAD), or null otherwise. */
  appleDictation: AppleDictationRuntime | null;
  /**
   * Converging preview cadence timer that periodically re-decodes the
   * accumulated utterance pcm with the quality tier and emits a tier:'quality'
   * voice:partial. Null when disabled (env 0) or after teardown.
   */
  previewTimer: ReturnType<typeof setInterval> | null;
  /** True while a preview re-decode is awaiting the worker (one at a time). */
  previewDecodeInFlight: boolean;
  /**
   * True while the final (dispatched) quality decode is running — the preview
   * cadence skips its tick so the two never contend on the same utterance's pcm.
   */
  finalDecodeInFlight: boolean;
  /**
   * Throttle bookkeeping for voice:partial: the epoch-ms of the last emitted
   * partial. 0 = never emitted (or reset at utterance end) → the next partial is
   * not throttled. There is exactly one session per client, so this lives on the
   * state (set on each emit, reset to 0 at utterance end, gone with the session).
   */
  lastPartialAt: number;
  /**
   * True while an STT session is mid-open (PTT) — prevents duplicate sessions
   * when a burst of PTT frames all arrive before the first open resolves.
   */
  opening: boolean;
}
