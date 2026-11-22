/**
 * Interactive Claude Code sign-in, driven from Snaglet.
 *
 * A session is registered synchronously in state `checking` and every later
 * step runs inside it: the caller-supplied `preflight` first tries to adopt
 * a usable keychain login without a browser; only when that yields nothing
 * does the session run `claude auth login` (fixed arguments, no shell). The
 * CLI opens the system browser itself; if it only prints the authorization
 * URL, the URL is surfaced on the snapshot so the desktop can open it.
 * Completion is detected two ways — the CLI exiting successfully, or the
 * keychain token changing — after which the caller-supplied `complete` step
 * imports and verifies the new login. One session at a time: a second start
 * while one is in flight (checking, waiting, importing or verifying) returns
 * the existing snapshot instead of running a second preflight or browser
 * flow. The overall timeout is armed at creation, so a keychain read or
 * verification that never returns still ends the session.
 *
 * CLI output is never surfaced or logged: the only thing read from it is the
 * authorization URL, and every user-facing message is a fixed string.
 * A terminal state ('connected', 'failed', 'cancelled', 'timed_out') is final; a
 * late process exit, keychain poll, or completion cannot change it.
 */

import { spawn, type ChildProcess } from 'child_process';
import { randomUUID } from 'crypto';
import { logger } from '@server/config/logger';
import { getErrorMessage } from '@snaglet/shared/utils';
import { buildCommandEnv } from '@server/services/ToolService/lib/buildSafeEnv';
import {
  CLAUDE_CODE_LOGIN_TERMINAL_STATES,
  type ClaudeCodeLoginSnapshot,
  type ClaudeCodeLoginState,
} from '@snaglet/shared/types';
import {
  readClaudeCliAuth,
  tokenFingerprint,
  type ClaudeCliAuth,
} from '@server/services/ProviderChatService/providers/claudeCliAuth';
import { resolveClaudeCliCommand } from '@server/services/ProviderChatService/providers/claudeCliLocation';

const DEFAULT_LOGIN_TIMEOUT_MS = 5 * 60 * 1000;
/** Import + live verification after the browser flow must finish in this long. */
const DEFAULT_COMPLETION_TIMEOUT_MS = 60_000;
const KEYCHAIN_POLL_MS = 3_000;
/** Bytes of raw output kept (in memory only) to spot a URL split across chunks. */
const URL_SCAN_WINDOW = 4_096;
const CLAUDE_CLI_LOGIN_ARGS: readonly string[] = ['auth', 'login'];

/** Hosts the CLI may hand us for browser authorization. Anything else is ignored. */
const AUTHORIZATION_HOSTS = new Set(['claude.ai', 'console.anthropic.com', 'platform.claude.com']);
const SECRET_PARAMS = ['token', 'access_token', 'refresh_token', 'id_token'];
/** The authorize URL's own `code=true` flag; any other `code` value is an issued authorization code. */
const AUTH_CODE_FLAG_VALUE = 'true';

export const LOGIN_MESSAGES = {
  canceled: 'Claude sign-in canceled.',
  shutdown: 'Snaglet stopped before sign-in finished.',
  timedOut: 'Timed out waiting for Claude authorization. Close the browser tab and try again.',
  denied: 'Claude sign-in did not complete. If you denied access or closed the browser, try again.',
  importFailed: 'Claude signed in, but Snaglet could not import the login. Try again.',
  importTimedOut: 'Claude signed in, but verifying the login took too long. Try again.',
  missingCli:
    'Claude Code CLI not found. Install it (curl -fsSL https://claude.ai/install.sh | bash, or ' +
    'npm install -g @anthropic-ai/claude-code), check that `claude --version` works in a ' +
    'terminal, then try again. If it is installed somewhere unusual, set ' +
    'SNAGLET_CLAUDE_CLI_PATH to the claude binary and restart Snaglet.',
  spawnFailed:
    'Could not start Claude sign-in. Check that the Claude Code CLI runs from a terminal.',
} as const;

