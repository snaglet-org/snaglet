/**
 * Path-like configuration helpers (Node-only).
 *
 * Deliberately not exported from the utils barrel: the barrel is bundled into
 * the browser UI, and this module imports `node:os` / `node:path`. Import it
 * directly via `@snaglet/shared/utils/paths` from Node-side code only.
 *
 * Why this exists: values arriving from `.env` files are never shell-expanded —
 * dotenv delivers `SNAGLET_HOME=~/.snaglet` as the literal string `~/.snaglet`. Any layer that
 * treats such a value as a path must expand the `~` itself, or Node resolves it
 * against the process cwd and scatters Snaglet state into places like `<repo>/~/.snaglet`
 * (observed: full misdirected Snaglet homes, each with its own PostgreSQL cluster).
 */

import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';

/**
 * Expand a leading `~` or `~/` (also `~\` for Windows-style input) against the
 * current user's home directory. Everything else — absolute paths, bare
 * relative paths, and `~user/...` forms — is returned unchanged.
 */
export function expandHomePath(input: string): string {
  if (input === '~') return homedir();
  if (input.startsWith('~/') || input.startsWith('~\\')) return join(homedir(), input.slice(2));
  return input;
}

/**
 * Resolve a path-like configuration value (env var or pointer-file entry) at
 * its resolution boundary: trim it, expand a `~` prefix, and require the
 * result to be absolute.
 *
 * Bare relative values (including unexpanded `~user/...`) are rejected rather
 * than resolved. Resolving them against the process working directory is how
 * misdirected Snaglet homes were created, and no Snaglet setting documents cwd-relative
 * semantics; failing closed with a clear message matches the desktop shell,
 * which likewise refuses to open a questionable home rather than silently
 * using a different one.
 *
 * @param value  the raw configured value (callers pass non-empty values)
 * @param source what to blame in the error, e.g. `'SNAGLET_HOME'` or a pointer file
 */
export function resolveConfiguredPath(value: string, source: string): string {
  const expanded = expandHomePath(value.trim());
  if (!isAbsolute(expanded)) {
    throw new Error(
      `${source} must be an absolute path or start with "~/" (got ${JSON.stringify(value)}); ` +
        'a relative path would resolve against the process working directory and misplace Snaglet data.'
    );
  }
  return expanded;
}
