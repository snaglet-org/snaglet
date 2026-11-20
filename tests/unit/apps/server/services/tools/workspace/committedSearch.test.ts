/**
 * committedSearch finish pipeline — the quality floor + honest empty state
 * and the semantic-vs-lexical floor rule. The cross-encoder is
 * stubbed in jest (onnxruntime), so the reranker is mocked to inject controlled
 * scores; the usefulness scorer runs for real (it is pure). buildCandidateCards
 * is mocked to an empty map — cards are evidence, never a ranking dependency.
 */

import { beforeEach, describe, expect, it, jest } from '@jest/globals';

let scoreById = new Map<string, number>();

jest.mock('@server/services/ToolService/handlers/search/workspaceSearch/rerankHits', () => ({
  // Identity reorder + injected scores — the reranker itself is exercised elsewhere.
  rerankSearchHitsScored: jest.fn(async (_q: string, hits: unknown[]) => ({
    items: hits,
    scoreById,
  })),
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
  finishCommittedSearch,
  renderHonestEmpty,
  weakMatchesFooter,
  COMMITTED_RERANK_FLOOR,
} from '@server/services/ToolService/handlers/search/workspaceSearch/committedSearch';
import type { SearchHit } from '@server/services/ToolService/handlers/search/workspaceSearch/types';

function doc(id: string): SearchHit {
  return { kind: 'doc', id, title: id, updatedAt: '2026-07-01T00:00:00Z', rank: 1, snippet: id };
}

beforeEach(() => {
  scoreById = new Map();
});

describe('committedSearch — quality floor + honest empty', () => {
  const hits = [doc('a'), doc('b'), doc('c')];

  it('withholds hits below the cross-encoder floor and reports the cut', async () => {
    scoreById = new Map([
      ['a', 5], // strong
      ['b', COMMITTED_RERANK_FLOOR - 1], // below floor
      ['c', COMMITTED_RERANK_FLOOR - 0.5], // below floor
    ]);
    const res = await finishCommittedSearch({
      query: 'q',
      hits,
      limit: 10,
      cardContext: {},
      includeArchived: false,
      semanticPath: true,
    });
    expect(res.floorApplied).toBe(true);
    expect(res.hits.map((h) => h.id)).toEqual(['a']);
    expect(res.weakCut).toBe(2);
  });

  it('empties the result when nothing clears the floor (honest empty state)', async () => {
    scoreById = new Map([
      ['a', COMMITTED_RERANK_FLOOR - 2],
      ['b', COMMITTED_RERANK_FLOOR - 3],
      ['c', COMMITTED_RERANK_FLOOR - 1],
    ]);
    const res = await finishCommittedSearch({
      query: 'purple monkey dishwasher',
      hits,
      limit: 10,
      cardContext: {},
      includeArchived: false,
      semanticPath: true,
    });
    expect(res.hits).toHaveLength(0);
    expect(res.floorApplied).toBe(true);
    expect(res.weakCut).toBe(3);

    const msg = renderHonestEmpty('purple monkey dishwasher', res.weakCut);
    expect(msg).toContain('No strongly-relevant matches');
    expect(msg).toContain('mode:');
    expect(msg).toContain('container_id:"root"');
    expect(weakMatchesFooter(res.weakCut)).toContain('withheld');
  });

  it('keeps unscored (unreranked-tail) hits — the floor never hides what the judge did not see', async () => {
    // Only 'a' scored (below floor); 'b'/'c' have no score → kept.
    scoreById = new Map([['a', COMMITTED_RERANK_FLOOR - 5]]);
    const res = await finishCommittedSearch({
      query: 'q',
      hits,
      limit: 10,
      cardContext: {},
      includeArchived: false,
      semanticPath: true,
    });
    expect(res.hits.map((h) => h.id).sort()).toEqual(['b', 'c']);
    expect(res.weakCut).toBe(1);
  });

  it('pins authoritative structured matches and exempts them from the semantic floor', async () => {
    const structured: SearchHit = {
      ...doc('structured-doc'),
      channels: ['structured'],
    };
    scoreById = new Map([
      ['ordinary-doc', 5],
      ['structured-doc', COMMITTED_RERANK_FLOOR - 5],
    ]);

    const res = await finishCommittedSearch({
      query: 'structured filter match',
      hits: [doc('ordinary-doc'), structured],
      limit: 10,
      cardContext: {},
      includeArchived: false,
      semanticPath: true,
    });

    expect(res.hits.map((hit) => hit.id)).toEqual(['structured-doc', 'ordinary-doc']);
    expect(res.weakCut).toBe(0);
  });

  it('the lexical path never applies the cross-encoder floor', async () => {
    scoreById = new Map([['a', 5]]); // even if scores existed, semanticPath=false ignores them
    const res = await finishCommittedSearch({
      query: 'q',
      hits,
      limit: 10,
      cardContext: {},
      includeArchived: false,
      semanticPath: false,
    });
    expect(res.floorApplied).toBe(false);
    expect(res.weakCut).toBe(0);
    expect(res.hits).toHaveLength(3);
  });

  it('include_archived skips the floor (the dig is about archived items)', async () => {
    scoreById = new Map([
      ['a', COMMITTED_RERANK_FLOOR - 2],
      ['b', COMMITTED_RERANK_FLOOR - 2],
      ['c', COMMITTED_RERANK_FLOOR - 2],
    ]);
    const res = await finishCommittedSearch({
      query: 'q',
      hits,
      limit: 10,
      cardContext: {},
      includeArchived: true,
      semanticPath: true,
    });
    expect(res.floorApplied).toBe(false);
    expect(res.hits).toHaveLength(3);
  });
});
