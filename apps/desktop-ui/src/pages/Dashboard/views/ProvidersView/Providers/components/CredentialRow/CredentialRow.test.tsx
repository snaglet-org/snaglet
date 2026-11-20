import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProviderCredential } from '@desktop/utils/api';
import { CredentialRow } from './CredentialRow';

const api = vi.hoisted(() => ({ exportCredential: vi.fn() }));
const featureFlagState = vi.hoisted(() => ({ fallbackCredentials: false }));

vi.mock('@desktop/utils/api', () => ({
  providersApi: { exportCredential: api.exportCredential },
}));

vi.mock('@desktop/features/featureFlags/FeatureFlagsContext', () => ({
  useFeatureFlag: (name: string) =>
    name === 'fallback_credentials' ? featureFlagState.fallbackCredentials : false,
}));

beforeEach(() => {
  featureFlagState.fallbackCredentials = false;
});

const credential = {
  id: 'credential-1',
  providerId: 'codex',
  authTypeId: 'codex:api-key',
  authType: 'api_key',
  label: 'Work key',
  hasSecret: true,
  updatedAt: '2026-07-29T12:00:00.000Z',
  verificationStatus: 'untested',
} as ProviderCredential;

function renderRow(
  patch: Partial<ProviderCredential> = {},
  retestState?: { status: 'idle' | 'testing' | 'ok' | 'fail'; message?: string }
) {
  return render(
    <CredentialRow
      credential={{ ...credential, ...patch }}
      authTypeLabel="API Key"
      isPrimary={false}
      isFallback={false}
      retestState={retestState}
      onRetest={vi.fn()}
      onDelete={vi.fn()}
    />
  );
}

describe('CredentialRow verification status', () => {
  it('shows a saved-but-untested credential as "Not tested"', () => {
    const { container } = renderRow();
    expect(screen.getByText('Not tested')).toBeInTheDocument();
    expect(container.querySelector('[data-status="untested"]')).not.toBeNull();
    expect(screen.queryByText('Verified')).not.toBeInTheDocument();
  });

  it('shows the server status for verified and failed credentials', () => {
    renderRow({ verificationStatus: 'ok' });
    expect(screen.getByText('Verified')).toBeInTheDocument();
    renderRow({ id: 'credential-2', verificationStatus: 'fail' });
    expect(screen.getByText('Test failed')).toBeInTheDocument();
  });

  it('keeps a Retest result visible alongside the stored status', () => {
    renderRow({ verificationStatus: 'untested' }, { status: 'fail', message: 'Unauthorized' });
    expect(screen.getByText('Not tested')).toBeInTheDocument();
    expect(screen.getByText('✗ Unauthorized')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Retest' })).toBeEnabled();
  });
});

describe('CredentialRow copy status timers', () => {
  const writeText = vi.fn();

  function stubClipboard() {
    api.exportCredential.mockResolvedValue({ id: 'credential-1' });
    writeText.mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
  }

  const clickCopy = async () => {
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Copy' }));
    });
  };

  afterEach(() => {
    vi.useRealTimers();
    api.exportCredential.mockReset();
    writeText.mockReset();
  });

  it('clears a pending reset timer on unmount', async () => {
    vi.useFakeTimers();
    stubClipboard();
    const { unmount } = renderRow();

    await clickCopy();
    expect(screen.getByText('Credential copied')).toBeInTheDocument();
    expect(vi.getTimerCount()).toBe(1);

    unmount();

    expect(vi.getTimerCount()).toBe(0);
  });

  it('restarts the reset timer on a repeat copy instead of letting the old one fire', async () => {
    vi.useFakeTimers();
    stubClipboard();
    renderRow();

    await clickCopy();
    await act(() => vi.advanceTimersByTimeAsync(1000));
    expect(screen.getByText('Credential copied')).toBeInTheDocument();

    await clickCopy();
    expect(vi.getTimerCount()).toBe(1);
    // 1700ms after the first copy: its 1600ms timer would have reset the
    // status, but the second copy only started 700ms ago.
    await act(() => vi.advanceTimersByTimeAsync(700));
    expect(screen.getByText('Credential copied')).toBeInTheDocument();

    await act(() => vi.advanceTimersByTimeAsync(900));
    expect(screen.queryByText('Credential copied')).not.toBeInTheDocument();
  });

  it('clears the pending timer when a failed copy follows a successful one', async () => {
    vi.useFakeTimers();
    stubClipboard();
    renderRow();

    await clickCopy();
    writeText.mockRejectedValue(new Error('denied'));
    await clickCopy();

    expect(screen.getByText('Copy failed')).toBeInTheDocument();
    expect(vi.getTimerCount()).toBe(1);
  });
});

