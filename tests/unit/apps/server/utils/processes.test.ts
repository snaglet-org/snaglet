import { afterEach, describe, expect, it } from '@jest/globals';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { killProcessTree } from '@server/utils/processes';

const temporaryHomes: string[] = [];

async function disposableHome(): Promise<string> {
  const home = await mkdtemp(path.join(os.tmpdir(), 'snaglet-process-tree-'));
  temporaryHomes.push(home);
  return home;
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForProcessToExit(pid: number, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!processIsAlive(pid)) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`process ${pid} was still running after ${timeoutMs}ms`);
}

afterEach(async () => {
  await Promise.all(
    temporaryHomes.splice(0).map((home) => rm(home, { recursive: true, force: true }))
  );
});

describe('killProcessTree', () => {
  it('reaps a spawned descendant in a disposable Snaglet home', async () => {
    const home = await disposableHome();
    const parentScript = [
      "const { spawn } = require('node:child_process');",
      "const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 30000)'], { stdio: 'ignore' });",
      'process.stdout.write(`${child.pid}\\n`);',
      'setInterval(() => {}, 30000);',
    ].join('\n');
    const parent = spawn(process.execPath, ['-e', parentScript], {
      env: { ...process.env, SNAGLET_HOME: home },
      stdio: ['ignore', 'pipe', 'ignore'],
      detached: process.platform !== 'win32',
      windowsHide: true,
    });
    const parentPid = parent.pid;
    if (!parentPid) throw new Error('parent process did not start');

    const descendantPid = await new Promise<number>((resolve, reject) => {
      let output = '';
      const timeout = setTimeout(
        () => reject(new Error('descendant process did not report its pid')),
        2_000
      );
      parent.stdout.on('data', (chunk: Buffer) => {
        output += chunk.toString();
        const pid = Number(output.trim());
        if (Number.isInteger(pid) && pid > 0) {
          clearTimeout(timeout);
          resolve(pid);
        }
      });
      parent.on('error', (error) => {
        clearTimeout(timeout);
        reject(error);
      });
    });

    expect(processIsAlive(parentPid)).toBe(true);
    expect(processIsAlive(descendantPid)).toBe(true);
    killProcessTree(parent);
    await Promise.all([waitForProcessToExit(parentPid), waitForProcessToExit(descendantPid)]);
  }, 15_000);
});
