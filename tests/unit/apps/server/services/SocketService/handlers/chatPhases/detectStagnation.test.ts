/**
 * Semantic stagnation detection.
 *
 * The policy is under test, not the embedder: embedding-based
 * cases inject a deterministic stub whose vectors have known cosines; the
 * Jaccard fallback cases run with the embedder reporting "unavailable"
 * (null), which is exactly what production does when local intelligence is
 * disabled.
 */

import {
  STAGNATION_POLICY,
  checkReplyStagnation,
  cosineSimilarity,
  tokenSetJaccard,
  type EmbedFn,
} from '@server/services/SocketService/handlers/chatPhases/detectStagnation';

/** Deterministic stub: maps exact strings to fixed vectors. */
function stubEmbed(vectors: Record<string, number[]>): EmbedFn {
  return async (text: string) => vectors[text] ?? null;
}

describe('cosineSimilarity', () => {
  it('is 1 for identical vectors, 0 for orthogonal ones', () => {
    expect(cosineSimilarity([1, 0], [1, 0])).toBeCloseTo(1);
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0);
  });

  it('is 0 for mismatched or empty vectors', () => {
    expect(cosineSimilarity([], [])).toBe(0);
    expect(cosineSimilarity([1, 2], [1, 2, 3])).toBe(0);
    expect(cosineSimilarity([0, 0], [1, 1])).toBe(0);
  });
});

describe('tokenSetJaccard', () => {
  it('is 1 for identical token sets regardless of order', () => {
    expect(tokenSetJaccard('the plan is final', 'final is the plan')).toBe(1);
  });

  it('is 0 for disjoint token sets', () => {
    expect(tokenSetJaccard('alpha beta', 'gamma delta')).toBe(0);
  });

  it('ignores punctuation and case', () => {
    expect(tokenSetJaccard('Ship it, now!', 'ship IT now')).toBe(1);
  });
});

describe('checkReplyStagnation — embedding primary', () => {
  it('catches a paraphrase loop (different words, same content → high cosine)', async () => {
    // The strings share few positional characters, but semantically they are
    // the same point.
    const a = 'I believe we should ship the simpler design first.';
    const b = 'My view: start by releasing the less complex approach.';
    const embed = stubEmbed({ [a]: [0.9, 0.4, 0.1], [b]: [0.88, 0.42, 0.12] }); // cosine ≈ 0.999
    const result = await checkReplyStagnation(a, [b], { embed });
    expect(result.method).toBe('embedding');
    expect(result.similar).toBe(true);
    expect(result.similarity).toBeGreaterThanOrEqual(STAGNATION_POLICY.embeddingThreshold);
  });

  it('does not flag distinct replies sharing a boilerplate prefix', async () => {
    // Distinct replies that open with the same header are not stagnation:
    // distinct embeddings stay below the threshold.
    const header = 'Status update from the infra rotation, covering the last twenty-four hours: ';
    const a = `${header}the database migration completed and latency is back to baseline.`;
    const b = `${header}we are still blocked on the certificate renewal for the edge nodes.`;
    const embed = stubEmbed({ [a]: [1, 0, 0.3], [b]: [0.2, 1, 0] }); // cosine ≈ 0.19
    const result = await checkReplyStagnation(a, [b], { embed });
    expect(result.method).toBe('embedding');
    expect(result.similar).toBe(false);
  });

  it('compares against the whole window and takes the max', async () => {
    const current = 'repeat of the first point';
    const older = 'the first point';
    const newer = 'a totally different aside';
    const embed = stubEmbed({
      [current]: [1, 0],
      [older]: [1, 0.01], // ≈ 1
      [newer]: [0, 1], // 0
    });
    const result = await checkReplyStagnation(current, [older, newer], { embed });
    expect(result.similar).toBe(true);
    expect(result.similarity).toBeGreaterThan(0.99);
  });

  it('respects a custom threshold (settings-tunable)', async () => {
    const a = 'first take';
    const b = 'second take';
    const embed = stubEmbed({ [a]: [1, 0.5], [b]: [1, 0.65] }); // cosine ≈ 0.99…? compute below
    const loose = await checkReplyStagnation(a, [b], { embed, embeddingThreshold: 0.9 });
    const strict = await checkReplyStagnation(a, [b], { embed, embeddingThreshold: 0.999 });
    expect(loose.similar).toBe(true);
    expect(strict.similar).toBe(false);
  });
});

describe('checkReplyStagnation — Jaccard fallback (embeddings unavailable)', () => {
  const noEmbed: EmbedFn = async () => null;

  it('falls back to token-set Jaccard and flags a near-copy', async () => {
    const a = 'the design is finalized and there is nothing further to add';
    const b = 'the design is finalized and there is nothing more to add';
    const result = await checkReplyStagnation(a, [b], { embed: noEmbed });
    expect(result.method).toBe('jaccard');
    expect(result.similar).toBe(true);
  });

  it('does not flag distinct replies sharing a boilerplate prefix', async () => {
    const header = 'Status update from the infra rotation covering the last day:';
    const a = `${header} database migration done, latency back to baseline, closing the incident.`;
    const b = `${header} still blocked on certificate renewal for edge nodes, escalating to networking.`;
    const result = await checkReplyStagnation(a, [b], { embed: noEmbed });
    expect(result.method).toBe('jaccard');
    expect(result.similar).toBe(false);
  });

  it('also falls back when the embedder throws', async () => {
    const boom: EmbedFn = async () => {
      throw new Error('embedder offline');
    };
    const result = await checkReplyStagnation('same words here', ['same words here'], {
      embed: boom,
    });
    expect(result.method).toBe('jaccard');
    expect(result.similar).toBe(true);
  });

  it('returns not-similar for an empty window', async () => {
    const result = await checkReplyStagnation('anything', [], { embed: noEmbed });
    expect(result.similar).toBe(false);
    expect(result.similarity).toBe(0);
  });
});
