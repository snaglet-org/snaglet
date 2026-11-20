/**
 * The project backfill and the worker sweep can embed the same content at
 * once; without single-flight both would pay for the provider call and the
 * loser would hit the file_embeddings unique key. Locks in:
 *   - one provider call per (model, content hash) in flight; a concurrent
 *     caller for the same pair comes back `unchanged` (counted as reused);
 *   - different hashes still run in parallel;
 *   - a failed leader's waiters inherit the failure (no retry — failures are
 *     mostly provider-side and a second call doubles cost / deepens a 429),
 *     and the in-flight entry is always cleared;
 *   - the sweep's backfill exclusion is read live, so it lifts when the
 *     backfill ends, fails or is canceled.
 */
import { beforeEach, describe, expect, it, jest } from '@jest/globals';

const existsByHashModel = jest.fn<(hash: string, modelId: string) => Promise<boolean>>();
const replaceChunks = jest.fn<(...args: unknown[]) => Promise<unknown[]>>();
const generateEmbeddingChunks = jest.fn<(...args: unknown[]) => Promise<unknown>>();
const query = jest.fn<(sql: string, values: unknown[]) => Promise<{ rows: unknown[] }>>();

jest.mock('@snaglet/db', () => ({ getDb: () => ({ query }) }));
jest.mock('@snaglet/db/tables/files', () => ({
  FileEmbeddings: {
    existsByHashModel: (h: string, m: string) => existsByHashModel(h, m),
    replaceChunks: (...a: unknown[]) => replaceChunks(...a),
    deleteOrphans: async () => 0,
  },
}));
jest.mock('@snaglet/db/tables/models', () => ({
  Models: { findByProviderAndModelId: async () => ({ id: 'model-1' }) },
}));
jest.mock('@server/services/embedding/EmbeddingOrchestrator', () => ({
  generateEmbeddingChunks: (...a: unknown[]) => generateEmbeddingChunks(...a),
}));
jest.mock('@server/services/embedding/EmbeddingProvider', () => ({
  resolveEmbeddingProvider: async () => null,
}));
jest.mock('@server/services/embedding/EmbeddingNodeClassifier', () => ({
  buildEmbeddingTarget: async () => null,
}));
jest.mock('@server/realtime/surfaces/fileEmbeddings', () => ({
  emitFileEmbeddingCoverageChanged: () => undefined,
  emitProjectIndexingStatusChanged: () => undefined,
}));

import {
  embedFileContent,
  inFlightFileEmbedCount,
  sweepMissingFileEmbeddings,
} from '@server/services/embedding/fileContentEmbedding';
import {
  endExclusiveOp,
  listProjectsWithActiveBackfill,
  tryBeginExclusiveOp,
} from '@server/services/fileIndexing/projectIndexingStatus';
import type { EmbeddingProvider } from '@server/services/embedding/EmbeddingProvider';

const provider = {
  info: { provider: 'test', model: 'm', dimensions: 3 },
} as unknown as EmbeddingProvider;

const CHUNKS = [{ chunkIndex: 0, content: 'x', embedding: [1, 2, 3] }];

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const flush = () => new Promise((r) => setImmediate(r));

beforeEach(() => {
  jest.clearAllMocks();
  existsByHashModel.mockResolvedValue(false);
  replaceChunks.mockResolvedValue([]);
  query.mockResolvedValue({ rows: [] });
});

