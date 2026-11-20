import { randomBytes, randomUUID } from 'crypto';
import type { ToolHandler } from '@server/services/ToolService/types';
import { resolveToolCwd } from '@server/services/ToolService/lib/resolveToolCwd';
import { buildShellEnv, type ShellEnvAgent } from '@server/services/ToolService/lib/buildSafeEnv';
import { resolveGitUserEmail } from '@server/services/ToolService/lib/gitUserEmail';
import { readInt, truncateToTokens } from './shellUtils';
import {
  getShellSessionExitCode,
  getShellSessionKillReason,
  isShellSessionClosed,
  listRunningBackgroundShellJobs,
  readShellSessionOutput,
  startShellSession,
  waitForShellSessionClose,
  type ShellKillReason,
  type ShellSessionEnd,
} from './codex-shell-sessions';
import {
  SHELL_MAX_BACKGROUND_JOBS_PER_AGENT,
  clampShellTimeoutMs,
  formatShellDuration,
  resolveShellLimits,
} from './shellGuardrails';
import { gitRefusal } from './gitSafety';
import { recursiveGrepHint } from './grepHint';
import { keepRunAlive } from './runKeepAlive';
import { getBackgroundJobReporter, type BackgroundJobStart } from './backgroundJobs';
import { settingsService } from '@server/services/settings';
import { toolSettings } from '@server/services/settings/categories/tool';
import { isHelperAgent } from '@server/services/subagents/helperVisibility';

/**
 * Agent identity for the shell env, read from this call's own context (never
 * module state). Absent for human-panel executions that borrow an agent's
 * context (bypassToolAccess) and for calls without a runtime, so only real
 * agent runs get the per-run git identity.
 */
function shellAgent(context: Parameters<ToolHandler>[2], cwd?: string): ShellEnvAgent | null {
  if (!context?.agentId || context.bypassToolAccess) return null;
  return {
    id: context.agentId,
    name: context.runtime?.agentName,
    email: resolveGitUserEmail(cwd),
  };
}

/** Default wait before a foreground `run` hands back a session id. */
const RUN_DEFAULT_YIELD_MS = 10_000;
/**
 * A background `run` waits this long (default; `yield_time_ms` may set
 * 250 ms..10 s) before returning, so a command that fails at once reports its
 * error in the same call instead of as a later message.
 */
const BACKGROUND_DEFAULT_YIELD_MS = 1_000;
const BACKGROUND_MAX_YIELD_MS = 10_000;

function describeKill(reason: ShellKillReason): string {
  switch (reason) {
    case 'hard-timeout':
      return 'Process was KILLED: it exceeded its hard time limit. If you need longer, re-run with a larger timeout_ms (or background: true); otherwise use a narrower/faster command.';
    case 'idle-poll-breaker':
      return 'Process was KILLED: repeated polls returned no new output (stalled command). Do not keep polling — try a different approach.';
    case 'abort':
      return 'Process was KILLED: the run was stopped.';
    case 'owner-removed':
      return 'Process was KILLED: its agent was archived or deleted.';
    case 'shutdown':
      return 'Process was KILLED: the server is shutting down.';
  }
}

function formatResult(input: {
  chunkId: string;
  wallMs: number;
  code: number | null;
  sessionId?: number;
  output: string;
  maxOutputTokens: number;
  killReason?: ShellKillReason | null;
  hint?: string | null;
  /** Extra lines after the status line (the background job notice). */
  notes?: string[];
}): string {
  const lines: string[] = [];
  lines.push(`Chunk ID: ${input.chunkId}`);
  lines.push(`Wall time: ${(input.wallMs / 1000).toFixed(4)} seconds`);
  if (input.code === null && input.sessionId != null) {
    lines.push(`Process running with session ID ${input.sessionId}`);
  } else {
    lines.push(`Process exited with code ${input.code ?? 0}`);
  }
  if (input.killReason) {
    lines.push(describeKill(input.killReason));
  }
  if (input.notes) lines.push(...input.notes);
  if (input.hint) lines.push(input.hint);
  lines.push('Output:');
  lines.push(truncateToTokens(input.output, input.maxOutputTokens));
  return lines.join('\n');
}

