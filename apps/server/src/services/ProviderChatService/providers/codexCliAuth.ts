/**
 * Codex CLI credential bridge.
 *
 * The Codex CLI (`codex` / ChatGPT desktop) stores its OAuth material in
 * `~/.codex/auth.json`:
 *
 *   {
 *     "auth_mode": "chatgpt",
 *     "tokens": { "id_token", "access_token", "refresh_token", "account_id" },
 *     "last_refresh": "<iso>"
 *   }
 *
 * Snaglet's stored Codex credential can end up WITHOUT a refresh token (e.g. it was
 * connected from a short-lived access token). When that access token expires
 * there's no way to mint a new one and the provider hard-fails — a time bomb.
 * This module reads the CLI's long-lived refresh token so Snaglet can adopt it for
 * the same ChatGPT account. Read-only against the CLI file; Snaglet never writes it.
 */

import { homedir } from 'os';
import { join } from 'path';
import { readFile } from 'fs/promises';
import { safeJsonParse } from '@snaglet/shared/utils';

export interface CodexCliAuth {
  accessToken: string;
  refreshToken: string;
  accountId: string;
  lastRefresh?: string;
}

/** Location of the Codex CLI auth file (honors `CODEX_HOME`). */
function codexCliAuthPath(): string {
  const home = process.env.CODEX_HOME?.trim();
  return home ? join(home, 'auth.json') : join(homedir(), '.codex', 'auth.json');
}

/**
 * Read `~/.codex/auth.json` and return its OAuth tokens, or null when the file
 * is absent/unreadable or carries no refresh token. Never throws.
 */
export async function readCodexCliAuth(): Promise<CodexCliAuth | null> {
  let raw: string;
  try {
    raw = await readFile(codexCliAuthPath(), 'utf8');
  } catch {
    return null;
  }

  const parsed = safeJsonParse<Record<string, unknown>>(raw, {});
  const tokens = (parsed?.tokens ?? {}) as Record<string, unknown>;
  const refreshToken = String(tokens.refresh_token ?? '');
  if (!refreshToken) return null;

  return {
    accessToken: String(tokens.access_token ?? ''),
    refreshToken,
    accountId: String(tokens.account_id ?? ''),
    lastRefresh: typeof parsed.last_refresh === 'string' ? parsed.last_refresh : undefined,
  };
}
