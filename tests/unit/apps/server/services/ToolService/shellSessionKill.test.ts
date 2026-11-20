/**
 * Shell-session process-tree reaping, so Stop actually stops. exec_command
 * spawns a detached shell (its own process-group leader).
 * killShellSessionsForThread reaps only the target thread's shells and
 * unblocks a waitForShellSessionClose parked on a killed session;
 * killAllShellSessions (server shutdown) reaps everything. Uses real child
 * processes (a Node timer) and asserts they are gone after the reap.
 */

import { afterEach, describe, expect, it } from '@jest/globals';
import {
  startShellSession,
  killShellSessionsForThread,
  killShellSessionsForAgent,
  killAllShellSessions,
  isShellSessionClosed,
  waitForShellSessionClose,
  getShellSession,
  recordShellPoll,
  writeShellSession,
} from '@server/services/ToolService/tools/shell/codex-shell-sessions';

const started: number[] = [];

function spawnSleep(threadId: string | null, agentId?: string): number {
  const s = startShellSession({
    cmd: `"${process.execPath}" -e "setInterval(() => {}, 30000)"`,
    cwd: process.cwd(),
    threadId,
    agentId,
  });
  started.push(s.id);
  return s.id;
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0); // signal 0 = existence probe, doesn't actually signal
    return true;
  } catch {
    return false;
  }
}

afterEach(() => {
  // Belt-and-suspenders: make sure no test leaves a real sleep running.
  killAllShellSessions();
  started.length = 0;
});

describe('killShellSessionsForAgent', () => {
  it('kills a blocked target agent in seconds while its peer continues', async () => {
    const idA = spawnSleep('thread-shared', 'agent-a');
    const idB = spawnSleep('thread-shared', 'agent-b');
    const waitA = waitForShellSessionClose(idA, 20_000);
    const startedAt = Date.now();

    expect(killShellSessionsForAgent('thread-shared', 'agent-a')).toBe(1);
    await expect(waitA).resolves.toBe(true);
    expect(Date.now() - startedAt).toBeLessThan(3_000);
    expect(isShellSessionClosed(idA)).toBe(true);
    expect(isShellSessionClosed(idB)).toBe(false);
  });
});

describe('killShellSessionsForThread', () => {
  it('treats a killed session as terminal before the child close event', async () => {
    const id = spawnSleep('thread-terminal');
    const session = getShellSession(id)!;

    expect(killShellSessionsForThread('thread-terminal')).toBe(1);
    // Signaling is synchronous, while ChildProcess.close is delivered by a
    // later event-loop turn. The terminal API state must not wait for it.
    expect(session.closedAt).toBeNull();
    expect(writeShellSession(id, 'still running?')).toEqual({
      ok: false,
      error: `shell session ${id} has exited`,
    });
    expect(recordShellPoll(id)).toBe(false);

    const startedAt = Date.now();
    await expect(waitForShellSessionClose(id, 10_000)).resolves.toBe(true);
    expect(Date.now() - startedAt).toBeLessThan(1_000);
  });

  it('reaps only the target thread and unblocks its parked waiter', async () => {
    const idA = spawnSleep('thread-A');
    const idB = spawnSleep('thread-B');
    const pidA = getShellSession(idA)!.child.pid!;
    const pidB = getShellSession(idB)!.child.pid!;
    expect(pidAlive(pidA)).toBe(true);
    expect(pidAlive(pidB)).toBe(true);

    // A yield-wait parked on session A (as exec_command does) must resolve the
    // moment A is killed — not block for the full timeout.
    const waitA = waitForShellSessionClose(idA, 30_000);

    const killed = killShellSessionsForThread('thread-A');
    expect(killed).toBe(1);

    // The parked wait returns (closed=true) without hitting its 30s timeout.
    await expect(waitA).resolves.toBe(true);
    expect(isShellSessionClosed(idA)).toBe(true);

    // Thread B is untouched.
    expect(isShellSessionClosed(idB)).toBe(false);
    expect(pidAlive(pidB)).toBe(true);

    // The OS actually reaped A's process (give the signal a beat to land).
    await new Promise((r) => setTimeout(r, 200));
    expect(pidAlive(pidA)).toBe(false);
  });

  it('returns 0 when the thread owns no live sessions', () => {
    spawnSleep('thread-X');
    expect(killShellSessionsForThread('thread-nobody')).toBe(0);
  });
});

describe('killAllShellSessions', () => {
  it('reaps every live session (server-shutdown path)', async () => {
    const idA = spawnSleep('thread-A');
    const idB = spawnSleep('thread-B');
    const pidA = getShellSession(idA)!.child.pid!;
    const pidB = getShellSession(idB)!.child.pid!;

    const killed = killAllShellSessions();
    expect(killed).toBe(2);
    expect(isShellSessionClosed(idA)).toBe(true);
    expect(isShellSessionClosed(idB)).toBe(true);

    await new Promise((r) => setTimeout(r, 200));
    expect(pidAlive(pidA)).toBe(false);
    expect(pidAlive(pidB)).toBe(false);
  });

  it('is idempotent — a second kill finds nothing live', () => {
    spawnSleep('thread-A');
    expect(killAllShellSessions()).toBe(1);
    expect(killAllShellSessions()).toBe(0);
  });
});
