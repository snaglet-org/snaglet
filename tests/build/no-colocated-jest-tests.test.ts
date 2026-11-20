import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

// Jest never runs a *.test.ts co-located with source: it compiles but is
// silently skipped. This guard fails the build when it finds one.
//
// Jest's testMatch (see jest.config.js) only picks up:
//   tests/unit/apps/server/**        (unit:server)
//   tests/unit/packages/**           (unit:shared)
//   tests/integration/apps/server/** (integration:server)
//   tests/integration/packages/**    (integration:db)
// The Jest-covered *source* trees are therefore apps/server and packages. Any
// *.test.ts(x) inside those trees but outside the root tests/ dir belongs under
// tests/unit or tests/integration instead.
//
// apps/desktop-ui and packages/ui use Vitest, which co-locates *.test.tsx next
// to source by design; they are not scanned here.

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

// Roots derived from jest.config.js testMatch — the Jest-covered source trees.
// Deliberately excludes apps/desktop-ui (Vitest co-locates tests by design).
const JEST_SOURCE_ROOTS = [
  'apps/server',
  'packages/db',
  'packages/snaglet-cli',
  'packages/snaglet-sdk',
  'packages/shared',
] as const;

// Skipped while walking: build output, deps, and any nested `tests/` dir (the
// only sanctioned home for Jest suites lives at the repo root, not in-tree).
const IGNORED_DIRS = new Set(['node_modules', 'dist', 'build', 'coverage', '.turbo', 'tests']);

const TEST_FILE = /\.test\.tsx?$/;

function collectColocatedTests(absDir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(absDir, { withFileTypes: true })) {
    const abs = path.join(absDir, entry.name);
    if (entry.isDirectory()) {
      if (IGNORED_DIRS.has(entry.name)) continue;
      found.push(...collectColocatedTests(abs));
    } else if (entry.isFile() && TEST_FILE.test(entry.name)) {
      found.push(abs);
    }
  }
  return found;
}

for (const root of JEST_SOURCE_ROOTS) {
  test(`no co-located Jest tests under ${root}/ (Jest silently skips them)`, () => {
    const offenders = collectColocatedTests(path.join(repoRoot, root))
      .map((p) => path.relative(repoRoot, p))
      .sort();

    assert.deepEqual(
      offenders,
      [],
      `Found ${offenders.length} co-located test file(s) inside the Jest-covered source tree "${root}/". ` +
        `Jest only runs tests under tests/unit/** and tests/integration/** (see jest.config.js testMatch), ` +
        `so these compile but never execute:\n` +
        offenders.map((f) => `  - ${f}`).join('\n') +
        `\nMove each one under tests/unit or tests/integration (mirroring its source path).`
    );
  });
}
