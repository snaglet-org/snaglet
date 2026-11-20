/**
 * Pure tokenizer used by the fallback search in ToolView.
 *
 * Lives in its own file (with no DB imports) so it can be unit-tested
 * without dragging the pg connection pool into the test runtime.
 */

/**
 * Split a query into normalized tokens for Layer 3 fallback search.
 *
 * Splits on underscore, hyphen, whitespace, and camelCase boundaries.
 * Drops tokens shorter than 3 chars (too noisy: `to`, `is`, `a`).
 * Lowercases and de-dupes (preserving first-seen order).
 */
export function tokenizeQuery(query: string): string[] {
  if (!query) return [];
  // Insert space before camelCase capital letters: 'readFile' -> 'read File'
  const decamel = query.replace(/([a-z0-9])([A-Z])/g, '$1 $2');
  const raw = decamel
    .toLowerCase()
    .split(/[_\-\s]+/)
    .map((t) => t.trim())
    .filter((t) => t.length >= 3);
  // de-dupe while preserving first-seen order
  const seen = new Set<string>();
  const out: string[] = [];
  for (const t of raw) {
    if (!seen.has(t)) {
      seen.add(t);
      out.push(t);
    }
  }
  return out;
}