function resolveCwd(input: Record<string, unknown>, context: Parameters<ToolHandler>[2]): string {
  return resolveToolCwd(
    input.workdir != null
      ? String(input.workdir)
      : input.cwd != null
        ? String(input.cwd)
        : undefined,
    context
  );
}

/**
 * The `shell_exec` contract, for calls that arrive through the shell_exec
 * alias (saved hooks and MCP clients may depend on it): block until the
 * command exits, a non-zero exit or timeout is a failure, and the output is
 * plain text with no envelope. Timeout resolution:
 * system setting → per-tool settings → 10 s default (a per-call timeout_ms is
 * also honored), clamped to the configured maximum.
 */
async function runLegacyShellExec(
  input: Record<string, unknown>,
  settings: Record<string, unknown> | undefined,
  context: Parameters<ToolHandler>[2]
): Promise<string> {
  const cmd = String(input.cmd ?? input.command ?? '').trim();
  if (!cmd) throw new Error('command is required');
  if (input.background === true) {
    throw new Error('shell_exec waits for the command to exit; use shell op:"run" for background.');
  }
  const cwd = resolveCwd(input, context);
  const cfg = await settingsService.readOptional(toolSettings.shell);
  const limits = resolveShellLimits(cfg);
  const timeoutMs = clampShellTimeoutMs(
    input.timeout_ms ??
      cfg?.timeoutMs ??
      Number(settings?.timeoutMs ?? toolSettings.shell.default.timeoutMs),
    limits.defaultTimeoutMs,
    limits.maxTimeoutMs
  );
  const maxBufferKb =
    cfg?.maxBufferKb ?? Number(settings?.maxBufferKb ?? toolSettings.shell.default.maxBufferKb);

  const session = startShellSession({
    cmd,
    cwd,
    env: buildShellEnv({}, shellAgent(context, cwd)),
    threadId: context?.threadId ?? null,
    agentId: context?.agentId ?? null,
    hardTimeoutMs: timeoutMs,
  });
  // Wait a little past the hard limit so the kill is observed, not raced.
  const stopKeepAlive = keepRunAlive(context?.threadId);
  try {
    await waitForShellSessionClose(session.id, timeoutMs + 1_000);
  } finally {
    stopKeepAlive();
  }
  const raw = readShellSessionOutput(session.id);
  const maxChars = maxBufferKb * 1024;
  const output = raw.length > maxChars ? raw.slice(0, maxChars) : raw;

  const killReason = getShellSessionKillReason(session.id);
  if (!isShellSessionClosed(session.id) || killReason === 'hard-timeout') {
    throw new Error(`Command timed out after ${timeoutMs}ms: ${cmd}`);
  }
  if (killReason) throw new Error(`Command was killed (${killReason}): ${cmd}`);
  const code = getShellSessionExitCode(session.id);
  if (code !== 0) {
    const detail = output.trim();
    throw new Error(
      `Command failed (exit code ${code ?? 'unknown'}): ${cmd}${detail ? `\n${detail}` : ''}`
    );
  }
  return output.trim() || '(no output)';
}

/** Says so when the call asked for more than the maximum lifetime (null otherwise). */
function clampNote(requested: unknown, maxMs: number, what: string): string | null {
  const n = Number(requested);
  if (!Number.isFinite(n) || n <= maxMs) return null;
  return `timeout_ms is over the ${what} maximum of ${formatShellDuration(maxMs)}; using ${formatShellDuration(maxMs)}.`;
}

/** One line per running job, for the cap refusal: id, how long, pid, command. */
function describeRunningJobs(agentId: string): string {
  const now = Date.now();
  return listRunningBackgroundShellJobs(agentId)
    .map((job) => {
      const command = (job.command.split('\n')[0] ?? '').slice(0, 120);
      const pid = job.pid != null ? `, pid ${job.pid}` : '';
      return `- session ${job.id} (running ${formatShellDuration(now - job.startedAt)}${pid}): ${command}`;
    })
    .join('\n');
}

