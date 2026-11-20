/**
 * voiceEngineWorker — worker-thread bootstrap that hosts the single {@link
 * VoiceEngine}. All native model handles (sherpa STT/TTS + silero VAD) live
 * here so no audio inference runs on the main server event loop. The engine
 * stays beside this entry so the bundled worker can load it from the same
 * output directory.
 *
 * Worker module-resolution rules: a worker thread loaded
 * from a `.ts` file runs under strip-types resolution where static *relative*
 * runtime imports and TS-only syntax (parameter properties, enums) do not
 * resolve/transpile. So this file imports only node builtins, uses type-only
 * relative imports (erased), and pulls the engine in via a dynamic import of the
 * exact URL the parent computed (`.ts` dev / `.js` prod). Model paths arrive as
 * plain data through `workerData` — no functions cross the boundary.
 */

import { parentPort, workerData } from 'node:worker_threads';
import type { VoiceEngine } from './voiceEngine';
import type {
  EngineRequest,
  EngineResponse,
  VoiceEnginePaths,
  VoiceWorkerData,
} from './voiceEngineProtocol';

// Inlined equivalent of @snaglet/shared/utils' getErrorMessage. This worker runs
// under native type-strip resolution (see the header), so it must import only
// node builtins — pulling in the shared barrel chains to extensionless relative
// re-exports that can't resolve here.
function errMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  return 'An unexpected error occurred';
}

async function main(): Promise<void> {
  const port = parentPort;
  if (!port) throw new Error('voiceEngineWorker must run as a worker thread');
  const { engineUrl, paths } = workerData as VoiceWorkerData;

  // Exact-URL dynamic import — the only relative-module form that resolves here.
  const mod = (await import(engineUrl)) as typeof import('./voiceEngine');

  const enginePaths: VoiceEnginePaths = {
    sttEncoder: paths.sttEncoder,
    sttDecoder: paths.sttDecoder,
    sttJoiner: paths.sttJoiner,
    sttTokens: paths.sttTokens,
    qualitySttPreprocessor: paths.qualitySttPreprocessor,
    qualitySttEncoder: paths.qualitySttEncoder,
    qualitySttUncachedDecoder: paths.qualitySttUncachedDecoder,
    qualitySttCachedDecoder: paths.qualitySttCachedDecoder,
    qualitySttTokens: paths.qualitySttTokens,
    vadModel: paths.vadModel,
    voice: (voiceId) => paths.voices[voiceId ?? ''] ?? paths.voices[paths.defaultVoiceId],
  };
  const engine: VoiceEngine = new mod.VoiceEngine(enginePaths);
  const post = (msg: EngineResponse): void => port.postMessage(msg);

  async function handle(req: EngineRequest): Promise<void> {
    switch (req.kind) {
      case 'stt:create':
        post({
          kind: 'result',
          reqId: req.reqId,
          result: { sessionId: engine.createSttSession() },
        });
        return;
      case 'stt:feed':
        post({
          kind: 'result',
          reqId: req.reqId,
          result: { partial: engine.feedStt(req.sessionId, req.pcm16) },
        });
        return;
      case 'stt:finalize':
        post({
          kind: 'result',
          reqId: req.reqId,
          result: { text: engine.finalizeStt(req.sessionId) },
        });
        return;
      case 'stt:close':
        engine.closeSttSession(req.sessionId);
        post({ kind: 'result', reqId: req.reqId, result: {} });
        return;
      case 'stt:quality':
        post({
          kind: 'result',
          reqId: req.reqId,
          result: { text: engine.qualityDecode(req.pcm16) },
        });
        return;
      case 'tts:synth': {
        const { sampleRate } = engine.synthesize(req.text, req.voiceId, (chunk) => {
          post({
            kind: 'tts:chunk',
            reqId: req.reqId,
            seq: chunk.seq,
            sampleRate: chunk.sampleRate,
            pcm16: chunk.pcm16,
          });
        });
        post({ kind: 'result', reqId: req.reqId, result: { sampleRate } });
        return;
      }
      case 'vad:create':
        post({
          kind: 'result',
          reqId: req.reqId,
          result: { sessionId: engine.createVadSession() },
        });
        return;
      case 'vad:prob':
        post({
          kind: 'result',
          reqId: req.reqId,
          result: { prob: await engine.vadProbability(req.sessionId, req.frame) },
        });
        return;
      case 'vad:close':
        engine.closeVadSession(req.sessionId);
        post({ kind: 'result', reqId: req.reqId, result: {} });
        return;
      case 'shutdown':
        await engine.shutdown();
        post({ kind: 'result', reqId: req.reqId, result: {} });
        return;
    }
  }

  port.on('message', (req: EngineRequest) => {
    void handle(req).catch((err) => {
      post({ kind: 'error', reqId: req.reqId, message: errMessage(err) });
    });
  });

  post({ kind: 'ready' });
}

void main().catch((err) => {
  parentPort?.postMessage({ kind: 'error', reqId: -1, message: errMessage(err) } as EngineResponse);
});
