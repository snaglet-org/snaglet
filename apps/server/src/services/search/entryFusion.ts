/**
 * Merging a keyword ranking of table rows with a ranking by meaning, shared by
 * the `search` tool and the palette's `entry:` search.
 */

/** Reciprocal-rank-fusion constant: how fast a lower rank stops counting. */
const RRF_K = 60;

export type EntryMatch = 'keyword' | 'meaning' | 'both';

/**
 * Cosine distance beyond which a row is not a meaning match for an agent:
 * the nearest rows always exist, related or not, and an agent pays for noise.
 * Calibrated on the real local embedder (nomic-embed-text-v1.5): related
 * phrases were 0.35-0.45 away, unrelated 0.44-0.70.
 */
export const SEMANTIC_MAX_DISTANCE = 0.46;

/**
 * Meaning hits the palette adds. One cut serves both: on a table of 100 quotes,
 * single words that mean something ("artistic", "love") had a nearest row
 * 0.26-0.44 away, while nonsense ("zebra", "xyzzy", "kubernetes") had none
 * nearer than 0.46, so 0.46 lets the first through and keeps the second out.
 * A cap keeps a vague word that is close to everything ("something
 * sarcastic": all 20 nearest within 0.44) from filling the list.
 */
export const PALETTE_MEANING_HITS = 8;

/**
 * Merge a keyword ranking and a meaning ranking of the same kind of key
 * (`table/entry`) by reciprocal rank fusion: a row in both lists rises, a row
 * in one keeps its place relative to the other's. `semantic` takes the
 * meaning order, falling back to the fused one only when there is no meaning
 * hit.
 */
export function fuseRankings(
  keyword: readonly string[],
  meaning: readonly string[],
  mode: 'hybrid' | 'semantic'
): Array<{ key: string; match: EntryMatch }> {
  const matchOf = (key: string): EntryMatch =>
    keyword.includes(key) ? (meaning.includes(key) ? 'both' : 'keyword') : 'meaning';
  if (mode === 'semantic' && meaning.length)
    return meaning.map((key) => ({ key, match: matchOf(key) }));
  const scores = new Map<string, number>();
  const add = (list: readonly string[]) =>
    list.forEach((key, rank) => scores.set(key, (scores.get(key) ?? 0) + 1 / (RRF_K + rank + 1)));
  add(keyword);
  add(meaning);
  return [...scores.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([key]) => ({ key, match: matchOf(key) }));
}
