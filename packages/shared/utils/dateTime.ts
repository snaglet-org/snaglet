/**
 * Shared date/time utilities used by both frontend and backend
 */

export function formatTimestamp(date: Date = new Date()): string {
  return date.toISOString();
}

export function startOfToday(): Date {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
}

/**
 * Compact relative-time label — "12s ago", "4m ago", "2h ago", "3d ago",
 * or the absolute short date past a week ("Mar 5"). Matches the terse,
 * mono-friendly texture of chat/status surfaces.
 *
 * Differs from {@link formatRelativeTime} which is long-form and Intl-based.
 * Returns the original `iso` string verbatim if it cannot be parsed.
 */
export function relativeFromNow(iso: string): string {
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return iso;
  const s = Math.floor(Math.max(0, elapsedMs(then)) / 1000);
  if (s < 45) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d}d ago`;
  return new Date(then).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

export function formatRelativeTime(input: string | number): string {
  const date = typeof input === 'number' ? new Date(input) : new Date(input);
  const diffMs = Date.now() - date.getTime();
  const diffMin = Math.floor(diffMs / 60000);
  if (diffMin < 1) return 'just now';
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  const diffDay = Math.floor(diffHr / 24);
  if (diffDay < 7) return `${diffDay}d ago`;
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

/**
 * 12-hour clock time: "3:07 PM".
 * Accepts an ISO string or unix-ms number.
 */
export function formatClockTime(input: string | number | Date): string {
  const date = input instanceof Date ? input : new Date(input);
  return date.toLocaleTimeString('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  });
}

/**
 * 24-hour clock time with seconds: "15:07:33".
 * Accepts an ISO string or unix-ms number.
 */
export function formatClockTime24(input: string | number): string {
  const date = typeof input === 'number' ? new Date(input) : new Date(input);
  return date.toLocaleTimeString('en-US', {
    hour12: false,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

/**
 * 12-hour clock time with seconds: "3:07:33 PM".
 * Accepts an ISO string or unix-ms number.
 */
export function formatClockTimeWithSeconds(input: string | number): string {
  const date = typeof input === 'number' ? new Date(input) : new Date(input);
  return date.toLocaleTimeString('en-US', {
    hour12: true,
    hour: 'numeric',
    minute: '2-digit',
    second: '2-digit',
  });
}

/**
 * Short date: "Mar 26, 2026".
 * Accepts an ISO string, unix-ms number, or Date.
 */
export function formatShortDate(input: string | number | Date): string {
  const date = input instanceof Date ? input : new Date(input);
  return date.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

/**
 * Short date + clock time: "Mar 26, 2026 3:07 PM".
 * The canonical "created at / updated at" display — replaces inline
 * `new Date(x).toLocaleString()` calls across the Dashboard.
 * Returns the raw input on parse failure so callers don't have to
 * guard NaN themselves.
 */
export function formatDateTime(input: string | number | Date): string {
  const date = input instanceof Date ? input : new Date(input);
  if (Number.isNaN(date.getTime())) return String(input);
  return `${formatShortDate(date)} ${formatClockTime(date)}`;
}

/**
 * Sleep for `ms` milliseconds. Canonical implementation — use this instead of
 * inline `new Promise(resolve => setTimeout(resolve, ms))` patterns.
 */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Minimum interval allowed for timer triggers (60 s). */
export const MIN_INTERVAL_MS = 60_000;

/**
 * Parse a human-readable interval string like "5m", "1h", "30s" to milliseconds.
 * Returns 0 for unparseable input.
 */
export function parseIntervalToMs(every: string): number {
  const match = every.match(/^(\d+)(s|m|h|d)$/);
  if (!match) return 0;
  const val = parseInt(match[1], 10);
  switch (match[2]) {
    case 's':
      return val * 1000;
    case 'm':
      return val * 60_000;
    case 'h':
      return val * 3_600_000;
    case 'd':
      return val * 86_400_000;
    default:
      return 0;
  }
}

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

/**
 * Long date without year: "Wednesday, March 26".
 * Useful for dashboard headers / greeting screens.
 * Accepts a Date, ISO string, or unix-ms number.
 */
export function formatLongDate(input: string | number | Date): string {
  const d = input instanceof Date ? input : new Date(input);
  return `${DAYS[d.getDay()]}, ${MONTHS[d.getMonth()]} ${d.getDate()}`;
}

/**
 * Milliseconds elapsed since `start` (an epoch-ms number, e.g. from
 * `Date.now()` or a parsed timestamp). Equivalent to `Date.now() - start`.
 *
 * Canonical helper — use this instead of hand-rolling subtraction. Works
 * identically whether `start` is a timer baseline (`const t0 = Date.now()`)
 * or a parsed prior timestamp.
 *
 * @param start epoch milliseconds
 * @returns non-negative number of milliseconds between `start` and now
 *   (returns a negative number if `start` is in the future — caller decides
 *   whether to clamp).
 */
export function elapsedMs(start: number): number {
  return Date.now() - start;
}

/**
 * Current time as an ISO 8601 string. Equivalent to `new Date().toISOString()`.
 *
 * Canonical helper for "timestamp of right now" — use this instead of
 * hand-rolling `new Date().toISOString()`. Keeps the intent ("now, as ISO")
 * obvious at the call site and gives a single seam for testing/mocking.
 *
 * @returns ISO 8601 string for the current instant, e.g. `"2025-01-15T12:34:56.789Z"`.
 */
export function isoNow(): string {
  return new Date().toISOString();
}

/**
 * ISO 8601 string for an arbitrary date/timestamp. Equivalent to
 * `new Date(input).toISOString()` but tolerates being passed an existing
 * `Date` without re-wrapping.
 *
 * Canonical helper — use this instead of hand-rolling `new Date(x).toISOString()`.
 *
 * @param input a `Date`, epoch-ms number, or ISO/parseable string
 * @returns ISO 8601 string for that instant
 * @throws RangeError if `input` does not produce a valid date
 */
export function isoStamp(input: Date | number | string): string {
  const d = input instanceof Date ? input : new Date(input);
  return d.toISOString();
}
