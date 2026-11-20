/**
 * Claude Code CLI credential bridge.
 *
 * The Claude Code CLI stores its OAuth material in the macOS keychain under
 * the generic-password service "Claude Code-credentials" for the current OS
 * user. The payload is JSON:
 *
 *   { "claudeAiOauth": { "accessToken": "sk-ant-oat01-…", "refreshToken": "…",
 *                        "expiresAt": 1700000000000, "scopes": [...], … } }
 *
 * This module reads that entry so Snaglet can adopt it for the
 * `anthropic:claude-code-pro` auth type — no manual `claude auth token` +
 * paste round-trip. The CLI refreshes and rotates the token on its own, so
 * Snaglet treats the keychain as the source of truth: callers re-read it (via
 * `resolveClaudeCliAccessToken`) rather than trusting a stored snapshot.
 * Read-only against the keychain; Snaglet never writes it. The refresh token is
 * deliberately not surfaced: only the CLI rotates it.
 */

import { execFile } from 'child_process';
import { createHash } from 'crypto';
import { promisify } from 'util';
import { userInfo } from 'os';
import { safeJsonParse } from '@snaglet/shared/utils';

const execFileAsync = promisify(execFile);

const KEYCHAIN_SERVICE = 'Claude Code-credentials';

/** Treat a token as expired this long before the CLI's own expiry stamp. */
const EXPIRY_SKEW_MS = 60_000;
/** Keychain reads shell out to `security`; reuse a fresh read this long. */
const CACHE_TTL_MS = 30_000;

export interface ClaudeCliAuth {
  accessToken: string;
  /** Epoch ms when the CLI expects the access token to expire, when recorded. */
  expiresAt?: number;
  scopes?: string[];
  subscriptionType?: string;
  /** Whether the CLI holds a refresh token (it can rotate on its own). */
  hasRefreshToken: boolean;
}

export function parseClaudeCliAuth(raw: string): ClaudeCliAuth | null {
  const parsed = safeJsonParse<Record<string, unknown>>(raw, {});
  const oauth = (parsed?.claudeAiOauth ?? {}) as Record<string, unknown>;
  const accessToken = String(oauth.accessToken ?? '');
  if (!accessToken) return null;
  const expiresAt = Number(oauth.expiresAt);
  const scopes = Array.isArray(oauth.scopes)
    ? oauth.scopes.filter((s): s is string => typeof s === 'string')
    : undefined;
  return {
    accessToken,
    expiresAt: Number.isFinite(expiresAt) && expiresAt > 0 ? expiresAt : undefined,
    scopes,
    subscriptionType:
      typeof oauth.subscriptionType === 'string' ? oauth.subscriptionType : undefined,
    hasRefreshToken: typeof oauth.refreshToken === 'string' && oauth.refreshToken.length > 0,
  };
}

/** True when the CLI's own expiry stamp says the token is still good (or unknown). */
export function isClaudeCliAuthCurrent(auth: ClaudeCliAuth, now = Date.now()): boolean {
  return auth.expiresAt === undefined || auth.expiresAt - EXPIRY_SKEW_MS > now;
}

/** Stable, non-reversible id for a token — safe for logs and change detection. */
export function tokenFingerprint(token: string): string {
  return createHash('sha256').update(token).digest('hex').slice(0, 12);
}

/**
 * Read the Claude Code CLI OAuth entry from the macOS keychain.
 * Returns null when the entry is missing, unreadable, or malformed
 * (e.g. not on macOS, or the user never logged into the Claude Code CLI).
 */
export async function readClaudeCliAuth(): Promise<ClaudeCliAuth | null> {
  let raw: string;
  try {
    const { stdout } = await execFileAsync(
      'security',
      ['find-generic-password', '-s', KEYCHAIN_SERVICE, '-a', userInfo().username, '-w'],
      { timeout: 5_000 }
    );
    raw = stdout.trim();
  } catch {
    return null;
  }
  if (!raw) return null;
  return parseClaudeCliAuth(raw);
}

let cached: { auth: ClaudeCliAuth | null; readAt: number } | null = null;

/**
 * Keychain read with a short cache: every Anthropic request consults it, and
 * the token only changes when the CLI refreshes (minutes apart at most).
 * `fresh` forces a re-read — used after a 401 and after an interactive login.
 */
export async function readClaudeCliAuthCached(fresh = false): Promise<ClaudeCliAuth | null> {
  if (!fresh && cached && Date.now() - cached.readAt < CACHE_TTL_MS) return cached.auth;
  const auth = await readClaudeCliAuth();
  cached = { auth, readAt: Date.now() };
  return auth;
}

/** Drop the cached read (tests, and after a login completes). */
export function forgetClaudeCliAuthCache(): void {
  cached = null;
}