describe('CredentialRow rotation UI (fallback_credentials flag)', () => {
  const rotationButtons = ['Make primary', 'Make fallback', 'Not in rotation'];

  function renderRotationRow(role: 'primary' | 'fallback') {
    const onChangeRotation = vi.fn();
    const onDragStart = vi.fn();
    const rendered = render(
      <CredentialRow
        credential={{ ...credential, label: 'Claude Code login' }}
        authTypeLabel="Claude Code"
        isPrimary={role === 'primary'}
        isFallback={role === 'fallback'}
        fallbackIndex={role === 'fallback' ? 0 : undefined}
        onChangeRotation={onChangeRotation}
        onRetest={vi.fn()}
        onDelete={vi.fn()}
        draggable
        onDragStart={onDragStart}
        onDragEnd={vi.fn()}
      />
    );
    const row = rendered.container.querySelector<HTMLElement>(
      '[data-credential-id="credential-1"]'
    );
    expect(row).not.toBeNull();
    return { ...rendered, row: row!, onChangeRotation, onDragStart };
  }

  it('shows a plain key with the flag off (the default)', () => {
    const { row, onDragStart } = renderRotationRow('primary');

    expect(within(row).getByText('Claude Code login')).toBeInTheDocument();
    expect(within(row).getByText(/Claude Code ·/)).toBeInTheDocument();
    expect(within(row).getByText('Not tested')).toBeInTheDocument();

    expect(within(row).queryByText('Primary')).not.toBeInTheDocument();
    expect(within(row).queryByText('Rotation')).not.toBeInTheDocument();
    expect(within(row).queryByRole('group', { name: /Rotation role/ })).not.toBeInTheDocument();
    for (const name of rotationButtons) {
      expect(within(row).queryByRole('button', { name })).not.toBeInTheDocument();
    }
    expect(within(row).queryByLabelText(/to change its role/)).not.toBeInTheDocument();
    expect(within(row).queryByText('⠿')).not.toBeInTheDocument();
    expect(row).toHaveAttribute('draggable', 'false');

    fireEvent.dragStart(row);
    expect(onDragStart).not.toHaveBeenCalled();
  });

  it('hides the fallback badge with the flag off', () => {
    const { row } = renderRotationRow('fallback');
    expect(within(row).queryByText('Fallback #1')).not.toBeInTheDocument();
    expect(within(row).getByText('Claude Code login')).toBeInTheDocument();
  });

  it('shows the badge, drag grip and Rotation buttons with the flag on', () => {
    featureFlagState.fallbackCredentials = true;
    const { row, onChangeRotation, onDragStart } = renderRotationRow('primary');

    expect(within(row).getByText('Primary')).toBeInTheDocument();
    expect(within(row).getByText('Rotation')).toBeInTheDocument();
    for (const name of rotationButtons) {
      expect(within(row).getByRole('button', { name })).toBeInTheDocument();
    }
    expect(
      within(row).getByLabelText('Drag Claude Code login to change its role')
    ).toHaveTextContent('⠿');
    expect(row).toHaveAttribute('draggable', 'true');

    fireEvent.dragStart(row);
    expect(onDragStart).toHaveBeenCalledTimes(1);
    fireEvent.click(within(row).getByRole('button', { name: 'Make fallback' }));
    expect(onChangeRotation).toHaveBeenCalledWith('fallback');
  });

  it('shows the fallback badge with the flag on', () => {
    featureFlagState.fallbackCredentials = true;
    const { row } = renderRotationRow('fallback');
    expect(within(row).getByText('Fallback #1')).toBeInTheDocument();
  });
});
