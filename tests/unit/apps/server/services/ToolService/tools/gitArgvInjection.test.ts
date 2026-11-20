/**
 * git handlers: a caller-supplied remote/branch/ref/commit that starts with
 * `-` is refused before git runs (`--upload-pack=<cmd>` executes <cmd>;
 * `--output=<file>` overwrites <file>), and operands are placed after
 * `--end-of-options`. The real git binary runs against a scratch repository
 * so the new argv forms are proven to work, not just to look right.
 */

import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
import { existsSync } from 'fs';
import { mkdtemp, rm, writeFile } from 'fs/promises';
import type { ToolHandler, ToolHandlerRichResult } from '@server/services/ToolService/types';

type SharedModule = typeof import('@server/services/ToolService/handlers/_shared');
const runExecFileMock = jest.fn<
  ReturnType<SharedModule['runExecFile']>,
  Parameters<SharedModule['runExecFile']>
>();

jest.mock('@server/services/ToolService/handlers/_shared', () => {
  const actual = jest.requireActual<SharedModule>('@server/services/ToolService/handlers/_shared');
  return {
    ...actual,
    runExecFile: (...args: Parameters<SharedModule['runExecFile']>) => runExecFileMock(...args),
  };
});

import branch from '@server/services/ToolService/handlers/integrations/git/branch';
import checkout from '@server/services/ToolService/handlers/integrations/git/checkout';
import commit from '@server/services/ToolService/handlers/integrations/git/commit';
import diff from '@server/services/ToolService/handlers/integrations/git/diff';
import log from '@server/services/ToolService/handlers/integrations/git/log';
import pull from '@server/services/ToolService/handlers/integrations/git/pull';
import push from '@server/services/ToolService/handlers/integrations/git/push';
import verify from '@server/services/ToolService/handlers/integrations/git/verify';
import { gitOperand } from '@server/services/ToolService/handlers/integrations/git/gitArgs';

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 'Test User',
  GIT_AUTHOR_EMAIL: 'user@example.com',
  GIT_COMMITTER_NAME: 'Test User',
  GIT_COMMITTER_EMAIL: 'user@example.com',
};

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, env: GIT_ENV, encoding: 'utf8' }).trim();
}

async function run(handler: ToolHandler, input: Record<string, unknown>): Promise<string> {
  const result = await handler(input, {});
  return typeof result === 'string' ? result : (result as ToolHandlerRichResult).output;
}

function gitArgvCalls(): string[][] {
  return runExecFileMock.mock.calls.filter(([cmd]) => cmd === 'git').map(([, args]) => args);
}

let tmpDir: string;
let repo: string;
let remote: string;
let marker: string;

