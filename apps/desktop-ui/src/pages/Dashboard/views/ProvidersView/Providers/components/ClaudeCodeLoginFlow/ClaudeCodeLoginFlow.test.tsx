import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import type { ProviderCredential } from '@desktop/utils/api';
import type { ClaudeCodeLoginFlowState } from '../../types';
import { ClaudeCodeLoginFlow, CLAUDE_CODE_AUTH_TYPE_ID } from './ClaudeCodeLoginFlow';

const claudeCodeCredential = (
  verificationStatus: ProviderCredential['verificationStatus']
): ProviderCredential => ({
  id: 'credential-claude-code',
  providerId: 'anthropic',
  authTypeId: CLAUDE_CODE_AUTH_TYPE_ID,
  authType: 'oauth',
  label: 'Claude Code login',
  hasSecret: true,
  updatedAt: '2026-07-29T12:00:00.000Z',
  verificationStatus,
});

function renderFlow(
  state: Partial<ClaudeCodeLoginFlowState> = {},
  credentials: ProviderCredential[] = []
) {
  const onStart = vi.fn();
  const onCancel = vi.fn();
  render(
    <ClaudeCodeLoginFlow
      state={{ status: 'idle', message: null, sessionId: null, ...state }}
      providerCredentials={credentials}
      onStart={onStart}
      onCancel={onCancel}
    />
  );
  return { onStart, onCancel };
}

describe('ClaudeCodeLoginFlow', () => {
  it('offers sign-in when idle and starts on click', () => {
    const { onStart } = renderFlow();

    const button = screen.getByRole('button', { name: 'Sign in with Claude Code' });
    expect(button).toBeEnabled();
    expect(button).toHaveAttribute(
      'title',
      'Uses your Claude Code login (OAuth) — no API key needed'
    );
    expect(screen.queryByRole('button', { name: 'Cancel' })).not.toBeInTheDocument();

    fireEvent.click(button);
    expect(onStart).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['checking', 'Checking Claude Code login…'],
    ['importing', 'Importing…'],
    ['verifying', 'Verifying…'],
  ] as const)('disables the button and offers Cancel while %s', (status, label) => {
    const { onCancel } = renderFlow({ status, sessionId: 'login-session-1' });

    expect(screen.getByRole('button', { name: label })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('withholds Cancel until the server has assigned a session', () => {
    renderFlow({ status: 'checking', sessionId: null });

    expect(screen.getByRole('button', { name: 'Checking Claude Code login…' })).toBeDisabled();
    expect(screen.queryByRole('button', { name: 'Cancel' })).not.toBeInTheDocument();
  });

  it('shows the browser hint and a Cancel button while waiting', () => {
    const { onCancel } = renderFlow({ status: 'waiting', sessionId: 'login-session-1' });

    expect(
      screen.getByRole('button', { name: 'Waiting for Claude authorization…' })
    ).toBeDisabled();
    expect(
      screen.getByText(
        'Claude sign-in opened in your browser. Approve access, then return here — Snaglet will detect it automatically.'
      )
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('reports success without mentioning an API key', () => {
    renderFlow({ status: 'connected', sessionId: 'login-session-1' }, [claudeCodeCredential('ok')]);

    expect(
      screen.getByText('Claude Code login connected (OAuth, not an API key).')
    ).toBeInTheDocument();
    expect(screen.queryByText('Claude Code login expired or was revoked.')).not.toBeInTheDocument();
  });

  it.each([
    ['failed', 'Claude authorization was denied.'],
    ['timed_out', 'Timed out waiting for Claude authorization.'],
    ['cancelled', 'Sign-in canceled.'],
  ] as const)('shows the server message on %s and offers a retry', (status, message) => {
    const { onStart } = renderFlow({ status, message, sessionId: 'login-session-1' });

    expect(screen.getByText(message)).toBeInTheDocument();
    const retry = screen.getByRole('button', { name: 'Sign in again' });
    expect(retry).toBeEnabled();
    fireEvent.click(retry);
    expect(onStart).toHaveBeenCalledTimes(1);
  });

  it('falls back to generic copy when a terminal state has no message', () => {
    renderFlow({ status: 'timed_out', sessionId: 'login-session-1' });

    expect(screen.getByText('Claude Code sign-in timed out. Try again.')).toBeInTheDocument();
  });

  it('offers re-authentication when the stored Claude Code login failed verification', () => {
    renderFlow({}, [claudeCodeCredential('fail')]);

    expect(screen.getByText('Claude Code login expired or was revoked.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Re-authenticate Claude Code' })).toBeEnabled();
  });

  it('does not treat a failed API-key credential as a revoked login', () => {
    renderFlow({}, [
      {
        ...claudeCodeCredential('fail'),
        id: 'credential-api-key',
        authTypeId: 'anthropic:api-key',
      },
    ]);

    expect(screen.getByRole('button', { name: 'Sign in with Claude Code' })).toBeInTheDocument();
    expect(screen.queryByText('Claude Code login expired or was revoked.')).not.toBeInTheDocument();
  });
});
