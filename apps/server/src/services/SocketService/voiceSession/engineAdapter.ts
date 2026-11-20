/**
 * engineAdapter — the single integration point between the voice session layer
 * and the audio engine.
 *
 * `VoiceEngineService` lives under @server/services/voice. The session layer
 * never imports that module anywhere else — only here. This file adapts its
 * promise/callback surface to `VoiceEngineApi` (types.ts):
 *
 *   VoiceEngineService                      VoiceEngineApi
 *   createSttSession(): Promise<Session>    createSttSession(): SttSession
 *     session.feed(pcm16) → Promise<part.>    stt.feed(pcm16) + stt.onPartial(cb)
 *     session.finalize()  → Promise<text>     stt.finalize() → Promise<text>
 *   synthesize(text, id, onChunk) → Promise  synthesize(text, id): AsyncIterable
 *   vadProbability(frame, sid)              createVadSession() → VadSession
 *   warmup(voiceId)                         warmup(voiceId)
 *
 * Pinned to the real engine: no runtime shape-probing. The engine
 * runs its native inference in a worker thread that spawns lazily on first use,
 * so importing VoiceEngineService here (main thread, jest) loads no native addon.
 * When the worker genuinely fails to init (missing models / addon), the first
 * STT/synth/warmup call rejects — VoiceSessionService surfaces that as
 * voice:error {speakable:false} (the warmup on session start is the probe).
 */

import { logger } from '@server/config/logger';
import { getErrorMessage } from '@snaglet/shared/utils';
import { VoiceEngineService } from '@server/services/voice/VoiceEngineService';
import { AppleSttEngine } from '@server/services/voice/appleSttEngine';
import { AppleTtsEngine } from '@server/services/voice/appleTtsEngine';
import { DEFAULT_VOICE_ID, VOICE_CATALOG } from '@server/services/voice/voiceModelManifest';
import {
  appleSpeechOsSupported,
  ensureAppleSttBinary,
  resolveSttEngineKind,
  appleSttBinaryPath,
} from '@server/services/voice/sttEngineResolver';
import {
  ensureAppleTtsBinary,
  resolveTtsEngineKind,
  appleTtsBinaryPath,
} from '@server/services/voice/ttsEngineResolver';
import { sweepAppleSidecarOrphans } from '@server/services/voice/appleSidecarCleanup';
import { voiceLang } from '@server/services/voice/installedVoices';
import { parseVoiceId, toAppleVoiceId } from './voiceIdNamespace';
import { speakingVoiceId } from './speakingVoice';
import type {
  SttSession,
  TtsChunk,
  VadSession,
  VoiceEngineApi,
  VoiceInfo,
  WarmupNeeds,
} from './types';

/** The bundled piper catalog as capability entries (bare ids — back-compat). */
export function piperVoiceInfos(): VoiceInfo[] {
  return VOICE_CATALOG.map((v) => ({
    id: v.id, // BARE — the router treats unprefixed ids as piper (see voiceIdNamespace)
    engine: 'piper' as const,
    name: v.label,
    quality: 'standard' as const,
    lang: voiceLang(v.id), // derived from the piper id (`en_US-amy-medium` → `en-US`)
  }));
}

/**
 * Bridge `VoiceEngineService` onto `VoiceEngineApi`. Exported so tests
 * can drive the binding against a VoiceEngineService backed by a fake worker
 * (no native addon), verifying the feed→onPartial + synth→async-iterable bridges.
 */
