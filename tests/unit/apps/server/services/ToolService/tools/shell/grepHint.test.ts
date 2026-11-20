/**
 * The shell tool adds one corrective line when an agent's recursive
 * grep crawls node_modules and turns slow (yields or is killed) — and never
 * otherwise.
 */
import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import { mkdirSync, mkdtempSync, renameSync } from 'fs';
import { homedir, tmpdir } from 'os';
import { join } from 'path';
import {
  RECURSIVE_GREP_HINT,
  isRecursiveGrepOverNodeModules,
  recursiveGrepHint,
} from '@server/services/ToolService/tools/shell/grepHint';

let repo: string;
let clean: string;

beforeAll(() => {
  // repo/ has no node_modules of its own; repo/apps/server/node_modules is
  // the pnpm layout. repo/docs has none anywhere.
  repo = mkdtempSync(join(tmpdir(), 'snaglet-grephint-'));
  mkdirSync(join(repo, 'apps', 'server', 'node_modules', 'dep'), { recursive: true });
  mkdirSync(join(repo, 'node_modules'), { recursive: true });
  mkdirSync(join(repo, 'docs', 'guide'), { recursive: true });
  clean = mkdtempSync(join(tmpdir(), 'snaglet-grephint-clean-'));
  mkdirSync(join(clean, 'src'), { recursive: true });
});

afterAll(() => {
  const trash = join(homedir(), '.Trash');
  for (const dir of [repo, clean]) {
    try {
      renameSync(dir, join(trash, `${dir.split('/').pop()}-${Date.now()}`));
    } catch {
      /* tmp cleanup is best-effort */
    }
  }
});

describe('isRecursiveGrepOverNodeModules', () => {
  it.each([
    ['grep -rn "stale-plan" apps', 'apps/ (pnpm: apps/server/node_modules)'],
    ['grep -R foo .', 'cwd with node_modules'],
    ['grep --recursive foo', 'no path: searches the cwd'],
    ['cd x; grep -rln "a b" apps tests | head', 'inside a pipeline'],
    ['/usr/bin/grep -rn foo apps', 'absolute binary path'],
    ['egrep -ri "x|y" apps', 'egrep'],
    ['grep -rn -e foo apps', 'explicit -e pattern'],
    ['grep -rn foo apps/server/node_modules', 'path inside node_modules'],
    ['LC_ALL=C grep -rn foo apps', 'env-assignment prefix'],
    ['cd /tmp && sudo grep -r foo apps', 'after && with a wrapper'],
  ])('flags %s (%s)', (cmd) => {
    expect(isRecursiveGrepOverNodeModules(cmd, repo)).toBe(true);
  });

  it.each([
    ['git grep -n foo -- apps', 'git grep'],
    ['rg foo apps', 'ripgrep'],
    ['grep -n foo apps/server/src/index.ts', 'not recursive'],
    ['grep -rn --exclude-dir=node_modules foo apps', 'excludes node_modules'],
    ['grep -rn --exclude-dir node_modules foo apps', 'excludes node_modules (spaced)'],
    ['grep -rn foo docs', 'tree without node_modules'],
    ['grep -rn apps docs', 'pattern that names a node_modules tree is not a path'],
    ['echo grep -r foo', 'grep as an argument'],
    ['git log --grep -r apps', 'a git option, not grep'],
  ])('ignores %s (%s)', (cmd) => {
    expect(isRecursiveGrepOverNodeModules(cmd, repo)).toBe(false);
  });

  it('ignores grep -r in a cwd with no node_modules anywhere', () => {
    expect(isRecursiveGrepOverNodeModules('grep -rn foo .', clean)).toBe(false);
    expect(isRecursiveGrepOverNodeModules('grep -rn foo', clean)).toBe(false);
  });
});

describe('recursiveGrepHint', () => {
  it('adds the hint only when the call was slow', () => {
    const command = 'grep -rn foo apps';
    expect(recursiveGrepHint({ command, cwd: repo, slow: true })).toBe(RECURSIVE_GREP_HINT);
    expect(recursiveGrepHint({ command, cwd: repo, slow: false })).toBeNull();
  });

  it('never hints for a slow non-grep command', () => {
    expect(recursiveGrepHint({ command: 'pnpm test', cwd: repo, slow: true })).toBeNull();
  });

  it('points at git grep (rg is not guaranteed on the agent PATH)', () => {
    expect(RECURSIVE_GREP_HINT).toMatch(/git grep/);
    expect(RECURSIVE_GREP_HINT).not.toMatch(/\brg\b/);
  });
});

describe('shell(op:run) wiring', () => {
  // A shell function named grep that just sleeps: deterministic "slow grep -r"
  // without crawling anything. The hint keys off the command text, not timing.
  const slowGrep = (args: string) => `grep() { sleep 2; }; grep ${args}`;

  it('appends the hint when a recursive grep over node_modules yields', async () => {
    const { default: shellRun } = await import('@server/services/ToolService/tools/shell/shellRun');
    const out = String(
      await shellRun(
        { cmd: slowGrep('-rn foo apps'), workdir: repo, yield_time_ms: 250, timeout_ms: 10_000 },
        {}
      )
    );
    expect(out).toContain('Process running with session ID');
    expect(out).toContain(RECURSIVE_GREP_HINT);
  });

  it('stays silent when the same grep finishes inside the yield window', async () => {
    const { default: shellRun } = await import('@server/services/ToolService/tools/shell/shellRun');
    const out = String(
      await shellRun({ cmd: 'grep -rn zzz-no-match-zzz docs; true', workdir: repo }, {})
    );
    expect(out).toContain('Process exited with code 0');
    expect(out).not.toContain(RECURSIVE_GREP_HINT);
  });
});
