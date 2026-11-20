/**
 * Documentation release gate (`pnpm lint:docs`). Checks every markdown file
 * git tracks or would track (new files count before they are committed;
 * ignored files never do); the rules live in `scripts/lib/docsGate.ts`.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runDocsGate } from './lib/docsGate';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const trackedFiles = [
  ...new Set(
    execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], {
      cwd: repoRoot,
      encoding: 'utf8',
    }).split('\0')
  ),
].filter((file) => file && existsSync(path.join(repoRoot, file)));

const scripts = new Map<string, Set<string>>();
for (const manifest of trackedFiles.filter((file) => /(^|\/)package\.json$/.test(file))) {
  const pkg = JSON.parse(readFileSync(path.join(repoRoot, manifest), 'utf8')) as {
    name?: string;
    scripts?: Record<string, string>;
  };
  const names = new Set(Object.keys(pkg.scripts ?? {}));
  const dir = path.posix.dirname(manifest);
  scripts.set(dir === '.' ? '' : dir, names);
  if (dir !== '.' && pkg.name) scripts.set(pkg.name, names);
}

const violations = runDocsGate({
  trackedFiles,
  readFile: (file) => readFileSync(path.join(repoRoot, file), 'utf8'),
  scripts,
});

if (violations.length > 0) {
  for (const violation of violations) {
    console.error(`${violation.file}:${violation.line} [${violation.rule}] ${violation.message}`);
  }
  console.error(
    `\nlint:docs: ${violations.length} problem(s). See the Documentation section of CONTRIBUTING.md.`
  );
  process.exit(1);
}

console.log('lint:docs: documentation gate passed.');
