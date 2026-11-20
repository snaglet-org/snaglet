import { fuseRRF, RRF_K, TITLE_BOOST, RankedCandidate } from '@server/services/search/fuseRRF';

describe('fuseRRF', () => {
  describe('single-channel behavior', () => {
    it('preserves order and computes 1/(k+rank) scores', () => {
      const channel: RankedCandidate[] = [
        { id: 'a', channel: 'vec', rank: 1 },
        { id: 'b', channel: 'vec', rank: 2 },
        { id: 'c', channel: 'vec', rank: 3 },
      ];
      const out = fuseRRF([channel]);
      expect(out.map((r) => r.id)).toEqual(['a', 'b', 'c']);
      expect(out[0].rrfScore).toBeCloseTo(1 / (RRF_K + 1), 10);
      expect(out[1].rrfScore).toBeCloseTo(1 / (RRF_K + 2), 10);
      expect(out[2].rrfScore).toBeCloseTo(1 / (RRF_K + 3), 10);
    });
  });

  describe('two-channel fusion', () => {
    it('rewards docs that appear in both channels', () => {
      const vec: RankedCandidate[] = [
        { id: 'shared', channel: 'vec', rank: 3 },
        { id: 'vec-only', channel: 'vec', rank: 1 },
      ];
      const fts: RankedCandidate[] = [
        { id: 'shared', channel: 'fts', rank: 3 },
        { id: 'fts-only', channel: 'fts', rank: 1 },
      ];
      const out = fuseRRF([vec, fts]);
      expect(out[0].id).toBe('shared');
      expect(out[0].channels.sort()).toEqual(['fts', 'vec']);
      expect(out[0].ranks).toEqual({ vec: 3, fts: 3 });
    });

    it('does not double-count when same doc appears twice in one channel', () => {
      const vec: RankedCandidate[] = [
        { id: 'dup', channel: 'vec', rank: 2 },
        { id: 'dup', channel: 'vec', rank: 5 },
      ];
      const out = fuseRRF([vec]);
      expect(out).toHaveLength(1);
      expect(out[0].ranks.vec).toBe(2);
    });

    it('preserves the best raw score for duplicate candidates in each channel', () => {
      const vector: RankedCandidate[] = [
        { id: 'dup', channel: 'vector', rank: 1, rawScore: 0.61 },
        { id: 'dup', channel: 'vector', rank: 2, rawScore: 0.72 },
      ];
      const fts: RankedCandidate[] = [
        { id: 'dup', channel: 'fts', rank: 1, rawScore: 0.4 },
        { id: 'dup', channel: 'fts', rank: 2, rawScore: 0.8 },
      ];

      const [result] = fuseRRF([vector, fts]);

      expect(result.rawScores).toEqual({ vector: 0.72, fts: 0.8 });
    });
  });

  describe('title boost', () => {
    it('multiplies score by TITLE_BOOST when query is a substring of title', () => {
      const channel: RankedCandidate[] = [
        { id: 'a', channel: 'vec', rank: 1, title: 'How to use workspace_search' },
      ];
      const out = fuseRRF([channel], { query: 'workspace_search' });
      expect(out[0].titleBoosted).toBe(true);
      expect(out[0].score).toBeCloseTo(out[0].rrfScore * TITLE_BOOST, 10);
    });

    it('is case-insensitive and whitespace-tolerant', () => {
      const channel: RankedCandidate[] = [
        { id: 'a', channel: 'vec', rank: 1, title: '  Hybrid   SEARCH design  ' },
      ];
      const out = fuseRRF([channel], { query: 'hybrid search' });
      expect(out[0].titleBoosted).toBe(true);
    });

    it('is not applied when query is absent from title', () => {
      const channel: RankedCandidate[] = [
        { id: 'a', channel: 'vec', rank: 1, title: 'Something else entirely' },
      ];
      const out = fuseRRF([channel], { query: 'hybrid search' });
      expect(out[0].titleBoosted).toBe(false);
      expect(out[0].score).toBeCloseTo(out[0].rrfScore, 10);
    });

    it('is not applied when query is empty', () => {
      const channel: RankedCandidate[] = [{ id: 'a', channel: 'vec', rank: 1, title: 'anything' }];
      const out = fuseRRF([channel], { query: '' });
      expect(out[0].titleBoosted).toBe(false);
    });

    it('can be overridden via titleBoost option', () => {
      const channel: RankedCandidate[] = [{ id: 'a', channel: 'vec', rank: 1, title: 'match me' }];
      const out = fuseRRF([channel], { query: 'match', titleBoost: 2.0 });
      expect(out[0].score).toBeCloseTo(out[0].rrfScore * 2.0, 10);
    });
  });

  describe('tiebreakers', () => {
    it('prefers higher channel-count on equal fused score', () => {
      const vec: RankedCandidate[] = [{ id: 'solo', channel: 'vec', rank: 1 }];
      const fts: RankedCandidate[] = [{ id: 'both', channel: 'fts', rank: 2 }];
      const vec2: RankedCandidate[] = [{ id: 'both', channel: 'vec', rank: 2 }];
      // With k=0: solo score = 1/1 = 1.0; both score = 1/2 + 1/2 = 1.0 — exact tie.
      const out = fuseRRF([vec, fts, vec2], { k: 0 });
      expect(out[0].score).toBeCloseTo(out[1].score, 10);
      expect(out[0].id).toBe('both');
    });

    it('is fully deterministic via lexicographic id on total ties', () => {
      const channel: RankedCandidate[] = [
        { id: 'bravo', channel: 'vec', rank: 1 },
        { id: 'alpha', channel: 'vec', rank: 1 },
      ];
      const out = fuseRRF([channel]);
      expect(out.map((r) => r.id)).toEqual(['alpha', 'bravo']);
    });
  });

  describe('input hygiene', () => {
    it('skips malformed candidates (missing id or invalid rank)', () => {
      const channel = [
        { id: '', channel: 'vec', rank: 1 },
        { id: 'ok', channel: 'vec', rank: 1 },
        { id: 'bad-rank', channel: 'vec', rank: 0 },
        { id: 'nan', channel: 'vec', rank: Number.NaN },
      ] as RankedCandidate[];
      const out = fuseRRF([channel]);
      expect(out.map((r) => r.id)).toEqual(['ok']);
    });

    it('respects limit', () => {
      const channel: RankedCandidate[] = Array.from({ length: 20 }, (_, i) => ({
        id: `d${i}`,
        channel: 'vec',
        rank: i + 1,
      }));
      const out = fuseRRF([channel], { limit: 5 });
      expect(out).toHaveLength(5);
      expect(out.map((r) => r.id)).toEqual(['d0', 'd1', 'd2', 'd3', 'd4']);
    });
  });

  describe('k constant', () => {
    it('defaults to 60 per the RRF paper / design decision', () => {
      expect(RRF_K).toBe(60);
    });
  });
});
