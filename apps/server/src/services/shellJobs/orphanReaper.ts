/**
 * Boot-time reaping of a background job's process group that outlived a
 * crashed server.
 *
 * Shell sessions are spawned detached (their own process group), so a
 * graceful shutdown kills them (killAllShellSessions) but a server that is
 * SIGKILLed or crashes leaves them running headless. Boot recovery calls this
 * for each job the restart cut off. Pids are reused, so the group is killed
 * only when it is provably the job: a live member of group `pgid` started
 * within START_MATCH_MS of the job's recorded start. A reused pid cannot
 * match, because at that moment the job's own leader held it.
 */

import { execFile } from 'node:child_process';

/** Recorded start vs. `ps` start (whole seconds, measured at different instants). */
const START_MATCH_MS = 3_000;
const KILL_ESCALATE_MS = 3_000;
const PS_TIMEOUT_MS = 5_000;

export interface ProcessEntry {
  pid: number;
  pgid: number;
  elapsedMs: number;
}

export type ReapOutcome = 'stopped' | 'unverified' | 'none';

/** `ps -o etime` ([[dd-]hh:]mm:ss) in ms, or null when it does not parse. */
export function parseElapsed(etime: string): number | null {
  const match = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/.exec(etime.trim());
  if (!match) return null;
  const [, days, hours, minutes, seconds] = match;
  return (
    (((Number(days ?? 0) * 24 + Number(hours ?? 0)) * 60 + Number(minutes)) * 60 +
      Number(seconds)) *
    1000
  );
}

/** Lines of `ps -A -o pid=,pgid=,etime=`. Unparseable lines are skipped. */
export function parsePsOutput(stdout: string): ProcessEntry[] {
  const out: ProcessEntry[] = [];
  for (const line of stdout.split('\n')) {
    const [pid, pgid, etime] = line.trim().split(/\s+/);
    const elapsedMs = etime ? parseElapsed(etime) : null;
    if (!pid || !pgid || elapsedMs === null) continue;
    const entry = { pid: Number(pid), pgid: Number(pgid), elapsedMs };
    if (Number.isInteger(entry.pid) && Number.isInteger(entry.pgid)) out.push(entry);
  }
  return out;
}

function listProcesses(): Promise<ProcessEntry[]> {
  return new Promise((resolve) => {
    execFile(
      'ps',
      ['-A', '-o', 'pid=,pgid=,etime='],
      { timeout: PS_TIMEOUT_MS, windowsHide: true },
      (err, stdout) => resolve(err ? [] : parsePsOutput(String(stdout)))
    );
  });
}

function killGroup(pgid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pgid, signal);
  } catch {
    /* already gone */
  }
}

/**
 * Kill group `pgid` if it is still the job that started at `startedAt`.
 * 'stopped': it was, and got TERM (KILL after a grace); 'unverified': a group
 * with that id is alive but cannot be proven to be the job, so it is left
 * alone; 'none': nothing to do (no such group, or Windows).
 */
export async function reapOrphanGroup(input: {
  pgid: number;
  startedAt: number;
  now?: number;
  list?: () => Promise<ProcessEntry[]>;
  kill?: (pgid: number, signal: NodeJS.Signals) => void;
}): Promise<ReapOutcome> {
  if (process.platform === 'win32') return 'none';
  if (!Number.isInteger(input.pgid) || input.pgid <= 1) return 'none';
  const members = (await (input.list ?? listProcesses)()).filter((p) => p.pgid === input.pgid);
  if (members.length === 0) return 'none';
  const now = input.now ?? Date.now();
  const matches = members.some(
    (p) => Math.abs(now - p.elapsedMs - input.startedAt) <= START_MATCH_MS
  );
  if (!matches) return 'unverified';
  const kill = input.kill ?? killGroup;
  kill(input.pgid, 'SIGTERM');
  const escalate = setTimeout(() => kill(input.pgid, 'SIGKILL'), KILL_ESCALATE_MS);
  escalate.unref?.();
  return 'stopped';
}
