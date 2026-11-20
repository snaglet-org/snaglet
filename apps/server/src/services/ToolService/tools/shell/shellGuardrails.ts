/**
 * Guardrail-2 tuning for the codex shell sessions (exec_command / write_stdin).
 *
 * The `exec_command` tool spawns a long-lived shell session and hands the model
 * a `session_id` to poll with `write_stdin`. Before these guardrails a command
 * that never returned (e.g. an `rg` crawling multi-worktree node_modules) had NO
 * hard cap: the model polled it every few seconds and burned 150+ LLM calls
 * while an operator killed the unix process by hand. Two independent limits stop
 * that class of hang:
 *
 *  1. HARD LIFETIME — every session self-destructs (process-group TERM→KILL)
 *     once it has run longer than the hard cap, no matter how the model polls.
 *  2. IDLE-POLL CIRCUIT BREAKER — N consecutive polls that return no new output
 *     force the session killed, so a degenerate poll-forever loop is cut off.
 *     Background jobs (`run` with `background: true`) are exempt: nobody needs
 *     to poll them, their completion is delivered as a message.
 *
 * The lifetimes are configurable: env sets the defaults, and the system-wide
 * `tool.shell` setting (timeoutMs / maxTimeoutMs / backgroundMaxMs), when
 * a user has set it, wins over env. Nothing can exceed SHELL_TIMEOUT_CEILING_MS.
 */

import { readEnvInt } from '@server/services/ToolService/lib/executionGuards';

/** Shortest hard lifetime a call or a setting can ask for. */
const SHELL_TIMEOUT_MIN_MS = 1_000;

/** Absolute ceiling for any shell lifetime, however it is configured: 4 h. */
export const SHELL_TIMEOUT_CEILING_MS = 4 * 60 * 60_000;

/** Lower clamp for the env-configured lifetimes. */
const ENV_TIMEOUT_MIN_MS = 10_000;

/**
 * Default hard wall-clock limit for a foreground command (a call with no
 * `timeout_ms`). On expiry the whole process group is killed and the tool
 * returns a "command killed" result the model can react to. Default 5 min;
 * clamp 10s..4h, and never above the configured maximum.
 * Env: SNAGLET_SHELL_HARD_TIMEOUT_MS.
 */
export const SHELL_HARD_TIMEOUT_MS = readEnvInt(
  'SNAGLET_SHELL_HARD_TIMEOUT_MS',
  5 * 60_000,
  ENV_TIMEOUT_MIN_MS,
  SHELL_TIMEOUT_CEILING_MS
);

/**
 * Largest `timeout_ms` a foreground command may ask for. Default 30 min;
 * clamp 10s..4h. Env: SNAGLET_SHELL_MAX_TIMEOUT_MS.
 */
export const SHELL_MAX_TIMEOUT_MS = readEnvInt(
  'SNAGLET_SHELL_MAX_TIMEOUT_MS',
  30 * 60_000,
  ENV_TIMEOUT_MIN_MS,
  SHELL_TIMEOUT_CEILING_MS
);

/**
 * Limit for a background job (`background: true`): its default lifetime when
 * the call gives no `timeout_ms`, and the most it may ask for. Default 2 h;
 * clamp 10s..4h. Env: SNAGLET_SHELL_BACKGROUND_MAX_MS.
 */
export const SHELL_BACKGROUND_MAX_MS = readEnvInt(
  'SNAGLET_SHELL_BACKGROUND_MAX_MS',
  2 * 60 * 60_000,
  ENV_TIMEOUT_MIN_MS,
  SHELL_TIMEOUT_CEILING_MS
);

/** Background jobs one agent may have running at once (across its threads). */
export const SHELL_MAX_BACKGROUND_JOBS_PER_AGENT = 3;

/** The `tool.shell` setting keys that tune shell lifetimes (all optional). */
export interface ShellLimitSetting {
  timeoutMs?: number;
  maxTimeoutMs?: number;
  backgroundMaxMs?: number;
}

/** The effective lifetimes for one call. */
export interface ShellLimits {
  /** Foreground hard lifetime when the call gives no `timeout_ms`. */
  defaultTimeoutMs: number;
  /** Largest foreground `timeout_ms`. */
  maxTimeoutMs: number;
  /** Background default lifetime and its maximum. */
  backgroundMaxMs: number;
}

function clampLifetime(value: number): number {
  return Math.max(SHELL_TIMEOUT_MIN_MS, Math.min(SHELL_TIMEOUT_CEILING_MS, Math.floor(value)));
}

function positive(value: unknown): number | null {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * Merge the `tool.shell` setting (null when unset) over the env defaults.
 * The setting wins key by key; the default never exceeds the maximum.
 */
export function resolveShellLimits(setting: ShellLimitSetting | null | undefined): ShellLimits {
  const maxTimeoutMs = clampLifetime(positive(setting?.maxTimeoutMs) ?? SHELL_MAX_TIMEOUT_MS);
  const defaultTimeoutMs = Math.min(
    clampLifetime(positive(setting?.timeoutMs) ?? SHELL_HARD_TIMEOUT_MS),
    maxTimeoutMs
  );
  const backgroundMaxMs = clampLifetime(
    positive(setting?.backgroundMaxMs) ?? SHELL_BACKGROUND_MAX_MS
  );
  return { defaultTimeoutMs, maxTimeoutMs, backgroundMaxMs };
}

/**
 * A per-call `timeout_ms`, clamped to [SHELL_TIMEOUT_MIN_MS, maxMs]; `fallback`
 * when the call gives none (or garbage).
 */
export function clampShellTimeoutMs(value: unknown, fallback: number, maxMs: number): number {
  const n = positive(value);
  if (n === null) return fallback;
  return Math.max(SHELL_TIMEOUT_MIN_MS, Math.min(maxMs, Math.floor(n)));
}

/** "2 h", "30 min", "45 s", "1 h 30 min": a lifetime for the model to read. */
export function formatShellDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.round(ms / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const parts: string[] = [];
  if (hours) parts.push(`${hours} h`);
  if (minutes) parts.push(`${minutes} min`);
  if (seconds || parts.length === 0) parts.push(`${seconds} s`);
  return parts.join(' ');
}

/**
 * Number of consecutive no-new-output polls (write_stdin / exec_command re-yield)
 * that trips the circuit breaker and kills the session. Default 20; clamp 3..200.
 * Env: SNAGLET_SHELL_MAX_IDLE_POLLS.
 */
export const SHELL_MAX_IDLE_POLLS = readEnvInt('SNAGLET_SHELL_MAX_IDLE_POLLS', 20, 3, 200);

/**
 * How much exec_command output a session retains (the newest chars). Output
 * past it is dropped oldest-first and the next read is prefixed with a marker,
 * so a chatty command held for the closed-session TTL can't exhaust memory.
 * Default 1 MiB of text; clamp 64 KiB..8 MiB. Env: SNAGLET_SHELL_OUTPUT_BUFFER_CHARS.
 */
export const SHELL_OUTPUT_BUFFER_CHARS = readEnvInt(
  'SNAGLET_SHELL_OUTPUT_BUFFER_CHARS',
  1024 * 1024,
  64 * 1024,
  8 * 1024 * 1024
);
