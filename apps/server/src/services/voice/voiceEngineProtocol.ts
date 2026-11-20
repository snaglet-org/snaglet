/**
 * voiceEngineProtocol — the message contract between the main thread
 * ({@link VoiceEngineService}) and the sherpa/onnx worker
 * ({@link voiceEngineWorker}). Every request carries a `reqId`; the worker
 * answers with a result/error tagged with the same `reqId`. TTS additionally
 * streams `tts:chunk` messages (same `reqId`) before its terminal result.
 *
 * PCM is exchanged as typed arrays: STT input as `Int16Array` (pcm16 @ 16 kHz
 * mono), VAD input as `Float32Array` frames, TTS output as `Int16Array` chunks.
 */

/** sherpa vits paths for one voice. */
interface VoiceModelFilePaths {
  readonly model: string;
  readonly tokens: string;
  readonly dataDir: string;
}

/**
 * Cloneable path data handed to the worker via `workerData`. The parent
 * (main thread, full module resolution) resolves these from the manifest; the
 * worker only ever sees plain strings (no functions cross the boundary).
 */
export interface VoiceWorkerPaths {
  readonly sttEncoder: string;
  readonly sttDecoder: string;
  readonly sttJoiner: string;
  readonly sttTokens: string;
  /** Quality (offline Moonshine) STT graphs — the two-tier re-decode. */
  readonly qualitySttPreprocessor: string;
  readonly qualitySttEncoder: string;
  readonly qualitySttUncachedDecoder: string;
  readonly qualitySttCachedDecoder: string;
  readonly qualitySttTokens: string;
  readonly vadModel: string;
  /** voiceId -> paths, for every catalog voice. */
  readonly voices: Readonly<Record<string, VoiceModelFilePaths>>;
  /** Voice used when a requested id is unknown. */
  readonly defaultVoiceId: string;
}

/** Runtime paths the {@link VoiceEngine} consumes (voice resolved via closure). */
export interface VoiceEnginePaths {
  readonly sttEncoder: string;
  readonly sttDecoder: string;
  readonly sttJoiner: string;
  readonly sttTokens: string;
  /** Quality (offline Moonshine) STT graphs — the two-tier re-decode. */
  readonly qualitySttPreprocessor: string;
  readonly qualitySttEncoder: string;
  readonly qualitySttUncachedDecoder: string;
  readonly qualitySttCachedDecoder: string;
  readonly qualitySttTokens: string;
  readonly vadModel: string;
  /** Resolve a voiceId to its sherpa vits paths (model, tokens, dataDir). */
  readonly voice: (voiceId: string | null | undefined) => VoiceModelFilePaths;
}

/** Payload the parent posts as `workerData` when spawning the engine worker. */
export interface VoiceWorkerData {
  /** Exact file URL of the engine module (.ts dev / .js prod). */
  readonly engineUrl: string;
  readonly paths: VoiceWorkerPaths;
}

export type EngineRequest =
  | { kind: 'stt:create'; reqId: number }
  | { kind: 'stt:feed'; reqId: number; sessionId: number; pcm16: Int16Array }
  | { kind: 'stt:finalize'; reqId: number; sessionId: number }
  | { kind: 'stt:close'; reqId: number; sessionId: number }
  // Two-tier QUALITY re-decode: one-shot offline decode of a whole utterance's
  // pcm16 with the cased+punctuated Moonshine model.
  | { kind: 'stt:quality'; reqId: number; pcm16: Int16Array }
  | { kind: 'tts:synth'; reqId: number; text: string; voiceId: string }
  | { kind: 'vad:create'; reqId: number }
  | { kind: 'vad:prob'; reqId: number; sessionId: number; frame: Float32Array }
  | { kind: 'vad:close'; reqId: number; sessionId: number }
  | { kind: 'shutdown'; reqId: number };

type EngineRequestKind = EngineRequest['kind'];

/** Result payloads keyed by request kind (the resolved value of each call). */
export interface EngineResultMap {
  'stt:create': { sessionId: number };
  'stt:feed': { partial: string };
  'stt:finalize': { text: string };
  'stt:close': Record<string, never>;
  'stt:quality': { text: string };
  'tts:synth': { sampleRate: number };
  'vad:create': { sessionId: number };
  'vad:prob': { prob: number };
  'vad:close': Record<string, never>;
  shutdown: Record<string, never>;
}

export type EngineResponse =
  | { kind: 'ready' }
  | { kind: 'result'; reqId: number; result: EngineResultMap[EngineRequestKind] }
  | { kind: 'error'; reqId: number; message: string }
  | {
      kind: 'tts:chunk';
      reqId: number;
      seq: number;
      sampleRate: number;
      pcm16: Int16Array;
    };
