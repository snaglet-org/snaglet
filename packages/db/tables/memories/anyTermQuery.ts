/**
 * Any-term lexical query text for the memory hybrid search.
 *
 * `plainto_tsquery` ANDs every lexeme, so a natural query (a thread title plus
 * a message) matches almost no memory. This builds text for
 * `websearch_to_tsquery('english', …)` that ORs the query's words instead.
 * Every non-word character becomes a separator (rewriting
 * `plainto_tsquery(...)::text` would corrupt hyphenated phrase operators);
 * websearch_to_tsquery then drops stopwords, stems and never throws, so the
 * output is always safe to bind.
 *
 * Only the first {@link MAX_QUERY_TERMS} unique words are kept: an OR over a
 * long paste would match nearly every memory. Only the hybrid arm uses this;
 * the keyword-only path and `deleteByQuery` keep the strict all-terms match.
 */
export const MAX_QUERY_TERMS = 32;

export function anyTermQueryText(query: string): string {
  const words = query
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    // "or" is websearch syntax; a literal "or" in the query is a stopword anyway.
    .filter((word) => word.length > 0 && word !== 'or');
  return [...new Set(words)].slice(0, MAX_QUERY_TERMS).join(' or ');
}
