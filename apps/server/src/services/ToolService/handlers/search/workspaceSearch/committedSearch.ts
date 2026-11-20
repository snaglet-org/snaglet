/**
 * committedSearch — the shared finish pipeline for agent-facing
 * workspace_search. Both the semantic/hybrid and
 * the lexical (keyword) committed paths funnel their hydrated candidate POOL
 * through here so ranking, evidence, and the quality floor stay consistent.
 *
 * Order of operations (pool-level, before the final cut to `limit`):
 *   1. (semantic paths only) cross-encoder rerank a bounded pool → relevance
 *      order + raw scores;
 *   2. build candidate cards for the pool (batched SQL, fixed query count);
 *   3. (semantic paths only) quality floor on the cross-encoder score: hits
 *      below the floor are withheld ("weak matches"); if nothing clears the
 *      floor the caller renders an honest empty state.
 *
 * The floor is a semantic-relevance gate, so it applies only to reranked
 * (semantic/hybrid) paths. The lexical path is exact-match by nature: a
 * container/tool name matching a literal query term is a good hit even if a
 * semantic judge scores it low — so keyword search gets no cross-encoder floor.
 */

import {
  buildCandidateCards,
  toCardCandidate,
  type CandidateCard,
  type CandidateCardContext,
} from '@server/services/search/candidateCards';
import { RERANK_RELEVANCE_FLOOR } from '@server/services/reranking/rerankQuality';
import { rerankSearchHitsScored } from './rerankHits';
import type { SearchHit } from './types';

function isStructuredConstraintHit(hit: SearchHit): boolean {
  return 'channels' in hit && hit.channels?.includes('structured') === true;
}

/**
 * Cross-encoder score floor (ms-marco-MiniLM-L6-v2 logit). Derived from the
 * live score distribution (a read-only calibration bench over ~14
 * representative queries): genuine-gibberish queries top out at ≤ -11.18 while
 * every real query's best candidate scored ≥ -10.69 — a clean separating
 * window. -11.0 sits inside it with ~0.3 good-side margin and ~0.18 junk-side
 * margin, and it also trims each pool's noise tail (real-query pools park most
 * of their candidates at the reranker's ~-11.4 floor). Env-overridable for ops
 * tuning without a redeploy.
 */
export const COMMITTED_RERANK_FLOOR = RERANK_RELEVANCE_FLOOR;

/**
 * How many pool candidates to hand the cross-encoder per committed search.
 * Bounded to keep p50 within the latency budget (rerank cost is linear in
 * candidates); a buffer over `limit` gives the reranker enough of the RRF pool
 * to promote a relevant item across the final cut. Measured: 16 holds committed
 * p50 ≈ 1.18× baseline (24 pushed
 * it to ~1.53×, over the ≤1.5× budget). Capped at RERANK_MAX_CANDIDATES.
 */
export const COMMITTED_RERANK_POOL = 16;

export interface CommittedSearchResult {
  /** Final hits, cut to `limit`, in relevance order (strong matches only). */
  hits: SearchHit[];
  /** Cards keyed by hit id — for the per-result evidence lines. */
  cardById: Map<string, CandidateCard>;
  /** Candidates that were reordered before the final cut (pool size, ≤ rerank pool). */
  consideredCount: number;
  /** Count withheld below the quality floor (0 unless the floor applied). */
  weakCut: number;
  /** True when the cross-encoder floor actually ran (reranker online, semantic path). */
  floorApplied: boolean;
}

export async function finishCommittedSearch(args: {
  query: string;
  hits: SearchHit[];
  limit: number;
  cardContext: CandidateCardContext;
  includeArchived: boolean;
  /** true = semantic/hybrid (rerank + quality floor); false = lexical evidence only. */
  semanticPath: boolean;
  rerankPoolSize?: number;
}): Promise<CommittedSearchResult> {
  const { query, hits, limit } = args;
  if (hits.length === 0) {
    return { hits: [], cardById: new Map(), consideredCount: 0, weakCut: 0, floorApplied: false };
  }

  const poolSize = Math.min(hits.length, args.rerankPoolSize ?? COMMITTED_RERANK_POOL);
  const pool = hits.slice(0, poolSize);
  const tail = hits.slice(poolSize);

  // 1. Rerank (semantic paths only) → relevance order + raw cross-encoder scores.
  let ordered = pool;
  let scoreById = new Map<string, number>();
  if (args.semanticPath) {
    const reranked = await rerankSearchHitsScored(query, pool);
    ordered = reranked.items;
    scoreById = reranked.scoreById;
  }

  // A structured hit satisfies an authoritative filter (an exact-match lane
  // rather than a similarity lane). Keep those exact matches
  // ahead of similarity-ranked candidates; the cross-encoder may still score
  // them for diagnostics, but it must not undo the caller's explicit filter.
  ordered = [
    ...ordered.filter(isStructuredConstraintHit),
    ...ordered.filter((hit) => !isStructuredConstraintHit(hit)),
  ];

  // 2. Cards for the (reranked) pool — batched, fixed query count.
  const cardById = await buildCandidateCards(
    ordered.map((hit, index) =>
      toCardCandidate(hit as unknown as Record<string, unknown>, index + 1)
    ),
    args.cardContext
  );

  const rerankedHits: SearchHit[] = [...ordered, ...tail];

  // 3. Quality floor (semantic paths only; skipped when the caller wants archived
  //    digs, and skipped entirely when the reranker is offline → no scores).
  const floorEligible = args.semanticPath && !args.includeArchived && scoreById.size > 0;
  let strong = rerankedHits;
  let weakCut = 0;
  if (floorEligible) {
    // Unscored items (the un-reranked tail) are never punished — the floor is a
    // precision gate, not a way to hide results the judge never saw.
    strong = rerankedHits.filter((hit) => {
      if (isStructuredConstraintHit(hit)) return true;
      const score = scoreById.get(hit.id);
      return score === undefined || score >= COMMITTED_RERANK_FLOOR;
    });
    weakCut = rerankedHits.length - strong.length;
  }

  return {
    hits: strong.slice(0, limit),
    cardById,
    consideredCount: rerankedHits.length,
    weakCut,
    floorApplied: floorEligible,
  };
}

/**
 * Honest empty state: the pool held candidates but none cleared the
 * relevance floor. Tells the agent what to try instead of returning ten
 * confident look-alikes.
 */
export function renderHonestEmpty(query: string, weakCut: number): string {
  return [
    `No strongly-relevant matches for "${query}".`,
    `${weakCut} weaker candidate(s) fell below the relevance floor and were withheld. To find it, try:`,
    `  - rephrasing with the key terms, or an exact "quoted phrase"`,
    `  - a different mode (mode:"hybrid" for concepts, mode:"keyword" for exact words)`,
    `  - widening scope (container_id:"root" for the whole workspace) or naming a kind (kinds:["doc"|"memory"|"thread_summary"])`,
  ].join('\n');
}

/** One-line footer noting weak matches were withheld (shown when strong hits remain). */
export function weakMatchesFooter(weakCut: number): string {
  return `(${weakCut} weaker match(es) below the relevance floor withheld — rephrase, or set mode/kinds/scope to see them.)`;
}
