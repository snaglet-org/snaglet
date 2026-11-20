/**
 * Recall-oriented floor for committed agent search. The local MS MARCO model
 * emits logits rather than probabilities, so callers should display this as a
 * score (higher is better), not a percentage.
 *
 * Calibrated against the live workspace corpus: junk-query maxima stayed at or
 * below -11.18 while representative real-query winners were at least -10.69.
 */
const FLOOR_ENV = Number(process.env.SNAGLET_SEARCH_RERANK_FLOOR);

export const RERANK_RELEVANCE_FLOOR = Number.isFinite(FLOOR_ENV) ? FLOOR_ENV : -11.0;
