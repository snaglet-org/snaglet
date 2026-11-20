/**
 * LocalEmbedderService — idle-unload + boot-warm-gating behavior.
 *
 * Needs a working fake ONNX session (with a spyable `.release()`) instead of
 * the jest-wide stub (tests/support/onnxruntime-stub.cjs), which throws on
 * `.create()` because real inference can't run in jest's VM realm. The
 * `jest.mock` here overrides that stub for this file only, so the
 * timer/dispose/reload logic runs without real ONNX.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

jest.mock('onnxruntime-node', () => {
  const release = jest.fn(async () => undefined);
  const run = jest.fn(async () => {
    // batch=1, width=3 (matches the fake tokenizer's 3-token encoding), 768-d.
    const batch = 1;
    const width = 3;
    const hidden = 768;
    const data = new Float32Array(batch * width * hidden).fill(0.1);
    return { last_hidden_state: { dims: [batch, width, hidden], data } };
  });
  const create = jest.fn(async () => ({
    inputNames: ['input_ids', 'attention_mask'],
    outputNames: ['last_hidden_state'],
    run,
    release,
  }));
  class FakeTensor {
    type: string;
    data: unknown;
    dims: number[];
    constructor(type: string, data: unknown, dims: number[]) {
      this.type = type;
      this.data = data;
      this.dims = dims;
    }
  }
  return {
    Tensor: FakeTensor,
    InferenceSession: { create },
    __mockRelease: release,
    __mockRun: run,
  };
});

jest.mock('@server/services/reranking/WordPieceTokenizer', () => {
  const fromFiles = jest.fn(async () => ({
    padTokenId: 0,
    encodeSingle: () => ({
      inputIds: [101, 2001, 102],
      attentionMask: [1, 1, 1],
      tokenTypeIds: [0, 0, 0],
    }),
  }));
  return { WordPieceTokenizer: { fromFiles } };
});

import * as ortModule from 'onnxruntime-node';

const ort = ortModule as unknown as {
  InferenceSession: { create: jest.Mock };
  __mockRelease: jest.Mock;
  __mockRun: jest.Mock;
};

import {
  embedDocument,
  forceIdleUnloadForTests,
  resetLocalEmbedderForTests,
  shouldWarmEmbedderAtBoot,
  warmLocalEmbedder,
} from '@server/services/embedding/LocalEmbedderService';

/** Poll (real wall-clock, not fake timers) until `check()` is true or `timeoutMs` elapses. */
async function waitFor(check: () => boolean, timeoutMs = 500): Promise<void> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`waitFor: condition not met within ${timeoutMs}ms`);
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe('LocalEmbedderService — shouldWarmEmbedderAtBoot (boot-warm gating)', () => {
  it('does not warm by default', () => {
    expect(shouldWarmEmbedderAtBoot({})).toBe(false);
  });

  it('warms only when local intelligence and background workers are enabled', () => {
    expect(
      shouldWarmEmbedderAtBoot({
        SNAGLET_LOCAL_INTELLIGENCE: 'true',
        RUN_BACKGROUND_WORKERS: 'true',
      })
    ).toBe(true);
  });

  it('does not warm when background workers are disabled despite local intelligence opt-in', () => {
    expect(
      shouldWarmEmbedderAtBoot({
        SNAGLET_LOCAL_INTELLIGENCE: 'true',
        RUN_BACKGROUND_WORKERS: 'false',
      })
    ).toBe(false);
  });
});

