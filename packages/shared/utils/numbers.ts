/**
 * Shared number parsing utilities used by both frontend and backend.
 */

export function parseOptionalPositiveInt(value: unknown, fieldName: string): number | undefined {
  if (value === undefined || value === null) return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 1) {
    throw new Error(`${fieldName} must be a positive integer`);
  }
  return Math.floor(parsed);
}

export function requirePositiveInt(value: unknown, fieldName: string): number {
  const parsed = parseOptionalPositiveInt(value, fieldName);
  if (parsed === undefined) {
    throw new Error(`${fieldName} must be a positive integer`);
  }
  return parsed;
}

/** Human-readable uptime: "3d 2h 15m 7s". */
export function formatUptime(seconds: number): string {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  const parts: string[] = [];
  if (d > 0) parts.push(`${d}d`);
  if (h > 0) parts.push(`${h}h`);
  if (m > 0) parts.push(`${m}m`);
  if (s > 0 || parts.length === 0) parts.push(`${s}s`);
  return parts.join(' ');
}

/** Human-readable byte size: "1.5 MB", "320 KB", etc. */
export function formatBytes(bytes: number): string {
  const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
  if (bytes === 0) return '0 Bytes';
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), sizes.length - 1);
  return Math.round((bytes / Math.pow(1024, i)) * 100) / 100 + ' ' + sizes[i];
}

/** Coerce `value` to a finite number, returning `fallback` if NaN / Infinity / non-numeric. */
export function asFiniteNumber(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

/**
 * Parse an unknown value as an integer clamped to `[min, max]`.
 * Returns `fallback` when the value is missing, NaN, or non-finite.
 *
 * Designed for query-string / tool-input parsing:
 * ```
 * const limit = clampInt(req.query.limit, 20, 1, 50);
 * ```
 */
export function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  const raw = Number(value ?? fallback);
  const n = Number.isFinite(raw) ? raw : fallback;
  return Math.min(Math.max(Math.floor(n), min), max);
}
