import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { escapeRegex } from '@snaglet/shared/utils';
import { logger } from '@server/config/logger';

/**
 * Kill stale Apple voice sidecars left by a previous server process. The match
 * is the fully-resolved executable path, never a broad process-name pattern,
 * so unrelated user processes cannot be touched.
 */
export interface AppleSidecarCleanupDeps {
  exists(path: string): boolean;
  pgrep(binary: string): string;
  kill(pid: number): void;
  selfPid: number;
}

const defaultDeps: AppleSidecarCleanupDeps = {
  exists: existsSync,
  pgrep: (binary) =>
    execFileSync('pgrep', ['-f', `^${escapeRegex(binary)}(?: |$)`], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }),
  kill: (pid) => process.kill(pid, 'SIGKILL'),
  selfPid: process.pid,
};

export function sweepAppleSidecarOrphans(
  paths: readonly string[],
  deps: AppleSidecarCleanupDeps = defaultDeps
): void {
  for (const binary of paths) {
    if (!binary || !deps.exists(binary)) continue;
    try {
      const output = deps.pgrep(binary);
      for (const line of output.trim().split('\n')) {
        const pid = Number.parseInt(line.trim(), 10);
        if (!Number.isInteger(pid) || pid <= 1 || pid === deps.selfPid) continue;
        try {
          deps.kill(pid);
          logger.warn(`[voice] killed orphaned Apple sidecar ${binary} (pid ${pid})`);
        } catch {
          // It exited between pgrep and kill.
        }
      }
    } catch {
      // pgrep exits 1 when there are no matches; this is the normal case.
    }
  }
}
