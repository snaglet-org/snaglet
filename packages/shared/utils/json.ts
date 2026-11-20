/**
 * Shared JSON utilities
 */

/** Safely parse a JSON string, returning the fallback on failure. */
export function safeJsonParse<T = unknown>(json: string, fallback: T): T;
export function safeJsonParse<T = unknown>(json: string): T | undefined;
export function safeJsonParse<T = unknown>(json: string, fallback?: T): T | undefined {
  try {
    return JSON.parse(json) as T;
  } catch {
    return fallback;
  }
}
