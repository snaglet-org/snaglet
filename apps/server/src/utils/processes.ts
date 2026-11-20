import { spawnSync, type ChildProcess } from 'node:child_process';
import path from 'node:path';

/** The current Node executable is reliable even when `node` is only a .cmd shim. */
export function nodeExecutable(): string {
  return process.execPath;
}

/** Reap a child and the processes it started on every supported platform. */
export function killProcessTree(child: ChildProcess, force = true): void {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const pid = child.pid;
  if (pid == null) return;

  if (process.platform === 'win32') {
    const systemRoot = process.env.SystemRoot ?? process.env.SYSTEMROOT ?? 'C:\\Windows';
    const taskkill = path.join(systemRoot, 'System32', 'taskkill.exe');
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const result = spawnSync(taskkill, ['/pid', String(pid), '/t', ...(force ? ['/f'] : [])], {
          stdio: 'ignore',
          windowsHide: true,
          timeout: 2_000,
        });
        if (!result.error && result.status === 0) return;
      } catch {
        // A bounded retry covers taskkill startup contention before the direct
        // wrapper fallback below.
      }
    }
  }

  try {
    if (process.platform !== 'win32') {
      process.kill(-pid, force ? 'SIGKILL' : 'SIGTERM');
      return;
    }
    child.kill(force ? 'SIGKILL' : 'SIGTERM');
  } catch {
    try {
      child.kill(force ? 'SIGKILL' : 'SIGTERM');
    } catch {
      // The child already exited.
    }
  }
}
