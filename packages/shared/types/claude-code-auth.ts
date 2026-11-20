/**
 * Claude Code login session, as reported by
 * `POST/GET /api/providers/anthropic/claude-code/login`.
 *
 * Snaglet adopts the Claude Code CLI's OAuth login for the `anthropic:claude-code-pro`
 * auth type. When the keychain holds a usable token the "session" completes
 * synchronously; otherwise the server runs `claude auth login`, which opens
 * the browser, and the desktop polls this snapshot until it settles.
 */
export type ClaudeCodeLoginState =
  | 'checking'
  | 'waiting'
  | 'importing'
  | 'verifying'
  | 'connected'
  | 'failed'
  | 'cancelled'
  | 'timed_out';

export const CLAUDE_CODE_LOGIN_TERMINAL_STATES: ReadonlySet<ClaudeCodeLoginState> = new Set([
  'connected',
  'failed',
  'cancelled',
  'timed_out',
]);

export interface ClaudeCodeLoginSnapshot {
  id: string;
  state: ClaudeCodeLoginState;
  /** Authorization URL the CLI printed, for the desktop to open when it could not itself. */
  authorizationUrl?: string;
  /** Human-readable outcome or remediation. Never contains token material. */
  message?: string;
  /** The `anthropic:claude-code-pro` credential once imported. */
  credentialId?: string;
  startedAt: string;
  updatedAt: string;
}
