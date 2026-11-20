import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import {
  SHELL_HARD_TIMEOUT_MS,
  SHELL_MAX_IDLE_POLLS,
  SHELL_OUTPUT_BUFFER_CHARS,
} from './shellGuardrails';
import { killProcessTree } from '@server/utils/processes';

/**
 * Why a session was force-killed — surfaced in the tool result for the model.
 * `owner-removed`: its agent was archived or deleted (background jobs);
 * `shutdown`: the server is stopping.
 */
export type ShellKillReason =
  | 'abort'
  | 'hard-timeout'
  | 'idle-poll-breaker'
  | 'owner-removed'
  | 'shutdown';

/** What a session's `onEnd` listener learns, once, when the command is over. */
export interface ShellSessionEnd {
  id: number;
  command: string;
  cwd: string;
  threadId: string | null;
  agentId: string | null;
  /** Process-group leader pid (null if the spawn failed). */
  pid: number | null;
  startedAt: number;
  endedAt: number;
  /** Exit code of a natural exit; null when killed or ended by a signal. */
  exitCode: number | null;
  /** Signal that ended a natural exit (e.g. an external `kill`), else null. */
  signal: NodeJS.Signals | null;
  killReason: ShellKillReason | null;
  /** The lifetime the session was armed with. */
  hardTimeoutMs: number;
  /** The last `maxChars` of retained output (does not move the read offset). */
  tail(maxChars: number): string;
}

interface ShellSession {
  id: number;
  child: ChildProcessWithoutNullStreams;
  /** The retained tail of the output (at most ~SHELL_OUTPUT_BUFFER_CHARS). */
  output: string;
  /** Chars dropped from the front of `output` so far. */
  droppedChars: number;
  /** Absolute offset (counting dropped chars) the next read starts from. */
  readOffset: number;
  cwd: string;
  command: string;
  startedAt: number;
  exitCode: number | null;
  closedAt: number | null;
  /** Thread that owns this session — lets Stop kill only this thread's shells. */
  threadId: string | null;
  agentId: string | null;
  /** True once we've sent a kill signal, so callers can distinguish reap from exit. */
  killed: boolean;
  /**
   * Started with `background: true`: exempt from the idle-poll breaker and
   * from the Stop path (killShellSessionsForAgent / ForThread); its owner is
   * told when it ends (onEnd). Archive, removal and shutdown still kill it.
   */
  background: boolean;
  /** The lifetime the hard timer was armed with. */
  hardTimeoutMs: number;
  /** Signal reported by the child's close event, if any. */
  exitSignal: NodeJS.Signals | null;
  /** Called once when the command is over (see notifyEnded). */
  onEnd: ((end: ShellSessionEnd) => void) | null;
  endNotified: boolean;
  /** Why it was killed (null = natural exit or still running). Guardrail-2/3. */
  killReason: ShellKillReason | null;
  /** Resolvers parked on waitForShellSessionClose, released on close OR kill. */
  waiters: Set<() => void>;
  /**
   * Guardrail-2 hard-lifetime timer. Fires SHELL_HARD_TIMEOUT_MS after spawn and
   * kills the process group so a never-returning command can't outlive the cap
   * no matter how the model polls it. Cleared on natural close.
   */
  hardTimeout: ReturnType<typeof setTimeout> | null;
  /** Total chars of output (dropped included) at the last poll — "no new output" check. */
  lastPolledOutputLen: number;
  /** Consecutive polls that saw no new output (guardrail-2 circuit breaker). */
  idlePollCount: number;
  /**
   * Text written to stdin after the last newline — the line the shell has not
   * submitted yet. The write guard checks `pendingLine + chars` so a command
   * split across writes is still seen whole. Cleared on exit/kill.
   */
  pendingLine: string;
}

const sessions = new Map<number, ShellSession>();
let nextSessionId = 1;
/** How long an ended session (and its output) stays readable with op:write. */
export const CLOSED_SESSION_TTL_MS = 10 * 60 * 1000;
/** Grace between SIGTERM and the SIGKILL escalation when reaping a group. */
const KILL_ESCALATE_MS = 3_000;

function pruneSessions(): void {
  const now = Date.now();
  for (const [id, session] of sessions) {
    if (session.closedAt && now - session.closedAt > CLOSED_SESSION_TTL_MS) {
      sessions.delete(id);
    }
  }
}

/** Trim only once this far over the cap, so a chatty stream isn't re-sliced per chunk. */
const OUTPUT_TRIM_SLACK_CHARS = Math.floor(SHELL_OUTPUT_BUFFER_CHARS / 4);

function totalOutputChars(session: ShellSession): number {
  return session.droppedChars + session.output.length;
}

