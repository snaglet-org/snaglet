/**
 * exec_command output is a bounded ring buffer: a command that prints far more
 * than the cap keeps only the newest output in memory, and the next read says
 * how much was dropped instead of silently starting mid-stream. Runs a real
 * child process, like shellGuardrails.test.ts.
 */

import { afterEach, describe, expect, it } from '@jest/globals';
import {
  getShellSession,
  killAllShellSessions,
  readShellSessionOutput,
  recordShellPoll,
  startShellSession,
  waitForShellSessionClose,
} from '@server/services/ToolService/tools/shell/codex-shell-sessions';
import { SHELL_OUTPUT_BUFFER_CHARS } from '@server/services/ToolService/tools/shell/shellGuardrails';

const FLOOD_CHARS = SHELL_OUTPUT_BUFFER_CHARS * 3;

function printCommand(script: string): string {
  return `"${process.execPath}" -e "${script}"`;
}

afterEach(() => {
  killAllShellSessions();
});

describe('exec_command output buffer', () => {
  it('keeps only the newest output and marks what was dropped', async () => {
    const session = startShellSession({
      cmd: printCommand(
        `process.stdout.write('a'.repeat(${FLOOD_CHARS})); process.stdout.write('TAIL-END')`
      ),
      cwd: process.cwd(),
    });

    await expect(waitForShellSessionClose(session.id, 20_000)).resolves.toBe(true);

    const retained = getShellSession(session.id)!.output.length;
    expect(retained).toBeLessThanOrEqual(Math.ceil(SHELL_OUTPUT_BUFFER_CHARS * 1.25));

    const text = readShellSessionOutput(session.id);
    expect(text).toMatch(/^\[snaglet-guardrail\] \d+ chars of earlier output were dropped/);
    expect(text.endsWith('TAIL-END')).toBe(true);
    const dropped = Number(/^\[snaglet-guardrail\] (\d+) chars/.exec(text)![1]);
    expect(dropped + retained).toBe(FLOOD_CHARS + 'TAIL-END'.length);

    expect(readShellSessionOutput(session.id)).toBe('');
  });

  it('returns small output unchanged and resumes from the last read', async () => {
    const session = startShellSession({
      cmd: printCommand(
        `process.stdout.write('first'); setTimeout(() => process.stdout.write('second'), 300)`
      ),
      cwd: process.cwd(),
    });

    const deadline = Date.now() + 5_000;
    while (!getShellSession(session.id)!.output.includes('first') && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(readShellSessionOutput(session.id)).toBe('first');

    await expect(waitForShellSessionClose(session.id, 5_000)).resolves.toBe(true);
    expect(readShellSessionOutput(session.id)).toBe('second');
  });

  it('still counts dropped output as progress for the idle-poll breaker', async () => {
    const session = startShellSession({
      cmd: printCommand(
        `process.stdout.write('b'.repeat(${FLOOD_CHARS})); setInterval(() => {}, 30000)`
      ),
      cwd: process.cwd(),
    });

    const deadline = Date.now() + 10_000;
    while (getShellSession(session.id)!.droppedChars === 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(getShellSession(session.id)!.droppedChars).toBeGreaterThan(0);

    expect(recordShellPoll(session.id)).toBe(false);
    expect(getShellSession(session.id)!.idlePollCount).toBe(0);
  });
});
