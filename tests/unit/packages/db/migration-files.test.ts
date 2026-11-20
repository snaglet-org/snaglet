import { readdirSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import * as path from 'node:path';
import { describe, expect, it } from '@jest/globals';
import {
  BASELINE_MIGRATION,
  migrationFiles,
  resolveMigrationsDir,
} from '../../../../packages/db/migration-files';

const repoRoot = path.resolve(__dirname, '../../../..');
const canonicalDir = path.join(repoRoot, 'packages', 'db', 'migrations');
const canonicalFiles = readdirSync(canonicalDir)
  .filter((name) => /^\d{4}_.+\.sql$/.test(name))
  .sort();

describe('migration file discovery', () => {
  it('finds the canonical SQL set from source and dist-shaped module locations', () => {
    const sourceModuleUrl = pathToFileURL(
      path.join(repoRoot, 'packages', 'db', 'migrations.ts')
    ).href;
    const distModuleUrl = pathToFileURL(path.join(repoRoot, 'dist', 'db', 'migrations.js')).href;

    const sourceDir = resolveMigrationsDir(sourceModuleUrl);
    const distDir = resolveMigrationsDir(distModuleUrl);
    const sourceFiles = migrationFiles(sourceDir);
    const distFiles = migrationFiles(distDir);

    expect(sourceDir).toBe(canonicalDir);
    expect(distDir).toBe(canonicalDir);
    expect(sourceFiles).toEqual(canonicalFiles);
    expect(distFiles).toEqual(sourceFiles);
    // The chain starts at the baseline: the complete initial schema.
    expect(sourceFiles[0]).toBe(BASELINE_MIGRATION);
  });

  it('ignores the seeds/ directory — seed files are not migrations', () => {
    // seeds/*.sql are replayed by ensureBuiltinCatalog / clean-slate resets
    // and folded into 0001_init.sql; they must never enter the ledger.
    expect(readdirSync(canonicalDir)).toContain('seeds');
    expect(migrationFiles().some((name) => name.includes('seeds'))).toBe(false);
    expect(migrationFiles()).toEqual(canonicalFiles);
  });

  it('holds no top-level rollback scripts — the runner is forward-only', () => {
    // A top-level NNNN_x.down.sql would match the runner's pattern and sort
    // before its forward file, so a hand-run rollback lives in down/.
    expect(migrationFiles().some((name) => name.includes('down'))).toBe(false);
    expect(readdirSync(canonicalDir).some((name) => /\.down\.sql$/.test(name))).toBe(false);
  });

  it('stays in sorted order, contiguous from 0001 with no gaps or duplicates', () => {
    // The ledger is forward-only and applied in FILENAME order, so this is
    // enforced strictly — a gap or duplicate is how a rebase silently drops
    // or collides a migration.
    const files = migrationFiles();
    expect(files).toEqual([...files].sort());
    const prefixes = files.map((name) => name.slice(0, 4));
    const expected = Array.from({ length: prefixes.length }, (_, i) =>
      String(i + 1).padStart(4, '0')
    );
    expect(prefixes).toEqual(expected);
  });
});
