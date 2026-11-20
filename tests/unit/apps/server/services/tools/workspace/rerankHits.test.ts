/**
 * rerankSearchHits — the committed-path tier-3 pass: cross-encoder ordering,
 * the ≤50-candidate cap (tail keeps RRF order), and graceful degradation
 * when the local model is unavailable.
 */

import { beforeEach, describe, expect, it } from '@jest/globals';

const mockRerank = jest.fn();
const mockWarn = jest.fn(async () => false);
jest.mock('@server/services/reranking/LocalRerankerService.js', () => ({
  rerank: (...args: unknown[]) => mockRerank(...args),
  warnIfRerankerUnavailable: (...args: unknown[]) => mockWarn(...args),
  releaseLocalReranker: async () => undefined,
}));
jest.mock('@server/services/reranking/rerankerFlag', () => ({
  isRerankerEnabled: async () => true,
}));

jest.mock('@server/config/logger.js', () => ({
  logger: { warn: jest.fn() },
}));

import {
  RERANK_MAX_CANDIDATES,
  rerankSearchHits,
} from '@server/services/ToolService/handlers/search/workspaceSearch/rerankHits';
import type { SearchHit } from '@server/services/ToolService/handlers/search/workspaceSearch/types';

const hit = (id: string, title: string): SearchHit =>
  ({ id, kind: 'doc', title, snippet: `${title} snippet` }) as unknown as SearchHit;

beforeEach(() => {
  jest.clearAllMocks();
  mockWarn.mockResolvedValue(false);
});

describe('rerankSearchHits', () => {
  it('re-orders hits by cross-encoder score', async () => {
    mockRerank.mockResolvedValue({
      results: [
        { id: 'b', score: 9 },
        { id: 'a', score: 1 },
      ],
    });

    const out = await rerankSearchHits('query', [hit('a', 'Alpha'), hit('b', 'Beta')]);

    expect(out.map((h) => h.id)).toEqual(['b', 'a']);
    // Candidate text carries more than the title (snippet/content matter).
    const call = mockRerank.mock.calls[0]?.[0] as { candidates: Array<{ text: string }> };
    expect(call.candidates[0]?.text).toContain('Alpha snippet');
  });

  it('caps the cross-encoder at 50 candidates; the tail keeps RRF order', async () => {
    const hits = Array.from({ length: 60 }, (_, i) => hit(`h${i}`, `Hit ${i}`));
    mockRerank.mockImplementation(async (input: { candidates: Array<{ id: string }> }) => ({
      // Reverse the scored block so the reorder is visible.
      results: [...input.candidates].reverse().map((c, i) => ({ id: c.id, score: 60 - i })),
    }));

    const out = await rerankSearchHits('query', hits);

    const call = mockRerank.mock.calls[0]?.[0] as { candidates: unknown[] };
    expect(call.candidates).toHaveLength(RERANK_MAX_CANDIDATES);
    expect(out).toHaveLength(60);
    expect(out[0]?.id).toBe('h49'); // reversed scored block first…
    expect(out.slice(50).map((h) => h.id)).toEqual(
      hits.slice(50).map((h) => h.id) // …tail untouched, RRF order
    );
  });

  it('keeps the incoming order when the reranker throws', async () => {
    mockRerank.mockRejectedValue(new Error('boom'));
    mockWarn.mockResolvedValue(true); // "model not installed" path

    const hits = [hit('a', 'Alpha'), hit('b', 'Beta')];
    const out = await rerankSearchHits('query', hits);

    expect(out.map((h) => h.id)).toEqual(['a', 'b']);
  });

  it('scores a singleton and short-circuits only for zero hits', async () => {
    mockRerank.mockResolvedValue({ results: [{ id: 'a', score: 1 }] });

    const single = [hit('a', 'Alpha')];
    expect(await rerankSearchHits('query', single)).toEqual(single);
    expect(mockRerank).toHaveBeenCalledTimes(1);

    mockRerank.mockClear();
    const empty: SearchHit[] = [];
    expect(await rerankSearchHits('query', empty)).toBe(empty);
    expect(mockRerank).not.toHaveBeenCalled();
  });
});
