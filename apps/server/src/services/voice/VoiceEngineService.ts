/**
 * VoiceEngineService — main-thread façade over the sherpa/onnx worker.
 *
 * Owns exactly one {@link voiceEngineWorker} (spawned lazily), correlates each
 * request to its response by `reqId`, and exposes an ergonomic promise-based API:
 * streaming STT sessions (feed pcm16 -> partials, finalize -> text), TTS
 * synthesis (text + voiceId -> ordered pcm16 chunks + sample rate), and per-frame
 * silero VAD probability. All heavy inference happens off the event loop in the
 * worker; this class never touches a native addon, so it (and its tests) load
 * without audio hardware or the sherpa binary.
 *
 * The worker is injectable ({@link VoiceEngineServiceOptions.workerFactory}) so
 * the queue/correlation/lifecycle logic is unit-tested against a fake worker.
 */

import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Worker } from 'node:worker_threads';
import { logger } from '@server/config/logger';
import { isLocalModelEnabled } from '@server/services/localModels/localModelPreferences';
import {
  DEFAULT_VOICE_ID,
  qualitySttModelPaths,
  sttModelPaths,
  vadModelPath,
  voiceModelPaths,
  VOICE_IDS,
} from './voiceModelManifest';
import type {
  EngineRequest,
  EngineResponse,
  EngineResultMap,
  VoiceWorkerData,
  VoiceWorkerPaths,
} from './voiceEngineProtocol';

/** Distributive `Omit` — the request shape callers pass (reqId added internally). */
type WithoutReqId<T> = T extends unknown ? Omit<T, 'reqId'> : never;
type EngineRequestInput = WithoutReqId<EngineRequest>;

/** ~0.5s of silence to prime the Moonshine graphs on warmup. */
const STT_WARMUP_SAMPLES = 8000;

async function assertLocalVoiceModelEnabled(modelId: string): Promise<void> {
  if (!(await isLocalModelEnabled(modelId))) {
    throw new Error(`Local voice model is disabled: ${modelId}`);
  }
}

/** Ordered pcm16 output chunk from a synthesis. */
export interface TtsChunk {
  readonly seq: number;
  readonly sampleRate: number;
  readonly pcm16: Int16Array;
}

/** A live streaming STT session. */
export interface SttSession {
  readonly id: number;
  /** Feed a pcm16 chunk (16 kHz mono); resolves with the running partial. */
  feed(pcm16: Int16Array): Promise<string>;
  /** End the utterance; resolves with the final transcript. */
  finalize(): Promise<string>;
  /** Discard the session without finalizing (barge-in / abort). */
  close(): Promise<void>;
}

/** The subset of `worker_threads.Worker` this service depends on. */
export interface WorkerLike {
  postMessage(value: unknown): void;
  on(event: 'message', listener: (msg: EngineResponse) => void): void;
  on(event: 'error', listener: (err: Error) => void): void;
  on(event: 'exit', listener: (code: number) => void): void;
  terminate(): Promise<number> | void;
}

export interface VoiceEngineServiceOptions {
  /** Inject a fake worker (tests). Defaults to spawning the real worker. */
  workerFactory?: () => WorkerLike;
}

interface Pending {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  onChunk?: (chunk: TtsChunk) => void;
}

export class VoiceEngineService {
  private worker: WorkerLike | null = null;
  private ready: Promise<void> | null = null;
  private readonly pending = new Map<number, Pending>();
  private nextReqId = 1;
  private defaultVadSession: number | null = null;
  private readonly workerFactory: () => WorkerLike;

  private static singleton: VoiceEngineService | null = null;

  constructor(options: VoiceEngineServiceOptions = {}) {
    this.workerFactory = options.workerFactory ?? (() => this.spawnWorker());
  }

  /** Process-wide singleton (real worker). */
  static instance(): VoiceEngineService {
    if (!VoiceEngineService.singleton) VoiceEngineService.singleton = new VoiceEngineService();
    return VoiceEngineService.singleton;
  }

  // Public API