/** Remove anything that looks like an Anthropic token or an OAuth code (log hygiene). */
export function scrubSecrets(text: string): string {
  return text
    .replace(/sk-ant-[A-Za-z0-9_-]+/g, 'sk-ant-…')
    .replace(/([?&#](?:code|token|access_token|refresh_token|id_token)=)[^&\s]+/gi, '$1…');
}

/**
 * The browser authorization URL from raw CLI output. Only Anthropic-owned
 * hosts qualify, URLs with embedded credentials are ignored, and a URL that
 * carries token material in its query or fragment (a callback echoed back,
 * say) is never handed to the desktop. Unless `atEnd`, a URL that runs into
 * the end of the text is treated as still arriving (the query may follow in
 * the next chunk) and skipped.
 */
export function findAuthorizationUrl(text: string, atEnd = true): string | undefined {
  const pattern = /https:\/\/[^\s"'<>)]+/g;
  for (const match of text.matchAll(pattern)) {
    const candidate = match[0];
    if (!atEnd && match.index + candidate.length === text.length) continue;
    try {
      const url = new URL(candidate);
      if (url.username || url.password) continue;
      const anthropicHost =
        AUTHORIZATION_HOSTS.has(url.hostname) || url.hostname.endsWith('.anthropic.com');
      if (anthropicHost && !carriesSecret(url)) return candidate;
    } catch {
      // not a URL after all
    }
  }
  return undefined;
}

function carriesSecret(url: URL): boolean {
  const fragment = new URLSearchParams(url.hash.replace(/^#/, ''));
  for (const params of [url.searchParams, fragment]) {
    for (const [rawKey, value] of params) {
      const key = rawKey.toLowerCase();
      if (SECRET_PARAMS.includes(key)) return true;
      if (key === 'code' && value !== AUTH_CODE_FLAG_VALUE) return true;
    }
  }
  return false;
}

interface LoginCompletion {
  credentialId?: string;
  ok: boolean;
  message: string;
}

export interface ClaudeCodeLoginDeps {
  spawnLogin: () => ChildProcess;
  readAuth: () => Promise<ClaudeCliAuth | null>;
  /**
   * Try to connect from the login already in the keychain. Resolves to the
   * outcome when a usable login verified, or null when a browser sign-in is
   * needed (no login, expired, or rejected by Anthropic).
   */
  preflight: () => Promise<LoginCompletion | null>;
  /** Import + verify after the browser flow finishes. */
  complete: () => Promise<LoginCompletion>;
  now: () => number;
  timeoutMs: number;
  completionTimeoutMs: number;
}

interface Session {
  snapshot: ClaudeCodeLoginSnapshot;
  child: ChildProcess | null;
  startFingerprint: string | null;
  timer: ReturnType<typeof setTimeout> | null;
  poll: ReturnType<typeof setInterval> | null;
  /** Raw output window for URL detection only — never exposed. */
  urlScan: string;
  completing: boolean;
}

export class ClaudeCodeLoginService {
  private session: Session | null = null;
  private readonly deps: ClaudeCodeLoginDeps;

  constructor(
    deps: Partial<ClaudeCodeLoginDeps> & Pick<ClaudeCodeLoginDeps, 'complete' | 'preflight'>
  ) {
    this.deps = {
      // The `claude` that runs may be a file in the user's home an agent can replace, so it
      // gets buildCommandEnv(): HOME, USER, PATH, locale, proxy and CA settings, never the
      // server's tokens or keys. Nothing else is needed: on macOS the CLI opens the browser
      // with `open`, and where it cannot, the session hands the URL to the desktop. A
      // CLAUDE_CONFIG_DIR set for the server stays out too: Snaglet reads the CLI's default
      // login (claudeCliAuth.ts).
      spawnLogin: () =>
        spawn(resolveClaudeCliCommand(), [...CLAUDE_CLI_LOGIN_ARGS], {
          stdio: ['ignore', 'pipe', 'pipe'],
          shell: false,
          env: buildCommandEnv(),
        }),
      readAuth: readClaudeCliAuth,
      now: Date.now,
      timeoutMs: DEFAULT_LOGIN_TIMEOUT_MS,
      completionTimeoutMs: DEFAULT_COMPLETION_TIMEOUT_MS,
      ...deps,
    };
  }

  /** The in-flight session, if any (terminal sessions stay readable by id). */
  get current(): ClaudeCodeLoginSnapshot | null {
    return this.session ? { ...this.session.snapshot } : null;
  }

  get active(): boolean {
    return !!this.session && !isTerminal(this.session);
  }

  status(id: string): ClaudeCodeLoginSnapshot | null {
    return this.session?.snapshot.id === id ? { ...this.session.snapshot } : null;
  }

  /**
   * Start a sign-in, or return the one already in flight. Registers the
   * session and arms its timeout before anything asynchronous happens, so a
   * cancel — or a second start — issued a moment later is seen by every step.
   */
  start(): ClaudeCodeLoginSnapshot {
    if (this.session && this.active) return { ...this.session.snapshot };

    const startedAt = new Date(this.deps.now()).toISOString();
    const session: Session = {
      snapshot: { id: randomUUID(), state: 'checking', startedAt, updatedAt: startedAt },
      child: null,
      startFingerprint: null,
      timer: null,
      poll: null,
      urlScan: '',
      completing: false,
    };
    this.session = session;
    session.timer = setTimeout(() => {
      if (isTerminal(session)) return;
      this.settle(session, 'timed_out', LOGIN_MESSAGES.timedOut);
    }, this.deps.timeoutMs);

    void this.run(session);
    return { ...session.snapshot };
  }

  private async run(session: Session): Promise<void> {
    // Preflight: adopt the keychain login without a browser when it verifies.
    try {
      session.completing = true;
      const adopted = await this.deps.preflight();
      session.completing = false;
      if (isTerminal(session)) return;
      if (adopted?.ok) {
        this.settle(session, 'connected', adopted.message, adopted.credentialId);
        return;
      }
    } catch (err) {
      session.completing = false;
      logger.warn(`[claude-code-auth] preflight failed: ${scrubSecrets(getErrorMessage(err))}`);
      if (isTerminal(session)) return;
    }

    // Remember which token we started with so a rotation counts as success.
    const before = await this.deps.readAuth().catch(() => null);
    if (isTerminal(session)) return;
    session.startFingerprint = before ? tokenFingerprint(before.accessToken) : null;

    let child: ChildProcess;
    try {
      child = this.deps.spawnLogin();
    } catch (err) {
      this.settle(session, 'failed', missingCliMessage(err));
      return;
    }
    session.child = child;
    this.update(session, { state: 'waiting' });

    const scanForUrl = (atEnd: boolean) => {
      if (session.snapshot.authorizationUrl || isTerminal(session)) return;
      const url = findAuthorizationUrl(session.urlScan, atEnd);
      if (url) this.update(session, { authorizationUrl: url });
    };
    const onOutput = (chunk: Buffer | string) => {
      session.urlScan = (session.urlScan + String(chunk)).slice(-URL_SCAN_WINDOW);
      scanForUrl(false);
    };
    child.stdout?.on('data', onOutput);
    child.stderr?.on('data', onOutput);
    child.on('error', (err) => {
      this.settle(session, 'failed', missingCliMessage(err));
    });
    child.on('exit', (code) => {
      // Whatever was buffered is complete now: a URL the CLI printed without
      // a trailing newline still reaches the desktop.
      scanForUrl(true);
      if (session.completing || isTerminal(session)) return;
      if (code === 0) {
        void this.finish(session);
        return;
      }
      this.settle(session, 'failed', LOGIN_MESSAGES.denied);
    });

    // The CLI may keep running after the browser hands back the code (for
    // example while it prints further prompts). A changed keychain token is
    // the ground truth that sign-in succeeded.
    session.poll = setInterval(() => {
      void this.checkKeychain(session);
    }, KEYCHAIN_POLL_MS);
  }

  /**
   * Cancel a session. While waiting for the browser the CLI is killed. Once
   * the browser step is over and the import has begun (`importing` /
   * `verifying`), the session is still marked canceled for the caller, but
   * the import itself — a keychain read plus a credential upsert — is allowed
   * to finish: the keychain is the source of truth either way, and the row
   * is only its mirror. Its result is dropped, never applied to the session.
   */
  cancel(id: string): ClaudeCodeLoginSnapshot | null {
    const session = this.session;
    if (!session || session.snapshot.id !== id) return null;
    if (!isTerminal(session)) {
      this.kill(session);
      this.settle(session, 'cancelled', LOGIN_MESSAGES.canceled);
    }
    return { ...session.snapshot };
  }

  /** Server shutdown: never leave a login process behind. */
  shutdown(): void {
    const session = this.session;
    if (session && !isTerminal(session)) {
      this.kill(session);
      this.settle(session, 'cancelled', LOGIN_MESSAGES.shutdown);
    }
  }

  private async checkKeychain(session: Session): Promise<void> {
    if (session.completing || isTerminal(session)) return;
    const auth = await this.deps.readAuth().catch(() => null);
    // The poll may have been canceled or superseded while `security` ran.
    if (!auth || session.completing || isTerminal(session)) return;
    if (tokenFingerprint(auth.accessToken) !== session.startFingerprint) {
      this.kill(session);
      await this.finish(session);
    }
  }

  private async finish(session: Session): Promise<void> {
    if (session.completing || isTerminal(session)) return;
    session.completing = true;
    if (session.poll) clearInterval(session.poll);
    session.poll = null;
    this.update(session, { state: 'importing' });
    let timer: ReturnType<typeof setTimeout> | null = null;
    try {
      this.update(session, { state: 'verifying' });
      // Bounded on top of the session timeout: the browser step is done, so
      // a slow keychain read or verification must not keep "verifying" up
      // for the rest of the session window.
      const result = await Promise.race([
        this.deps.complete(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new CompletionTimeoutError()),
            this.deps.completionTimeoutMs
          );
        }),
      ]);
      this.settle(session, result.ok ? 'connected' : 'failed', result.message, result.credentialId);
    } catch (err) {
      const message =
        err instanceof CompletionTimeoutError
          ? LOGIN_MESSAGES.importTimedOut
          : LOGIN_MESSAGES.importFailed;
      logger.warn(
        `[claude-code-auth] login completion failed: ${scrubSecrets(getErrorMessage(err))}`
      );
      this.settle(session, 'failed', message);
    } finally {
      if (timer) clearTimeout(timer);
      session.completing = false;
    }
  }

  /**
   * Terminal states are final: canceled stays canceled even if the CLI later
   * exits 0. Every terminal transition also stops the CLI (no-op once it has
   * exited) so no path can leave a login process behind.
   */
  private settle(
    session: Session,
    state: ClaudeCodeLoginState,
    message: string,
    credentialId?: string
  ): void {
    if (isTerminal(session)) return;
    this.clearTimers(session);
    this.kill(session);
    this.update(session, { state, message, ...(credentialId ? { credentialId } : {}) });
    logger.info(`[claude-code-auth] login session ${session.snapshot.id}: ${state}`);
  }

  private update(session: Session, patch: Partial<ClaudeCodeLoginSnapshot>): void {
    session.snapshot = {
      ...session.snapshot,
      ...patch,
      updatedAt: new Date(this.deps.now()).toISOString(),
    };
  }

  private clearTimers(session: Session): void {
    if (session.timer) clearTimeout(session.timer);
    if (session.poll) clearInterval(session.poll);
    session.timer = null;
    session.poll = null;
  }

  private kill(session: Session): void {
    const child = session.child;
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    try {
      child.kill('SIGTERM');
    } catch (err) {
      logger.warn(`[claude-code-auth] could not stop login process: ${getErrorMessage(err)}`);
    }
  }
}

class CompletionTimeoutError extends Error {}

function isTerminal(session: Session): boolean {
  return CLAUDE_CODE_LOGIN_TERMINAL_STATES.has(session.snapshot.state);
}

function missingCliMessage(err: unknown): string {
  const code = (err as NodeJS.ErrnoException | undefined)?.code;
  return code === 'ENOENT' ? LOGIN_MESSAGES.missingCli : LOGIN_MESSAGES.spawnFailed;
}
