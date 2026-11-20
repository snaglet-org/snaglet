/**
 * The user's login-shell PATH, for agent shell commands and for the
 * pnpm/npx/node processes Snaglet starts itself (tool installs, MCP servers).
 *
 * A macOS app launched from the Dock, Finder or `open` inherits launchd's
 * minimal PATH (/usr/bin:/bin:/usr/sbin:/sbin), so agents' shells could not
 * find node, pnpm, nvm or Homebrew tools that work in the user's terminal.
 * This asks the user's own login shell for its PATH once (in the background,
 * bounded by a timeout) and merges it ahead of the inherited entries. Shell
 * commands are user-authorized, and running the login shell's startup files is
 * exactly what a terminal does. On failure or timeout the inherited PATH stays.
 *
 * Those startup files (~/.zshenv, ~/.zprofile, ~/.zshrc) are files an agent
 * can write, so the login shell gets loginShellEnv(), never the server's own
 * environment.
 */

import { execFile } from 'node:child_process';
import { delimiter, isAbsolute } from 'node:path';
import { getErrorMessage } from '@snaglet/shared/utils';
import { logger } from '@server/config/logger';

const MARK = '__SNAGLET_LOGIN_PATH__';
const TIMEOUT_MS = 5000;
/** How long past the timeout to wait for the killed shell's callback. */
const SETTLE_GRACE_MS = 1000;

let resolved: string | null = null;
let pending: Promise<void> | null = null;

/**
 * What a login shell needs to find and run the user's startup files: who and where the
 * user is, the inherited PATH it builds on, locale and terminal type. ZDOTDIR and
 * XDG_CONFIG_HOME point zsh and fish at their startup files. Kept here rather than in
 * buildSafeEnv.ts, which imports this module.
 */
const LOGIN_SHELL_ENV_KEYS = [
  'HOME',
  'USER',
  'LOGNAME',
  'SHELL',
  'PATH',
  'TMPDIR',
  'LANG',
  'TERM',
  'ZDOTDIR',
  'XDG_CONFIG_HOME',
];

/** The login shell's environment: LOGIN_SHELL_ENV_KEYS and the LC_* locale settings. */
function loginShellEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && (LOGIN_SHELL_ENV_KEYS.includes(key) || key.startsWith('LC_'))) {
      env[key] = value;
    }
  }
  return env;
}

/**
 * Login-shell PATH entries first, then any inherited entries it lacks.
 * Relative entries (`.`, `node_modules/.bin`) are dropped: they resolve
 * against the child's cwd, so a tool folder could shadow pnpm or node.
 */
export function mergePaths(loginPath: string, inherited: string | undefined): string {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const entry of [...loginPath.split(delimiter), ...(inherited ?? '').split(delimiter)]) {
    if (entry && isAbsolute(entry) && !seen.has(entry)) {
      seen.add(entry);
      out.push(entry);
    }
  }
  return out.join(delimiter);
}

/** Pull the PATH printed between markers out of noisy shell startup output. */
export function extractMarkedPath(stdout: string): string | null {
  const start = stdout.indexOf(MARK);
  const end = start >= 0 ? stdout.indexOf(MARK, start + MARK.length) : -1;
  if (start < 0 || end < 0) return null;
  const value = stdout.slice(start + MARK.length, end).trim();
  return value.length > 0 ? value : null;
}

/**
 * Start resolving once; later calls reuse it. Never throws, and settles within
 * `timeoutMs` + SETTLE_GRACE_MS even if the shell hangs. `timeoutMs` applies
 * to the first call only.
 */
export function resolveLoginShellPath(timeoutMs = TIMEOUT_MS): Promise<void> {
  if (process.platform === 'win32') return Promise.resolve();
  pending ??= new Promise<void>((done) => {
    const shell = process.env.SHELL || '/bin/zsh';
    // An interactive zsh ignores SIGTERM, so the timeout's default kill left a
    // shell stuck in its rc files running and the callback never came. The
    // timeout sends SIGKILL instead; the fallback settles the lookup even if
    // the shell still does not exit (e.g. blocked on a network home folder).
    const fallback = setTimeout(() => {
      logger.warn('[shell-env] login shell did not answer in time; using the inherited PATH');
      done();
    }, timeoutMs + SETTLE_GRACE_MS);
    fallback.unref();
    execFile(
      shell,
      ['-ilc', `printf '${MARK}%s${MARK}' "$PATH"`],
      {
        timeout: timeoutMs,
        killSignal: 'SIGKILL',
        env: loginShellEnv(),
        maxBuffer: 1024 * 1024,
      },
      (err, stdout) => {
        clearTimeout(fallback);
        const loginPath = extractMarkedPath(String(stdout ?? ''));
        if (loginPath) {
          resolved = mergePaths(loginPath, process.env.PATH);
        } else if (err) {
          logger.warn('[shell-env] login shell PATH unavailable; using the inherited PATH', {
            error: getErrorMessage(err),
          });
        }
        done();
      }
    );
  });
  return pending;
}

/** The PATH agent shells should get: the merged login PATH once known, else the inherited one. */
export function shellPath(): string | undefined {
  return resolved ?? process.env.PATH;
}