describe('LocalEmbedderService — idle unload', () => {
  let modelFile: string;
  let vocabFile: string;

  beforeAll(() => {
    const dir = mkdtempSync(path.join(tmpdir(), 'snaglet-embedder-idle-unload-'));
    modelFile = path.join(dir, 'model.onnx');
    vocabFile = path.join(dir, 'vocab.txt');
    // Content is irrelevant — InferenceSession.create/WordPieceTokenizer.fromFiles
    // are mocked above, and the env-override path skips checksum verification.
    writeFileSync(modelFile, 'fake-model-bytes');
    writeFileSync(vocabFile, '[PAD]\n[UNK]\nhello\nworld\n');
    process.env.SNAGLET_EMBEDDER_MODEL_FILE = modelFile;
    process.env.SNAGLET_EMBEDDER_VOCAB_FILE = vocabFile;
    process.env.SNAGLET_EMBEDDER_TOKENIZER_CONFIG_FILE = vocabFile; // unused (fromFiles is mocked)
  });

  beforeEach(() => {
    resetLocalEmbedderForTests();
    jest.clearAllMocks();
    delete process.env.SNAGLET_EMBEDDER_IDLE_UNLOAD_MS;
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('boot-time warm never reads the model when boot-warm is gated off', async () => {
    // Simulates index.ts's gate: `if (shouldWarmEmbedderAtBoot()) warmLocalEmbedder();`
    const enabled = shouldWarmEmbedderAtBoot({
      SNAGLET_LOCAL_INTELLIGENCE: 'true',
      RUN_BACKGROUND_WORKERS: 'false',
    });
    expect(enabled).toBe(false);
    if (enabled) warmLocalEmbedder();
    // Give any (wrongly) fired async work a beat, then assert nothing loaded.
    await Promise.resolve();
    await Promise.resolve();
    expect(ort.InferenceSession.create).not.toHaveBeenCalled();
  });

  it('a cold embed call lazy-loads the session exactly once', async () => {
    const vector = await embedDocument('hello world');
    expect(vector).toHaveLength(768);
    expect(ort.InferenceSession.create).toHaveBeenCalledTimes(1);

    // A second call within the idle window reuses the cached session.
    await embedDocument('hello again');
    expect(ort.InferenceSession.create).toHaveBeenCalledTimes(1);
  });

  it('force-unload releases the session and nulls the singleton; the next call reloads', async () => {
    await embedDocument('hello world');
    expect(ort.InferenceSession.create).toHaveBeenCalledTimes(1);
    expect(ort.__mockRelease).not.toHaveBeenCalled();

    await forceIdleUnloadForTests();
    expect(ort.__mockRelease).toHaveBeenCalledTimes(1);

    // Next embed call must reload from scratch (a fresh create()), not reuse
    // a released session.
    const vector = await embedDocument('hello again');
    expect(vector).toHaveLength(768);
    expect(ort.InferenceSession.create).toHaveBeenCalledTimes(2);
  });

  it('the real idle timer fires after SNAGLET_EMBEDDER_IDLE_UNLOAD_MS of inactivity and reloads on next use', async () => {
    jest.useFakeTimers();
    process.env.SNAGLET_EMBEDDER_IDLE_UNLOAD_MS = '1000';

    await embedDocument('hello world');
    expect(ort.InferenceSession.create).toHaveBeenCalledTimes(1);

    // Not yet idle long enough — no release.
    await jest.advanceTimersByTimeAsync(999);
    expect(ort.__mockRelease).not.toHaveBeenCalled();

    // Cross the threshold — the scheduled unload fires and its internal
    // awaits (real promises, not fake timers) get flushed by the async
    // advance.
    await jest.advanceTimersByTimeAsync(1);
    expect(ort.__mockRelease).toHaveBeenCalledTimes(1);

    await embedDocument('hello again');
    expect(ort.InferenceSession.create).toHaveBeenCalledTimes(2);
  });

  it('race safety: an embed call arriving mid-dispose waits and reloads cleanly', async () => {
    // Drives the dispose through the real timer path (touch()'s setTimeout
    // callback), the only path that sets IdleUnloader's `disposing` field;
    // forceIdleUnloadForTests() would pass even without
    // `awaitInFlightDispose()`. Real timers, not fake ones, so the "must not
    // have settled yet" window is a genuine wall-clock gap: the racing call's
    // mocked create()/fromFiles() resolve near-instantly, so a few microtask
    // ticks are not a reliable probe.
    process.env.SNAGLET_EMBEDDER_IDLE_UNLOAD_MS = '30';

    await embedDocument('hello world');
    expect(ort.InferenceSession.create).toHaveBeenCalledTimes(1);

    // Make the next release() call hang until we manually resolve it, so we
    // can land a concurrent embed call while the dispose is still in flight.
    let resolveRelease: () => void = () => {};
    ort.__mockRelease.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          resolveRelease = resolve;
        })
    );

    // Let the real idle timer (armed by the embed above) fire on its own —
    // this is the only path that sets IdleUnloader's `disposing` field.
    await waitFor(() => ort.__mockRelease.mock.calls.length === 1, 2000);

    // A real embed call arrives while the timer-driven dispose is still in flight.
    let racingEmbedSettled = false;
    const racingEmbed = embedDocument('racing call').then((v) => {
      racingEmbedSettled = true;
      return v;
    });

    // A generous real-time window: with the guard in place this must never
    // settle until resolveRelease() is called below, no matter how long we wait.
    await new Promise((resolve) => setTimeout(resolve, 250));
    // The racing call must not have grabbed a stale/half-released session and
    // returned before the dispose finished — this is exactly what
    // `awaitInFlightDispose()` in loadTokenizer/loadSession guards against.
    expect(racingEmbedSettled).toBe(false);

    resolveRelease();
    const vector = await racingEmbed;

    expect(racingEmbedSettled).toBe(true);
    expect(vector).toHaveLength(768);
    // The dispose released the first session; the racing call had to load a
    // fresh one afterward.
    expect(ort.InferenceSession.create).toHaveBeenCalledTimes(2);
  }, 10_000);

  it('warmLocalEmbedder starts the idle clock so a warmed-but-unused model still unloads', async () => {
    // Real timers: warmLocalEmbedder is fire-and-forget and does a real (if
    // mocked-file) fs.access round trip internally, which fake timers don't
    // advance — poll with real waits instead.
    process.env.SNAGLET_EMBEDDER_IDLE_UNLOAD_MS = '30';

    warmLocalEmbedder();
    await waitFor(() => ort.InferenceSession.create.mock.calls.length === 1);
    expect(ort.__mockRelease).not.toHaveBeenCalled();

    // Past the idle threshold — the touch() inside warmLocalEmbedder's
    // completion should have started the clock even though nothing embedded.
    await waitFor(() => ort.__mockRelease.mock.calls.length === 1, 2000);
  });
});
