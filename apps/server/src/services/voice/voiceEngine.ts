/**
 * voiceEngine — the native voice engine, hosted inside a worker thread (never
 * the main server thread). Wraps sherpa-onnx (streaming STT + offline piper
 * TTS) and the silero v5 VAD (via onnxruntime-node) behind a small, synchronous-
 * where-possible API. Models load lazily on first use and STT/VAD sessions +
 * per-voice TTS engines are cached.
 *
 * This module imports the native addons directly, so it is only ever loaded
 * inside the worker (or the tsx smoke script) — jest stubs both `sherpa-onnx-
 * node` and `onnxruntime-node` via moduleNameMapper, and the engine unit tests
 * drive {@link VoiceEngineService} through a fake worker instead of loading this.
 *
 * sherpa-onnx-node's named ESM exports are unreliable under the CJS interop
 * (e.g. `OfflineTts` comes back undefined via `import * as`), so we default-
 * import the package object and destructure. onnxruntime-node exposes a stable
 * namespace, matching the embedder.
 */

import { existsSync } from 'node:fs';
import sherpaPkg from 'sherpa-onnx-node';
import * as ort from 'onnxruntime-node';
import type { VoiceEnginePaths } from './voiceEngineProtocol';

// Constants are defined locally (not imported) because this module is loaded
// inside a worker thread via a dynamic exact-URL import, where static relative
// runtime imports do not resolve — only npm/builtin + type-only imports do.
// They mirror the exported values in `voiceEngineProtocol` (kept in sync there).
const STT_SAMPLE_RATE = 16000;
const TTS_CHUNK_MS = 200;
const VAD_FRAME_SAMPLES = 512;
const VAD_CONTEXT_SAMPLES = 64;

// sherpa's constructors, pulled off the default export (named ESM exports are
// unreliable under CJS interop — see the header note).
const { OnlineRecognizer, OfflineRecognizer, OfflineTts } = sherpaPkg;
type SherpaOnlineRecognizer = InstanceType<typeof OnlineRecognizer>;
type SherpaOnlineStream = ReturnType<SherpaOnlineRecognizer['createStream']>;
type SherpaOfflineRecognizer = InstanceType<typeof OfflineRecognizer>;
type SherpaOfflineTts = InstanceType<typeof OfflineTts>;

/**
 * sherpa only says "Please check your config!" when a model file is missing,
 * so check the files first and name what isn't installed and where to get it.
 */
function requireModelFiles(what: string, files: readonly string[]): void {
  if (files.every((f) => existsSync(f))) return;
  throw new Error(
    `The ${what} isn't installed. Download it from Settings → Local storage → Download voice models.`
  );
}

/** pcm16 -> float32 in [-1, 1]. */
function i16ToF32(pcm: Int16Array): Float32Array {
  const out = new Float32Array(pcm.length);
  for (let i = 0; i < pcm.length; i++) out[i] = pcm[i] / 32768;
  return out;
}

/** float32 in [-1, 1] -> pcm16 (clamped). */
function f32ToI16(samples: Float32Array): Int16Array {
  const out = new Int16Array(samples.length);
  for (let i = 0; i < samples.length; i++) {
    const v = Math.max(-1, Math.min(1, samples[i]));
    out[i] = v < 0 ? Math.round(v * 32768) : Math.round(v * 32767);
  }
  return out;
}

interface VadSessionState {
  /** silero recurrent state, [2, 1, 128]. */
  state: Float32Array;
  /** Left-context carried between frames (64 samples). */
  context: Float32Array;
}

export interface TtsChunkSink {
  (chunk: { seq: number; sampleRate: number; pcm16: Int16Array }): void;
}

export class VoiceEngine {
  private recognizer: SherpaOnlineRecognizer | null = null;
  private qualityRecognizer: SherpaOfflineRecognizer | null = null;
  private readonly sttStreams = new Map<number, SherpaOnlineStream>();
  private readonly ttsByVoice = new Map<string, SherpaOfflineTts>();
  private vadSession: ort.InferenceSession | null = null;
  private readonly vadStates = new Map<number, VadSessionState>();
  private nextSessionId = 1;
  // Not a parameter property: worker-thread strip-types mode rejects those.
  private readonly paths: VoiceEnginePaths;

  constructor(paths: VoiceEnginePaths) {
    this.paths = paths;
  }

