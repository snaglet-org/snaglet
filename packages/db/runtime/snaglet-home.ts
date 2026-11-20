import { existsSync, readFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { safeJsonParse } from '@snaglet/shared/utils';
import { resolveConfiguredPath } from '@snaglet/shared/utils/paths';

interface SnagletPointerFile {
  homePath?: unknown;
}

function pointerFilePath(): string {
  const configured = process.env.SNAGLET_HOME_POINTER_FILE?.trim();
  if (configured) return resolveConfiguredPath(configured, 'SNAGLET_HOME_POINTER_FILE');
  return join(homedir(), '.snaglet.json');
}

function readPointerHomePath(): string | null {
  const pointerPath = pointerFilePath();
  if (!existsSync(pointerPath)) return null;

  const parsed = safeJsonParse<SnagletPointerFile>(readFileSync(pointerPath, 'utf-8'), {});
  const homePath = typeof parsed.homePath === 'string' ? parsed.homePath.trim() : '';
  return homePath.length > 0 ? resolveConfiguredPath(homePath, `homePath in ${pointerPath}`) : null;
}

/**
 * Resolve the Snaglet home directory for DB-owned files.
 *
 * The server has its own snagletHome service, but packages/db cannot import server
 * code. Keep this resolver aligned with that service: env override first,
 * then the configured pointer file (`SNAGLET_HOME_POINTER_FILE` or `~/.snaglet.json`),
 * then ~/.snaglet.
 *
 * Every configured source goes through `resolveConfiguredPath`: `~`/`~/...`
 * expand against the user home (dotenv never shell-expands, so `SNAGLET_HOME=~/.snaglet`
 * arrives as a literal), absolute paths pass through, and bare relative paths
 * throw instead of silently resolving against the process cwd (which would
 * create homes like `<repo>/~/.snaglet`).
 */
export function resolveDbHome(): string {
  const envHome = process.env.SNAGLET_HOME?.trim();
  if (envHome) return resolveConfiguredPath(envHome, 'SNAGLET_HOME');
  return defaultDbHome();
}

/** The home `resolveDbHome()` falls back to when `SNAGLET_HOME` is unset. */
function defaultDbHome(): string {
  return readPointerHomePath() ?? join(homedir(), '.snaglet');
}

/**
 * Every path that counts as the production home for the db-script guard:
 * `~/.snaglet` itself, plus wherever the default pointer file (`~/.snaglet.json`)
 * points. `SNAGLET_HOME_POINTER_FILE` is deliberately ignored here, so a
 * redirected pointer cannot hide the real production home. Callers compare
 * realpaths.
 */
export function productionDbHomes(userHome: string = homedir()): string[] {
  const homes = [join(userHome, '.snaglet')];
  const readTarget = (file: string, parse: (raw: string) => string): void => {
    try {
      if (!existsSync(file)) return;
      const value = parse(readFileSync(file, 'utf-8')).trim();
      if (value) homes.push(resolveConfiguredPath(value, file));
    } catch {
      // An unreadable or malformed pointer adds nothing; ~/.snaglet still counts.
    }
  };
  readTarget(join(userHome, '.snaglet.json'), (raw) => {
    const parsed = safeJsonParse<SnagletPointerFile>(raw, {});
    return typeof parsed.homePath === 'string' ? parsed.homePath : '';
  });
  return homes;
}
