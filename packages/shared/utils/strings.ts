/**
 * String case conversion utilities
 */

/** Convert a snake_case string to camelCase. */
export function snakeToCamel(s: string): string {
  return s.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
}

/** Convert a camelCase string to snake_case. */
export function camelToSnake(s: string): string {
  return s.replace(/[A-Z]/g, (c) => '_' + c.toLowerCase());
}

/** Convert a display name like "Library Create Page" to snake_case ("library_create_page"). */
export function toSnakeCase(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, '_');
}

/**
 * Slugify an agent display name into its id (the `agents` primary key):
 * lowercase, non-alphanumeric runs → single '-', trim leading/trailing '-'.
 * e.g. "Bob" → "bob", "My Agent" → "my-agent". Do not change it: existing
 * agent ids were derived with this exact algorithm. Returns '' for names with no
 * usable characters (callers must reject an empty slug).
 */
export function slugifyAgentName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/** Returns true if the candidate parses as an http: or https: URL. */
export function isHttpUrl(candidate: string): boolean {
  try {
    const url = new URL(candidate);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

/** Generate a unique ID with an optional prefix. */
export function generateId(prefix = 'id'): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).substring(2, 11)}`;
}

/** Collapse runs of whitespace into single spaces and trim. */
export function normalizeWhitespace(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/**
 * Capitalize the first character of a string; leave the rest unchanged.
 * Returns the input unchanged if empty or falsy.
 * @example capitalize('hello world') // → 'Hello world'
 * @example capitalize('fooBar') // → 'FooBar'
 */
export function capitalize(s: string): string {
  if (!s) return s;
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** Split a comma-separated string into trimmed, non-empty tokens. */
export function parseCsv(raw: string | undefined): string[] {
  return String(raw ?? '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
}

/**
 * Truncate text to `maxLen` characters, breaking at the last word boundary.
 * Normalizes whitespace first. Returns empty string for nullish input.
 */
export function snippet(text: string | null | undefined, maxLen = 220): string {
  if (!text) return '';
  const clean = normalizeWhitespace(text);
  return clean.length <= maxLen ? clean : clean.slice(0, maxLen).replace(/\s+\S*$/, '') + '…';
}

/** Format a pgvector-style literal from a numeric array: `[0.1,0.2,…]`. */
export function vectorLiteral(embedding: number[]): string {
  return `[${embedding.join(',')}]`;
}

/** Join the `text` field of each block with blank-line separators. */
export function flattenTextBlocks(blocks: ReadonlyArray<{ text: string }>): string {
  return blocks.map((b) => b.text).join('\n\n');
}

/**
 * Linear recency score from 1 (now) to 0 (`windowDays` ago), clamped to [0, 1].
 */
export function recencyScore(createdAt: string, windowDays = 120): number {
  const ageMs = Date.now() - new Date(createdAt).getTime();
  const ageDays = ageMs / (1000 * 60 * 60 * 24);
  return Math.max(0, 1 - ageDays / windowDays);
}

/** Escape special regex characters in a string for use in RegExp constructor. */
export function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
