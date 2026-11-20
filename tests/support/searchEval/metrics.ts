/** Metrics operate on the displayed order, never on a re-sorted candidate list. */
export interface QueryScore {
  recallAt5: number;
  reciprocalRank: number;
  firstRightRank: number | null;
  tokens: number;
  hits: number;
}
export function scoreQuery(hits: string[], expected: string[], tokens: number): QueryScore {
  const relevant = new Set(expected);
  if (!relevant.size) throw new Error('Each query needs expected results');
  const found = new Set(hits.slice(0, 5).filter((id) => relevant.has(id)));
  const first = hits.findIndex((id) => relevant.has(id));
  return {
    recallAt5: found.size / relevant.size,
    reciprocalRank: first < 0 ? 0 : 1 / (first + 1),
    firstRightRank: first < 0 ? null : first + 1,
    tokens,
    hits: hits.length,
  };
}
export function summarize(scores: QueryScore[]) {
  const sum = (select: (score: QueryScore) => number) => scores.reduce((n, s) => n + select(s), 0);
  const totalTokens = sum((s) => s.tokens);
  const totalHits = sum((s) => s.hits);
  const answered = scores.filter((s) => s.firstRightRank !== null);
  return {
    queries: scores.length,
    recallAt5: scores.length ? sum((s) => s.recallAt5) / scores.length : 0,
    mrr: scores.length ? sum((s) => s.reciprocalRank) / scores.length : 0,
    meanFirstRightRank: answered.length
      ? answered.reduce((n, s) => n + s.firstRightRank!, 0) / answered.length
      : null,
    unanswered: scores.length - answered.length,
    emptyResults: scores.filter((s) => s.hits === 0).length,
    tokensPerSearch: scores.length ? totalTokens / scores.length : 0,
    tokensPerHit: totalHits ? totalTokens / totalHits : null,
    totalTokens,
  };
}
