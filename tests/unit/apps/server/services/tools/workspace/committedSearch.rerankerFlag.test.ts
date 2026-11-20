/**
 * committedSearch with the `reranker` feature flag. Runs the real rerankHits
 * and reorderByRerank path with the model service mocked: off keeps the hybrid
 * order and the offline floor behavior (no scores, nothing withheld) without
 * calling or probing the reranker; on reranks and floors as before.
 */

import { beforeEach, describe, expect, it, jest } from '@jest/globals';

const mockRerank =
  jest.fn<
    (args: {
      candidates: Array<{ id: string }>;
    }) => Promise<{ results: Array<{ id: string; score: number }> }>
  >();
const mockWarnUnavailable = jest.fn<() => Promise<boolean>>();
const mockFlagEnabled = jest.fn<() => Promise<boolean>>();

jest.mock('@server/services/reranking/LocalRerankerService', () => ({
  rerank: (args: { candidates: Array<{ id: string }> }) => mockRerank(args),
  warnIfRerankerUnavailable: () => mockWarnUnavailable(),
  releaseLocalReranker: async () => undefined,
}));

jest.mock('@server/services/reranking/rerankerFlag', () => ({
  isRerankerEnabled: () => mockFlagEnabled(),
}));

jest.mock('@server/services/search/candidateCards', () => ({
  buildCandidateCards: jest.fn(async () => new Map()),
  toCardCandidate: (hit: { id: string; kind: string }, rank: number) => ({
    id: hit.id,
    kind: hit.kind,
    rank,
  }),
}));

import {
  COMMITTED_RERANK_FLOOR,
  finishCommittedSearch,
} from '@server/services/ToolService/handlers/search/workspaceSearch/committedSearch';
import type { SearchHit } from '@server/services/ToolService/handlers/search/workspaceSearch/types';

function doc(id: string): SearchHit {
  return { kind: 'doc', id, title: id, updatedAt: '2026-07-01T00:00:00Z', rank: 1, snippet: id };
}

const hybridOrder = [doc('a'), doc('b'), doc('c')];

function finish(hits: SearchHit[] = hybridOrder) {
  return finishCommittedSearch({
    query: 'purple monkey dishwasher',
    hits,
    limit: 10,
    cardContext: {},
    includeArchived: false,
    semanticPath: true,
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  mockWarnUnavailable.mockResolvedValue(false);
  // Every candidate below the floor, in reverse order: had the reranker run,
  // the search would come back as the honest empty state.
  mockRerank.mockImplementation(async ({ candidates }) => ({
    results: [...candidates]
      .reverse()
      .map((candidate, index) => ({ id: candidate.id, score: COMMITTED_RERANK_FLOOR - 1 - index })),
  }));
});

describe('committedSearch with the reranker flag off', () => {
  beforeEach(() => {
    mockFlagEnabled.mockResolvedValue(false);
  });

  it('keeps the hybrid order without calling or probing the reranker', async () => {
    const res = await finish();

    expect(res.hits.map((hit) => hit.id)).toEqual(['a', 'b', 'c']);
    expect(mockRerank).not.toHaveBeenCalled();
    expect(mockWarnUnavailable).not.toHaveBeenCalled();
  });

  it('skips the relevance floor as it does when the reranker is offline', async () => {
    const res = await finish();

    expect(res.floorApplied).toBe(false);
    expect(res.weakCut).toBe(0);
    expect(res.consideredCount).toBe(3);
  });
});

describe('committedSearch with the reranker flag on', () => {
  beforeEach(() => {
    mockFlagEnabled.mockResolvedValue(true);
  });

  it('reranks the pool and applies the relevance floor', async () => {
    const res = await finish();

    expect(mockRerank).toHaveBeenCalledTimes(1);
    expect(res.floorApplied).toBe(true);
    expect(res.hits).toEqual([]);
    expect(res.weakCut).toBe(3);
  });

  it('orders the pool by the cross-encoder', async () => {
    mockRerank.mockImplementation(async ({ candidates }) => ({
      results: [...candidates].reverse().map((candidate) => ({ id: candidate.id, score: 5 })),
    }));

    const res = await finish();

    expect(res.hits.map((hit) => hit.id)).toEqual(['c', 'b', 'a']);
  });
});
