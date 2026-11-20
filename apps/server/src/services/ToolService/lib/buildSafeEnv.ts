/**
 * Env-allowlist helpers for spawned child processes.
 *
 * Three flavors:
 *   - buildToolEnv    — for untrusted tool processes (workspace tools, external tools)
 *                       Minimal set: only what Node needs to run + SNAGLET_* vars.
 *   - buildShellEnv   — for user-authorized shell commands (shell-exec, exec-command)
 *                       Broader set: includes standard shell/user vars so CLI tools work,
 *                       but still never exposes server secrets.
 *   - buildCommandEnv — for programs the server runs itself for a tool call or a
 *                       feature (git, sqlite3, rg, pnpm, claude, npx, cupsfilter)
 *                       The shell set plus proxy, CA, ssh and git-config settings.
 *
 * buildShellEnv can also stamp a per-run git identity for an agent run, so
 * commits made from an agent shell are authored by the agent (see
 * buildAgentGitIdentityEnv).
 *
 * None of them ever passes DB credentials, API keys, AES keys, or OAuth secrets.
 */

import { shellPath } from './loginShellPath';

const TOOL_ENV_KEYS = [
  'PATH',
  'HOME',
  'USERPROFILE', // Windows home-directory convention
  'TMPDIR',
  'TEMP', // Windows compat
  'TMP', // Windows compat
  'SYSTEMROOT', // required by some Windows process launches
  'NODE_ENV',
  'NODE_PATH',
];

// NODE_ENV is the server's own mode (Snaglet.app's sidecar runs with
// NODE_ENV=production). Inheriting it made every agent shell load production
// builds: e.g. vitest under React's production build fails with
// `React.act is not a function`. Shells get no NODE_ENV, like a fresh terminal;
// package scripts set their own and callers can still pass it via `extra`.
// Tool/hook children (buildToolEnv) keep it unchanged.
const SHELL_ENV_KEYS = [
  ...TOOL_ENV_KEYS.filter((key) => key !== 'NODE_ENV'),
  'SHELL',
  'ComSpec',
  'USER',
  'LOGNAME',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'TERM',
  'COLORTERM',
  'EDITOR',
  'VISUAL',
  'PAGER',
  'XDG_CONFIG_HOME',
  'XDG_DATA_HOME',
  'XDG_CACHE_HOME',
  'XDG_RUNTIME_DIR',
  'SSH_AUTH_SOCK', // allows git operations over SSH
];

/**
 * Extra keys `buildToolEnv()` may pass through to an untrusted tool child, on
 * top of TOOL_ENV_KEYS. Allow-listed by name: unlike `buildShellEnv`'s
 * `extra` (merged verbatim, for the broader user-authorized-shell trust
 * level), `buildToolEnv`'s `extra` is filtered against this exact set, so a
 * careless call site can never hand an untrusted tool/hook child a secret.
 *
 * Invariant: `SNAGLET_PANEL_TOKEN` (full panel/act_as/execute-test authority, see
 * middleware/panelAuth.ts) is deliberately absent and must never be added:
 * tools and hooks run agent/user-authored code that must never reach it, and
 * this list makes that structural. Those callers inject the narrower
 * `SNAGLET_CHILD_DISPATCH_TOKEN` instead, which can only run a normal tool as the
 * invoking agent.
 */
const TOOL_ENV_EXTRA_ALLOWLIST: ReadonlySet<string> = new Set([
  'SNAGLET_SERVER_URL',
  'SNAGLET_TOOL_NAME',
  'SNAGLET_HOOK_NAME',
  'SNAGLET_TOOL_CONTEXT_JSON',
  'SNAGLET_CHILD_DISPATCH_TOKEN',
  // The run's chain depth, for the child's information only. The
  // authoritative copy is signed inside SNAGLET_CHILD_DISPATCH_TOKEN.
  'SNAGLET_CHAIN_DEPTH',
]);

function pickEnv(
  keys: string[],
  extra: Record<string, string | undefined> = {}
): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {};
  for (const key of keys) {
    const sourceKey =
      process.platform === 'win32'
        ? Object.keys(process.env).find(
            (candidate) => candidate.toLowerCase() === key.toLowerCase()
          )
        : key;
    if (sourceKey && process.env[sourceKey] !== undefined) result[key] = process.env[sourceKey];
  }
  return { ...result, ...extra };
}

/**
 * Minimal safe env for untrusted tool child processes.
 * Only PATH/HOME/TMPDIR/NODE_ENV/NODE_PATH plus any explicitly passed extras
 * that appear in TOOL_ENV_EXTRA_ALLOWLIST above — anything else in `extra`
 * (including, critically, SNAGLET_PANEL_TOKEN) is silently dropped, never merged.
 */
export function buildToolEnv(extra: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  const allowedExtra: Record<string, string | undefined> = {};
  for (const key of Object.keys(extra)) {
    if (TOOL_ENV_EXTRA_ALLOWLIST.has(key)) allowedExtra[key] = extra[key];
  }
  return pickEnv(TOOL_ENV_KEYS, allowedExtra);
}

/** The running agent, as known from the tool call's context. */
export interface ShellEnvAgent {
  id?: string | null;
  name?: string | null;
  /**
   * The user's own git email (see gitUserEmail.ts). When absent the commit
   * gets an inert `<id>@agents.snaglet.invalid` address so it still succeeds.
   */
  email?: string | null;
}