  // STT — streaming zipformer transducer

  private ensureRecognizer(): SherpaOnlineRecognizer {
    if (!this.recognizer) {
      requireModelFiles('speech-to-text model', [
        this.paths.sttEncoder,
        this.paths.sttDecoder,
        this.paths.sttJoiner,
        this.paths.sttTokens,
      ]);
      this.recognizer = new OnlineRecognizer({
        featConfig: { sampleRate: STT_SAMPLE_RATE, featureDim: 80 },
        modelConfig: {
          transducer: {
            encoder: this.paths.sttEncoder,
            decoder: this.paths.sttDecoder,
            joiner: this.paths.sttJoiner,
          },
          tokens: this.paths.sttTokens,
          numThreads: 1,
          provider: 'cpu',
        },
        decodingMethod: 'greedy_search',
        enableEndpoint: true,
        rule1MinTrailingSilence: 2.4,
        rule2MinTrailingSilence: 1.2,
        rule3MinUtteranceLength: 20,
      });
    }
    return this.recognizer;
  }

  createSttSession(): number {
    const rec = this.ensureRecognizer();
    const id = this.nextSessionId++;
    this.sttStreams.set(id, rec.createStream());
    return id;
  }

  /** Feed a pcm16 chunk; decode what's ready and return the running partial. */
  feedStt(sessionId: number, pcm16: Int16Array): string {
    const rec = this.ensureRecognizer();
    const stream = this.sttStreams.get(sessionId);
    if (!stream) throw new Error(`unknown STT session ${sessionId}`);
    stream.acceptWaveform({ samples: i16ToF32(pcm16), sampleRate: STT_SAMPLE_RATE });
    while (rec.isReady(stream)) rec.decode(stream);
    return rec.getResult(stream).text;
  }

  /** End the utterance: pad, flush the decoder, return the final transcript. */
  finalizeStt(sessionId: number): string {
    const rec = this.ensureRecognizer();
    const stream = this.sttStreams.get(sessionId);
    if (!stream) throw new Error(`unknown STT session ${sessionId}`);
    // Trailing silence flushes the last zipformer chunk out of the decoder.
    // The chunk-16-left-128 model needs ~0.6s of tail to commit the final word
    // (0.35s clips it, e.g. "dog" -> "do").
    stream.acceptWaveform({
      samples: new Float32Array(Math.round(STT_SAMPLE_RATE * 0.6)),
      sampleRate: STT_SAMPLE_RATE,
    });
    stream.inputFinished();
    while (rec.isReady(stream)) rec.decode(stream);
    const text = rec.getResult(stream).text;
    this.sttStreams.delete(sessionId);
    return text.trim();
  }

  closeSttSession(sessionId: number): void {
    this.sttStreams.delete(sessionId);
  }

  // Quality STT — offline Moonshine (cased + punctuated; two-tier re-decode)

  private ensureQualityRecognizer(): SherpaOfflineRecognizer {
    if (!this.qualityRecognizer) {
      requireModelFiles('punctuated speech-to-text model', [
        this.paths.qualitySttPreprocessor,
        this.paths.qualitySttEncoder,
        this.paths.qualitySttUncachedDecoder,
        this.paths.qualitySttCachedDecoder,
        this.paths.qualitySttTokens,
      ]);
      this.qualityRecognizer = new OfflineRecognizer({
        modelConfig: {
          moonshine: {
            preprocessor: this.paths.qualitySttPreprocessor,
            encoder: this.paths.qualitySttEncoder,
            uncachedDecoder: this.paths.qualitySttUncachedDecoder,
            cachedDecoder: this.paths.qualitySttCachedDecoder,
          },
          tokens: this.paths.qualitySttTokens,
          numThreads: 1,
          provider: 'cpu',
        },
      });
    }
    return this.qualityRecognizer;
  }

  /**
   * One-shot offline decode of a whole utterance's pcm16 with Moonshine —
   * returns cased + punctuated text (the dispatched final in two-tier STT). The
   * offline recognizer takes the entire waveform at once; a fresh stream is used
   * per call so decodes never share state.
   */
  qualityDecode(pcm16: Int16Array): string {
    const rec = this.ensureQualityRecognizer();
    const stream = rec.createStream();
    stream.acceptWaveform({ samples: i16ToF32(pcm16), sampleRate: STT_SAMPLE_RATE });
    rec.decode(stream);
    return rec.getResult(stream).text.trim();
  }