  async createSttSession(): Promise<SttSession> {
    await assertLocalVoiceModelEnabled('stt-streaming');
    const { sessionId } = await this.send({ kind: 'stt:create' });
    return {
      id: sessionId,
      feed: async (pcm16: Int16Array) =>
        (await this.send({ kind: 'stt:feed', sessionId, pcm16 })).partial,
      finalize: async () => (await this.send({ kind: 'stt:finalize', sessionId })).text,
      close: async () => {
        await this.send({ kind: 'stt:close', sessionId });
      },
    };
  }

  /**
   * QUALITY re-decode of a whole utterance's pcm16 with the offline Moonshine
   * model — cased + punctuated. This is the dispatched final in two-tier STT;
   * the streaming zipformer still drives live partials. Resolves with the text
   * (may be empty for silence); rejects if the model is missing/fails to load —
   * callers fall back to the (normalized) streaming final.
   */
  async qualityDecode(pcm16: Int16Array): Promise<string> {
    await assertLocalVoiceModelEnabled('stt-quality');
    return (await this.send({ kind: 'stt:quality', pcm16 })).text;
  }

  /**
   * Synthesize `text` in `voiceId`, delivering ordered pcm16 chunks to
   * `onChunk` as they are produced. Resolves with the audio sample rate once
   * the whole utterance has been emitted.
   */
  async synthesize(
    text: string,
    voiceId: string = DEFAULT_VOICE_ID,
    onChunk?: (chunk: TtsChunk) => void
  ): Promise<{ sampleRate: number }> {
    if (!voiceId.startsWith('apple:')) {
      await assertLocalVoiceModelEnabled('tts-espeak');
      await assertLocalVoiceModelEnabled(`tts:${voiceId}`);
    }
    return this.send({ kind: 'tts:synth', text, voiceId }, onChunk);
  }

  /** Create an isolated VAD stream (its own silero recurrent state + context). */
  async createVadSession(): Promise<number> {
    await assertLocalVoiceModelEnabled('vad');
    return (await this.send({ kind: 'vad:create' })).sessionId;
  }

  async closeVadSession(sessionId: number): Promise<void> {
    await this.send({ kind: 'vad:close', sessionId });
  }

  /**
   * Speech probability in [0, 1] for one 512-sample frame. With no `sessionId`
   * a lazily-created default session is used (rolling server-side safety VAD).
   */
  async vadProbability(frame: Float32Array, sessionId?: number): Promise<number> {
    let sid = sessionId;
    if (sid === undefined) {
      if (this.defaultVadSession === null) this.defaultVadSession = await this.createVadSession();
      sid = this.defaultVadSession;
    }
    return (await this.send({ kind: 'vad:prob', sessionId: sid, frame })).prob;
  }

  /**
   * Pre-load models so the first real request pays no cold-start cost: all of
   * them, or only the parts `needs` names.
   */
  async warmup(
    voiceId: string = DEFAULT_VOICE_ID,
    { stt = true, tts = true, vad = true }: { stt?: boolean; tts?: boolean; vad?: boolean } = {}
  ): Promise<void> {
    if (stt) {
      const session = await this.createSttSession();
      await session.close();
    }
    if (tts) await this.synthesize('.', voiceId);
    if (vad) await this.vadProbability(new Float32Array(512));
    if (!stt) return;
    // Warm the Moonshine quality recognizer too (its cold construction is ~700ms).
    // Best-effort: a missing/broken quality model must not fail warmup — the
    // pipeline degrades to the normalized streaming final, so voice still works.
    await this.qualityDecode(new Int16Array(STT_WARMUP_SAMPLES)).catch((err) => {
      logger.warn(`[VoiceEngineService] quality-STT warmup skipped: ${err?.message ?? err}`);
    });
  }

  /** Terminate the worker and reject anything still in flight. */
  async shutdown(): Promise<void> {
    if (!this.worker) return;
    try {
      await this.send({ kind: 'shutdown' });
    } catch {
      // worker may already be gone — fall through to terminate
    }
    const w = this.worker;
    this.teardown(new Error('voice engine shut down'));
    await w.terminate();
  }

  // Internals