function append(session: ShellSession, data: Buffer | string): void {
  session.output += data.toString();
  if (session.output.length > SHELL_OUTPUT_BUFFER_CHARS + OUTPUT_TRIM_SLACK_CHARS) {
    const excess = session.output.length - SHELL_OUTPUT_BUFFER_CHARS;
    session.output = session.output.slice(excess);
    session.droppedChars += excess;
  }
}

function releaseWaiters(session: ShellSession): void {
  for (const resolve of session.waiters) resolve();
  session.waiters.clear();
}

/** The last `maxChars` of a session's retained output, leaving its read offset alone. */
function tailOf(session: ShellSession, maxChars: number): string {
  const n = Math.max(0, Math.floor(maxChars));
  if (n === 0) return '';
  return session.output.length > n ? session.output.slice(-n) : session.output;
}

/**
 * Tell the session's `onEnd` listener, once, that the command is over: on its
 * close, or for a kill whose process tree never closes its stdio, after the
 * TERM→KILL escalation window. A throwing listener never breaks the session.
 */
function notifyEnded(session: ShellSession): void {
  if (session.endNotified || !session.onEnd) return;
  session.endNotified = true;
  const killed = session.killReason !== null;
  const end: ShellSessionEnd = {
    id: session.id,
    command: session.command,
    cwd: session.cwd,
    threadId: session.threadId,
    agentId: session.agentId,
    pid: session.child.pid ?? null,
    startedAt: session.startedAt,
    endedAt: session.closedAt ?? Date.now(),
    exitCode: killed || session.exitSignal ? null : session.exitCode,
    signal: killed ? null : session.exitSignal,
    killReason: session.killReason,
    hardTimeoutMs: session.hardTimeoutMs,
    tail: (maxChars) => tailOf(session, maxChars),
  };
  try {
    session.onEnd(end);
  } catch {
    /* the listener owns its own errors */
  }
}

/** Mark a session closed and release everyone parked on waitForShellSessionClose. */
function settle(
  session: ShellSession,
  exitCode: number | null,
  signal: NodeJS.Signals | null = null
): void {
  if (session.closedAt !== null) return;
  session.exitCode = exitCode ?? 0;
  session.exitSignal = signal;
  session.closedAt = Date.now();
  session.pendingLine = '';
  // The command is over — stop the hard-lifetime timer so it can't fire against
  // a dead/recycled session and can't hold the event loop open at shutdown.
  if (session.hardTimeout) {
    clearTimeout(session.hardTimeout);
    session.hardTimeout = null;
  }
  releaseWaiters(session);
  notifyEnded(session);
}

export function startShellSession(input: {
  cmd: string;
  cwd: string;
  shell?: string;
  env?: NodeJS.ProcessEnv;
  threadId?: string | null;
  agentId?: string | null;
  /** Per-call hard-lifetime override (guardrail-2); defaults to SHELL_HARD_TIMEOUT_MS. */
  hardTimeoutMs?: number;
  /** A detached job: see ShellSession.background. */
  background?: boolean;
  /** Called once when the command is over (natural exit or kill). */
  onEnd?: (end: ShellSessionEnd) => void;
}): ShellSession {
  pruneSessions();
  const id = nextSessionId++;
  const child = spawn(input.cmd, {
    cwd: input.cwd,
    env: input.env ?? {},
    shell: input.shell || true,
    stdio: ['pipe', 'pipe', 'pipe'],
    // Own process group: the spawned shell becomes group leader, so a later
    // process.kill(-pid) reaps the whole tree (shell + npx + tsx + node), not
    // just the shell. Without this a killed shell leaves its children as
    // orphans that outlive Stop and the server. We deliberately do not
    // unref(): the server keeps tracking it.
    detached: process.platform !== 'win32',
    windowsHide: true,
  });

  const session: ShellSession = {
    id,
    child,
    output: '',
    droppedChars: 0,
    readOffset: 0,
    cwd: input.cwd,
    command: input.cmd,
    startedAt: Date.now(),
    exitCode: null,
    closedAt: null,
    threadId: input.threadId ?? null,
    agentId: input.agentId ?? null,
    killed: false,
    killReason: null,
    background: input.background === true,
    hardTimeoutMs: input.hardTimeoutMs ?? SHELL_HARD_TIMEOUT_MS,
    exitSignal: null,
    onEnd: input.onEnd ?? null,
    endNotified: false,
    waiters: new Set(),
    hardTimeout: null,
    lastPolledOutputLen: 0,
    idlePollCount: 0,
    pendingLine: '',
  };

  child.stdout.on('data', (chunk) => append(session, chunk));
  child.stderr.on('data', (chunk) => append(session, chunk));
  child.on('error', (error) => {
    append(session, `${error.name}: ${error.message}\n`);
  });
  child.on('close', (code, signal) => {
    settle(session, code ?? 0, signal);
  });

  // Guardrail-2 hard lifetime: arm a timer that reaps the process group once the
  // command runs past the hard cap, regardless of how (or whether) the model
  // polls it. This is what stops the "9-minute rg that never returned" class of
  // hang. The kill goes through killShellSession so it's TERM→KILL on the whole
  // group and settles any parked waiter immediately.
  const hardTimeoutMs = session.hardTimeoutMs;
  const hardTimeout = setTimeout(() => {
    if (session.closedAt === null) {
      append(
        session,
        `\n[snaglet-guardrail] command exceeded hard timeout of ${hardTimeoutMs}ms — killing process group\n`
      );
      killShellSession(id, 'hard-timeout');
    }
  }, hardTimeoutMs);
  hardTimeout.unref?.();
  session.hardTimeout = hardTimeout;

  sessions.set(id, session);
  return session;
}

