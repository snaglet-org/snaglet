/**
 * When a timed pause of a subagent helper ends, from the `for` ("15m",
 * "2h", "1h30m") or `until` (an ISO date-time) its caller gave. Pure, so the
 * tool's and the REST route's parsing is pinned by unit tests.
 */
import { SubagentError } from './errors';

/** Shortest timed pause: the resume check runs once a minute. */
const PAUSE_MIN_MS = 60_000;
/** Longest timed pause. A timed helper is exempt from the idle sweep, so this bounds how long one lingers. */
export const PAUSE_MAX_MS = 7 * 24 * 60 * 60_000;

const SECOND = 1_000;
const MINUTE = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;

const UNIT_MS: Record<string, number> = {
  s: 1_000,
  sec: 1_000,
  secs: 1_000,
  second: 1_000,
  seconds: 1_000,
  m: 60_000,
  min: 60_000,
  mins: 60_000,
  minute: 60_000,
  minutes: 60_000,
  h: 3_600_000,
  hr: 3_600_000,
  hrs: 3_600_000,
  hour: 3_600_000,
  hours: 3_600_000,
  d: 86_400_000,
  day: 86_400_000,
  days: 86_400_000,
};

const SEGMENT = /(\d+(?:\.\d+)?)\s*([a-z]+)/g;
const ISO_DURATION =
  /^p(?:(\d+(?:\.\d+)?)d)?(?:t(?:(\d+(?:\.\d+)?)h)?(?:(\d+(?:\.\d+)?)m)?(?:(\d+(?:\.\d+)?)s)?)?$/;
/** A date and a time, optionally seconds, fraction and zone. A missing zone reads as server-local. */
const ISO_DATE_TIME =
  /^\d{4}-\d{2}-\d{2}[t ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:z|[+-]\d{2}(?::?\d{2})?)?$/;

/**
 * A pause length in milliseconds: one or more number+unit pieces ("15m",
 * "2h", "1h 30m", "90 minutes", "1.5 hours") or an ISO 8601 duration
 * ("PT15M"). Null when it is not one.
 */
export function parsePauseDuration(raw: string): number | null {
  const text = raw.trim().toLowerCase();
  if (!text) return null;
  const iso = ISO_DURATION.exec(text);
  if (iso && text !== 'p' && text !== 'pt') {
    const [, d, h, m, s] = iso;
    return (
      Number(d ?? 0) * DAY +
      Number(h ?? 0) * HOUR +
      Number(m ?? 0) * MINUTE +
      Number(s ?? 0) * SECOND
    );
  }
  let total = 0;
  let matched = 0;
  for (const match of text.matchAll(SEGMENT)) {
    const unit = UNIT_MS[match[2] ?? ''];
    if (unit === undefined) return null;
    total += Number(match[1]) * unit;
    matched += 1;
  }
  // Only pieces, separated by spaces, commas or "and".
  const rest = text
    .replace(SEGMENT, '')
    .replace(/\band\b|,/g, '')
    .trim();
  return matched > 0 && rest === '' ? total : null;
}

function afterLength(text: string, now: Date): number {
  const ms = parsePauseDuration(text);
  if (ms === null) {
    throw new SubagentError(`for must be a length such as "15m", "2h" or "1h30m" (got "${text}").`);
  }
  if (ms < PAUSE_MIN_MS) throw new SubagentError('for must be at least 1 minute.');
  return now.getTime() + ms;
}

function atTime(text: string, now: Date): number {
  const parsed = ISO_DATE_TIME.test(text.toLowerCase()) ? Date.parse(text) : Number.NaN;
  if (Number.isNaN(parsed)) {
    throw new SubagentError(
      `until must be an ISO date and time such as "2026-10-13T15:00:00Z" (got "${text}").`
    );
  }
  if (parsed <= now.getTime()) throw new SubagentError('until must be in the future.');
  return parsed;
}

export interface PauseTimeInput {
  /** A length: "15m", "2h", "1h30m". */
  for?: unknown;
  /** An ISO date-time, e.g. "2026-10-13T15:00:00Z". */
  until?: unknown;
}

function readOptional(value: unknown, field: string): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') throw new SubagentError(`${field} must be a string.`);
  const text = value.trim();
  return text ? text : null;
}

/**
 * When the pause ends, or null for a pause with no timer (neither given).
 * Throws SubagentError, phrased for the caller, on a bad or out-of-range value.
 */
export function resolveResumeAt(input: PauseTimeInput, now: Date = new Date()): Date | null {
  const forText = readOptional(input.for, 'for');
  const untilText = readOptional(input.until, 'until');
  if (forText && untilText) throw new SubagentError('give for or until, not both.');

  const at = forText ? afterLength(forText, now) : untilText ? atTime(untilText, now) : null;
  if (at === null) return null;
  if (at - now.getTime() > PAUSE_MAX_MS) {
    throw new SubagentError('a timed pause can last at most 7 days.');
  }
  return new Date(at);
}
