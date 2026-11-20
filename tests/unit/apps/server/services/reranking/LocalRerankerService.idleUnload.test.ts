/**
 * LocalRerankerService — idle-unload behavior (the shared `IdleUnloader`
 * helper, same as LocalEmbedderService.idleUnload.test.ts).
 *
 * Mocks onnxruntime-node (the jest-wide stub always throws on `.create()` —
 * see tests/support/onnxruntime-stub.cjs), WordPieceTokenizer, and
 * `@snaglet/db/tables/models` (rerank() resolves its model row from the DB) so
 * the timer/dispose/reload/cache-clearing logic can run without a real
 * model file or a real database.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

jest.mock('onnxruntime-node', () => {
  const release = jest.fn(async () => undefined);
  const run = jest.fn(async () => {
    // batch=2 candidates, 1 logit each.
    const data = new Float32Array([0.7, 0.3]);
    return { logits: { dims: [2, 1], data } };
  });
  const create = jest.fn(async () => ({
    inputNames: ['input_ids', 'attention_mask', 'token_type_ids'],
    outputNames: ['logits'],
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
    encodePair: () => ({
      inputIds: [101, 2001, 102],
      attentionMask: [1, 1, 1],
      tokenTypeIds: [0, 0, 0],
    }),
  }));
  return { WordPieceTokenizer: { fromFiles } };
});

const findByProviderAndModelId = jest.fn();
jest.mock('@snaglet/db/tables/models', () => ({
  Models: { findByProviderAndModelId: (...args: unknown[]) => findByProviderAndModelId(...args) },
}));

import * as ortModule from 'onnxruntime-node';
import {
  forceRerankerIdleUnloadForTests,
  rerank,
  resetLocalRerankerForTests,
  DEFAULT_RERANKER_PROVIDER_ID,
  DEFAULT_RERANKER_MODEL_ID,
} from '@server/services/reranking/LocalRerankerService';

const ort = ortModule as unknown as {
  InferenceSession: { create: jest.Mock };
  __mockRelease: jest.Mock;
  __mockRun: jest.Mock;
};

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

describe('LocalRerankerService — idle unload', () => {
  let modelFile: string;
  let vocabFile: string;

  beforeAll(() => {
    const dir = mkdtempSync(path.join(tmpdir(), 'snaglet-reranker-idle-unload-'));
    modelFile = path.join(dir, 'reranker.onnx');
    vocabFile = path.join(dir, 'vocab.txt');
    writeFileSync(modelFile, 'fake-reranker-model-bytes');
    writeFileSync(vocabFile, '[PAD]\n[UNK]\nhello\nworld\n');

    findByProviderAndModelId.mockResolvedValue({
      id: 'model-row-1',
      providerId: DEFAULT_RERANKER_PROVIDER_ID,
      modelId: DEFAULT_RERANKER_MODEL_ID,
      displayName: 'Test Reranker',
      description: '',
      family: null,
      contextWindowTokens: 512,
      maxOutputTokens: null,
      supportsTools: false,
      supportsVision: false,
      supportsReasoning: false,
      isActive: true,
      sortOrder: 0,
      type: 'reranker',
      dimensions: null,
      metadata: { reranking: { modelFile, vocabFile } },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
  });

  beforeEach(() => {
    resetLocalRerankerForTests();
    jest.clearAllMocks();
    findByProviderAndModelId.mockResolvedValue({
      id: 'model-row-1',
      providerId: DEFAULT_RERANKER_PROVIDER_ID,
      modelId: DEFAULT_RERANKER_MODEL_ID,
      displayName: 'Test Reranker',
      description: '',
      family: null,
      contextWindowTokens: 512,
      maxOutputTokens: null,
      supportsTools: false,
      supportsVision: false,
      supportsReasoning: false,
      isActive: true,
      sortOrder: 0,
      type: 'reranker',
      dimensions: null,
      metadata: { reranking: { modelFile, vocabFile } },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    delete process.env.SNAGLET_RERANKER_IDLE_UNLOAD_MS;
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  const candidates = [{ text: 'Mars is red' }, { text: 'the sky is blue' }];

  it('a cold rerank call lazy-loads the session exactly once', async () => {
    const res = await rerank({ query: 'what color is mars', candidates });
    expect(res.results).toHaveLength(2);
    expect(ort.InferenceSession.create).toHaveBeenCalledTimes(1);

    await rerank({ query: 'another query', candidates });
    expect(ort.InferenceSession.create).toHaveBeenCalledTimes(1); // cached
  });

  it('force-unload releases the cached session and clears the caches; the next call reloads', async () => {
    await rerank({ query: 'q1', candidates });
    expect(ort.InferenceSession.create).toHaveBeenCalledTimes(1);
    expect(ort.__mockRelease).not.toHaveBeenCalled();

    await forceRerankerIdleUnloadForTests();
    expect(ort.__mockRelease).toHaveBeenCalledTimes(1);

    await rerank({ query: 'q2', candidates });
    expect(ort.InferenceSession.create).toHaveBeenCalledTimes(2);
  });

  it('the real idle timer fires after SNAGLET_RERANKER_IDLE_UNLOAD_MS and reloads on next use', async () => {
    jest.useFakeTimers();
    process.env.SNAGLET_RERANKER_IDLE_UNLOAD_MS = '1000';

    await rerank({ query: 'q1', candidates });
    expect(ort.InferenceSession.create).toHaveBeenCalledTimes(1);

    await jest.advanceTimersByTimeAsync(999);
    expect(ort.__mockRelease).not.toHaveBeenCalled();

    await jest.advanceTimersByTimeAsync(1);
    expect(ort.__mockRelease).toHaveBeenCalledTimes(1);

    await rerank({ query: 'q2', candidates });
    expect(ort.InferenceSession.create).toHaveBeenCalledTimes(2);
  });

  it('race safety: a rerank call arriving mid-dispose waits and reloads cleanly', async () => {
    // Drives the dispose through the real timer path (touch()'s setTimeout
    // callback), the only path that sets IdleUnloader's `disposing` field;
    // forceRerankerIdleUnloadForTests() would pass even without
    // `awaitInFlightDispose()`. Real timers, not fake ones, so the "must not
    // have settled yet" window is a genuine wall-clock gap: the racing call's
    // mocked create()/fromFiles() resolve near-instantly, so a few microtask
    // ticks are not a reliable probe.
    process.env.SNAGLET_RERANKER_IDLE_UNLOAD_MS = '30';

    await rerank({ query: 'q1', candidates });
    expect(ort.InferenceSession.create).toHaveBeenCalledTimes(1);

    let resolveRelease: () => void = () => {};
    ort.__mockRelease.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          resolveRelease = resolve;
        })
    );

    // Let the real idle timer (armed by the rerank above) fire on its own —
    // this is the only path that sets IdleUnloader's `disposing` field.
    await waitFor(() => ort.__mockRelease.mock.calls.length === 1, 2000);

    let racingSettled = false;
    const racingRerank = rerank({ query: 'racing query', candidates }).then((r) => {
      racingSettled = true;
      return r;
    });

    // A generous real-time window: with the guard in place this must never
    // settle until resolveRelease() is called below, no matter how long we wait.
    await new Promise((resolve) => setTimeout(resolve, 250));
    // The racing call must not have grabbed a stale/half-released session and
    // returned before the dispose finished — this is exactly what
    // `awaitInFlightDispose()` in loadTokenizer/loadSession guards against.
    expect(racingSettled).toBe(false);

    resolveRelease();
    const result = await racingRerank;

    expect(racingSettled).toBe(true);
    expect(result.results).toHaveLength(2);
    expect(ort.InferenceSession.create).toHaveBeenCalledTimes(2);
  });
});