const AGENT_NAME_SUFFIX = ' (Snaglet agent)';
const AGENT_NAME_MAX = 80;
const AGENT_EMAIL_DOMAIN = 'agents.snaglet.invalid';
const AGENT_EMAIL_LOCAL_MAX = 64;

function sanitizeAgentName(name: string): string {
  const cleaned = name
    .normalize('NFC')
    // control + format characters (newlines, NUL, bidi marks), then quote and
    // address-delimiter characters git would strip or mis-parse.
    .replace(/[\p{Cc}\p{Cf}\u2028\u2029]/gu, ' ')
    .replace(/["'`<>\\]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return cleaned.slice(0, AGENT_NAME_MAX - AGENT_NAME_SUFFIX.length).trim();
}

/** Reduce an id to [a-z0-9._-] so it is always a valid, inert mail local part. */
function sanitizeAgentEmailLocal(id: string): string {
  return id
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
    .slice(0, AGENT_EMAIL_LOCAL_MAX)
    .replace(/[-.]+$/g, '');
}

/**
 * Per-run git identity for an agent shell: commits made from it show the agent
 * as author and committer name, e.g. `Patty (Snaglet agent)`, with the user's own
 * email so they stay the author of record on GitHub. Without a configured
 * email the address is `<id>@agents.snaglet.invalid` (.invalid is reserved, so it
 * can never be a real mailbox). Returns
 * {} when the agent is unknown or nothing usable survives sanitizing, so the
 * machine's own git identity applies. Pure: built per call from that call's
 * agent, so concurrent agents never share or mix identities.
 */
export function buildAgentGitIdentityEnv(agent?: ShellEnvAgent | null): Record<string, string> {
  const local = sanitizeAgentEmailLocal(String(agent?.id ?? ''));
  if (!local) return {};
  const base = sanitizeAgentName(String(agent?.name ?? '')) || local;
  const name = `${base}${AGENT_NAME_SUFFIX}`;
  const email = agent?.email || `${local}@${AGENT_EMAIL_DOMAIN}`;
  return {
    GIT_AUTHOR_NAME: name,
    GIT_AUTHOR_EMAIL: email,
    GIT_COMMITTER_NAME: name,
    GIT_COMMITTER_EMAIL: email,
  };
}

/**
 * Broader safe env for user-authorized shell commands.
 * Includes shell/user/locale vars so CLI tools (git, curl, etc.) work correctly.
 * Still never exposes server secrets. Pass `agent` for an agent run to add the
 * per-run git identity; explicit `extra` entries win over it.
 */
export function buildShellEnv(
  extra: Record<string, string | undefined> = {},
  agent?: ShellEnvAgent | null
): NodeJS.ProcessEnv {
  // PATH comes from the user's login shell once resolved (see loginShellPath):
  // an app launched from the Dock inherits only /usr/bin:/bin:/usr/sbin:/sbin.
  const path = shellPath();
  return pickEnv(SHELL_ENV_KEYS, {
    ...(path ? { PATH: path } : {}),
    ...buildAgentGitIdentityEnv(agent),
    ...extra,
  });
}

/**
 * Settings that network and TLS clients honor (proxies, extra CA bundles), the ssh and
 * askpass overrides a user set for git on their machine, and where Playwright keeps its
 * browsers. They configure how git or npx reach a remote with the user's own credentials
 * (ssh agent, macOS keychain, ~/.npmrc); they are not credentials themselves. Tokens such
 * as GH_TOKEN and GITHUB_TOKEN, and npm_config_* (which can carry registry auth), stay out.
 *
 * A proxy URL can embed the user's proxy login (http://user:pass@host), and code these
 * programs run (git hooks, install scripts) can read it. The URLs pass through whole
 * anyway: stripping the login breaks authenticated proxies for git, npx and pnpm, and it
 * is the user's own network setting, not a Snaglet secret.
 */
const COMMAND_PASSTHROUGH_KEYS = [
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'ALL_PROXY',
  'NO_PROXY',
  'http_proxy',
  'https_proxy',
  'all_proxy',
  'no_proxy',
  'SSL_CERT_FILE',
  'SSL_CERT_DIR',
  'CURL_CA_BUNDLE',
  'GIT_SSL_CAINFO',
  'GIT_SSL_CAPATH',
  'GIT_SSH',
  'GIT_SSH_COMMAND',
  'GIT_ASKPASS',
  'SSH_ASKPASS',
  'GIT_CONFIG_GLOBAL',
  'GIT_CONFIG_SYSTEM',
  'GIT_CONFIG_NOSYSTEM',
  'NODE_EXTRA_CA_CERTS',
  'PLAYWRIGHT_BROWSERS_PATH',
];

/**
 * Env for a program the server runs itself (git, sqlite3, rg, pnpm, claude, npx,
 * cupsfilter): the shell's allow-list plus COMMAND_PASSTHROUGH_KEYS. Each can run code an
 * agent can write: git hooks and fsmonitor in an agent-picked directory, startup and config
 * files in the home folder, install scripts, the first `npx` binary on PATH. So the
 * server's own environment (session and panel tokens, provider keys, database credentials)
 * must never be inherited; tests/unit/apps/server/childProcessEnv.guard.test.ts checks
 * every spawn site.
 */
export function buildCommandEnv(): NodeJS.ProcessEnv {
  return buildShellEnv(pickEnv(COMMAND_PASSTHROUGH_KEYS));
}