/**
 * `run` with `background: true`: start the command detached and return at
 * once. The job keeps its own lifetime (timeout_ms, else the background
 * maximum), is exempt from the idle-poll breaker and from Stop, and its agent
 * is told when it ends (BackgroundJobReporter). The same guards ran before
 * this point as for a foreground run: the permission guard (executor), the
 * git rail and the cwd resolution.
 */
async function runInBackground(input: {
  cmd: string;
  cwd: string;
  shell: string | undefined;
  timeoutMs: unknown;
  yieldTimeMs: unknown;
  maxOutputTokens: number;
  backgroundMaxMs: number;
  context: Parameters<ToolHandler>[2];
}): Promise<string> {
  const threadId = input.context?.threadId;
  const agentId = input.context?.agentId;
  if (!threadId || !agentId) {
    throw new Error(
      'background: true needs an agent in a thread to report back to; run in the foreground instead.'
    );
  }
  const reporter = getBackgroundJobReporter();
  if (!reporter) {
    throw new Error(
      'Background jobs are not available on this server; run in the foreground instead.'
    );
  }
  if (await isHelperAgent(agentId)) {
    throw new Error(
      'Subagent helpers cannot start background jobs: a helper is done when its turn ends. Run in the foreground (raise timeout_ms and yield_time_ms) instead.'
    );
  }
  const limitMs = clampShellTimeoutMs(
    input.timeoutMs,
    input.backgroundMaxMs,
    input.backgroundMaxMs
  );
  const yieldTimeMs = readInt(
    input.yieldTimeMs,
    BACKGROUND_DEFAULT_YIELD_MS,
    250,
    BACKGROUND_MAX_YIELD_MS
  );

  // The cap check and the spawn below are synchronous together, so two
  // parallel calls cannot both slip under the cap.
  const running = listRunningBackgroundShellJobs(agentId);
  if (running.length >= SHELL_MAX_BACKGROUND_JOBS_PER_AGENT) {
    throw new Error(
      `Refused: you already have ${running.length} background jobs running (the most at once is ${SHELL_MAX_BACKGROUND_JOBS_PER_AGENT}):\n` +
        `${describeRunningJobs(agentId)}\n` +
        'Wait for one to finish (its result arrives as a message), or stop one with `kill -TERM -<pid>`, then retry.'
    );
  }

  const t0 = Date.now();
  const chunkId = randomBytes(4).toString('hex');
  // Until the start window closes, an end is reported in this call's own
  // result; after it, through the reporter.
  let phase: 'starting' | 'running' = 'starting';
  let job: BackgroundJobStart | null = null;
  const session = startShellSession({
    cmd: input.cmd,
    cwd: input.cwd,
    shell: input.shell,
    env: buildShellEnv({}, shellAgent(input.context, input.cwd)),
    threadId,
    agentId,
    hardTimeoutMs: limitMs,
    background: true,
    onEnd: (end: ShellSessionEnd) => {
      if (phase === 'running' && job) reporter.ended(job, end);
    },
  });
  job = {
    jobId: randomUUID(),
    sessionId: session.id,
    threadId,
    agentId,
    command: input.cmd,
    cwd: input.cwd,
    pid: session.child.pid ?? null,
    startedAt: session.startedAt,
    limitMs,
  };

  await waitForShellSessionClose(session.id, yieldTimeMs);
  const output = readShellSessionOutput(session.id);
  if (isShellSessionClosed(session.id)) {
    // Over before the window closed: this result is the report.
    const killReason = getShellSessionKillReason(session.id);
    return formatResult({
      chunkId,
      wallMs: Date.now() - t0,
      code: getShellSessionExitCode(session.id),
      output,
      maxOutputTokens: input.maxOutputTokens,
      killReason,
    });
  }
  phase = 'running';
  await reporter.started(job);
  const pid = job.pid != null ? ` (pid ${job.pid})` : '';
  const clamped = clampNote(input.timeoutMs, input.backgroundMaxMs, 'background');
  return formatResult({
    chunkId,
    wallMs: Date.now() - t0,
    code: null,
    sessionId: session.id,
    output,
    maxOutputTokens: input.maxOutputTokens,
    notes: [
      `Running in the background${pid}; it is killed after ${formatShellDuration(limitMs)}.`,
      ...(clamped ? [clamped] : []),
      `When it exits you get one message with its exit code, run time and the end of its output. No need to poll; op:"write" session_id ${session.id} reads more output any time.`,
    ],
  });
}

