/**
 * detectStagnation — semantic repetition detection for agent replies.
 *
 * Primary signal: embedding cosine similarity between the candidate reply and
 * the agent's own recent replies, using the local embedder. Fallback when
 * embeddings are unavailable (local intelligence disabled, no provider,
 * transient failure): token-set Jaccard — order-independent lexical similarity.
 * Neither compares character positions, so paraphrase loops are caught and
 * distinct replies sharing a boilerplate prefix are not.
 *
 * Policy (owned by the caller, finalReply.ts): similarity alone does not
 * auto-pass. An agent accrues a strike per similar reply (the reply still
 * posts) and auto-passes only on `strikesToPass` consecutive strikes; a
 * genuinely different reply resets the count. This makes one echo harmless
 * while still cutting real repetition loops quickly.
 */

export interface StagnationPolicy {
  /**
   * Embedding-cosine threshold. 0.93 start value: high enough that
   * distinct-but-on-topic replies (which often sit 0.75–0.9 on nomic-style
   * embedders) do not strike, low enough to catch true paraphrase loops.
   * Tunable via settings (`dispatch.stagnation_similarity`).
   */
  embeddingThreshold: number;
  /**
   * Token-set Jaccard threshold for the no-embeddings fallback. 0.8 ≈ the
   * reply reuses four of every five distinct words of a previous one —
   * near-copy territory. Paraphrase detection is not expected of this path
   * (that is what embeddings are for).
   */
  jaccardThreshold: number;
  /** Consecutive similar replies before auto-pass. */
  strikesToPass: number;
  /** How many of the agent's own recent replies to compare against. */
  window: number;
}

/** One config block, one place to tune. */
export const STAGNATION_POLICY: StagnationPolicy = {
  embeddingThreshold: 0.93,
  jaccardThreshold: 0.8,
  strikesToPass: 2,
  window: 2,
};

export interface ReplySimilarityResult {
  /** True when the reply is too similar to a recent own reply. */
  similar: boolean;
  /** The highest similarity observed across the window. */
  similarity: number;
  /** Which signal produced the decision. */
  method: 'embedding' | 'jaccard';
}

/** Embeds text; null = embeddings unavailable (caller falls back to Jaccard). */
export type EmbedFn = (text: string) => Promise<number[] | null>;

function normalizeTokens(s: string): Set<string> {
  return new Set(
    s
      .toLowerCase()
      .split(/[^\p{L}\p{N}]+/u)
      .filter((t) => t.length > 0)
  );
}

/** Token-set Jaccard similarity (0–1). Order-independent, positional-free. */
export function tokenSetJaccard(a: string, b: string): number {
  const ta = normalizeTokens(a);
  const tb = normalizeTokens(b);
  if (ta.size === 0 && tb.size === 0) return 1;
  if (ta.size === 0 || tb.size === 0) return 0;
  let intersection = 0;
  for (const t of ta) if (tb.has(t)) intersection++;
  const union = ta.size + tb.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

/** Cosine similarity between two vectors (0 for mismatched/zero vectors). */
export function cosineSimilarity(a: readonly number[], b: readonly number[]): number {
  if (a.length === 0 || a.length !== b.length) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/** Default embedder: the local embedding provider via EmbeddingService. */
async function defaultEmbed(text: string): Promise<number[] | null> {
  // Dynamic import keeps this module dependency-light for unit tests, which
  // inject a deterministic stub instead (the policy is under test, not the
  // embedder).
  const { generateQueryEmbedding } = await import('@server/services/EmbeddingService');
  const result = await generateQueryEmbedding(text);
  return result.embedding;
}

/**
 * Compare a candidate reply against the agent's recent own replies.
 *
 * Embedding-cosine when the embedder yields vectors for the candidate AND at
 * least one prior reply; token-set Jaccard otherwise. Returns the max
 * similarity across the window and whether it crosses the active threshold.
 */
export async function checkReplyStagnation(
  currentReply: string,
  previousReplies: readonly string[],
  opts?: {
    embed?: EmbedFn;
    embeddingThreshold?: number;
    jaccardThreshold?: number;
  }
): Promise<ReplySimilarityResult> {
  const embed = opts?.embed ?? defaultEmbed;
  const embeddingThreshold = opts?.embeddingThreshold ?? STAGNATION_POLICY.embeddingThreshold;
  const jaccardThreshold = opts?.jaccardThreshold ?? STAGNATION_POLICY.jaccardThreshold;

  const window = previousReplies.slice(-STAGNATION_POLICY.window);
  if (window.length === 0) {
    return { similar: false, similarity: 0, method: 'jaccard' };
  }

  let currentVector: number[] | null = null;
  try {
    currentVector = await embed(currentReply);
  } catch {
    currentVector = null;
  }

  if (currentVector && currentVector.length > 0) {
    let best = 0;
    let comparedAny = false;
    for (const prev of window) {
      let prevVector: number[] | null = null;
      try {
        prevVector = await embed(prev);
      } catch {
        prevVector = null;
      }
      if (!prevVector || prevVector.length === 0) continue;
      comparedAny = true;
      best = Math.max(best, cosineSimilarity(currentVector, prevVector));
    }
    if (comparedAny) {
      return { similar: best >= embeddingThreshold, similarity: best, method: 'embedding' };
    }
  }

  // Embeddings unavailable — lexical fallback.
  let best = 0;
  for (const prev of window) {
    best = Math.max(best, tokenSetJaccard(currentReply, prev));
  }
  return { similar: best >= jaccardThreshold, similarity: best, method: 'jaccard' };
}
