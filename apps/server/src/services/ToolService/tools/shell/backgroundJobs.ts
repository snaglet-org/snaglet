/**
 * The seam between `shell` background jobs and the service that reports them.
 *
 * `run` with `background: true` starts a detached session and returns at
 * once. Telling the owning agent when the job ends (a thread row, a mid-run
 * message or a wake) needs the database and the dispatch path, which the
 * shell tool must not import: it sits under the tool executor, and the hot
 * paths that read sessions (the permission guard, Stop) stay light. So the
 * reporter registers itself here at boot (ShellJobService.init) and the tool
 * looks it up per call. No reporter means no background jobs on this server.
 */

import type { ShellSessionEnd } from './codex-shell-sessions';

/** A background job the tool has started (still running when reported). */
export interface BackgroundJobStart {
  /** Stable id across restarts (session ids restart at 1 with the server). */
  jobId: string;
  sessionId: number;
  threadId: string;
  agentId: string;
  command: string;
  cwd: string;
  /** Process-group leader pid, for boot-time orphan reaping. */
  pid: number | null;
  startedAt: number;
  /** The lifetime the job was armed with. */
  limitMs: number;
}

export interface BackgroundJobReporter {
  /** The job is running past its start window: record it (boot recovery reads it). */
  started(job: BackgroundJobStart): Promise<void>;
  /** The job is over: tell its agent. Never throws. */
  ended(job: BackgroundJobStart, end: ShellSessionEnd): void;
}

let reporter: BackgroundJobReporter | null = null;

export function setBackgroundJobReporter(next: BackgroundJobReporter | null): void {
  reporter = next;
}

export function getBackgroundJobReporter(): BackgroundJobReporter | null {
  return reporter;
}
