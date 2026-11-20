/**
 * ToolWorkspaceService.install finds pnpm through the login shell's PATH.
 *
 * Snaglet.app opened from the Dock or Finder inherits launchd's PATH
 * (/usr/bin:/bin:/usr/sbin:/sbin), so creating a tool failed with
 * `Install failed: spawn pnpm ENOENT`. These tests spawn for real: $SHELL is a
 * fake login shell that prints a PATH naming a temp folder with a fake `pnpm`,
 * and the inherited PATH is set to launchd's. A login shell that ignores
 * SIGTERM and hangs must not hold an install up past the lookup's bound.
 */
import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
  afterEach,
  jest,
} from '@jest/globals';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import path from 'path';

jest.mock('@server/config/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const LAUNCHD_PATH = '/usr/bin:/bin:/usr/sbin:/sbin';
const MARK = '__SNAGLET_LOGIN_PATH__';
const describePosix = process.platform === 'win32' ? describe.skip : describe;

let root: string;
let workspacesDir: string;
const saved = { PATH: process.env.PATH, SHELL: process.env.SHELL };

async function writeScript(file: string, body: string): Promise<void> {
  await writeFile(file, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
}

/** Fresh modules, so the memoized login-shell lookup runs again with this test's $SHELL. */
async function loadModules(shellName: string, shellBody: string) {
  const shell = path.join(root, shellName);
  await writeScript(shell, shellBody);
  process.env.SHELL = shell;
  jest.resetModules();
  const lookup = await import('@server/services/ToolService/lib/loginShellPath');
  const mod = await import('@server/services/ToolService/ToolWorkspaceService');
  return { service: mod.toolWorkspaceService, resolveLoginShellPath: lookup.resolveLoginShellPath };
}

/** A service whose login shell answers with `loginPath`. */
async function loadService(loginPath: string) {
  const { service } = await loadModules(
    `login-shell-${path.basename(loginPath)}`,
    `printf '${MARK}%s${MARK}' '${loginPath}'`
  );
  return service;
}

beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'snaglet-tool-login-path-'));
  workspacesDir = path.join(root, 'workspaces');
  await mkdir(path.join(workspacesDir, 'test-tool'), { recursive: true });
  process.env.TOOL_WORKSPACES_DIR = workspacesDir;
});

afterAll(async () => {
  delete process.env.TOOL_WORKSPACES_DIR;
  await rm(root, { recursive: true, force: true });
});

beforeEach(() => {
  process.env.PATH = LAUNCHD_PATH;
});

afterEach(() => {
  process.env.PATH = saved.PATH;
  if (saved.SHELL === undefined) delete process.env.SHELL;
  else process.env.SHELL = saved.SHELL;
});

describePosix('ToolWorkspaceService.install — login-shell PATH', () => {
  it('runs a pnpm that only the login shell PATH has, and the child sees the merged PATH', async () => {
    const loginBin = path.join(root, 'login-bin');
    await mkdir(loginBin, { recursive: true });
    await writeScript(path.join(loginBin, 'pnpm'), `printf 'PATH=%s' "$PATH"`);
    const service = await loadService(loginBin);

    const result = await service.install('test-tool');

    expect(result.error).toBeUndefined();
    expect(result.success).toBe(true);
    expect(result.output).toBe(`PATH=${loginBin}:${LAUNCHD_PATH}`);
  });

  it('says in plain words what to do when no pnpm exists anywhere', async () => {
    const emptyLoginBin = path.join(root, 'empty-login-bin');
    const emptyInherited = path.join(root, 'empty-inherited-bin');
    await mkdir(emptyLoginBin, { recursive: true });
    await mkdir(emptyInherited, { recursive: true });
    process.env.PATH = emptyInherited;
    const service = await loadService(emptyLoginBin);

    const result = await service.install('test-tool');

    expect(result.success).toBe(false);
    expect(result.error).toBe(
      "Snaglet could not find pnpm. Install it, or add its folder to your shell's PATH, then restart Snaglet."
    );
  });

  describe('a login shell that ignores SIGTERM and hangs', () => {
    const sleepPidFile = (): string => path.join(root, 'hung-shell-sleep.pid');

    afterEach(async () => {
      const pid = Number(await readFile(sleepPidFile(), 'utf-8').catch(() => ''));
      if (pid > 0) {
        try {
          process.kill(pid, 'SIGKILL');
        } catch {
          // already gone
        }
      }
    });

    it('settles within the bound, and the install proceeds with the inherited PATH', async () => {
      const inheritedBin = path.join(root, 'inherited-bin');
      await mkdir(inheritedBin, { recursive: true });
      await writeScript(path.join(inheritedBin, 'pnpm'), `printf 'PATH=%s' "$PATH"`);
      process.env.PATH = `${inheritedBin}:${LAUNCHD_PATH}`;
      // Ignores SIGTERM, as an interactive zsh does, and hangs; the pid file
      // lets afterEach reap the sleep.
      const { service, resolveLoginShellPath } = await loadModules(
        'login-shell-hung',
        `trap '' TERM\nsleep 10 &\necho $! > '${sleepPidFile()}'\nwait`
      );

      const timeoutMs = 300;
      const t0 = Date.now();
      await resolveLoginShellPath(timeoutMs);
      const elapsed = Date.now() - t0;

      // timeout + the 1 s settle grace, plus scheduling slack.
      expect(elapsed).toBeLessThan(timeoutMs + 1000 + 1000);
      const result = await service.install('test-tool');
      expect(result.success).toBe(true);
      expect(result.output).toBe(`PATH=${inheritedBin}:${LAUNCHD_PATH}`);
    });
  });
});
