import { randomBytes } from 'crypto';
import type { ToolHandler } from '@server/services/ToolService/types';
import { readInt, truncateToTokens } from './shellUtils';
import { gitRefusalForStdin } from './gitSafety';
import { stdinCommandLines } from './stdinLines';
import { recursiveGrepHint } from './grepHint';
import { keepRunAlive } from './runKeepAlive';
import { SHELL_TIMEOUT_CEILING_MS } from './shellGuardrails';
import {
  getShellSession,
  getShellSessionExitCode,
  getShellSessionKillReason,
  getShellSessionPendingLine,
  isShellSessionClosed,
  readShellSessionOutput,
  recordShellPoll,
  waitForShellSessionClose,
  writeShellSession,
  type ShellKillReason,
} from './codex-shell-sessions';

function describeKill(reason: ShellKillReason): string {
  switch (reason) {
    case 'hard-timeout':
      return 'Process was KILLED: it exceeded its hard time limit. Do not keep polling this session — it is gone. If needed, re-run with shell op run and a larger timeout_ms.';
    case 'idle-poll-breaker':
      return 'Process was KILLED: too many consecutive polls returned no new output (stalled command). Do not retry the same poll loop — try a different approach.';
    case 'abort':
      return 'Process was KILLED: the run was stopped.';
    case 'owner-removed':
      return 'Process was KILLED: its agent was archived or deleted.';
    case 'shutdown':
      return 'Process was KILLED: the server is shutting down.';
  }
}

const tool: ToolHandler = async (input, _settings, context) => {
  const sessionId = Number(input.session_id);
  if (!Number.isInteger(sessionId) || sessionId <= 0) {
    throw new Error('session_id must be a positive integer');
  }

  const chars = String(input.chars ?? '');
  // Same git rail as run: typing `git reset --hard` into a session is refused
  // before a byte reaches its stdin. It reads the session's unfinished line plus
  // `chars` (stdinCommandLines), the same text the tool-access guard checks.
  const pending = getShellSessionPendingLine(sessionId);
  const refusal = gitRefusalForStdin(chars, pending);
  if (refusal) throw new Error(refusal);
  // The wait is capped by the session's own lifetime: past it the process is gone.
  const yieldTimeMs = readInt(
    input.yield_time_ms,
    1000,
    250,
    getShellSession(sessionId)?.hardTimeoutMs ?? SHELL_TIMEOUT_CEILING_MS
  );
  const maxOutputTokens = readInt(input.max_output_tokens, 10_000, 1, 200_000);
  const t0 = Date.now();
  const chunkId = randomBytes(4).toString('hex');

  if (chars.length > 0) {
    const written = writeShellSession(
      sessionId,
      chars,
      stdinCommandLines(pending, chars).nextPending
    );
    if (!written.ok) throw new Error(written.error);
  }

  const stopKeepAlive = keepRunAlive(context?.threadId);
  try {
    await waitForShellSessionClose(sessionId, yieldTimeMs);
  } finally {
    stopKeepAlive();
  }
  // Guardrail-2 circuit breaker: count this poll after the yield window so
  // output produced during the wait registers as progress. N consecutive
  // no-new-output polls kill the process group (the write_stdin ×150 spin).
  // A background job is exempt (recordShellPoll skips it).
  recordShellPoll(sessionId);
  const closed = isShellSessionClosed(sessionId);
  const output = readShellSessionOutput(sessionId);
  const killReason = closed ? getShellSessionKillReason(sessionId) : null;

  const lines: string[] = [];
  lines.push(`Chunk ID: ${chunkId}`);
  lines.push(`Wall time: ${((Date.now() - t0) / 1000).toFixed(4)} seconds`);
  if (closed) {
    lines.push(`Process exited with code ${getShellSessionExitCode(sessionId) ?? 0}`);
  } else {
    lines.push(`Process running with session ID ${sessionId}`);
  }
  if (killReason) {
    lines.push(describeKill(killReason));
    // A poll that finds the process killed: say why once, if it was a grep -r.
    const session = getShellSession(sessionId);
    const hint = session
      ? recursiveGrepHint({ command: session.command, cwd: session.cwd, slow: true })
      : null;
    if (hint) lines.push(hint);
  }
  lines.push('Output:');
  lines.push(truncateToTokens(output, maxOutputTokens));
  return lines.join('\n');
};

export default tool;