export function buildAdapter(service: VoiceEngineService): VoiceEngineApi {
  return {
    sttEngine: 'local',
    // The local engine always decodes at 16 kHz — the session layer band-limits
    // to it, so the capture rate hint is ignored here.
    createSttSession(_opts?: { sampleRate?: number }): SttSession {
      // The engine's create is async and its feed returns the partial; we want a
      // synchronous handle with a feed()+onPartial() subscription. Bridge by
      // resolving the session lazily and serializing feeds through `queue` so
      // the worker sees frames in order and the emitted partial is monotonic.
      const ready = service.createSttSession();
      const partialCbs: Array<(text: string) => void> = [];
      let queue: Promise<void> = Promise.resolve();
      let lastPartial = '';

      return {
        feed(pcm16: Int16Array): void {
          queue = queue
            .then(async () => {
              const session = await ready;
              const partial = await session.feed(pcm16);
              if (typeof partial === 'string' && partial && partial !== lastPartial) {
                lastPartial = partial;
                for (const cb of partialCbs) {
                  try {
                    cb(partial);
                  } catch (err) {
                    logger.warn(`[voice] STT partial listener threw: ${getErrorMessage(err)}`);
                  }
                }
              }
            })
            .catch((err) => {
              logger.warn(`[voice] STT feed failed: ${getErrorMessage(err)}`);
            });
        },
        onPartial(cb: (text: string) => void): void {
          partialCbs.push(cb);
        },
        async finalize(): Promise<string> {
          // Drain queued feeds first so the final decode sees the whole utterance.
          // eslint-disable-next-line no-restricted-syntax -- intentional: feed failures are already logged inside feed()'s own catch; this only awaits the drain
          await queue.catch(() => {});
          const session = await ready;
          return (await session.finalize()).trim();
        },
        close(): void {
          void ready
            .then((session) => session.close())
            .catch((err) => {
              logger.debug(`[voice] STT session close failed: ${getErrorMessage(err)}`);
            });
        },
      };
    },

    async qualityDecode(pcm16: Int16Array): Promise<string> {
      // The engine's qualityDecode already trims; pass through the cased+punctuated text.
      return (await service.qualityDecode(pcm16)).trim();
    },

    synthesize(text: string, voiceId: string): AsyncIterable<TtsChunk> {
      // The engine delivers chunks via an onChunk callback and resolves when done; adapt
      // to an async iterable the pipeline can `for await` over.
      return (async function* (): AsyncGenerator<TtsChunk> {
        const buffer: TtsChunk[] = [];
        let notify: (() => void) | null = null;
        let done = false;
        let failure: Error | null = null;

        const wake = (): void => {
          const n = notify;
          notify = null;
          n?.();
        };

        service
          .synthesize(text, voiceId, (chunk) => {
            buffer.push({ pcm16: chunk.pcm16, sampleRate: chunk.sampleRate });
            wake();
          })
          .then(() => {
            done = true;
            wake();
          })
          .catch((err: unknown) => {
            failure = err instanceof Error ? err : new Error(getErrorMessage(err));
            done = true;
            wake();
          });

        for (;;) {
          if (buffer.length > 0) {
            yield buffer.shift()!;
            continue;
          }
          if (failure) throw failure;
          if (done) return;
          await new Promise<void>((resolve) => {
            notify = resolve;
          });
        }
      })();
    },

    async createVadSession(): Promise<VadSession> {
      const sid = await service.createVadSession();
      return {
        process: (frame: Float32Array) => service.vadProbability(frame, sid),
        close: () => service.closeVadSession(sid),
      };
    },

    // The local engine offers exactly the bundled piper catalog. The Apple TTS
    // router (buildTtsRouter) merges installed Apple voices on top of this.
    async listVoices(): Promise<VoiceInfo[]> {
      return piperVoiceInfos();
    },

    async warmup(voiceId?: string, needs?: WarmupNeeds): Promise<void> {
      await service.warmup(await warmupVoiceId(voiceId, needs), needs);
    },
  };
}

/**
 * The voice a warmup synthesizes with: the one asked for, else the voice an
 * unconfigured agent speaks with (the default, or the first installed voice
 * when the default is not installed). Not looked up when TTS is not warmed.
 */
async function warmupVoiceId(
  voiceId: string | undefined,
  needs: WarmupNeeds | undefined
): Promise<string> {
  if (voiceId) return voiceId;
  return needs?.tts === false ? DEFAULT_VOICE_ID : speakingVoiceId(DEFAULT_VOICE_ID);
}