beforeEach(async () => {
  const actual = jest.requireActual<SharedModule>('@server/services/ToolService/handlers/_shared');
  runExecFileMock.mockReset();
  runExecFileMock.mockImplementation(actual.runExecFile);

  tmpDir = await mkdtemp(path.join(os.tmpdir(), 'snaglet-git-argv-test-'));
  remote = path.join(tmpDir, 'remote.git');
  repo = path.join(tmpDir, 'repo');
  marker = path.join(tmpDir, 'pwned');
  git(tmpDir, 'init', '-q', '--bare', remote);
  git(tmpDir, 'init', '-q', repo);
  git(repo, 'commit', '-q', '--allow-empty', '-m', 'first');
  await writeFile(path.join(repo, 'file.txt'), 'one\n');
  git(repo, 'add', 'file.txt');
  git(repo, 'commit', '-q', '-m', 'second');
  git(repo, 'remote', 'add', 'origin', remote);
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

describe('dash-leading operands are refused before git runs', () => {
  it('pull refuses a remote of --upload-pack=<cmd>', async () => {
    const remoteArg = `--upload-pack=touch ${marker}`;
    await expect(run(pull, { cwd: repo, remote: remoteArg, branch: 'main' })).rejects.toThrow(
      /remote must not start with "-"/
    );
    await expect(run(pull, { cwd: repo, remote: 'origin', branch: remoteArg })).rejects.toThrow(
      /branch must not start with "-"/
    );
    expect(gitArgvCalls()).toHaveLength(0);
    expect(existsSync(marker)).toBe(false);
  });

  it('push refuses a remote of --receive-pack=<cmd>', async () => {
    await expect(
      run(push, { cwd: repo, remote: `--receive-pack=touch ${marker}`, branch: 'main' })
    ).rejects.toThrow(/must not start with "-"/);
    expect(existsSync(marker)).toBe(false);
  });

  it('log and diff refuse --output=<file>', async () => {
    const output = `--output=${marker}`;
    await expect(run(log, { cwd: repo, branch: output })).rejects.toThrow(/must not start/);
    await expect(run(diff, { cwd: repo, commit: output })).rejects.toThrow(/must not start/);
    expect(existsSync(marker)).toBe(false);
  });

  it('branch, checkout, commit and verify refuse flag-shaped names and refs', async () => {
    await expect(run(branch, { cwd: repo, action: 'create', name: '-D' })).rejects.toThrow();
    await expect(
      run(branch, { cwd: repo, action: 'create', name: 'x', startPoint: '--all' })
    ).rejects.toThrow();
    await expect(run(checkout, { cwd: repo, ref: '--orphan=x' })).rejects.toThrow();
    await expect(run(commit, { cwd: repo, message: 'm', branch: '--detach' })).rejects.toThrow();
    await expect(run(verify, { cwd: repo, ref: '--git-dir' })).rejects.toThrow();
    expect(gitArgvCalls().some((args) => args.some((arg) => arg.startsWith('--orphan')))).toBe(
      false
    );
  });

  it('gitOperand passes ordinary operands through', () => {
    expect(gitOperand('ref', 'feature/x')).toBe('feature/x');
    expect(gitOperand('ref', 'HEAD~1')).toBe('HEAD~1');
    expect(() => gitOperand('ref', '-x')).toThrow();
  });
});

describe('operands follow --end-of-options and still work against real git', () => {
  it('log places the branch after --end-of-options', async () => {
    const out = await run(log, { cwd: repo, branch: 'HEAD', path: 'file.txt' });
    expect(out).toContain('second');
    const [args] = gitArgvCalls();
    expect(args.slice(-4)).toEqual(['--end-of-options', 'HEAD', '--', 'file.txt']);
  });

  it('diff compares against a commit placed after --end-of-options', async () => {
    const out = await run(diff, { cwd: repo, commit: 'HEAD~1', stat: true });
    expect(out).toContain('file.txt');
    for (const args of gitArgvCalls()) {
      expect(args.indexOf('--end-of-options')).toBe(args.indexOf('HEAD~1') - 1);
    }
  });

  it('branch create/delete and switch -c with a start point', async () => {
    await run(branch, { cwd: repo, action: 'create', name: 'feature-a', startPoint: 'HEAD~1' });
    await run(checkout, { cwd: repo, ref: 'feature-b', create: true, startPoint: 'HEAD~1' });
    expect(git(repo, 'branch', '--show-current')).toBe('feature-b');
    await run(checkout, { cwd: repo, ref: 'feature-a' });
    expect(git(repo, 'branch', '--show-current')).toBe('feature-a');
    await run(branch, { cwd: repo, action: 'delete', name: 'feature-b', force: true });
    expect(git(repo, 'branch', '--list', 'feature-b')).toBe('');
  });

  it('push and pull reach a real remote', async () => {
    const current = git(repo, 'branch', '--show-current');
    await run(push, { cwd: repo, remote: 'origin', branch: current });
    expect(git(remote, 'rev-parse', current)).toBe(git(repo, 'rev-parse', 'HEAD'));
    const pulled = await run(pull, { cwd: repo, remote: 'origin', branch: current, ffOnly: true });
    expect(pulled).toMatch(/up to date|Pulled/i);
    const pullArgs = gitArgvCalls().find((args) => args[0] === 'pull');
    expect(pullArgs?.slice(-3)).toEqual(['--end-of-options', 'origin', current]);
  });

  it('verify resolves an ordinary ref', async () => {
    const out = await run(verify, { cwd: repo, ref: 'HEAD' });
    expect(JSON.parse(out)).toMatchObject({ exists: true });
  });
});
