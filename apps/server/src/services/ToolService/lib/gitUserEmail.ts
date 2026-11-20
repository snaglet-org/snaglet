/**
 * The machine user's own git email, resolved at run time so agent commits keep
 * the user as author of record (GitHub links the commit to their account by
 * this address) while the commit's NAME shows the agent. Never logged, never
 * stored: read from `git config` and cached briefly.
 */

import { execFileSync } from 'child_process';

const TTL_MS = 60_000;
const GIT_TIMEOUT_MS = 2_000;

export type GitEmailReader = (scope: 'global' | 'local', cwd?: string) => string;

const EMAIL_SHAPE = /^[^\s<>@"'`\\]+@[^\s<>@"'`\\]+$/;

function readGitEmail(scope: 'global' | 'local', cwd?: string): string {
  try {
    return execFileSync(
      'git',
      ['config', ...(scope === 'global' ? ['--global'] : []), 'user.email'],
      {
        cwd,
        encoding: 'utf8',
        timeout: GIT_TIMEOUT_MS,
        stdio: ['ignore', 'pipe', 'ignore'],
      }
    );
  } catch {
    return '';
  }
}

let reader: GitEmailReader = readGitEmail;
const cache = new Map<string, { at: number; email: string | null }>();

function clean(raw: string): string | null {
  const email = raw.trim();
  return EMAIL_SHAPE.test(email) ? email : null;
}

/**
 * Global `user.email`, else the one `git config` resolves in `cwd`; null when
 * neither is set (callers fall back to an inert .invalid address). Cached per
 * working directory for a short TTL.
 */
export function resolveGitUserEmail(cwd?: string): string | null {
  const key = cwd ?? '';
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.email;
  const email = clean(reader('global', cwd)) ?? (cwd ? clean(reader('local', cwd)) : null);
  cache.set(key, { at: Date.now(), email });
  return email;
}

/** Test seam: swap the git reader (null restores it) and clear the cache. */
export function setGitEmailReaderForTests(next: GitEmailReader | null): void {
  reader = next ?? readGitEmail;
  cache.clear();
}
