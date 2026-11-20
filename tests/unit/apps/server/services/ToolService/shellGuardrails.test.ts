/**
 * Guardrail-2 against real child processes: a shell session can never outlive
 * its hard timeout, degenerate polling is cut off by the idle-poll circuit
 * breaker, and the chat Stop path (killShellSessionsForThread) unblocks a
 * parked tool wait within seconds. Verifies by pid that the children are gone.
 */

import { afterEach } from '@jest/globals';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import {
  getShellSession,
  killAllShellSessions,
  killShellSessionsForThread,
  recordShellPoll,
  startShellSession,
  waitForShellSessionClose,
} from '@server/services/ToolService/tools/shell/codex-shell-sessions';
import { SHELL_MAX_IDLE_POLLS } from '@server/services/ToolService/tools/shell/shellGuardrails';
import execCommandTool from '@server/services/ToolService/tools/shell/shellRun';
import writeStdinTool from '@server/services/ToolService/tools/shell/shellWrite';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const execFileAsync = promisify(execFile);

function longRunningCommand(options: { initialOutput?: string; reportPid?: boolean } = {}): string {
  const output = [
    options.reportPid ? "console.log('snaglet-shell-child:' + process.pid);" : '',
    options.initialOutput ? `console.log('${options.initialOutput}');` : '',
  ].join('');
  return `"${process.execPath}" -e "${output}setInterval(() => {}, 30000)"`;
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function expectProcessGone(pid: number, timeoutMs = 4000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isProcessAlive(pid)) return;
    await sleep(50);
  }
  throw new Error(`process ${pid} still alive after ${timeoutMs}ms`);
}

async function descendantPid(sessionId: number): Promise<number> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    const output = getShellSession(sessionId)?.output ?? '';
    const match = output.match(/snaglet-shell-child:(\d+)/);
    if (match) return Number(match[1]);
    await sleep(25);
  }
  throw new Error('shell child did not report its pid');
}

async function windowsProcessesWithArgument(argument: string): Promise<number[]> {
  if (process.platform !== 'win32') return [];
  const encoded = Buffer.from(argument, 'utf8').toString('base64');
  const { stdout } = await execFileAsync(
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      `$needle = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encoded}')); Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -and $_.CommandLine.Contains($needle) } | ForEach-Object { $_.ProcessId }`,
    ],
    { windowsHide: true }
  );
  return stdout
    .split(/\s+/)
    .map(Number)
    .filter((pid) => Number.isInteger(pid) && pid > 0);
}

afterEach(() => {
  killAllShellSessions();
});

describe('shell session hard timeout (guardrail-2)', () => {
  it('kills the process group once the hard cap elapses — verified by pid', async () => {
    const session = startShellSession({
      cmd: longRunningCommand({ reportPid: true }),
      cwd: process.cwd(),
      hardTimeoutMs: 1_000,
    });
    const pid = session.child.pid!;
    const childPid = await descendantPid(session.id);
    expect(isProcessAlive(pid)).toBe(true);

    // The parked waiter settles when the timer kills the group — well under
    // the command's own 30s, and the run gets control back immediately.
    const t0 = Date.now();
    const closed = await waitForShellSessionClose(session.id, 10_000);
    expect(closed).toBe(true);
    expect(Date.now() - t0).toBeLessThan(5_000);
    expect(session.killReason).toBe('hard-timeout');
    await expectProcessGone(pid);
    await expectProcessGone(childPid);
  }, 15_000);

  it('exec_command returns a timeout result the model can react to', async () => {
    const result = await execCommandTool(
      { cmd: longRunningCommand(), timeout_ms: 1_000, yield_time_ms: 8_000 },
      {},
      { threadId: 'thread-shell-guard', agentId: 'agent-shell-guard' }
    );

    const text = String(result);
    expect(text).toContain('Process exited with code');
    expect(text).toContain('Process was KILLED');
    expect(text).toContain('snaglet-guardrail');
  }, 15_000);
});

