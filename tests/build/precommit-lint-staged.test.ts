import assert from 'node:assert/strict';
import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const sourceHook = path.join(repoRoot, '.husky/pre-commit');
const sourceGuard = path.join(repoRoot, 'scripts/precommit-lint-staged.mjs');
const lintStagedBin = path.join(repoRoot, 'node_modules/.bin/lint-staged');
const prettierBinDir = path.join(repoRoot, 'node_modules/.bin');
const partialPath = 'partial file\nwith newline.js';

interface Fixture {
  root: string;
  repo: string;
  env: NodeJS.ProcessEnv;
  pnpmLog: string;
}

function run(
  command: string,
  args: string[],
  options: { cwd: string; env?: NodeJS.ProcessEnv }
): SpawnSyncReturns<string> {
  return spawnSync(command, args, {
    cwd: options.cwd,
    env: options.env,
    encoding: 'utf8',
  });
}

function git(fixture: Fixture, args: string[], allowFailure = false): SpawnSyncReturns<string> {
  const result = run('git', args, { cwd: fixture.repo, env: fixture.env });
  if (!allowFailure && result.status !== 0) {
    assert.fail(`git ${args.join(' ')} failed:\n${result.stdout}${result.stderr}`);
  }
  return result;
}

function gitText(fixture: Fixture, args: string[]): string {
  return git(fixture, args).stdout.trim();
}

function gitBytes(fixture: Fixture, args: string[]): Buffer {
  const result = spawnSync('git', args, {
    cwd: fixture.repo,
    env: fixture.env,
    encoding: null,
  });
  if (result.status !== 0) {
    assert.fail(`git ${args.join(' ')} failed:\n${String(result.stdout)}${String(result.stderr)}`);
  }
  return result.stdout;
}

function write(repo: string, relativePath: string, content: string | Buffer): void {
  const destination = path.join(repo, relativePath);
  mkdirSync(path.dirname(destination), { recursive: true });
  writeFileSync(destination, content);
}

function assertNoStash(fixture: Fixture): void {
  assert.equal(gitText(fixture, ['stash', 'list', '--format=%gd %s']), '');
}