const tool: ToolHandler = async (input, settings, context) => {
  // Git-safety rail: checked on the same resolved command both paths run,
  // before anything is spawned.
  const refusal = gitRefusal(String(input.cmd ?? input.command ?? ''));
  if (refusal) throw new Error(refusal);
  if (input.legacy_output === 'shell_exec') {
    return runLegacyShellExec(input, settings, context);
  }
  const cmd = String(input.cmd ?? input.command ?? '').trim();
  if (!cmd) throw new Error('cmd is required');

  const cwd = resolveCwd(input, context);
  // The system-wide `tool.shell` setting tunes the lifetimes (see
  // resolveShellLimits). Its older keys also apply to run when a user has
  // set them: timeoutMs bounds both the blocking wait and the process
  // lifetime (as for shell_exec), and maxBufferKb bounds the returned output.
  const legacy = await settingsService.readOptional(toolSettings.shell);
  const limits = resolveShellLimits(legacy);
  const legacyTimeoutMs = legacy?.timeoutMs;
  const legacyMaxChars = legacy?.maxBufferKb != null ? legacy.maxBufferKb * 1024 : undefined;
  const maxOutputTokens = readInt(input.max_output_tokens, 10_000, 1, 200_000);
  const shell = input.shell != null ? String(input.shell) : undefined;

  if (input.background === true) {
    return runInBackground({
      cmd,
      cwd,
      shell,
      timeoutMs: input.timeout_ms,
      yieldTimeMs: input.yield_time_ms,
      maxOutputTokens,
      backgroundMaxMs: limits.backgroundMaxMs,
      context,
    });
  }

  // Guardrail-2: per-call hard-lifetime override, clamped to the configured
  // maximum; defaults to the configured default (env SNAGLET_SHELL_HARD_TIMEOUT_MS,
  // 5 min, unless the setting says otherwise).
  const hardTimeoutMs = clampShellTimeoutMs(
    input.timeout_ms,
    limits.defaultTimeoutMs,
    limits.maxTimeoutMs
  );
  // The wait is capped by the command's own lifetime: past it the process is gone.
  const yieldTimeMs = readInt(
    input.yield_time_ms,
    legacyTimeoutMs != null ? Math.min(legacyTimeoutMs, hardTimeoutMs) : RUN_DEFAULT_YIELD_MS,
    250,
    hardTimeoutMs
  );
  const t0 = Date.now();
  const chunkId = randomBytes(4).toString('hex');

  const session = startShellSession({
    cmd,
    cwd,
    shell,
    env: buildShellEnv({}, shellAgent(context, cwd)),
    // Tag with the owning thread/agent so the chat Stop path can reap this
    // shell's process tree when the run is aborted.
    threadId: context?.threadId ?? null,
    agentId: context?.agentId ?? null,
    hardTimeoutMs,
  });

  const stopKeepAlive = keepRunAlive(context?.threadId);
  try {
    await waitForShellSessionClose(session.id, yieldTimeMs);
  } finally {
    stopKeepAlive();
  }
  const rawOutput = readShellSessionOutput(session.id);
  const output =
    legacyMaxChars != null && rawOutput.length > legacyMaxChars
      ? `${rawOutput.slice(0, legacyMaxChars)}\n[output truncated at the shell_exec maxBufferKb setting]`
      : rawOutput;
  const closed = isShellSessionClosed(session.id);
  const killReason = closed ? getShellSessionKillReason(session.id) : null;
  const clamped = clampNote(input.timeout_ms, limits.maxTimeoutMs, 'foreground');
  return formatResult({
    chunkId,
    wallMs: Date.now() - t0,
    code: closed ? getShellSessionExitCode(session.id) : null,
    sessionId: closed ? undefined : session.id,
    output,
    maxOutputTokens,
    killReason,
    notes: clamped ? [clamped] : undefined,
    // Yielded into a background session, or killed: the slow case only.
    hint: recursiveGrepHint({ command: cmd, cwd, slow: !closed || killReason != null }),
  });
};

export default tool;
