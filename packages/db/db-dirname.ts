/**
 * Provides __dirname equivalent for db.ts.
 * Isolated so Jest (CJS) can swap it via moduleNameMapper
 * without import.meta.url causing parse errors.
 */
import { basename, dirname, extname } from 'path';
import { fileURLToPath } from 'url';
import { realpathSync } from 'fs';

export const dbDirname = dirname(fileURLToPath(import.meta.url));

/**
 * Helper: is the given module URL the script that was invoked as the
 * entry point? Use realpath on both sides so symlink divergence (notably
 * macOS `/tmp` → `/private/tmp` and pnpm store paths) doesn't break the
 * comparison.
 */
export function isMainModule(metaUrl: string): boolean {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(fileURLToPath(metaUrl)) === realpathSync(process.argv[1]);
  } catch {
    return false;
  }
}

/**
 * Is this module being run as the named CLI (`tsx migrations.ts`, `tsx db.ts`)?
 *
 * Structural, not an env switch: inside the esbuild server bundle every
 * inlined module's URL is `server.mjs`, which is argv[1], so a bare
 * isMainModule() would fire the CLI on every packaged boot. Requiring the
 * entry file to be the named module means the bundle can never take the CLI
 * path, and a `SNAGLET_BUNDLED=1` in a checkout shell cannot skip the CLI (and its
 * db-script target guard).
 */
export function isCliEntry(metaUrl: string, moduleName: string): boolean {
  if (!isMainModule(metaUrl)) return false;
  const file = fileURLToPath(metaUrl);
  return basename(file, extname(file)) === moduleName;
}