  // TTS — offline piper vits (whole-wav output, chunked to ~200 ms frames)

  private ensureTts(voiceId: string): SherpaOfflineTts {
    let tts = this.ttsByVoice.get(voiceId);
    if (!tts) {
      const v = this.paths.voice(voiceId);
      requireModelFiles(`${voiceId} voice`, [v.model, v.tokens, v.dataDir]);
      tts = new OfflineTts({
        model: {
          vits: { model: v.model, tokens: v.tokens, dataDir: v.dataDir },
          numThreads: 1,
          provider: 'cpu',
        },
        maxNumSentences: 1,
      });
      this.ttsByVoice.set(voiceId, tts);
    }
    return tts;
  }

  /**
   * Synthesize `text` in `voiceId`, emitting ~200 ms pcm16 chunks to `sink` in
   * order. Returns the sample rate (piper voices are 22.05 kHz). sherpa returns
   * the whole waveform, so we slice it into frames the playback queue drains.
   */
  synthesize(text: string, voiceId: string, sink: TtsChunkSink): { sampleRate: number } {
    const tts = this.ensureTts(voiceId);
    const audio = tts.generate({ text, sid: 0, speed: 1.0 });
    const sampleRate = audio.sampleRate;
    const pcm16 = f32ToI16(audio.samples);
    const frame = Math.max(1, Math.round((sampleRate * TTS_CHUNK_MS) / 1000));
    let seq = 0;
    for (let i = 0; i < pcm16.length; i += frame) {
      sink({ seq: seq++, sampleRate, pcm16: pcm16.slice(i, i + frame) });
    }
    return { sampleRate };
  }

  // VAD — silero v5 (server-side safety net; primary VAD is client-side)

  private async ensureVadSession(): Promise<ort.InferenceSession> {
    if (!this.vadSession) {
      requireModelFiles('voice detection model', [this.paths.vadModel]);
      this.vadSession = await ort.InferenceSession.create(this.paths.vadModel);
    }
    return this.vadSession;
  }

  createVadSession(): number {
    const id = this.nextSessionId++;
    this.vadStates.set(id, {
      state: new Float32Array(2 * 1 * 128),
      context: new Float32Array(VAD_CONTEXT_SAMPLES),
    });
    return id;
  }

  /**
   * Speech probability in [0, 1] for one 512-sample frame. silero v5 needs the
   * previous frame's trailing 64 samples prepended (input [1, 576]) or it
   * silently returns ~0 — the context buffer is carried per session here.
   */
  async vadProbability(sessionId: number, frame: Float32Array): Promise<number> {
    const session = await this.ensureVadSession();
    const st = this.vadStates.get(sessionId);
    if (!st) throw new Error(`unknown VAD session ${sessionId}`);

    const window = new Float32Array(VAD_FRAME_SAMPLES);
    window.set(frame.subarray(0, VAD_FRAME_SAMPLES));

    const input = new Float32Array(VAD_CONTEXT_SAMPLES + VAD_FRAME_SAMPLES);
    input.set(st.context, 0);
    input.set(window, VAD_CONTEXT_SAMPLES);

    const feeds = {
      input: new ort.Tensor('float32', input, [1, VAD_CONTEXT_SAMPLES + VAD_FRAME_SAMPLES]),
      state: new ort.Tensor('float32', st.state, [2, 1, 128]),
      sr: new ort.Tensor('int64', BigInt64Array.from([BigInt(STT_SAMPLE_RATE)]), []),
    };
    const out = await session.run(feeds);
    st.state = out.stateN.data as Float32Array;
    st.context = window.slice(VAD_FRAME_SAMPLES - VAD_CONTEXT_SAMPLES);
    return Number((out.output.data as Float32Array)[0]);
  }

  closeVadSession(sessionId: number): void {
    this.vadStates.delete(sessionId);
  }

  async shutdown(): Promise<void> {
    this.sttStreams.clear();
    this.ttsByVoice.clear();
    this.vadStates.clear();
    this.recognizer = null;
    this.qualityRecognizer = null;
    if (this.vadSession) {
      const s = this.vadSession as { release?: () => Promise<void> };
      if (typeof s.release === 'function') await s.release();
      this.vadSession = null;
    }
  }
}