  private send<R extends EngineRequestInput>(
    req: R,
    onChunk?: (chunk: TtsChunk) => void
  ): Promise<EngineResultMap[R['kind']]> {
    return this.ensureReady().then(
      () =>
        new Promise<EngineResultMap[R['kind']]>((resolve, reject) => {
          // The worker can be torn down (error/exit) between ensureReady and
          // here — reject cleanly instead of dereferencing a null worker.
          if (!this.worker) {
            reject(new Error('voice engine worker is not available'));
            return;
          }
          const reqId = this.nextReqId++;
          this.pending.set(reqId, {
            resolve: resolve as (value: unknown) => void,
            reject,
            onChunk,
          });
          this.worker.postMessage({ ...req, reqId } as EngineRequest);
        })
    );
  }

  private ensureReady(): Promise<void> {
    if (this.ready) return this.ready;
    const worker = this.workerFactory();
    this.worker = worker;
    this.ready = new Promise<void>((resolve, reject) => {
      worker.on('message', (msg) => this.onMessage(msg, resolve));
      worker.on('error', (err) => {
        logger.error('[VoiceEngineService] worker error', { error: err.message });
        this.teardown(err);
        reject(err);
      });
      worker.on('exit', (code) => {
        if (code !== 0) {
          this.teardown(new Error(`voice engine worker exited (code ${code})`));
        }
      });
    });
    return this.ready;
  }

  private onMessage(msg: EngineResponse, markReady: () => void): void {
    switch (msg.kind) {
      case 'ready':
        markReady();
        return;
      case 'tts:chunk': {
        const p = this.pending.get(msg.reqId);
        p?.onChunk?.({ seq: msg.seq, sampleRate: msg.sampleRate, pcm16: msg.pcm16 });
        return;
      }
      case 'result': {
        const p = this.pending.get(msg.reqId);
        this.pending.delete(msg.reqId);
        p?.resolve(msg.result);
        return;
      }
      case 'error': {
        const p = this.pending.get(msg.reqId);
        this.pending.delete(msg.reqId);
        p?.reject(new Error(msg.message));
        return;
      }
    }
  }

  private teardown(err: Error): void {
    for (const [, p] of this.pending) p.reject(err);
    this.pending.clear();
    this.worker = null;
    this.ready = null;
    this.defaultVadSession = null;
  }

  private spawnWorker(): WorkerLike {
    // Resolve the worker + engine next to this module (.ts under tsx/dev/tests,
    // .js under compiled prod) and launch with the matching loader —
    // the sibling worker-entry pattern. The engine is dynamic-imported by the worker
    // from an exact URL (relative worker imports don't resolve; see the worker).
    const here = fileURLToPath(import.meta.url);
    const isTs = here.endsWith('.ts');
    const ext = isTs ? 'ts' : 'js';
    const dir = dirname(here);
    const workerFile = join(dir, `voiceEngineWorker.${ext}`);
    const engineUrl = pathToFileURL(join(dir, `voiceEngine.${ext}`)).href;
    const execArgv = isTs ? ['--import', 'tsx'] : [];
    const workerData: VoiceWorkerData = { engineUrl, paths: buildWorkerPaths() };
    return new Worker(workerFile, { execArgv, workerData }) as unknown as WorkerLike;
  }
}

/** Resolve every model path from the manifest into the worker's cloneable form. */
function buildWorkerPaths(): VoiceWorkerPaths {
  const stt = sttModelPaths();
  const quality = qualitySttModelPaths();
  const voices: Record<string, { model: string; tokens: string; dataDir: string }> = {};
  for (const id of VOICE_IDS) voices[id] = voiceModelPaths(id);
  return {
    sttEncoder: stt.encoder,
    sttDecoder: stt.decoder,
    sttJoiner: stt.joiner,
    sttTokens: stt.tokens,
    qualitySttPreprocessor: quality.preprocessor,
    qualitySttEncoder: quality.encoder,
    qualitySttUncachedDecoder: quality.uncachedDecoder,
    qualitySttCachedDecoder: quality.cachedDecoder,
    qualitySttTokens: quality.tokens,
    vadModel: vadModelPath(),
    voices,
    defaultVoiceId: DEFAULT_VOICE_ID,
  };
}