export function getShellSession(id: number): ShellSession | null {
  pruneSessions();
  return sessions.get(id) ?? null;
}

/**
 * The unfinished stdin line of a live session ('' when none, unknown, or the
 * session has exited — a pending line never outlives or crosses sessions).
 */
export function getShellSessionPendingLine(id: number): string {
  const session = sessions.get(id);
  if (!session || session.closedAt !== null || session.killed) return '';
  return session.pendingLine;
}

export function writeShellSession(
  id: number,
  chars: string,
  /** The unfinished line after this write (stdinCommandLines().nextPending). */
  nextPending?: string
): { ok: true } | { ok: false; error: string } {
  const session = getShellSession(id);
  if (!session) return { ok: false, error: `No shell session ${id}` };
  if (session.closedAt !== null || session.killed) {
    return { ok: false, error: `shell session ${id} has exited` };
  }
  session.child.stdin.write(chars);
  // Only a write that actually landed moves the pending line.
  if (nextPending !== undefined) session.pendingLine = nextPending;
  return { ok: true };
}

export function readShellSessionOutput(id: number): string {
  const session = getShellSession(id);
  if (!session) return '';
  const start = session.readOffset - session.droppedChars;
  session.readOffset = totalOutputChars(session);
  if (start >= 0) return session.output.slice(start);
  return (
    `[snaglet-guardrail] ${-start} chars of earlier output were dropped ` +
    `(shell keeps only the last ${SHELL_OUTPUT_BUFFER_CHARS} chars)\n` +
    session.output
  );
}

export function isShellSessionClosed(id: number): boolean {
  const session = getShellSession(id);
  return !session || session.closedAt !== null || session.killed;
}

export function getShellSessionExitCode(id: number): number | null {
  return getShellSession(id)?.exitCode ?? null;
}

/** Why the session was force-killed, or null for natural exit / still running. */
export function getShellSessionKillReason(id: number): ShellKillReason | null {
  return getShellSession(id)?.killReason ?? null;
}

/**
 * Guardrail-2 circuit breaker. Call once per poll (exec_command re-yield and
 * every write_stdin). If the session produced no NEW output since the last poll,
 * the idle counter increments; once it reaches SHELL_MAX_IDLE_POLLS the process
 * group is killed so a degenerate poll-forever loop (the write_stdin ×150 spin)
 * is cut off automatically. Any new output resets the counter. Returns true if
 * this call tripped the breaker (the session is now killed).
 *
 * Only counts polls against a running session; a closed or killed session can't loop.
 * A background job is exempt: polling it is optional, and a quiet build or
 * server is not a stall. Its own lifetime still bounds it.
 */
export function recordShellPoll(id: number): boolean {
  const session = getShellSession(id);
  if (!session || session.closedAt !== null || session.killed) return false;
  if (session.background) return false;
  if (totalOutputChars(session) > session.lastPolledOutputLen) {
    // Progress — reset the breaker.
    session.lastPolledOutputLen = totalOutputChars(session);
    session.idlePollCount = 0;
    return false;
  }
  session.idlePollCount += 1;
  if (session.idlePollCount >= SHELL_MAX_IDLE_POLLS) {
    append(
      session,
      `\n[snaglet-guardrail] no new output after ${session.idlePollCount} consecutive polls — killing process group\n`
    );
    killShellSession(id, 'idle-poll-breaker');
    return true;
  }
  return false;
}

/**
 * Kill a session's entire process group (SIGTERM, then SIGKILL after a grace
 * window) and makes it terminal to callers while its actual close remains tracked
 * for escalation. Idempotent. Returns true if the session existed and was running.
 */