describe('embedFileContent single-flight', () => {
  it('two concurrent calls for the same hash make one provider call; the second is unchanged', async () => {
    const gate = deferred<unknown>();
    generateEmbeddingChunks.mockReturnValueOnce(gate.promise);

    const a = embedFileContent({ contentHash: 'h1', content: 'body', providerOverride: provider });
    await flush();
    const b = embedFileContent({ contentHash: 'h1', content: 'body', providerOverride: provider });
    await flush();
    gate.resolve({ ok: true, chunks: CHUNKS });
    const [ra, rb] = await Promise.all([a, b]);

    expect(generateEmbeddingChunks).toHaveBeenCalledTimes(1);
    expect(replaceChunks).toHaveBeenCalledTimes(1);
    expect(ra).toMatchObject({ ok: true, chunks: 1 });
    expect(rb).toMatchObject({ ok: true, skipped: 'unchanged', contentHash: 'h1' });
    expect(inFlightFileEmbedCount()).toBe(0);
  });

  it('different hashes still embed in parallel', async () => {
    const g1 = deferred<unknown>();
    const g2 = deferred<unknown>();
    generateEmbeddingChunks.mockReturnValueOnce(g1.promise).mockReturnValueOnce(g2.promise);

    const a = embedFileContent({ contentHash: 'hA', content: 'a', providerOverride: provider });
    const b = embedFileContent({ contentHash: 'hB', content: 'b', providerOverride: provider });
    await flush();
    expect(generateEmbeddingChunks).toHaveBeenCalledTimes(2);
    g1.resolve({ ok: true, chunks: CHUNKS });
    g2.resolve({ ok: true, chunks: CHUNKS });
    const results = await Promise.all([a, b]);
    expect(results.every((r) => r.ok && !r.skipped)).toBe(true);
    expect(inFlightFileEmbedCount()).toBe(0);
  });

  it('a provider-error leader: the waiter inherits the error, 1 provider call, map cleared', async () => {
    const gate = deferred<unknown>();
    generateEmbeddingChunks.mockReturnValueOnce(gate.promise);

    const a = embedFileContent({ contentHash: 'h2', content: 'body', providerOverride: provider });
    await flush();
    const b = embedFileContent({ contentHash: 'h2', content: 'body', providerOverride: provider });
    await flush();
    gate.resolve({ ok: false, error: '429 rate limited' });
    const [ra, rb] = await Promise.all([a, b]);

    expect(generateEmbeddingChunks).toHaveBeenCalledTimes(1);
    expect(replaceChunks).not.toHaveBeenCalled();
    expect(ra).toMatchObject({ ok: false, skipped: 'provider-error', error: '429 rate limited' });
    expect(rb).toEqual(ra);
    expect(inFlightFileEmbedCount()).toBe(0);
  });

  it('a throwing leader: both callers reject with the same error, 1 provider call, map cleared', async () => {
    const gate = deferred<unknown>();
    generateEmbeddingChunks.mockReturnValueOnce(gate.promise);

    const a = embedFileContent({ contentHash: 'h3', content: 'body', providerOverride: provider });
    await flush();
    const b = embedFileContent({ contentHash: 'h3', content: 'body', providerOverride: provider });
    await flush();
    const boom = new Error('provider outage');
    gate.reject(boom);

    await expect(a).rejects.toBe(boom);
    await expect(b).rejects.toBe(boom);
    expect(generateEmbeddingChunks).toHaveBeenCalledTimes(1);
    expect(inFlightFileEmbedCount()).toBe(0);

    // Nothing sticks: a later call for the same hash calls the provider again.
    generateEmbeddingChunks.mockResolvedValueOnce({ ok: true, chunks: CHUNKS });
    const later = await embedFileContent({
      contentHash: 'h3',
      content: 'body',
      providerOverride: provider,
    });
    expect(later).toMatchObject({ ok: true, chunks: 1 });
    expect(generateEmbeddingChunks).toHaveBeenCalledTimes(2);
  });
});

describe('sweep excludes projects with a running backfill (read live)', () => {
  const excludedArg = () => {
    const call = query.mock.calls.at(-1);
    return (call?.[1] as unknown[])[2];
  };

  it('passes the active backfill set, and it lifts on end, failure and cancel', async () => {
    expect(listProjectsWithActiveBackfill()).toEqual([]);

    expect(tryBeginExclusiveOp('proj-a', 'backfill')).toBe(true);
    expect(tryBeginExclusiveOp('proj-b', 'clear')).toBe(true); // clear is not a backfill
    expect(listProjectsWithActiveBackfill()).toEqual(['proj-a']);
    await sweepMissingFileEmbeddings(10, provider);
    expect(query.mock.calls.at(-1)?.[0]).toContain('NOT (f.project_id = ANY($3::text[]))');
    expect(excludedArg()).toEqual(['proj-a']);

    endExclusiveOp('proj-a'); // success
    endExclusiveOp('proj-b');
    await sweepMissingFileEmbeddings(10, provider);
    expect(excludedArg()).toEqual([]);

    expect(tryBeginExclusiveOp('proj-a', 'backfill')).toBe(true);
    endExclusiveOp('proj-a', 'boom'); // failure
    expect(listProjectsWithActiveBackfill()).toEqual([]);

    expect(tryBeginExclusiveOp('proj-a', 'backfill')).toBe(true);
    endExclusiveOp('proj-a', undefined, true); // cancel
    expect(listProjectsWithActiveBackfill()).toEqual([]);
    await sweepMissingFileEmbeddings(10, provider);
    expect(excludedArg()).toEqual([]);
  });
});
