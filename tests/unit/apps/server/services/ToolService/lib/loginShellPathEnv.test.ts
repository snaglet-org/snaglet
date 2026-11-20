/**
 * At every boot Snaglet asks the user's login shell for its PATH, and the shell sources
 * ~/.zshenv, ~/.zprofile and ~/.zshrc, files an agent can write with its own shell. So the
 * login shell gets only what it needs to find and run those files, never the server's own
 * environment (session and panel tokens, the credential encryption key, provider keys).
 * $SHELL here is a fake login shell that writes its environment to a file and answers with
 * a PATH, as a planted line in a real rc file could.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, jest } from '@jest/globals';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import path from 'path';

jest.mock('@server/config/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const MARK = '__SNAGLET_LOGIN_PATH__';
const LAUNCHD_PATH = '/usr/bin:/bin:/usr/sbin:/sbin';
const describePosix = process.platform === 'win32' ? describe.skip : describe;

const SECRETS: Record<string, string> = {
  SNAGLET_AUTH_TOKEN: 'test-auth-token-aaaaaaaa',
  SNAGLET_PANEL_TOKEN: 'test-panel-token-aaaaaaaa',
  SNAGLET_SHUTDOWN_TOKEN: 'test-shutdown-token-aaaaaaaa',
  SNAGLET_EXPORT_GRANT_KEY: 'test-export-key-aaaaaaaa',
  CREDENTIAL_ENCRYPTION_KEY: 'test-encryption-key-aaaaaaaa',
  ANTHROPIC_API_KEY: 'test-provider-key-aaaaaaaa',
  NODE_OPTIONS: '--require /tmp/test-preload.js',
};
/** What a login shell needs to find and run the user's startup files. */
const NEEDED: Record<string, string> = {
  USER: 'test-user',
  LOGNAME: 'test-user',
  LANG: 'en_US.UTF-8',
  LC_CTYPE: 'en_US.UTF-8',
  TERM: 'xterm-256color',
  TMPDIR: '/tmp/test-tmp/',
};
/** Names sh and macOS add to every process. */
const ADDED_BY_SH = new Set(['PWD', 'OLDPWD', 'SHLVL', '_', '__CF_USER_TEXT_ENCODING']);

let root: string;
const saved: Record<string, string | undefined> = {};

beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'snaglet-login-shell-env-'));
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

afterEach(() => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describePosix('login shell PATH lookup', () => {
  it("runs the login shell without the server's secrets and still reads its PATH", async () => {
    const dump = path.join(root, 'login-shell-env.txt');
    const loginBin = path.join(root, 'login-bin');
    await mkdir(loginBin, { recursive: true });
    const shell = path.join(root, 'fake-login-shell');
    await writeFile(
      shell,
      `#!/bin/sh\nenv > '${dump}'\nprintf '${MARK}%s${MARK}' '${loginBin}'\n`,
      { mode: 0o755 }
    );
    for (const [key, value] of Object.entries({
      ...SECRETS,
      ...NEEDED,
      SHELL: shell,
      PATH: LAUNCHD_PATH,
    })) {
      saved[key] = process.env[key];
      process.env[key] = value;
    }
    jest.resetModules();
    const lookup = await import('@server/services/ToolService/lib/loginShellPath');

    await lookup.resolveLoginShellPath();

    expect(lookup.shellPath()).toBe(`${loginBin}:${LAUNCHD_PATH}`);
    const env = await readFile(dump, 'utf8');
    for (const [key, value] of Object.entries(SECRETS)) {
      expect(env).not.toContain(value);
      expect(env).not.toMatch(new RegExp(`^${key}=`, 'm'));
    }
    for (const [key, value] of Object.entries({ ...NEEDED, SHELL: shell, PATH: LAUNCHD_PATH })) {
      expect(env).toContain(`${key}=${value}\n`);
    }
    expect(env).toMatch(/^HOME=/m);
    const names = env
      .split('\n')
      .map((line) => line.split('=')[0])
      .filter(Boolean);
    const allowed = new Set([
      ...Object.keys(NEEDED),
      'SHELL',
      'PATH',
      'HOME',
      'ZDOTDIR',
      'XDG_CONFIG_HOME',
      ...ADDED_BY_SH,
    ]);
    expect(names.filter((name) => !allowed.has(name) && !name.startsWith('LC_'))).toEqual([]);
  });
});
