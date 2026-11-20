#!/usr/bin/env tsx
/**
 * verify:changed — the everyday check while working: typecheck only the
 * packages a change touches, run only the tests related to the changed files,
 * and print a short result. The full suites (`pnpm verify`, `pnpm test`) stay
 * the gate before a push.
 *
 * A server typecheck peaks at ~2 GB, and a coverage-on jest run uses several
 * times the memory and ~100x the output of a coverage-off one, so broad runs
 * in parallel can exhaust RAM.
 *
 *   pnpm verify:changed                        # files changed vs HEAD + untracked
 *   pnpm verify:changed -- path/a.ts path/b.ts # only these files (shared trees)
 *   pnpm verify:changed -- --since origin/main # files changed since a ref
 *   --integration   also run related integration suites (needs the test cluster)
 *   --no-typecheck  --no-tests  skip a step
 *
 * Only one verify:changed runs at a time on this machine: a second one waits
 * for the lock, so concurrent runs queue instead of stacking memory.
 *
 * When pnpm-lock.yaml changed since node_modules was installed, it re-syncs
 * with an offline frozen install first, so checks never run against stale
 * packages.
 */

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getErrorMessage } from '@snaglet/shared/utils';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
// Repo-local, so processes with different TMPDIRs (Snaglet.app's environment, a
// terminal) share one lock.
const LOCK_DIR = join(ROOT, 'node_modules', '.cache', 'snaglet-verify-changed.lock');
const LOCK_WAIT_MS = 20 * 60_000;
// pnpm's copy of the lockfile it last installed, and our stamp of the last
// lockfile we saw installed (pnpm's copy can legitimately differ, e.g. when
// platform-only packages were skipped).
const INSTALLED_LOCKFILE = join(ROOT, 'node_modules', '.pnpm', 'lock.yaml');
const LOCKFILE_STAMP = join(ROOT, 'node_modules', '.cache', 'snaglet-verify-changed.lockfile-sha');
const MAX_FAILURE_LINES = 120;

type Pkg = 'theme' | 'shared' | 'db' | 'sdk' | 'server' | 'ui' | 'desktop-ui' | 'build';

/** Typecheck command per package, run sequentially in this order. */
const TYPECHECK: Record<Pkg, string[]> = {
  // Also fails when its committed generated files are stale.
  theme: ['pnpm', '-s', '--filter', '@snaglet/theme', 'typecheck'],
  shared: ['pnpm', '-s', '--filter', '@snaglet/shared', 'typecheck'],
  db: ['pnpm', '-s', '--filter', '@snaglet/db', 'typecheck'],
  sdk: ['pnpm', '-s', '--filter', '@snaglet/sdk', 'typecheck'],
  server: ['pnpm', '-s', '--filter', '@snaglet/server', 'typecheck'],
  ui: ['pnpm', '-s', '--filter', '@snaglet/ui', 'typecheck'],
  'desktop-ui': ['pnpm', '-s', '--filter', '@snaglet/desktop-ui', 'typecheck'],
  build: ['pnpm', '-s', 'exec', 'tsc', '--noEmit', '-p', 'build/tsconfig.json'],
};
const ORDER: Pkg[] = ['theme', 'shared', 'db', 'sdk', 'server', 'ui', 'desktop-ui', 'build'];

/** A change under a package also needs its dependents rechecked. */
const DEPENDENTS: Record<Pkg, Pkg[]> = {
  theme: ['theme', 'shared', 'db', 'sdk', 'server', 'ui', 'desktop-ui'],
  shared: ['shared', 'db', 'sdk', 'server', 'desktop-ui'],
  db: ['db', 'server'],
  sdk: ['sdk'],
  server: ['server'],
  ui: ['ui', 'desktop-ui'],
  'desktop-ui': ['desktop-ui'],
  build: ['build'],
};

const PKG_PREFIX: [string, Pkg][] = [
  ['packages/theme/', 'theme'],
  ['packages/shared/', 'shared'],
  ['packages/db/', 'db'],
  ['packages/snaglet-sdk/', 'sdk'],
  ['packages/ui/', 'ui'],
  ['apps/server/', 'server'],
  ['apps/desktop-ui/', 'desktop-ui'],
  ['build/', 'build'],
];

const CODE_FILE = /\.(c|m)?(t|j)sx?$/;

