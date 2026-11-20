/**
 * Boot-time reaping of a crashed server's leftover job group: only a group
 * provably the job (a member started at the recorded moment) is killed; a
 * reused pid is left alone.
 */
import { describe, expect, it, jest } from '@jest/globals';
import {
  parseElapsed,
  parsePsOutput,
  reapOrphanGroup,
  type ProcessEntry,
} from '@server/services/shellJobs/orphanReaper';

const posix = process.platform !== 'win32';

describe('ps parsing', () => {
  it('reads every etime shape', () => {
    expect(parseElapsed('00:05')).toBe(5_000);
    expect(parseElapsed('12:34')).toBe((12 * 60 + 34) * 1000);
    expect(parseElapsed('1:02:03')).toBe((3600 + 2 * 60 + 3) * 1000);
    expect(parseElapsed('2-03:04:05')).toBe(((2 * 24 + 3) * 3600 + 4 * 60 + 5) * 1000);
    expect(parseElapsed('soon')).toBeNull();
  });

  it('reads pid, pgid and etime lines, skipping junk', () => {
    expect(parsePsOutput('  101   101    01:00\n  102   101 00:59\nbad line\n')).toEqual([
      { pid: 101, pgid: 101, elapsedMs: 60_000 },
      { pid: 102, pgid: 101, elapsedMs: 59_000 },
    ]);
  });
});

(posix ? describe : describe.skip)('reapOrphanGroup', () => {
  const now = 1_000_000_000;
  const startedAt = now - 600_000;
  const list = (entries: ProcessEntry[]) => async () => entries;

  it('kills a group with a member started at the recorded moment', async () => {
    const kill = jest.fn();
    const outcome = await reapOrphanGroup({
      pgid: 4321,
      startedAt,
      now,
      list: list([
        { pid: 4321, pgid: 4321, elapsedMs: 600_000 + 1_000 },
        { pid: 9, pgid: 9, elapsedMs: 600_000 },
      ]),
      kill,
    });
    expect(outcome).toBe('stopped');
    expect(kill).toHaveBeenCalledWith(4321, 'SIGTERM');
  });

  it('leaves a group alone when no member started then (a reused pid)', async () => {
    const kill = jest.fn();
    const outcome = await reapOrphanGroup({
      pgid: 4321,
      startedAt,
      now,
      list: list([{ pid: 4321, pgid: 4321, elapsedMs: 30_000 }]),
      kill,
    });
    expect(outcome).toBe('unverified');
    expect(kill).not.toHaveBeenCalled();
  });

  it('does nothing when the group is gone', async () => {
    const kill = jest.fn();
    expect(await reapOrphanGroup({ pgid: 4321, startedAt, now, list: list([]), kill })).toBe(
      'none'
    );
    expect(await reapOrphanGroup({ pgid: 1, startedAt, now, list: list([]), kill })).toBe('none');
    expect(kill).not.toHaveBeenCalled();
  });

  it('really reaps a live detached group started just now', async () => {
    const { spawn } = await import('node:child_process');
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 30000)'], {
      detached: true,
      stdio: 'ignore',
    });
    const t0 = Date.now();
    try {
      await new Promise((r) => setTimeout(r, 300));
      expect(await reapOrphanGroup({ pgid: child.pid!, startedAt: t0 })).toBe('stopped');
      const gone = await new Promise<boolean>((resolve) => {
        child.once('exit', () => resolve(true));
        setTimeout(() => resolve(false), 5_000);
      });
      expect(gone).toBe(true);
    } finally {
      try {
        process.kill(-child.pid!, 'SIGKILL');
      } catch {
        /* gone */
      }
    }
  }, 15_000);
});
