import type { ClaudeCodeLoginState } from '@snaglet/shared/types';

export interface CredentialDraft {
  authTypeId: string;
  label: string;
  /** Used for simple single-field auth types. */
  secret: string;
  /** Used for multi-field auth types (keyed by MetadataField.key). */
  metadata: Record<string, string>;
  /** Toggle between individual field inputs and a raw JSON textarea. */
  pasteMode: boolean;
  jsonPaste: string;
  jsonError: string | null;
}

/**
 * `untested` is the post-save notice: the credential was stored without any
 * remote check (the server never verifies on Connect). Only a Test result or
 * the server's own status may say `ok`.
 */
type VerifyStatus = 'idle' | 'testing' | 'ok' | 'fail' | 'untested';

export interface VerifyState {
  status: VerifyStatus;
  message: string;
}

export interface RetestState {
  status: 'idle' | 'testing' | 'ok' | 'fail';
  message?: string;
}

/**
 * Desktop-side view of the Claude Code sign-in. `idle` is before any attempt;
 * every other status mirrors the server session's state. `message` is the
 * server's human-readable outcome (never token material).
 */
export interface ClaudeCodeLoginFlowState {
  status: ClaudeCodeLoginState | 'idle';
  message: string | null;
  sessionId: string | null;
}
