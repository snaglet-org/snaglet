/**
 * VoiceEngineService — request/response correlation, session ergonomics, TTS
 * chunk streaming, error propagation, and lifecycle. Driven entirely through a
 * fake worker so no native addon, audio, or worker thread is involved.
 */

import { describe, expect, it, jest } from '@jest/globals';
import { VoiceEngineService, type WorkerLike } from '@server/services/voice/VoiceEngineService';
import type { EngineRequest, EngineResponse } from '@server/services/voice/voiceEngineProtocol';

type Responder = (req: EngineRequest, emit: (msg: EngineResponse) => void) => void;

class FakeWorker implements WorkerLike {
  readonly posted: EngineRequest[] = [];
  private messageCb: ((msg: EngineResponse) => void) | null = null;
  private errorCb: ((err: Error) => void) | null = null;
  private exitCb: ((code: number) => void) | null = null;
  terminated = false;

  constructor(
    private readonly responder: Responder,
    autoReady = true
  ) {
    if (autoReady) queueMicrotask(() => this.emit({ kind: 'ready' }));
  }

  postMessage(value: unknown): void {
    const req = value as EngineRequest;
    this.posted.push(req);
    queueMicrotask(() => this.responder(req, (msg) => this.emit(msg)));
  }

  on(event: 'message' | 'error' | 'exit', listener: (arg: never) => void): void {
    if (event === 'message') this.messageCb = listener as (m: EngineResponse) => void;
    if (event === 'error') this.errorCb = listener as (e: Error) => void;
    if (event === 'exit') this.exitCb = listener as (c: number) => void;
  }

  terminate(): Promise<number> {
    this.terminated = true;
    return Promise.resolve(0);
  }

  emit(msg: EngineResponse): void {
    this.messageCb?.(msg);
  }
  fail(err: Error): void {
    this.errorCb?.(err);
  }
  exit(code: number): void {
    this.exitCb?.(code);
  }
}

/** Default fake engine: deterministic replies for every request kind. */
const defaultResponder: Responder = (req, emit) => {
  switch (req.kind) {
    case 'stt:create':
    case 'vad:create':
      emit({ kind: 'result', reqId: req.reqId, result: { sessionId: 100 + req.reqId } });
      return;
    case 'stt:feed':
      emit({ kind: 'result', reqId: req.reqId, result: { partial: `p${req.pcm16.length}` } });
      return;
    case 'stt:finalize':
      emit({ kind: 'result', reqId: req.reqId, result: { text: 'final transcript' } });
      return;
    case 'stt:quality':
      emit({
        kind: 'result',
        reqId: req.reqId,
        result: { text: `Q${req.pcm16.length}: cased and punctuated.` },
      });
      return;
    case 'vad:prob':
      emit({ kind: 'result', reqId: req.reqId, result: { prob: 0.87 } });
      return;
    case 'tts:synth': {
      for (let seq = 0; seq < 3; seq++) {
        emit({
          kind: 'tts:chunk',
          reqId: req.reqId,
          seq,
          sampleRate: 22050,
          pcm16: Int16Array.from([seq, seq, seq]),
        });
      }
      emit({ kind: 'result', reqId: req.reqId, result: { sampleRate: 22050 } });
      return;
    }
    default:
      emit({ kind: 'result', reqId: req.reqId, result: {} });
  }
};

function makeService(responder: Responder = defaultResponder): {
  svc: VoiceEngineService;
  worker: () => FakeWorker;
} {
  let created: FakeWorker | null = null;
  const svc = new VoiceEngineService({
    workerFactory: () => {
      created = new FakeWorker(responder);
      return created;
    },
  });
  return { svc, worker: () => created! };
}

describe('VoiceEngineService — STT', () => {
  it('runs a session: create -> feed -> finalize', async () => {
    const { svc, worker } = makeService();
    const stt = await svc.createSttSession();
    expect(stt.id).toBeGreaterThan(0);
    const partial = await stt.feed(Int16Array.from([1, 2, 3, 4]));
    expect(partial).toBe('p4');
    const text = await stt.finalize();
    expect(text).toBe('final transcript');
    const kinds = worker().posted.map((p) => p.kind);
    expect(kinds).toEqual(['stt:create', 'stt:feed', 'stt:finalize']);
  });

  it('re-decodes a whole utterance via the quality (Moonshine) worker op', async () => {
    const { svc, worker } = makeService();
    const pcm = Int16Array.from([1, 2, 3, 4, 5, 6]);
    const text = await svc.qualityDecode(pcm);
    expect(text).toBe('Q6: cased and punctuated.');
    const req = worker().posted.find((p) => p.kind === 'stt:quality');
    expect(req && 'pcm16' in req && req.pcm16.length).toBe(6);
  });

  it('propagates a quality-decode error (caller falls back to streaming)', async () => {
    const responder: Responder = (req, emit) => {
      if (req.kind === 'stt:quality') {
        emit({ kind: 'error', reqId: req.reqId, message: 'moonshine model missing' });
      } else {
        defaultResponder(req, emit);
      }
    };
    const { svc } = makeService(responder);
    await expect(svc.qualityDecode(Int16Array.from([1, 2]))).rejects.toThrow(
      'moonshine model missing'
    );
  });
});

