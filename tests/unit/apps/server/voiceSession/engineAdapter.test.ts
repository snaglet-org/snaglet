/**
 * engineAdapter.buildAdapter — the engine→session binding. Driven against a real
 * VoiceEngineService backed by a fake worker (no native addon), proving the
 * shape adaptation: async feed → onPartial callback, promise+callback synth →
 * async-iterable, and the VAD session bridge.
 */

import { describe, expect, it, jest } from '@jest/globals';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { VoiceEngineService, type WorkerLike } from '@server/services/voice/VoiceEngineService';
import type { EngineRequest, EngineResponse } from '@server/services/voice/voiceEngineProtocol';
import { AppleSttEngine } from '@server/services/voice/appleSttEngine';
import {
  buildAdapter,
  buildCompositeAdapter,
} from '@server/services/SocketService/voiceSession/engineAdapter';

jest.mock('@server/config/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const FAKE_SIDECAR = join(process.cwd(), 'tests', 'support', 'fake-apple-stt.mjs');

type Responder = (req: EngineRequest, emit: (msg: EngineResponse) => void) => void;

class FakeWorker implements WorkerLike {
  private messageCb: ((msg: EngineResponse) => void) | null = null;
  constructor(private readonly responder: Responder) {
    queueMicrotask(() => this.messageCb?.({ kind: 'ready' }));
  }
  postMessage(value: unknown): void {
    const req = value as EngineRequest;
    queueMicrotask(() => this.responder(req, (msg) => this.messageCb?.(msg)));
  }
  on(event: 'message' | 'error' | 'exit', listener: (arg: never) => void): void {
    if (event === 'message') this.messageCb = listener as (m: EngineResponse) => void;
  }
  terminate(): Promise<number> {
    return Promise.resolve(0);
  }
}

const responder: Responder = (req, emit) => {
  switch (req.kind) {
    case 'stt:create':
    case 'vad:create':
      emit({ kind: 'result', reqId: req.reqId, result: { sessionId: 7 } });
      return;
    case 'stt:feed':
      emit({ kind: 'result', reqId: req.reqId, result: { partial: 'hello world' } });
      return;
    case 'stt:finalize':
      emit({ kind: 'result', reqId: req.reqId, result: { text: '  hello world.  ' } });
      return;
    case 'vad:prob':
      emit({ kind: 'result', reqId: req.reqId, result: { prob: 0.91 } });
      return;
    case 'tts:synth':
      for (let seq = 0; seq < 3; seq++) {
        emit({
          kind: 'tts:chunk',
          reqId: req.reqId,
          seq,
          sampleRate: 22050,
          pcm16: Int16Array.from([seq]),
        });
      }
      emit({ kind: 'result', reqId: req.reqId, result: { sampleRate: 22050 } });
      return;
    default:
      emit({ kind: 'result', reqId: req.reqId, result: {} });
  }
};

function makeAdapter() {
  const svc = new VoiceEngineService({ workerFactory: () => new FakeWorker(responder) });
  return buildAdapter(svc);
}

describe('buildAdapter — STT', () => {
  it('bridges async feed → onPartial callback and finalize → trimmed text', async () => {
    const engine = makeAdapter();
    const stt = engine.createSttSession();
    const partials: string[] = [];
    stt.onPartial((t) => partials.push(t));

    stt.feed(Int16Array.from([1, 2, 3, 4]));
    // feed() is fire-and-forget; finalize() drains the serialized feed queue
    // (session creation, the local-model gate, the worker round trip and the
    // partial callback) before decoding, so awaiting it is the completion
    // signal — no tick counting.
    const text = await stt.finalize();
    expect(partials).toEqual(['hello world']);
    expect(text).toBe('hello world.'); // trimmed
  });

  it('does not re-emit an unchanged partial', async () => {
    const engine = makeAdapter();
    const stt = engine.createSttSession();
    const partials: string[] = [];
    stt.onPartial((t) => partials.push(t));
    stt.feed(Int16Array.from([1]));
    stt.feed(Int16Array.from([2]));
    await stt.finalize(); // drains both queued feeds deterministically
    expect(partials).toEqual(['hello world']); // second identical partial suppressed
  });
});

describe('buildAdapter — TTS', () => {
  it('adapts the callback synth into an ordered async iterable', async () => {
    const engine = makeAdapter();
    const seqs: number[] = [];
    let sampleRate = 0;
    for await (const chunk of engine.synthesize('hi', 'en_US-amy-medium')) {
      seqs.push(chunk.pcm16[0]!);
      sampleRate = chunk.sampleRate;
    }
    expect(seqs).toEqual([0, 1, 2]);
    expect(sampleRate).toBe(22050);
  });

  it('listVoices returns the bundled piper catalog (bare ids, standard tier)', async () => {
    const engine = makeAdapter();
    const voices = await engine.listVoices!();
    expect(voices.length).toBeGreaterThan(0);
    expect(voices.every((v) => v.engine === 'piper')).toBe(true);
    expect(voices.every((v) => v.quality === 'standard')).toBe(true);
    const amy = voices.find((v) => v.id === 'en_US-amy-medium');
    expect(amy).toBeDefined();
    expect(amy!.lang).toBe('en-US'); // derived from the piper id
    // Back-compat: piper ids stay bare (no `piper:` prefix) so stored values match.
    expect(voices.some((v) => v.id.startsWith('piper:'))).toBe(false);
  });
});

describe('buildAdapter — VAD + warmup', () => {
  it('opens a VAD session and returns per-frame probabilities', async () => {
    const engine = makeAdapter();
    const vad = await engine.createVadSession!();
    expect(await vad.process(new Float32Array(512))).toBe(0.91);
    await vad.close();
  });

  it('warmup resolves', async () => {
    const engine = makeAdapter();
    await expect(engine.warmup!()).resolves.toBeUndefined();
  });

  it('identifies as local STT (needs the local models, VAD included)', () => {
    expect(makeAdapter().sttEngine).toBe('local');
  });
});

describe('buildCompositeAdapter — Apple STT + local TTS/VAD', () => {
  function makeComposite() {
    const svc = new VoiceEngineService({ workerFactory: () => new FakeWorker(responder) });
    const apple = new AppleSttEngine({
      command: process.execPath,
      prefixArgs: [FAKE_SIDECAR, '--final', 'apple cased final'],
      spawn,
      restartBackoffMs: 0,
      finalizeTimeoutMs: 2_000,
    });
    return { engine: buildCompositeAdapter(svc, apple), apple, svc };
  }

  it('routes STT to the Apple sidecar (native-rate, cased final) and drops the quality tier', async () => {
    const { engine, apple } = makeComposite();
    expect(engine.sttTier).toBe('quality');
    // Apple's final is the quality result — no offline re-decode tier is exposed.
    expect(engine.qualityDecode).toBeUndefined();

    const stt = engine.createSttSession({ sampleRate: 48_000 });
    expect(stt.wantsNativeRate).toBe(true);
    const partials: string[] = [];
    stt.onPartial((t) => partials.push(t));
    stt.feed(Int16Array.from([1, 2, 3, 4]));
    // finalize drains the fed frames first, so by the time it resolves the
    // sidecar has emitted this utterance's partial(s) too — no timing race.
    const final = await stt.finalize();
    expect(final).toBe('apple cased final');
    expect(partials.length).toBeGreaterThanOrEqual(1);
    await apple.shutdown();
  });

  it('keeps TTS + VAD on the local engine', async () => {
    const { engine, apple } = makeComposite();
    const seqs: number[] = [];
    for await (const chunk of engine.synthesize('hi', 'en_US-amy-medium')) {
      seqs.push(chunk.pcm16[0]!);
    }
    expect(seqs).toEqual([0, 1, 2]);
    const vad = await engine.createVadSession!();
    expect(await vad.process(new Float32Array(512))).toBe(0.91);
    await vad.close();
    await apple.shutdown();
  });

  it('warmup warms the Apple sidecar + local TTS/VAD together', async () => {
    const { engine, apple } = makeComposite();
    await expect(engine.warmup!()).resolves.toBeUndefined();
    await apple.shutdown();
  });

  it('identifies as Apple STT and probes Apple speech with the sidecar warmup', async () => {
    const { engine, apple } = makeComposite();
    expect(engine.sttEngine).toBe('apple');
    await expect(engine.prepareStt!()).resolves.toBeUndefined();
    await apple.shutdown();
  });

  it("prepareStt rejects with the sidecar's plain-language reason", async () => {
    const svc = new VoiceEngineService({ workerFactory: () => new FakeWorker(responder) });
    const apple = new AppleSttEngine({
      command: process.execPath,
      prefixArgs: [FAKE_SIDECAR, '--fail-code', 'assets'],
      spawn,
    });
    const engine = buildCompositeAdapter(svc, apple);
    await expect(engine.prepareStt!()).rejects.toThrow(
      "macOS couldn't set up its on-device speech model (fake failure)."
    );
  });

  it('warmup loads only the parts a session needs', async () => {
    const { engine, apple, svc } = makeComposite();
    const synth = jest.spyOn(svc, 'synthesize');
    const vad = jest.spyOn(svc, 'vadProbability');
    await engine.warmup!(undefined, { stt: true, tts: false, vad: false });
    expect(synth).not.toHaveBeenCalled();
    expect(vad).not.toHaveBeenCalled();
    await apple.shutdown();
  });
});
