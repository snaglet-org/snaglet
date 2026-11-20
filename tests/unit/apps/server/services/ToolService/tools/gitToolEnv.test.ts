/**
 * The git tool runs git in a directory the agent chooses, and git runs code that directory
 * controls: hooks, core.fsmonitor, diff and filter drivers. None of it may see the server's
 * secrets (the session and panel tokens, provider keys, database credentials, GitHub
 * tokens), while the settings git needs for the user's own credentials and network still
 * pass through. The real git binary runs against a scratch repository.
 */

import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'fs/promises';
import commit from '@server/services/ToolService/handlers/integrations/git/commit';
import status from '@server/services/ToolService/handlers/integrations/git/status';
import { runExecFile, runExecFileBuffer } from '@server/services/ToolService/handlers/_shared';
import { buildCommandEnv } from '@server/services/ToolService/lib/buildSafeEnv';

const SECRETS: Record<string, string> = {
  SNAGLET_AUTH_TOKEN: 'test-auth-token-aaaaaaaa',
  SNAGLET_PANEL_TOKEN: 'test-panel-token-aaaaaaaa',
  ANTHROPIC_API_KEY: 'test-provider-key-aaaaaaaa',
  DATABASE_URL: 'postgres://test-user:test-pass-aaaaaaaa@127.0.0.1:5432/test',
  GH_TOKEN: 'test-gh-token-aaaaaaaa',
  GITHUB_TOKEN: 'test-github-token-aaaaaaaa',
};

/** Settings git and its credential/network helpers honor; not credentials themselves. */
const SETTINGS: Record<string, string> = {
  HTTPS_PROXY: 'http://proxy.example.com:3128',
  NO_PROXY: 'localhost,127.0.0.1',
  SSH_AUTH_SOCK: '/tmp/test-agent.sock',
  GIT_SSH_COMMAND: 'ssh -o BatchMode=yes',
  SSL_CERT_FILE: '/tmp/test-ca.pem',
  LANG: 'en_US.UTF-8',
};

const saved: Record<string, string | undefined> = {};
const dirs: string[] = [];
const describePosix = process.platform === 'win32' ? describe.skip : describe;

beforeAll(async () => {
  // The developer's own git config must not change the result: a global core.hooksPath
  // skips .git/hooks, and commit.gpgsign can fail the commit. Both settings pass through
  // to git by design, so they isolate the scratch repositories here and in the tool.
  const configDir = await mkdtemp(path.join(os.tmpdir(), 'snaglet-git-config-'));
  dirs.push(configDir);
  const globalConfig = path.join(configDir, 'gitconfig');
  await writeFile(globalConfig, '');
  const isolation = { GIT_CONFIG_GLOBAL: globalConfig, GIT_CONFIG_NOSYSTEM: '1' };
  for (const [key, value] of Object.entries({ ...SECRETS, ...SETTINGS, ...isolation })) {
    saved[key] = process.env[key];
    process.env[key] = value;
  }
});

afterAll(async () => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', args, { cwd, stdio: 'ignore' });
}

/** A scratch repository and a script inside it that writes its environment to a file. */
async function repoWithEnvDump(): Promise<{ dir: string; dump: string; script: string }> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'snaglet-git-env-'));
  dirs.push(dir);
  git(dir, 'init', '-q');
  git(dir, 'config', 'user.name', 'Test User');
  git(dir, 'config', 'user.email', 'user@example.com');
  const dump = path.join(dir, '.git', 'env-dump.txt');
  const script = path.join(dir, '.git', 'dump-env.sh');
  await writeFile(script, `#!/bin/sh\nenv > "${dump}"\nexit 0\n`);
  await chmod(script, 0o755);
  await writeFile(path.join(dir, 'notes.txt'), 'hello\n');
  return { dir, dump, script };
}

/**
 * Names a hook may see that do not come from the server: git sets GIT_* for hooks, the
 * /usr/bin/git developer-tools shim sets the SDK paths, sh and CoreFoundation add the rest.
 */
const ADDED_BY_GIT_AND_SH = new Set([
  'PWD',
  'OLDPWD',
  'SHLVL',
  '_',
  '__CF_USER_TEXT_ENCODING',
  'SDKROOT',
  'CPATH',
  'LIBRARY_PATH',
  'MANPATH',
]);

/** Nothing else is inherited: every name is in the command allow-list or added downstream. */
function expectOnlyAllowedNames(env: string): void {
  const allowed = new Set(Object.keys(buildCommandEnv()));
  const names = env
    .split('\n')
    .map((line) => line.split('=')[0])
    .filter(Boolean);
  const stray = names.filter(
    (name) => !allowed.has(name) && !ADDED_BY_GIT_AND_SH.has(name) && !name.startsWith('GIT_')
  );
  expect(stray).toEqual([]);
}

function expectScrubbed(env: string): void {
  for (const [key, value] of Object.entries(SECRETS)) {
    expect(env).not.toContain(value);
    expect(env).not.toMatch(new RegExp(`^${key}=`, 'm'));
  }
  for (const [key, value] of Object.entries(SETTINGS)) {
    expect(env).toContain(`${key}=${value}`);
  }
  expect(env).toMatch(/^HOME=/m);
  expect(env).toMatch(/^PATH=/m);
}

describePosix('git tool environment', () => {
  it("a hook in the agent's repository never sees the server's secrets", async () => {
    const { dir, dump, script } = await repoWithEnvDump();
    await writeFile(path.join(dir, '.git', 'hooks', 'pre-commit'), `#!/bin/sh\n"${script}"\n`);
    await chmod(path.join(dir, '.git', 'hooks', 'pre-commit'), 0o755);

    const reply = await commit({ cwd: dir, message: 'Add notes' }, {});
    expect(String(reply)).toMatch(/^Committed [0-9a-f]{40}/);
    const env = await readFile(dump, 'utf8');
    expectScrubbed(env);
    expectOnlyAllowedNames(env);
  });

  it('nor does a core.fsmonitor command, which even git status runs', async () => {
    const { dir, dump, script } = await repoWithEnvDump();
    git(dir, 'config', 'core.fsmonitor', script);

    await status({ cwd: dir }, {});
    const env = await readFile(dump, 'utf8');
    expectScrubbed(env);
    expectOnlyAllowedNames(env);
  });

  it('the shared exec helpers default to the scrubbed environment', async () => {
    const text = await runExecFile('/usr/bin/env', []);
    expectScrubbed(text.stdout);
    const buffer = await runExecFileBuffer('/usr/bin/env', []);
    expectScrubbed(buffer.stdout.toString('utf8'));
  });

  it('a caller that passes its own environment still gets exactly that', async () => {
    const result = await runExecFile('/usr/bin/env', [], { env: { ONLY_THIS: 'yes' } });
    expect(result.stdout.trim()).toBe('ONLY_THIS=yes');
  });
});
