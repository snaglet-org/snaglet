/**
 * General-purpose type guard utilities.
 * Safe to use in both server and client contexts.
 */

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function asNonEmptyString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function asTrimmedString(value: unknown): string | undefined {
  return asNonEmptyString(value) ?? undefined;
}

export function readTrimmedString(value: unknown): string {
  return asNonEmptyString(value) ?? '';
}

export function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === 'string');
}

export function normalizeStringArray(value: unknown): string[] {
  return asStringArray(value)
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

/**
 * Read a required non-empty string from `input[key]`, trimmed.
 * Throws `${key} is required` if missing, non-string, or empty after trim.
 */
export function requireString(input: Record<string, unknown>, key: string): string {
  const value = input[key];
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${key} is required`);
  }
  return value.trim();
}
