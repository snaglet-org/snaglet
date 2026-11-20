import React from 'react';
import type { ProviderCredential } from '@desktop/utils/api';
import type { ClaudeCodeLoginFlowState } from '../../types';
import { Button, Stack, Cluster } from '@desktop/components';
import styles from './ClaudeCodeLoginFlow.module.scss';

/** Auth type the server assigns to an imported Claude Code login. */
export const CLAUDE_CODE_AUTH_TYPE_ID = 'anthropic:claude-code-pro';

interface ClaudeCodeLoginFlowProps {
  state: ClaudeCodeLoginFlowState;
  /** Place actions in a section header while retaining feedback in its body. */
  part?: 'actions' | 'status' | 'all';
  /** Anthropic credentials — used to spot a revoked Claude Code login. */
  providerCredentials: ProviderCredential[];
  onStart: () => void;
  onCancel: () => void;
}

const BUSY_LABELS: Partial<Record<ClaudeCodeLoginFlowState['status'], string>> = {
  checking: 'Checking Claude Code login…',
  waiting: 'Waiting for Claude authorization…',
  importing: 'Importing…',
  verifying: 'Verifying…',
};

const FAILURE_FALLBACKS: Partial<Record<ClaudeCodeLoginFlowState['status'], string>> = {
  failed: 'Claude Code sign-in failed.',
  timed_out: 'Claude Code sign-in timed out. Try again.',
  cancelled: 'Claude Code sign-in canceled.',
};

/**
 * Sign-in flow for Anthropic via the Claude Code CLI's OAuth login.
 *
 * The server owns the session: it checks the CLI keychain first (connecting
 * without a browser when a login is already there) and otherwise runs the
 * CLI's browser sign-in, which Snaglet opens in the system browser. The hook
 * polls until the session settles; this component only renders that state
 * and wires Sign in / Cancel. It never sees tokens.
 */
export const ClaudeCodeLoginFlow: React.FC<ClaudeCodeLoginFlowProps> = ({
  state,
  part = 'all',
  providerCredentials,
  onStart,
  onCancel,
}) => {
  const { status, message, sessionId } = state;
  const busyLabel = BUSY_LABELS[status];
  // The server owns the session from the first response, so Cancel is valid
  // in every non-terminal state once we know the session id.
  const canCancel = Boolean(busyLabel) && sessionId !== null;
  const failureFallback = FAILURE_FALLBACKS[status];
  // The server marks the row `fail` once it detects the login was revoked
  // (or expired); offer re-authentication instead of a fresh sign-in.
  const loginRevoked = providerCredentials.some(
    (c) => c.authTypeId === CLAUDE_CODE_AUTH_TYPE_ID && c.verificationStatus === 'fail'
  );

  const idleLabel = failureFallback
    ? 'Sign in again'
    : loginRevoked
      ? 'Re-authenticate Claude Code'
      : 'Sign in with Claude Code';

  return (
    <Stack gap={2}>
      {part !== 'status' && (
        <Cluster gap={2}>
          <Button
            variant="primary"
            size="md"
            disabled={Boolean(busyLabel)}
            title="Uses your Claude Code login (OAuth) — no API key needed"
            onClick={onStart}
          >
            {busyLabel ?? idleLabel}
          </Button>
          {canCancel && (
            <Button variant="ghost" size="md" onClick={onCancel}>
              Cancel
            </Button>
          )}
        </Cluster>
      )}

      {part !== 'actions' && status === 'waiting' && (
        <p className={styles.hint}>
          Claude sign-in opened in your browser. Approve access, then return here — Snaglet will
          detect it automatically.
        </p>
      )}
      {part !== 'actions' && status === 'connected' && (
        <p className={styles.success}>Claude Code login connected (OAuth, not an API key).</p>
      )}
      {part !== 'actions' && failureFallback && (
        <p className={styles.error}>{message || failureFallback}</p>
      )}
      {part !== 'actions' && loginRevoked && status !== 'connected' && (
        <p className={styles.warning}>Claude Code login expired or was revoked.</p>
      )}
    </Stack>
  );
};
