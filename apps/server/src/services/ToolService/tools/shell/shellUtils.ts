/**
 * Shared utilities for shell tool implementations (exec-command, write-stdin).
 */

/**
 * Truncate text to approximate token count using ~4 chars per token heuristic.
 * Keeps the **last** N chars (most recent output) with a truncation marker.
 */
export function truncateToTokens(text: string, maxOutputTokens: number): string {
  const maxChars = Math.max(0, maxOutputTokens * 4);
  if (text.length <= maxChars) return text;
  return `${text.slice(-maxChars)}\n\n[...truncated to last ~${maxOutputTokens} tokens]`;
}

/**
 * Parse a numeric value with fallback and clamping to [min, max] range.
 */
export function readInt(raw: unknown, fallback: number, min: number, max: number): number {
  const value = Number(raw ?? fallback);
  if (!Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(value)));
}
