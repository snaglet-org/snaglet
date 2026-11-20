import { existsSync, readdirSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const MIGRATION_FILE = /^\d{4}_.+\.sql$/;

/** The first migration: the complete initial schema and built-in rows. */
export const BASELINE_MIGRATION = '0001_init.sql';

/**
 * Resolve the migration assets for source, package-build, and server-bundle
 * module locations. Package builds emit `packages/db` into `dist/db` without
 * copying SQL assets, so compiled modules must walk back to the canonical
 * source directory. The standalone server bundle copies migrations beside
 * `server.mjs`, which is covered by the direct sibling candidate.
 */
export function resolveMigrationsDir(moduleUrl: string = import.meta.url): string {
  const moduleDir = dirname(fileURLToPath(moduleUrl));
  const packageBuildCandidate = join(moduleDir, '..', '..', 'packages', 'db', 'migrations');
  const candidates = moduleDir.endsWith(join('dist', 'db'))
    ? [packageBuildCandidate, join(moduleDir, 'migrations')]
    : [join(moduleDir, 'migrations'), packageBuildCandidate];

  const migrationsDir = candidates.find((candidate) =>
    existsSync(join(candidate, BASELINE_MIGRATION))
  );
  if (!migrationsDir) {
    throw new Error(`Could not resolve bundled database migrations from ${moduleDir}`);
  }
  return migrationsDir;
}

export function migrationFiles(migrationsDir: string = resolveMigrationsDir()): string[] {
  return readdirSync(migrationsDir)
    .filter((name) => MIGRATION_FILE.test(name))
    .sort();
}