describe('VoiceEngineService — TTS', () => {
  it('streams ordered chunks then resolves the sample rate', async () => {
    const { svc } = makeService();
    const chunks: number[] = [];
    const { sampleRate } = await svc.synthesize('hello', 'en_US-amy-medium', (c) => {
      chunks.push(c.seq);
    });
    expect(sampleRate).toBe(22050);
    expect(chunks).toEqual([0, 1, 2]);
  });

  it('defaults the voice id', async () => {
    const { svc, worker } = makeService();
    await svc.synthesize('hi');
    const req = worker().posted.find((p) => p.kind === 'tts:synth');
    expect(req && 'voiceId' in req && req.voiceId).toBe('en_US-amy-medium');
  });
});

describe('VoiceEngineService — VAD', () => {
  it('auto-creates a default VAD session on first vadProbability', async () => {
    const { svc, worker } = makeService();
    const prob = await svc.vadProbability(new Float32Array(512));
    expect(prob).toBe(0.87);
    const kinds = worker().posted.map((p) => p.kind);
    expect(kinds).toEqual(['vad:create', 'vad:prob']);
    // A second frame reuses the same session — no new vad:create.
    await svc.vadProbability(new Float32Array(512));
    expect(worker().posted.filter((p) => p.kind === 'vad:create')).toHaveLength(1);
  });
});

describe('VoiceEngineService — concurrency & errors', () => {
  it('resolves interleaved requests by reqId', async () => {
    // Responder answers in reverse order to prove correlation isn't positional.
    const pending: Array<() => void> = [];
    const responder: Responder = (req, emit) => {
      if (req.kind === 'vad:create') {
        emit({ kind: 'result', reqId: req.reqId, result: { sessionId: 1 } });
        return;
      }
      pending.push(() =>
        emit({ kind: 'result', reqId: req.reqId, result: { prob: req.reqId } as never })
      );
      if (pending.length === 2) {
        pending.pop()!();
        pending.pop()!();
      }
    };
    const { svc } = makeService(responder);
    const sid = await svc.createVadSession();
    const [a, b] = await Promise.all([
      svc.vadProbability(new Float32Array(512), sid),
      svc.vadProbability(new Float32Array(512), sid),
    ]);
    expect(a).not.toBe(b);
  });

  it('rejects the specific call on a worker error message', async () => {
    const responder: Responder = (req, emit) => {
      if (req.kind === 'tts:synth') {
        emit({ kind: 'error', reqId: req.reqId, message: 'voice not found' });
      } else {
        defaultResponder(req, emit);
      }
    };
    const { svc } = makeService(responder);
    await expect(svc.synthesize('x', 'nope')).rejects.toThrow('voice not found');
    // The service still works afterward.
    expect((await svc.createSttSession()).id).toBeGreaterThan(0);
  });

  it('rejects in-flight requests when the worker emits an error event', async () => {
    let workerRef: FakeWorker | null = null;
    const svc = new VoiceEngineService({
      workerFactory: () => {
        workerRef = new FakeWorker((req, emit) => {
          if (req.kind === 'vad:create')
            emit({ kind: 'result', reqId: req.reqId, result: { sessionId: 1 } });
          // never answer vad:prob -> leave it pending
        });
        return workerRef;
      },
    });
    const sid = await svc.createVadSession();
    const p = svc.vadProbability(new Float32Array(512), sid);
    // Let the request actually post (become in-flight) before the worker dies.
    await new Promise((r) => setTimeout(r, 0));
    workerRef!.fail(new Error('worker crashed'));
    await expect(p).rejects.toThrow('worker crashed');
  });
});

describe('VoiceEngineService — shutdown', () => {
  it('terminates the worker', async () => {
    const { svc, worker } = makeService();
    await svc.createSttSession();
    await svc.shutdown();
    expect(worker().terminated).toBe(true);
  });

  it('is a no-op before the worker spawns', async () => {
    const factory = jest.fn(() => new FakeWorker(defaultResponder));
    const svc = new VoiceEngineService({ workerFactory: factory });
    await svc.shutdown();
    expect(factory).not.toHaveBeenCalled();
  });
});
