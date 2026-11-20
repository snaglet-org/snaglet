import { describe, expect, it } from '@jest/globals';
import { scoreQuery, summarize } from '../../../../support/searchEval/metrics';

describe('search evaluation metrics', () => {
  it('counts all relevant identities, not repeated appearances, in the first five hits', () => {
    expect(scoreQuery(['wrong', 'a', 'a', 'b', 'other', 'c'], ['a', 'b', 'c'], 120)).toEqual({
      recallAt5: 2 / 3,
      reciprocalRank: 1 / 2,
      firstRightRank: 2,
      tokens: 120,
      hits: 6,
    });
  });
  it('does not reward a correct answer outside the top five for recall', () => {
    expect(scoreQuery(['x', 'y', 'z', 'v', 'w', 'a'], ['a'], 30)).toMatchObject({
      recallAt5: 0,
      reciprocalRank: 1 / 6,
      firstRightRank: 6,
    });
  });
  it('retains empty responses in averages and reports their tokens', () => {
    const result = summarize([scoreQuery([], ['a'], 20), scoreQuery(['a', 'b'], ['a'], 100)]);
    expect(result).toEqual({
      queries: 2,
      recallAt5: 0.5,
      mrr: 0.5,
      meanFirstRightRank: 1,
      unanswered: 1,
      emptyResults: 1,
      tokensPerSearch: 60,
      tokensPerHit: 60,
      totalTokens: 120,
    });
  });
  it('rejects an empty relevance judgment instead of dividing by zero', () => {
    expect(() => scoreQuery([], [], 10)).toThrow('expected');
  });
});