/**
 * Compose the APPLE STT tier onto the local engine (TTS + VAD stay local — Apple
 * replaces STT only). STT sessions come from the sidecar; there is no quality
 * re-decode tier (Apple's final is already cased + punctuated, so it IS the
 * quality result) and partials are tagged `'quality'`. Warmup pre-installs the
 * Apple on-device model AND warms the local TTS + VAD graphs (but NOT the unused
 * local STT/Moonshine models). Open-mic dictation on this engine needs no local
 * model at all: it ends utterances without the VAD (see appleDictation.ts), and
 * `prepareStt` is its start-time probe.
 */
export function buildCompositeAdapter(
  service: VoiceEngineService,
  apple: AppleSttEngine
): VoiceEngineApi {
  const local = buildAdapter(service);
  return {
    ...local,
    createSttSession(opts?: { sampleRate?: number }): SttSession {
      return apple.createSttSession(opts);
    },
    // Apple's final IS the quality result — no offline re-decode tier.
    qualityDecode: undefined,
    sttTier: 'quality',
    sttEngine: 'apple',
    // The sidecar's warmup: sets up Apple's on-device model, or rejects with
    // an AppleSttError naming the fix.
    prepareStt(): Promise<void> {
      return apple.warmup();
    },
    async shutdown(): Promise<void> {
      await apple.shutdown();
    },
    async warmup(voiceId?: string, needs?: WarmupNeeds): Promise<void> {
      const id = await warmupVoiceId(voiceId, needs);
      const { stt = true, tts = true, vad = true } = needs ?? {};
      await Promise.all([
        stt ? apple.warmup() : undefined,
        tts ? service.synthesize('.', id).then(() => undefined) : undefined,
        vad ? service.vadProbability(new Float32Array(512)).then(() => undefined) : undefined,
      ]);
    },
  };
}

/**
 * Layer the HYBRID TTS router onto a base engine (piper stays the default; Apple
 * is added, not swapped). Only `synthesize` + `listVoices` (+ `warmup`) are
 * overridden — STT/VAD and everything the barge-in/floor/pipeline code touches
 * are untouched (they never call synthesize with a namespace they don't already
 * pass through). `synthesize` dispatches by voiceId namespace:
 *   `apple:<AVid>`      → the Apple sidecar (identifier stripped)
 *   `piper:<id>` / bare → the base (piper) engine
 * so an existing bare `agents.voice` value routes to piper exactly as before.
 */
export function buildTtsRouter(base: VoiceEngineApi, appleTts: AppleTtsEngine): VoiceEngineApi {
  return {
    ...base,
    synthesize(text: string, voiceId: string): AsyncIterable<TtsChunk> {
      const { engine, nativeId } = parseVoiceId(voiceId);
      if (engine === 'apple') return appleTts.synthesize(text, nativeId);
      return base.synthesize(text, nativeId);
    },
    async listVoices(): Promise<VoiceInfo[]> {
      const piper = base.listVoices ? await base.listVoices() : piperVoiceInfos();
      const apple = await appleTts.listVoices();
      const appleInfos: VoiceInfo[] = apple.map((v) => ({
        id: toAppleVoiceId(v.identifier),
        engine: 'apple',
        name: v.name,
        quality: v.quality,
        lang: v.lang,
      }));
      return [...piper, ...appleInfos];
    },
    async shutdown(): Promise<void> {
      await Promise.all([base.shutdown?.(), appleTts.shutdown()]);
    },
    async warmup(voiceId?: string, needs?: WarmupNeeds): Promise<void> {
      // Warm the base (piper/STT/VAD) AND, when the session speaks, pre-spawn
      // the Apple daemon so the first Apple synth pays no cold-start cost.
      // Best-effort on the Apple side.
      await Promise.all([
        base.warmup?.(voiceId, needs),
        needs?.tts === false
          ? undefined
          : appleTts.warmup().catch((err) => {
              logger.warn(`[apple-tts] warmup skipped: ${getErrorMessage(err)}`);
            }),
      ]);
    },
  };
}

/** Why a Mac fell back to local STT (shown when the local models fail too). */
const APPLE_HELPER_MISSING =
  "Apple's built-in speech recognition isn't available because Snaglet's speech helper " +
  'is missing (reinstalling Snaglet restores it)';
const APPLE_SPEECH_NEEDS_MACOS_26 = "Apple's built-in speech recognition needs macOS 26 or later";

