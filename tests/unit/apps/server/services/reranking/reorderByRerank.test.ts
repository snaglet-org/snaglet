/**
 * reorderByRerank — the shared tier-3 reorder contract. Pins the behaviors
 * both former call sites (workspace-search rerankHits, nodeSearch fused
 * candidates) depended on: cap + tail order, dropped-id backfill, graceful
 * degrade, and the no-op fast paths.
 */

import { beforeEach, describe, expect, it, jest } from '@jest/globals';

const mockRerank =
  jest.fn<
    (args: { candidates: Array<{ id: string }> }) => Promise<{ results: { id?: string }[] }>
  >();
const mockWarnUnavailable = jest.fn<() => Promise<boolean>>();
const mockFlagEnabled = jest.fn<() => Promise<boolean>>();
const mockRelease = jest.fn<() => Promise<void>>();

jest.mock('@server/services/reranking/LocalRerankerService', () => ({
  rerank: (...args: unknown[]) => mockRerank(...(args as [{ candidates: Array<{ id: string }> }])),
  warnIfRerankerUnavailable: () => mockWarnUnavailable(),
  releaseLocalReranker: () => mockRelease(),
}));

jest.mock('@server/services/reranking/rerankerFlag', () => ({
  isRerankerEnabled: () => mockFlagEnabled(),
}));

import {
  RERANK_MAX_CANDIDATES,
  reorderByRerank,
  reorderByRerankScored,
} from '@server/services/reranking/reorderByRerank';

interface Item {
  id: string;
  title: string;
}

const item = (n: number): Item => ({ id: `id-${n}`, title: `Item ${n}` });
const items = (n: number): Item[] => Array.from({ length: n }, (_, i) => item(i));

function run(list: Item[], query = 'find things'): Promise<Item[]> {
  return reorderByRerank({
    query,
    items: list,
    getId: (i) => i.id,
    getText: (i) => i.title,
    context: 'test search',
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  mockWarnUnavailable.mockResolvedValue(false);
  mockFlagEnabled.mockResolvedValue(true);
  mockRelease.mockResolvedValue(undefined);
});

describe('reorderByRerank', () => {
  it('reorders scored candidates by reranker order', async () => {
    mockRerank.mockResolvedValue({ results: [{ id: 'id-2' }, { id: 'id-0' }, { id: 'id-1' }] });

    const out = await run(items(3));

    expect(out.map((i) => i.id)).toEqual(['id-2', 'id-0', 'id-1']);
    expect(mockRelease).not.toHaveBeenCalled();
  });

  it('caps candidates and keeps the tail in incoming order behind the reranked block', async () => {
    const list = items(RERANK_MAX_CANDIDATES + 5);
    // Reranker returns the capped set reversed.
    mockRerank.mockImplementation(async ({ candidates }) => ({
      results: [...candidates].reverse().map((c) => ({ id: c.id })),
    }));

    const out = await run(list);

    expect(mockRerank.mock.calls[0]![0].candidates).toHaveLength(RERANK_MAX_CANDIDATES);
    expect(out).toHaveLength(list.length);
    // Tail (past the cap) preserved verbatim at the end.
    expect(out.slice(-5).map((i) => i.id)).toEqual(list.slice(-5).map((i) => i.id));
    // Head is the reversed capped block.
    expect(out[0]!.id).toBe(`id-${RERANK_MAX_CANDIDATES - 1}`);
  });

  it('backfills candidates the reranker dropped, in incoming order', async () => {
    mockRerank.mockResolvedValue({ results: [{ id: 'id-3' }] });

    const out = await run(items(4));

    expect(out.map((i) => i.id)).toEqual(['id-3', 'id-0', 'id-1', 'id-2']);
  });

  it('keeps incoming order when the reranker fails', async () => {
    mockRerank.mockRejectedValue(new Error('model not loaded'));

    const list = items(4);
    const out = await run(list);

    expect(out).toEqual(list);
  });

  it('scores a singleton and skips only empty candidates or an empty query', async () => {
    mockRerank.mockResolvedValue({ results: [{ id: 'id-0' }] });

    await expect(run(items(1))).resolves.toEqual(items(1));
    expect(mockRerank).toHaveBeenCalledTimes(1);

    mockRerank.mockClear();
    await run(items(0));
    await run(items(5), '   ');

    expect(mockRerank).not.toHaveBeenCalled();
  });
});

describe('reorderByRerank with the reranker flag off', () => {
  beforeEach(() => {
    mockFlagEnabled.mockResolvedValue(false);
  });

  it('keeps the incoming order without calling or probing the reranker', async () => {
    const list = items(4);

    await expect(run(list)).resolves.toEqual(list);

    expect(mockRerank).not.toHaveBeenCalled();
    expect(mockWarnUnavailable).not.toHaveBeenCalled();
  });

  it('frees a reranker session left loaded from when the flag was on', async () => {
    await run(items(2));

    expect(mockRelease).toHaveBeenCalledTimes(1);
  });

  it('returns no scores, like an offline reranker', async () => {
    const list = items(3);

    const out = await reorderByRerankScored({
      query: 'find things',
      items: list,
      getId: (i) => i.id,
      getText: (i) => i.title,
      context: 'test search',
    });

    expect(out.items).toEqual(list);
    expect(out.scoreById.size).toBe(0);
    expect(mockRerank).not.toHaveBeenCalled();
  });
});
