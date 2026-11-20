/**
 * Reciprocal Rank Fusion (RRF) for hybrid search.
 *
 * Fuses ranked result lists from multiple retrieval channels (vector search
 * and full-text search) into a single ordered list, then applies a small
 * post-fusion nudge for exact title matches.
 *
 * RRF formula (Cormack et al. 2009):
 *   score(doc) = sum over channels of: 1 / (k + rank_in_channel(doc))
 *
 * k defaults to RRF_K = 60, the canonical value from the original paper.
 *
 * Title boost: if the query (normalized) appears as a substring of the
 * document title (normalized), multiply the fused score by TITLE_BOOST
 * (default 1.15). This is a small, deterministic nudge — not a second fusion
 * channel — so it cannot dominate RRF's ranking logic.
 */

export const RRF_K = 60;
export const TITLE_BOOST = 1.15;

export interface RankedCandidate {
  /** Stable identifier used to dedupe the same document across channels. */
  id: string;
  /** Channel this rank came from (for debugging / telemetry). */
  channel: string;
  /** 1-indexed rank within this channel (1 = best). */
  rank: number;
  /** Channel-native confidence when available (cosine similarity for vector). */
  rawScore?: number;
  /** Optional title, used for the post-fusion exact-substring boost. */
  title?: string | null;
  /** Arbitrary payload the caller wants to keep attached. */
  payload?: unknown;
}

export interface FusedResult<P = unknown> {
  id: string;
  /** Final fused score after RRF sum and title boost. */
  score: number;
  /** Score before title boost (useful for debugging / eval attribution). */
  rrfScore: number;
  /** True if the title-exact-substring boost was applied. */
  titleBoosted: boolean;
  /** The set of channels that contributed to this doc's fused score. */
  channels: string[];
  /** Per-channel rank contribution (channel -> rank). */
  ranks: Record<string, number>;
  /** Best channel-native score observed per channel. */
  rawScores: Record<string, number>;
  /** Passthrough of the first payload we saw for this id. */
  payload: P | undefined;
  /** Passthrough of the first title we saw for this id. */
  title: string | null;
}

export interface FuseRRFOptions {
  /** Override the RRF constant k. Defaults to RRF_K (60). */
  k?: number;
  /** Override the title-boost multiplier. Defaults to TITLE_BOOST (1.15). */
  titleBoost?: number;
  /** Query string used for the title-exact-substring nudge. If omitted or
   *  empty, no title boost is applied. */
  query?: string;
  /** Maximum results to return after fusion. If omitted, returns all. */
  limit?: number;
}

/**
 * Normalize a string for case-insensitive substring comparison.
 * Lowercase + collapse whitespace. NFKC to fold fullwidth / compat forms.
 */
function normalize(s: string): string {
  return s.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();
}

/**
 * Fuse N ranked candidate lists via Reciprocal Rank Fusion.
 *
 * Tiebreakers (applied in order when two docs have equal fused scores):
 *   1. Higher channel-count first (appeared in more channels = stronger signal).
 *   2. Lower best-rank first (best single-channel rank wins).
 *   3. Lexicographic id (fully deterministic final tiebreaker).
 */
export function fuseRRF<P = unknown>(
  channelResults: RankedCandidate[][],
  options: FuseRRFOptions = {}
): FusedResult<P>[] {
  const k = options.k ?? RRF_K;
  const titleBoost = options.titleBoost ?? TITLE_BOOST;
  const normalizedQuery = options.query ? normalize(options.query) : '';

  // Accumulate fused state keyed by document id.
  const acc = new Map<string, FusedResult<P>>();

  for (const channel of channelResults) {
    for (const cand of channel) {
      if (!cand || typeof cand.id !== 'string' || cand.id.length === 0) continue;
      if (!Number.isFinite(cand.rank) || cand.rank < 1) continue;

      const contribution = 1 / (k + cand.rank);
      const existing = acc.get(cand.id);

      if (existing) {
        // Same id appeared in a second (or later) channel.
        existing.rrfScore += contribution;
        if (!existing.channels.includes(cand.channel)) {
          existing.channels.push(cand.channel);
        }
        // Keep the BEST (lowest) rank per channel if the same channel
        // duplicates an id (shouldn't happen but defensive).
        const prior = existing.ranks[cand.channel];
        if (prior === undefined || cand.rank < prior) {
          existing.ranks[cand.channel] = cand.rank;
        }
        if (
          cand.rawScore !== undefined &&
          (existing.rawScores[cand.channel] === undefined ||
            cand.rawScore > existing.rawScores[cand.channel])
        ) {
          existing.rawScores[cand.channel] = cand.rawScore;
        }
        if (existing.title == null && cand.title != null) {
          existing.title = cand.title;
        }
      } else {
        acc.set(cand.id, {
          id: cand.id,
          score: 0, // filled in below after title boost
          rrfScore: contribution,
          titleBoosted: false,
          channels: [cand.channel],
          ranks: { [cand.channel]: cand.rank },
          rawScores: cand.rawScore === undefined ? {} : { [cand.channel]: cand.rawScore },
          payload: cand.payload as P | undefined,
          title: cand.title ?? null,
        });
      }
    }
  }

  // Apply title boost and finalize score.
  for (const row of acc.values()) {
    let finalScore = row.rrfScore;
    if (normalizedQuery && row.title) {
      const normTitle = normalize(row.title);
      if (normTitle.includes(normalizedQuery)) {
        finalScore = row.rrfScore * titleBoost;
        row.titleBoosted = true;
      }
    }
    row.score = finalScore;
  }

  // Sort with deterministic tiebreakers.
  const sorted = Array.from(acc.values()).sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    if (b.channels.length !== a.channels.length) return b.channels.length - a.channels.length;
    const aBest = Math.min(...Object.values(a.ranks));
    const bBest = Math.min(...Object.values(b.ranks));
    if (aBest !== bBest) return aBest - bBest;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });

  return options.limit ? sorted.slice(0, options.limit) : sorted;
}