/**
 * Why a Mac uses local STT when nobody asked for it (SNAGLET_VOICE_STT_ENGINE
 * unset): its macOS predates SpeechAnalyzer, or the speech helper is missing.
 * Undefined off macOS, where local STT is the only engine.
 */
function localSttFallbackReason(input: {
  platform: string;
  forced: string | undefined;
  osSupported: boolean;
}): string | undefined {
  if (input.platform !== 'darwin' || input.forced?.trim()) return undefined;
  return input.osSupported ? APPLE_HELPER_MISSING : APPLE_SPEECH_NEEDS_MACOS_26;
}

let cached: VoiceEngineApi | null | undefined;
let warned = false;

/**
 * Resolve the audio engine, or null when it cannot be constructed. Cached after
 * the first resolution. On macOS 26 or later with the Apple sidecar
 * present-or-buildable the STT tier is the Apple engine (TTS + VAD stay local);
 * otherwise the all-local engine. Constructing the services does not spawn any
 * worker/process or load models — that happens on the first STT/synth/warmup
 * call.
 */
export async function getVoiceEngine(): Promise<VoiceEngineApi | null> {
  if (cached !== undefined) return cached;
  try {
    sweepAppleSidecarOrphans([appleSttBinaryPath(), appleTtsBinaryPath()]);
    const service = VoiceEngineService.instance();

    // 1. STT tier: Apple sidecar on macOS 26+ (present/buildable), else local ONNX.
    let engine: VoiceEngineApi;
    if (resolveSttEngineKind() === 'apple') {
      const sttBin = ensureAppleSttBinary();
      if (sttBin) {
        logger.info(`[voice] STT engine: apple (sidecar ${sttBin})`);
        engine = buildCompositeAdapter(service, new AppleSttEngine({ command: sttBin }));
      } else {
        logger.warn('[voice] apple STT selected but sidecar unavailable — using local STT');
        engine = { ...buildAdapter(service), sttFallbackReason: APPLE_HELPER_MISSING };
      }
    } else {
      engine = buildAdapter(service);
      // On a Mac, local STT is a fallback unless the user forced it.
      const reason = localSttFallbackReason({
        platform: process.platform,
        forced: process.env.SNAGLET_VOICE_STT_ENGINE,
        osSupported: appleSpeechOsSupported(),
      });
      logger.info(`[voice] STT engine: local (ONNX)${reason ? `: ${reason}` : ''}`);
      if (reason) engine = { ...engine, sttFallbackReason: reason };
    }

    // 2. TTS tier (ADDITIVE + orthogonal to STT): layer the Apple TTS router on
    //    top when available. Piper stays the default voice — an install with no
    //    Apple voices downloaded, or a non-darwin/CI host, keeps today's behavior.
    if (resolveTtsEngineKind() === 'apple') {
      const ttsBin = ensureAppleTtsBinary();
      if (ttsBin) {
        logger.info(`[voice] TTS engine: hybrid piper + apple (sidecar ${ttsBin})`);
        engine = buildTtsRouter(engine, new AppleTtsEngine({ command: ttsBin }));
      } else {
        logger.warn('[voice] apple TTS selected but sidecar unavailable — using piper only');
      }
    } else {
      logger.info('[voice] TTS engine: piper (local)');
    }

    cached = engine;
    return cached;
  } catch (err) {
    if (!warned) {
      warned = true;
      logger.warn(`[voice] engine unavailable — voice disabled: ${getErrorMessage(err)}`);
    }
    cached = null;
    return null;
  }
}

/** Stop any cached external voice sidecars during server shutdown. */
export async function shutdownVoiceEngine(): Promise<void> {
  await cached?.shutdown?.();
}

/** Test-only: inject a fake engine (or null) and reset the warn latch. */
export function __setVoiceEngineForTest(engine: VoiceEngineApi | null): void {
  cached = engine;
  warned = false;
}

/** Test-only: clear the cache so the next getVoiceEngine re-resolves. */
export function __resetVoiceEngine(): void {
  cached = undefined;
  warned = false;
}
