import { unique } from '@snaglet/shared/utils';

export function parseDelimitedStringList(input: unknown): string[] {
  if (input == null) return [];
  let raw: unknown[];
  if (Array.isArray(input)) {
    raw = input;
  } else if (typeof input === 'string') {
    const trimmed = input.trim();
    // Tolerate a JSON-stringified array (e.g. '["doc", "task"]') — a common
    // failure mode for smaller models that serialize array params as a string.
    if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
      try {
        const parsed = JSON.parse(trimmed);
        raw = Array.isArray(parsed) ? parsed : [trimmed];
      } catch {
        // Not valid JSON — strip brackets and fall back to comma-split.
        raw = trimmed.slice(1, -1).split(',');
      }
    } else {
      raw = trimmed.split(',');
    }
  } else {
    raw = [];
  }
  return raw
    .filter((value): value is string => typeof value === 'string')
    .map((value) => value.trim().toLowerCase())
    .filter((value) => value.length > 0);
}

export function parseEnumList<T extends string>(
  input: unknown,
  allowed: Iterable<T>,
  fallback: readonly T[]
): T[] {
  const allowedSet = new Set<T>(allowed);
  const values = parseDelimitedStringList(input).filter((value): value is T =>
    allowedSet.has(value as T)
  );
  return values.length > 0 ? unique(values) : [...fallback];
}

export function parseEnumValue<T extends string>(
  input: unknown,
  allowed: Iterable<T>,
  fallback: T
): T {
  if (typeof input !== 'string') return fallback;
  const value = input.trim().toLowerCase();
  return new Set<T>(allowed).has(value as T) ? (value as T) : fallback;
}

export function parseIdList(input: unknown, max = 20): string[] {
  if (input == null) return [];
  const raw = Array.isArray(input) ? input : [input];
  const ids = raw
    .filter((value): value is string => typeof value === 'string')
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
  return unique(ids).slice(0, max);
}

export function parseOptionalNonEmptyString(input: unknown): string | null {
  if (typeof input !== 'string') return null;
  const trimmed = input.trim();
  return trimmed.length > 0 ? trimmed : null;
}