function setupFixture(t: TestContext): Fixture {
  assert.equal(existsSync(lintStagedBin), true, 'lint-staged binary must be installed');
  const root = mkdtempSync(path.join(tmpdir(), 'snaglet-precommit-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const repo = path.join(root, 'repo');
  const bin = path.join(root, 'bin');
  const pnpmLog = path.join(root, 'pnpm.log');
  mkdirSync(repo, { recursive: true });
  mkdirSync(bin, { recursive: true });

  const pnpmWrapper = path.join(bin, 'pnpm');
  writeFileSync(
    pnpmWrapper,
    [
      '#!/bin/sh',
      'printf \'%s\\n\' "$*" >> "$T015_PNPM_LOG"',
      'if [ "$1" != "exec" ] || [ "$2" != "lint-staged" ]; then',
      '  echo "unexpected pnpm invocation: $*" >&2',
      '  exit 64',
      'fi',
      'shift 2',
      'exec "$T015_LINT_STAGED_BIN" "$@"',
      '',
    ].join('\n')
  );
  chmodSync(pnpmWrapper, 0o755);

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PATH: `${bin}${path.delimiter}${prettierBinDir}${path.delimiter}${process.env.PATH ?? ''}`,
    T015_LINT_STAGED_BIN: lintStagedBin,
    T015_PNPM_LOG: pnpmLog,
  };
  const fixture = { root, repo, env, pnpmLog };
  git(fixture, ['init', '-q']);
  git(fixture, ['config', 'user.name', 'Test User']);
  git(fixture, ['config', 'user.email', 'user@example.com']);

  write(repo, '.husky/pre-commit', `#!/bin/sh\nset -eu\n${readFileSync(sourceHook, 'utf8')}`);
  chmodSync(path.join(repo, '.husky/pre-commit'), 0o755);
  mkdirSync(path.join(repo, 'scripts'), { recursive: true });
  copyFileSync(sourceGuard, path.join(repo, 'scripts/precommit-lint-staged.mjs'));
  write(
    repo,
    'package.json',
    `${JSON.stringify({ 'lint-staged': { '*.{js,json}': ['prettier --write'] } }, null, 2)}\n`
  );
  write(repo, 'foreign.js', 'const foreign = "baseline";\n');
  write(repo, partialPath, 'const baseline = true;\n');
  git(fixture, [
    'add',
    '--',
    '.husky/pre-commit',
    'scripts/precommit-lint-staged.mjs',
    'package.json',
    'foreign.js',
    partialPath,
  ]);
  git(fixture, ['commit', '-qm', 'fixture baseline']);
  git(fixture, ['config', 'core.hooksPath', '.husky']);
  assertNoStash(fixture);
  return fixture;
}

test('the real hook delegates to the guarded lint-staged runner', () => {
  assert.equal(readFileSync(sourceHook, 'utf8').trim(), 'node scripts/precommit-lint-staged.mjs');
});

test('normal staged commit formats successfully without creating a stash', (t) => {
  const fixture = setupFixture(t);
  write(fixture.repo, 'normal.js', 'const value={answer:42}\n');
  git(fixture, ['add', '--', 'normal.js']);

  git(fixture, ['commit', '-m', 'normal staged commit']);

  assert.equal(gitText(fixture, ['show', 'HEAD:normal.js']), 'const value = { answer: 42 };');
  assert.match(readFileSync(fixture.pnpmLog, 'utf8'), /^exec lint-staged --no-stash$/m);
  assertNoStash(fixture);
});

test('foreign dirty file survives byte-identically and stays unstaged', (t) => {
  const fixture = setupFixture(t);
  const foreignBytes = Buffer.from('const foreign={dirty:true}\n');
  write(fixture.repo, 'owned.js', 'const owned={ready:true}\n');
  write(fixture.repo, 'foreign.js', foreignBytes);
  git(fixture, ['add', '--', 'owned.js']);

  git(fixture, ['commit', '-m', 'owned change only']);

  assert.deepEqual(readFileSync(path.join(fixture.repo, 'foreign.js')), foreignBytes);
  assert.equal(gitText(fixture, ['diff', '--name-only']), 'foreign.js');
  assert.equal(
    gitText(fixture, ['diff-tree', '--no-commit-id', '--name-only', '-r', 'HEAD']),
    'owned.js'
  );
  assertNoStash(fixture);
});

test('partially staged whitespace and newline path fails before formatting', (t) => {
  const fixture = setupFixture(t);
  write(fixture.repo, partialPath, 'const staged={value:1}\n');
  git(fixture, ['add', '--', partialPath]);
  write(fixture.repo, partialPath, 'const staged={value:1}\nconst unstaged=true\n');
  const indexBefore = gitBytes(fixture, ['show', `:${partialPath}`]);
  const worktreeBefore = readFileSync(path.join(fixture.repo, partialPath));

  const commit = git(fixture, ['commit', '-m', 'must fail'], true);

  assert.notEqual(commit.status, 0);
  assert.match(commit.stderr, /refusing to format partially staged files/);
  assert.ok(commit.stderr.includes(JSON.stringify(partialPath)));
  assert.equal(existsSync(fixture.pnpmLog), false, 'formatter must not start');
  assert.deepEqual(gitBytes(fixture, ['show', `:${partialPath}`]), indexBefore);
  assert.deepEqual(readFileSync(path.join(fixture.repo, partialPath)), worktreeBefore);
  assertNoStash(fixture);
});

test('formatter failure preserves staged and foreign work without a stash', (t) => {
  const fixture = setupFixture(t);
  const broken = Buffer.from('{"broken": }\n');
  const foreign = Buffer.from('const foreign={mustSurvive:true}\n');
  write(fixture.repo, 'broken.json', broken);
  write(fixture.repo, 'foreign.js', foreign);
  git(fixture, ['add', '--', 'broken.json']);
  const indexBefore = gitBytes(fixture, ['show', ':broken.json']);

  const commit = git(fixture, ['commit', '-m', 'formatter must fail'], true);

  assert.notEqual(commit.status, 0);
  assert.match(`${commit.stdout}\n${commit.stderr}`, /prettier --write|SyntaxError/);
  assert.deepEqual(gitBytes(fixture, ['show', ':broken.json']), indexBefore);
  assert.deepEqual(readFileSync(path.join(fixture.repo, 'broken.json')), broken);
  assert.deepEqual(readFileSync(path.join(fixture.repo, 'foreign.js')), foreign);
  assert.equal(gitText(fixture, ['diff', '--cached', '--name-only']), 'broken.json');
  assert.equal(gitText(fixture, ['diff', '--name-only']), 'foreign.js');
  assertNoStash(fixture);
});

test('git inspection failure is visible, non-zero, and never invokes formatting', (t) => {
  const root = mkdtempSync(path.join(tmpdir(), 'snaglet-precommit-nonrepo-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const pnpmLog = path.join(root, 'pnpm.log');
  const bin = path.join(root, 'bin');
  mkdirSync(bin);
  const pnpm = path.join(bin, 'pnpm');
  writeFileSync(pnpm, '#!/bin/sh\nprintf invoked > "$T015_PNPM_LOG"\n');
  chmodSync(pnpm, 0o755);
  const result = run(process.execPath, [sourceGuard], {
    cwd: root,
    env: {
      ...process.env,
      PATH: `${bin}${path.delimiter}${process.env.PATH ?? ''}`,
      T015_PNPM_LOG: pnpmLog,
    },
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /not a git repository/i);
  assert.equal(existsSync(pnpmLog), false);
});
