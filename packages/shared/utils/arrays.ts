/**
 * Shared array utilities
 */

/** Deduplicate an array by a key function, keeping the last occurrence. */
export function deduplicateBy<T>(arr: T[], keyFn: (item: T) => string | number): T[] {
  return Array.from(new Map(arr.map((item) => [keyFn(item), item])).values());
}

/**
 * Return an array containing only the unique values from `arr`,
 * preserving first-occurrence order. Uses `Set` equality (===).
 *
 * For object arrays where uniqueness is by a derived key,
 * use {@link deduplicateBy} instead.
 */
export function unique<T>(arr: Iterable<T>): T[] {
  return Array.from(new Set(arr));
}

/**
 * Locale-aware, case-insensitive name order (`"alpha" < "Beta" < "gamma"`),
 * the one rule every name-sorted list in Snaglet uses.
 */
export function compareNames(a: string, b: string): number {
  return a.localeCompare(b, undefined, { sensitivity: 'base' });
}

/** `compareNames` over records with a `name`, for `Array.prototype.sort`. */
export function compareByName(a: { name: string }, b: { name: string }): number {
  return compareNames(a.name, b.name);
}