function killShellSession(id: number, reason: ShellKillReason = 'abort'): boolean {
  const session = sessions.get(id);
  if (!session || session.closedAt !== null || session.killed) return false;
  session.killed = true;
  session.killReason = reason;
  session.pendingLine = '';
  if (session.hardTimeout) {
    clearTimeout(session.hardTimeout);
    session.hardTimeout = null;
  }
  signalGroup(session, 'SIGTERM');
  // Escalate if the group ignores SIGTERM.
  const escalate = setTimeout(() => {
    if (session.closedAt === null && session.killed) signalGroup(session, 'SIGKILL');
  }, KILL_ESCALATE_MS);
  // Don't let the escalation timer hold the event loop open at shutdown.
  escalate.unref?.();
  // A killed tree normally closes within the escalation window (settle tells
  // onEnd then). One whose stdio a stray grandchild keeps open never closes:
  // tell onEnd anyway, shortly after the SIGKILL.
  if (session.onEnd) {
    const giveUp = setTimeout(() => notifyEnded(session), KILL_ESCALATE_MS + 2_000);
    giveUp.unref?.();
  }
  // A killed command is terminal to the tool caller, but its stdio and process
  // tree can take a moment to close. Release parked tool waits now while
  // preserving closedAt for the real child close event and escalation retry.
  releaseWaiters(session);
  return true;
}

/** Send `signal` to the session's whole process group; fall back to the pid. */
function signalGroup(session: ShellSession, signal: NodeJS.Signals): void {
  if (process.platform === 'win32') {
    killProcessTree(session.child, true);
    return;
  }
  const pid = session.child.pid;
  if (pid == null) return;
  try {
    // Negative pid targets the process GROUP (leader pid == child pid because
    // we spawned detached), reaping descendants too.
    process.kill(-pid, signal);
  } catch {
    // Group already gone, or platform without group semantics — try the pid.
    try {
      session.child.kill(signal);
    } catch {
      /* already dead */
    }
  }
}

function isLive(session: ShellSession): boolean {
  return session.closedAt === null && !session.killed;
}

/**
 * Kill every live foreground session owned by a thread. The chat Stop path
 * reaps the shells a run spawned; background jobs are detached from the run
 * and survive Stop (see killBackgroundShellJobs). Returns the count killed.
 */
export function killShellSessionsForThread(threadId: string): number {
  let count = 0;
  for (const [id, session] of sessions) {
    if (session.threadId === threadId && !session.background && isLive(session)) {
      if (killShellSession(id)) count++;
    }
  }
  return count;
}

/**
 * Kill one agent's live foreground shells without disturbing its thread peers
 * (the run-abort path). Its background jobs keep running.
 */
export function killShellSessionsForAgent(threadId: string, agentId: string): number {
  let count = 0;
  for (const [id, session] of sessions) {
    if (
      session.threadId === threadId &&
      session.agentId === agentId &&
      !session.background &&
      isLive(session) &&
      killShellSession(id)
    ) {
      count++;
    }
  }
  return count;
}

/**
 * Kill an agent's running background jobs (all its threads, or one): its
 * archive or deletion. Returns the count killed.
 */
export function killBackgroundShellJobs(
  filter: { agentId: string; threadId?: string },
  reason: ShellKillReason = 'owner-removed'
): number {
  let count = 0;
  for (const [id, session] of sessions) {
    if (
      session.background &&
      session.agentId === filter.agentId &&
      (filter.threadId === undefined || session.threadId === filter.threadId) &&
      isLive(session) &&
      killShellSession(id, reason)
    ) {
      count++;
    }
  }
  return count;
}

/** A running background job, for the per-agent cap and its refusal message. */
export interface RunningBackgroundJob {
  id: number;
  command: string;
  threadId: string | null;
  pid: number | null;
  startedAt: number;
}

/** The background jobs an agent has running now, oldest first. */
export function listRunningBackgroundShellJobs(agentId: string): RunningBackgroundJob[] {
  const out: RunningBackgroundJob[] = [];
  for (const session of sessions.values()) {
    if (session.background && session.agentId === agentId && isLive(session)) {
      out.push({
        id: session.id,
        command: session.command,
        threadId: session.threadId,
        pid: session.child.pid ?? null,
        startedAt: session.startedAt,
      });
    }
  }
  return out.sort((a, b) => a.startedAt - b.startedAt);
}

/** Kill every live session — server shutdown reaps all shells so none orphan. */
export function killAllShellSessions(): number {
  let count = 0;
  for (const [id, session] of sessions) {
    if (isLive(session) && killShellSession(id, 'shutdown')) count++;
  }
  return count;
}

export function waitForShellSessionClose(id: number, timeoutMs: number): Promise<boolean> {
  const session = getShellSession(id);
  if (!session) return Promise.resolve(true);
  if (session.closedAt !== null || session.killed) return Promise.resolve(true);

  return new Promise((resolve) => {
    const done = (closed: boolean) => {
      clearTimeout(timer);
      session.waiters.delete(onSettle);
      resolve(closed);
    };
    const onSettle = () => done(true);
    const timer = setTimeout(() => done(false), timeoutMs);
    // Released by settle() on natural close or kill. The early killed check
    // above also handles a waiter registered after Stop.
    session.waiters.add(onSettle);
  });
}
