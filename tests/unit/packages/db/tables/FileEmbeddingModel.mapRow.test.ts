import { afterAll, beforeEach, describe, expect, it, jest } from '@jest/globals';

const mockQuery =
  jest.fn<(sql: string, params?: unknown[]) => Promise<{ rows: unknown[]; rowCount: number }>>();

jest.mock('@snaglet/db/db', () => ({
  getDb: () => ({ query: mockQuery }),
  transaction: jest.fn(),
}));

import { FileEmbeddings } from '@snaglet/db/tables/files';

interface RawFileEmbeddingRow {
  id: string;
  content_hash: string;
  model_id: string;
  vector: string;
  chunk_index: number;
  chunk_start: number | null;
  chunk_end: number | null;
  created_at: string;
  updated_at: string;
}

function rawRow(
  id: string,
  vector: string,
  overrides: Partial<RawFileEmbeddingRow> = {}
): RawFileEmbeddingRow {
  return {
    id,
    content_hash: 'sha256-abc',
    model_id: 'model-1',
    vector,
    chunk_index: 0,
    chunk_start: 0,
    chunk_end: 12,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-02T00:00:00.000Z',
    ...overrides,
  };
}

function resolveRows(rows: RawFileEmbeddingRow[]): void {
  mockQuery.mockResolvedValue({ rows, rowCount: rows.length });
}

const warnSpy = jest.spyOn(console, 'warn');

describe('FileEmbeddingModel vector mapping', () => {
  beforeEach(() => {
    mockQuery.mockReset();
    warnSpy.mockReset();
    warnSpy.mockImplementation(() => {});
  });

  afterAll(() => {
    warnSpy.mockRestore();
  });

  it('keeps the whole chunk set when one chunk in it is corrupt', async () => {
    // Blast radius is the property under test: without the guard, one bad
    // cell would throw inside row mapping and take the entire chunk set with it.
    resolveRows([
      rawRow('fe-good-1', '[0.1,0.2,0.3]'),
      rawRow('fe-corrupt', '[0.4,0.5', { chunk_index: 1, chunk_start: 12, chunk_end: 24 }),
      rawRow('fe-good-2', '[0.6,0.7,0.8]', { chunk_index: 2, chunk_start: 24, chunk_end: 36 }),
    ]);

    const rows = await FileEmbeddings.listByHash('sha256-abc', 'model-1');

    expect(rows.map((r) => r.id)).toEqual(['fe-good-1', 'fe-corrupt', 'fe-good-2']);
    expect(rows[0].vector).toEqual([0.1, 0.2, 0.3]);
    expect(rows[2].vector).toEqual([0.6, 0.7, 0.8]);
    expect(rows[1].vector).toEqual([]);
    // The corrupt chunk degrades only in its vector — its content address and
    // offsets survive, so it can be located and re-embedded.
    expect(rows[1]).toMatchObject({
      id: 'fe-corrupt',
      contentHash: 'sha256-abc',
      modelId: 'model-1',
      chunkIndex: 1,
      chunkStart: 12,
      chunkEnd: 24,
    });
  });

  it('warns once, naming the corrupt row id and no healthy row id', async () => {
    resolveRows([
      rawRow('fe-good-1', '[0.1,0.2,0.3]'),
      rawRow('fe-corrupt', 'not-json-at-all', { chunk_index: 1 }),
      rawRow('fe-good-2', '[0.6]', { chunk_index: 2 }),
    ]);

    await FileEmbeddings.listByHash('sha256-abc');

    expect(warnSpy).toHaveBeenCalledTimes(1);
    const message = String(warnSpy.mock.calls[0][0]);
    expect(message).toContain('fe-corrupt');
    expect(message).toContain('FileEmbeddingModel');
    expect(message).not.toContain('fe-good-1');
    expect(message).not.toContain('fe-good-2');
  });

  it('degrades every non-array vector cell instead of throwing', async () => {
    // JSON.parse succeeds on `null` and on scalars, so parse-success alone is
    // not enough: a null cell would reach `.length` and throw.
    resolveRows([
      rawRow('fe-null-cell', null as unknown as string),
      rawRow('fe-json-null', 'null'),
      rawRow('fe-scalar', '768'),
      rawRow('fe-object', '{"0":0.1}'),
      rawRow('fe-truncated', '[0.1,'),
      rawRow('fe-good', '[0.9]'),
    ]);

    const rows = await FileEmbeddings.listByHash('sha256-abc');

    expect(rows).toHaveLength(6);
    expect(rows.slice(0, 5).map((r) => r.vector)).toEqual([[], [], [], [], []]);
    expect(rows[5].vector).toEqual([0.9]);
    expect(warnSpy).toHaveBeenCalledTimes(5);
  });

  it('does not warn when every vector parses', async () => {
    resolveRows([rawRow('fe-good-1', '[0.1,0.2]'), rawRow('fe-good-2', '[0.3,0.4]')]);

    const rows = await FileEmbeddings.listByHash('sha256-abc');

    expect(rows.map((r) => r.vector)).toEqual([
      [0.1, 0.2],
      [0.3, 0.4],
    ]);
    expect(warnSpy).not.toHaveBeenCalled();
  });
});
