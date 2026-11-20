/**
 * Generic execution guards for the tool executor (guardrails 2 + 3).
 *
 * Every tool execution — builtin handler, workspace/external spawn, MCP call —
 * is raced against a hard timeout and the run's AbortSignal, so a
 * never-returning tool can stall a run for at most the cap instead of forever,
 * and socket:chat:abort reaches INSIDE an in-flight call instead of only the
 * space between iterations. The underlying work is abandoned (JS promises are
 * not cancellable); process-backed tools kill their own children via the shell
 * session guards / spawn signal wiring.
 */

import { getErrorMessage, resolveToolId } from '@snaglet/shared/utils';
import { logger } from '@server/config/logger';

/**
 * Detach an abandoned execution: its eventual settlement does not matter to
 * the run, but a late rejection must not become an unhandled rejection; log
 * it quietly instead.
 */
function detach(work: Promise<unknown>): void {
  void work.catch((err: unknown) => {
    logger.debug(`[tool-guard] abandoned execution settled with error: ${getErrorMessage(err)}`);
  });
}

export function readEnvInt(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name];
  if (raw == null || raw.trim() === '') return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(value)));
}

/**
 * Default hard ceiling for one tool execution. Env: SNAGLET_TOOL_HARD_TIMEOUT_MS
 * (default 5 min; clamp 30s..30min).
 */
export const TOOL_HARD_TIMEOUT_MS = readEnvInt(
  'SNAGLET_TOOL_HARD_TIMEOUT_MS',
  5 * 60_000,
  30_000,
  30 * 60_000
);

/** Clamp bounds for a per-call `timeout_ms` override. */
const PER_CALL_TIMEOUT_MIN_MS = 1_000;
const PER_CALL_TIMEOUT_MAX_MS = 30 * 60_000;

/**
 * Tools that legitimately block longer than the generic default:
 *  - ask parks on a human answer (its own timeout is 10 min).
 */
const TOOL_TIMEOUT_OVERRIDES_MS: Record<string, number> = {
  ask: 11 * 60_000,
};

/** The shell tool and its alias ids (aliases resolve to `shell` first). */
const SHELL_FAMILY: ReadonlySet<string> = new Set([
  'shell',
  'exec_command',
  'write_stdin',
  'shell_exec',
]);

/**
 * Executor guard for the shell family: the 4 h shell ceiling
 * (SHELL_TIMEOUT_CEILING_MS in shellGuardrails, which imports this module, so
 * the value is restated here and pinned by a test) plus a minute.
 *
 * The shell handlers bound their own waits: run and write block for at most
 * `yield_time_ms`, capped by the command's lifetime, and the shell_exec alias
 * waits for exit, capped the same way. Those lifetimes
 * come from the call, the env and the `tool.shell` setting (up to 4 h),
 * and a shell call's `timeout_ms` is the process lifetime, not the call's
 * duration. So the per-call rule below does not apply to shell: this guard
 * is a backstop, and the session's hard timeout owns the real limit.
 */
export const SHELL_CALL_GUARD_MS = 4 * 60 * 60_000 + 60_000;

/**
 * Resolve the effective timeout for one call:
 * per-call `timeout_ms` input > tool settings `timeout_ms` > per-tool override
 * > generic default. Per-call values are clamped to sane bounds. The shell
 * family skips the per-call step (see SHELL_CALL_GUARD_MS).
 */
export function resolveToolTimeoutMs(
  toolName: string,
  input: Record<string, unknown>,
  settings: Record<string, unknown>
): number {
  const canonicalToolName = resolveToolId(toolName).id;
  if (SHELL_FAMILY.has(canonicalToolName)) {
    const fromSettings = Number(settings.timeout_ms);
    if (Number.isFinite(fromSettings) && fromSettings > 0) {
      return Math.max(PER_CALL_TIMEOUT_MIN_MS, Math.min(SHELL_CALL_GUARD_MS, fromSettings));
    }
    return SHELL_CALL_GUARD_MS;
  }
  const perCall = Number(input.timeout_ms);
  if (Number.isFinite(perCall) && perCall > 0) {
    return Math.max(PER_CALL_TIMEOUT_MIN_MS, Math.min(PER_CALL_TIMEOUT_MAX_MS, perCall));
  }
  const fromSettings = Number(settings.timeout_ms);
  if (Number.isFinite(fromSettings) && fromSettings > 0) {
    return Math.max(PER_CALL_TIMEOUT_MIN_MS, Math.min(PER_CALL_TIMEOUT_MAX_MS, fromSettings));
  }
  return TOOL_TIMEOUT_OVERRIDES_MS[canonicalToolName] ?? TOOL_HARD_TIMEOUT_MS;
}

export type GuardedOutcome<T> =
  | { kind: 'ok'; value: T }
  | { kind: 'timeout'; timeoutMs: number }
  | { kind: 'aborted' };

/**
 * Race `work` against a hard timeout and an optional AbortSignal. Resolves with
 * a tagged outcome rather than throwing so the executor can hand the model a
 * structured timeout/abort result it can react to. The abandoned promise gets a
 * no-op catch so a late rejection never becomes an unhandled rejection.
 */
export function withExecutionGuards<T>(
  work: Promise<T>,
  opts: { timeoutMs: number; signal?: AbortSignal }
): Promise<GuardedOutcome<T>> {
  const { timeoutMs, signal } = opts;
  if (signal?.aborted) {
    detach(work);
    return Promise.resolve({ kind: 'aborted' });
  }
  return new Promise<GuardedOutcome<T>>((resolve, reject) => {
    let settled = false;
    const cleanup = (): void => {
      settled = true;
      clearTimeout(timer);
      if (signal && onAbort) signal.removeEventListener('abort', onAbort);
    };
    const finish = (outcome: GuardedOutcome<T>): void => {
      if (settled) return;
      cleanup();
      resolve(outcome);
    };
    const timer = setTimeout(() => {
      detach(work);
      finish({ kind: 'timeout', timeoutMs });
    }, timeoutMs);
    timer.unref?.();
    const onAbort = signal
      ? (): void => {
          detach(work);
          finish({ kind: 'aborted' });
        }
      : null;
    if (signal && onAbort) signal.addEventListener('abort', onAbort, { once: true });
    work.then(
      (value) => finish({ kind: 'ok', value }),
      (err: unknown) => {
        if (settled) return;
        cleanup();
        // Preserve normal rejection semantics for the caller's try/catch.
        reject(err instanceof Error ? err : new Error(getErrorMessage(err)));
      }
    );
  });
}