describe('idle-poll circuit breaker (guardrail-2)', () => {
  it('kills a silent session after N consecutive no-output polls', async () => {
    const session = startShellSession({
      cmd: longRunningCommand({ reportPid: true }),
      cwd: process.cwd(),
    });
    const pid = session.child.pid!;
    const childPid = await descendantPid(session.id);
    expect(recordShellPoll(session.id)).toBe(false);

    let tripped = false;
    let polls = 0;
    while (!tripped && polls < SHELL_MAX_IDLE_POLLS + 5) {
      polls++;
      tripped = recordShellPoll(session.id);
    }

    expect(tripped).toBe(true);
    expect(polls).toBe(SHELL_MAX_IDLE_POLLS);
    expect(session.killReason).toBe('idle-poll-breaker');
    await expectProcessGone(pid);
    await expectProcessGone(childPid);
  }, 15_000);

  it('new output resets the breaker counter', async () => {
    const session = startShellSession({
      cmd: longRunningCommand({ initialOutput: 'tick', reportPid: true }),
      cwd: process.cwd(),
      threadId: 'thread-output-reset',
    });
    // Let the echo land so the first poll observes progress.
    await sleep(400);
    expect(recordShellPoll(session.id)).toBe(false);
    expect(getShellSession(session.id)?.idlePollCount).toBe(0);

    // A few silent polls accumulate but stay below the breaker.
    recordShellPoll(session.id);
    recordShellPoll(session.id);
    expect(getShellSession(session.id)?.idlePollCount).toBe(2);
    expect(session.killReason).toBeNull();

    // Clean up the long-running process tree.
    const childPid = await descendantPid(session.id);
    killShellSessionsForThread('thread-output-reset');
    await expectProcessGone(childPid);
  }, 15_000);

  it('write_stdin polling a stalled session surfaces the kill to the model', async () => {
    const session = startShellSession({
      cmd: longRunningCommand({ reportPid: true }),
      cwd: process.cwd(),
    });
    const childPid = await descendantPid(session.id);

    let lastResult = '';
    for (let i = 0; i < SHELL_MAX_IDLE_POLLS + 2; i++) {
      lastResult = String(
        await writeStdinTool({ session_id: session.id, yield_time_ms: 250 }, {}, {})
      );
      if (lastResult.includes('Process exited')) break;
    }

    expect(lastResult).toContain('Process was KILLED');
    expect(lastResult).toContain('no new output');
    expect(session.killReason).toBe('idle-poll-breaker');
    await expectProcessGone(childPid);
  }, 30_000);
});

describe('abort reaches a blocked exec (guardrail-3)', () => {
  it('does not leave a child behind when cancellation races startup', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'snaglet-shell-startup-'));
    const script = path.join(directory, 'startup-child.cjs');
    const marker = path.join(directory, 'child.pid');
    await writeFile(
      script,
      "require('node:fs').writeFileSync(process.argv[2], String(process.pid)); setInterval(() => {}, 30000);"
    );

    try {
      const threadId = 'thread-immediate-abort';
      const session = startShellSession({
        cmd: `"${process.execPath}" "${script}" "${marker}"`,
        cwd: directory,
        threadId,
      });
      const wrapperPid = session.child.pid!;

      // Do not wait for the child marker before Stop: taskkill must cover a
      // child the cmd wrapper races to launch during cancellation.
      expect(killShellSessionsForThread(threadId)).toBe(1);
      await sleep(500);
      await expectProcessGone(wrapperPid);
      if (existsSync(marker)) {
        const childPid = Number(await readFile(marker, 'utf8'));
        expect(Number.isInteger(childPid)).toBe(true);
        await expectProcessGone(childPid);
      }
      await expect(windowsProcessesWithArgument(marker)).resolves.toEqual([]);
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  }, 15_000);

  it('killShellSessionsForThread unblocks the parked tool wait within seconds', async () => {
    const threadId = 'thread-abort-guard';
    const session = startShellSession({
      cmd: longRunningCommand({ reportPid: true }),
      cwd: process.cwd(),
      threadId,
    });
    const pid = session.child.pid!;
    const childPid = await descendantPid(session.id);

    const t0 = Date.now();
    const parked = waitForShellSessionClose(session.id, 20_000);
    setTimeout(() => killShellSessionsForThread(threadId), 100);

    expect(await parked).toBe(true);
    expect(Date.now() - t0).toBeLessThan(3_000);
    expect(session.killReason).toBe('abort');
    await expectProcessGone(pid);
    await expectProcessGone(childPid);
  }, 15_000);
});
