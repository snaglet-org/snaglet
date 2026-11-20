import { afterAll, beforeEach, describe, expect, it, jest } from '@jest/globals';

const mockQuery =
  jest.fn<(sql: string, params?: unknown[]) => Promise<{ rows: unknown[]; rowCount: number }>>();

jest.mock('@snaglet/db/db', () => ({
  getDb: () => ({ query: mockQuery }),
  transaction: jest.fn(),
}));

import { Embeddings } from '@snaglet/db/tables/embeddings';

interface RawEmbeddingRow {
  id: string;
  node_id: string;
  model_id: string;
  vector: string;
  content_hash: string | null;
  chunk_index: number;
  chunk_start: number | null;
  chunk_end: number | null;
  created_at: string;
  updated_at: string;
}

function rawRow(
  id: string,
  vector: string,
  overrides: Partial<RawEmbeddingRow> = {}
): RawEmbeddingRow {
  return {
    id,
    node_id: 'node-1',
    model_id: 'model-1',
    vector,
    content_hash: 'hash-1',
    chunk_index: 0,
    chunk_start: 0,
    chunk_end: 12,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-02T00:00:00.000Z',
    ...overrides,
  };
}

function resolveRows(rows: RawEmbeddingRow[]): void {
  mockQuery.mockResolvedValue({ rows, rowCount: rows.length });
}

const warnSpy = jest.spyOn(console, 'warn');

describe('EmbeddingModel vector mapping', () => {
  beforeEach(() => {
    mockQuery.mockReset();
    warnSpy.mockReset();
    warnSpy.mockImplementation(() => {});
  });

  afterAll(() => {
    warnSpy.mockRestore();
  });

  it('keeps every row and every healthy vector when one row in the set is corrupt', async () => {
    // Blast radius is the property under test: without the guard, one bad
    // cell would throw inside row mapping and take the whole result set with it.
    resolveRows([
      rawRow('emb-good-1', '[0.1,0.2,0.3]'),
      rawRow('emb-corrupt', '[0.4,0.5', { chunk_index: 1, content_hash: 'hash-corrupt' }),
      rawRow('emb-good-2', '[0.6,0.7,0.8]', { chunk_index: 2 }),
    ]);

    const rows = await Embeddings.listByNode('node-1', 'model-1');

    expect(rows.map((r) => r.id)).toEqual(['emb-good-1', 'emb-corrupt', 'emb-good-2']);
    expect(rows[0].vector).toEqual([0.1, 0.2, 0.3]);
    expect(rows[2].vector).toEqual([0.6, 0.7, 0.8]);
    expect(rows[1].vector).toEqual([]);
    // The corrupt row degrades only in its vector — its identity still resolves,
    // so callers can find and re-embed it.
    expect(rows[1]).toMatchObject({
      id: 'emb-corrupt',
      nodeId: 'node-1',
      modelId: 'model-1',
      contentHash: 'hash-corrupt',
      chunkIndex: 1,
      updatedAt: '2026-01-02T00:00:00.000Z',
    });
  });

  it('warns once, naming the corrupt row id and no healthy row id', async () => {
    resolveRows([
      rawRow('emb-good-1', '[0.1,0.2,0.3]'),
      rawRow('emb-corrupt', 'not-json-at-all'),
      rawRow('emb-good-2', '[0.6]'),
    ]);

    await Embeddings.listByNode('node-1');

    expect(warnSpy).toHaveBeenCalledTimes(1);
    const message = String(warnSpy.mock.calls[0][0]);
    expect(message).toContain('emb-corrupt');
    expect(message).toContain('EmbeddingModel');
    expect(message).not.toContain('emb-good-1');
    expect(message).not.toContain('emb-good-2');
  });

  it('degrades every non-array vector cell instead of throwing', async () => {
    // JSON.parse succeeds on `null` and on scalars, so parse-success alone is
    // not enough: a null cell would reach `.length` and throw.
    resolveRows([
      rawRow('emb-null-cell', null as unknown as string),
      rawRow('emb-json-null', 'null'),
      rawRow('emb-scalar', '768'),
      rawRow('emb-object', '{"0":0.1}'),
      rawRow('emb-truncated', '[0.1,'),
      rawRow('emb-good', '[0.9]'),
    ]);

    const rows = await Embeddings.listByNode('node-1');

    expect(rows).toHaveLength(6);
    expect(rows.slice(0, 5).map((r) => r.vector)).toEqual([[], [], [], [], []]);
    expect(rows[5].vector).toEqual([0.9]);
    expect(warnSpy).toHaveBeenCalledTimes(5);
  });

  it('does not warn when every vector parses', async () => {
    resolveRows([rawRow('emb-good-1', '[0.1,0.2]'), rawRow('emb-good-2', '[0.3,0.4]')]);

    const rows = await Embeddings.listByNode('node-1');

    expect(rows.map((r) => r.vector)).toEqual([
      [0.1, 0.2],
      [0.3, 0.4],
    ]);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('returns a corrupt single row from findById rather than failing the lookup', async () => {
    resolveRows([rawRow('emb-corrupt', '[0.1,0.2')]);

    await expect(Embeddings.findById('emb-corrupt')).resolves.toMatchObject({
      id: 'emb-corrupt',
      vector: [],
    });
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });
});