interface Options {
  files: string[];
  since: string | null;
  integration: boolean;
  typecheck: boolean;
  tests: boolean;
}

function parseArgs(argv: string[]): Options {
  const opts: Options = {
    files: [],
    since: null,
    integration: false,
    typecheck: true,
    tests: true,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === '--') continue;
    if (arg === '--since') opts.since = argv[++i] ?? null;
    else if (arg === '--integration') opts.integration = true;
    else if (arg === '--no-typecheck') opts.typecheck = false;
    else if (arg === '--no-tests') opts.tests = false;
    else if (arg.startsWith('--')) throw new Error(`unknown option ${arg}`);
    else opts.files.push(relative(ROOT, resolve(process.cwd(), arg)));
  }
  return opts;
}

interface RunResult {
  code: number;
  output: string;
}

function run(cmd: string[], cwd = ROOT, env: NodeJS.ProcessEnv = {}): Promise<RunResult> {
  return new Promise((done) => {
    const child = spawn(cmd[0]!, cmd.slice(1), {
      cwd,
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', (chunk: Buffer) => (output += chunk.toString()));
    child.stderr.on('data', (chunk: Buffer) => (output += chunk.toString()));
    child.on('close', (code) => done({ code: code ?? 1, output }));
  });
}

async function changedFiles(opts: Options): Promise<string[]> {
  if (opts.files.length > 0) return opts.files;
  const diff = await run(['git', 'diff', '--name-only', opts.since ?? 'HEAD']);
  const untracked = opts.since
    ? { output: '' }
    : await run(['git', 'ls-files', '--others', '--exclude-standard']);
  return [...new Set(`${diff.output}\n${untracked.output}`.split('\n').filter(Boolean))];
}

function packagesFor(files: string[]): Pkg[] {
  const hit = new Set<Pkg>();
  for (const file of files) {
    if (!CODE_FILE.test(file) && !file.endsWith('tsconfig.json')) continue;
    const match = PKG_PREFIX.find(([prefix]) => file.startsWith(prefix));
    if (match) for (const pkg of DEPENDENTS[match[1]]) hit.add(pkg);
  }
  return ORDER.filter((pkg) => hit.has(pkg));
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** One verify:changed at a time on this machine; a dead holder's lock is reclaimed. */
async function acquireLock(): Promise<() => void> {
  const started = Date.now();
  let announced = false;
  for (;;) {
    try {
      mkdirSync(join(LOCK_DIR, '..'), { recursive: true });
      mkdirSync(LOCK_DIR);
      writeFileSync(join(LOCK_DIR, 'pid'), String(process.pid));
      return () => rmSync(LOCK_DIR, { recursive: true, force: true });
    } catch {
      let holder = 0;
      try {
        holder = Number(readFileSync(join(LOCK_DIR, 'pid'), 'utf8'));
      } catch {
        /* lock dir mid-creation: retry */
      }
      if (holder && !pidAlive(holder)) {
        rmSync(LOCK_DIR, { recursive: true, force: true });
        continue;
      }
      if (Date.now() - started > LOCK_WAIT_MS) {
        throw new Error(`another verify:changed (pid ${holder}) has held the lock for 20 min`);
      }
      if (!announced) {
        console.log(`waiting: another verify:changed is running (pid ${holder || '?'})`);
        announced = true;
      }
      await new Promise((r) => setTimeout(r, 3000));
    }
  }
}

function readOrNull(path: string): string | null {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

/**
 * Re-sync node_modules when pnpm-lock.yaml changed since the last install.
 * Returns false (with the reason printed) when the offline install fails.
 */
async function syncDependencies(): Promise<boolean> {
  const wanted = readOrNull(join(ROOT, 'pnpm-lock.yaml'));
  if (wanted === null) return true;
  const sha = createHash('sha256').update(wanted).digest('hex');
  if (readOrNull(LOCKFILE_STAMP) === sha) return true;
  if (readOrNull(INSTALLED_LOCKFILE) !== wanted) {
    console.log('· pnpm-lock.yaml changed since the last install: pnpm install --offline');
    const res = await run(['pnpm', 'install', '--offline', '--frozen-lockfile']);
    if (res.code !== 0) {
      console.log(
        `✗ dependency re-sync failed (a package may not be in the store yet; run pnpm install)\n${res.output.split('\n').slice(-15).join('\n')}`
      );
      return false;
    }
    console.log('✓ dependencies re-synced');
  }
  writeFileSync(LOCKFILE_STAMP, sha);
  return true;
}

/** Failure detail only, capped, so a red run stays cheap to read. */
function failureExcerpt(output: string): string {
  const lines = output.split('\n');
  const keep = lines.filter(
    (line) =>
      /error TS\d+|●|✕|×|FAIL|Expected|Received|Error:|at .+:\d+:\d+\)?$/.test(line) &&
      !/^\s*at .*node_modules/.test(line)
  );
  const picked = (keep.length > 0 ? keep : lines.slice(-40)).slice(0, MAX_FAILURE_LINES);
  const more =
    keep.length > MAX_FAILURE_LINES ? `\n… ${keep.length - MAX_FAILURE_LINES} more lines` : '';
  return picked.join('\n') + more;
}

function summaryLines(output: string): string {
  return output
    .split('\n')
    .filter((l) => /^(Tests:|Test Suites:)|Test Files|^\s+Tests\s/.test(l))
    .map((l) => l.trim())
    .join(' · ');
}

async function main(): Promise<number> {
  const opts = parseArgs(process.argv.slice(2));
  const files = await changedFiles(opts);
  const code = files.filter((f) => CODE_FILE.test(f));
  if (code.length === 0) {
    console.log('verify:changed: no changed code files — nothing to check');
    return 0;
  }
  const release = await acquireLock();
  const t0 = Date.now();
  let failed = false;
  try {
    console.log(`verify:changed: ${code.length} changed code file(s)`);
    if (!(await syncDependencies())) return 1;

    if (opts.typecheck) {
      const pkgs = packagesFor(files);
      for (const pkg of pkgs) {
        const res = await run(TYPECHECK[pkg]);
        if (res.code === 0) console.log(`✓ typecheck ${pkg}`);
        else {
          failed = true;
          console.log(`✗ typecheck ${pkg}\n${failureExcerpt(res.output)}`);
        }
      }
      if (pkgs.length === 0) console.log('· typecheck: no package touched');
    }

    if (opts.tests) {
      const jestFiles = code.filter(
        (f) => !f.startsWith('apps/desktop-ui/') && !f.startsWith('packages/ui/')
      );
      if (jestFiles.length > 0) {
        const projects = ['unit:server', 'unit:shared'];
        if (opts.integration) projects.push('integration:server', 'integration:db');
        const res = await run(
          [
            'node',
            '--experimental-vm-modules',
            'node_modules/jest/bin/jest.js',
            '--selectProjects',
            ...projects,
            '--findRelatedTests',
            ...jestFiles,
            '--coverage=false',
            '--maxWorkers=2',
            '--passWithNoTests',
            '--silent',
          ],
          ROOT,
          { NODE_ENV: 'test' }
        );
        if (res.code === 0)
          console.log(`✓ jest (related) ${summaryLines(res.output) || 'no related tests'}`);
        else {
          failed = true;
          console.log(
            `✗ jest (related) ${summaryLines(res.output)}\n${failureExcerpt(res.output)}`
          );
        }
      }

      const uiFiles = code
        .filter((f) => f.startsWith('apps/desktop-ui/'))
        .map((f) => relative('apps/desktop-ui', f));
      if (uiFiles.length > 0) {
        const res = await run(
          ['npx', 'vitest', 'related', ...uiFiles, '--run', '--passWithNoTests', '--reporter=dot'],
          join(ROOT, 'apps/desktop-ui')
        );
        if (res.code === 0) console.log(`✓ vitest (related) ${summaryLines(res.output)}`);
        else {
          failed = true;
          console.log(
            `✗ vitest (related) ${summaryLines(res.output)}\n${failureExcerpt(res.output)}`
          );
        }
      }
    }
  } finally {
    release();
  }
  const secs = Math.round((Date.now() - t0) / 1000);
  console.log(`verify:changed ${failed ? '✗ FAILED' : '✓ passed'} in ${secs}s`);
  return failed ? 1 : 0;
}

main().then(
  (code) => process.exit(code),
  (err: unknown) => {
    console.error(`verify:changed: ${getErrorMessage(err)}`);
    process.exit(1);
  }
);
