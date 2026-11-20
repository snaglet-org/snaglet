import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { ConfirmModal } from './ConfirmModal';

function renderConfirm(overrides: Partial<React.ComponentProps<typeof ConfirmModal>> = {}) {
  const onConfirm = vi.fn();
  const onCancel = vi.fn();
  render(
    <ConfirmModal
      title="Delete this thing?"
      confirmLabel="Delete"
      destructive
      onConfirm={onConfirm}
      onCancel={onCancel}
      {...overrides}
    >
      This cannot be undone.
    </ConfirmModal>
  );
  return { onConfirm, onCancel };
}

describe('ConfirmModal', () => {
  it('renders the title as the dialog name and the string body as a message', () => {
    renderConfirm();

    expect(screen.getByRole('dialog', { name: 'Delete this thing?' })).toBeInTheDocument();
    expect(screen.getByText('This cannot be undone.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Delete' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeEnabled();
  });

  it('sits on the confirmation layer, above the preview overlays it can open from', () => {
    renderConfirm();

    // The overlay is the dialog's parent; Modal.module.scss lifts this class
    // above the 1100 previews (doc chip, image, file, Mermaid).
    const overlay = screen.getByRole('dialog', { name: 'Delete this thing?' }).parentElement;
    expect(overlay?.className).toMatch(/confirmOverlay/);
  });

  it('renders an array of strings as separate message paragraphs', () => {
    render(
      <ConfirmModal title="Two lines?" onConfirm={vi.fn()} onCancel={vi.fn()}>
        {['First line.', 'Second line.']}
      </ConfirmModal>
    );

    expect(screen.getByText('First line.')).toBeInTheDocument();
    expect(screen.getByText('Second line.')).toBeInTheDocument();
  });

  it('fires onConfirm only when the confirm button is clicked', async () => {
    const user = userEvent.setup();
    const { onConfirm, onCancel } = renderConfirm();

    expect(onConfirm).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Delete' }));

    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(onCancel).not.toHaveBeenCalled();
  });

  it('cancel is a no-op for the action: onCancel fires, onConfirm never does', async () => {
    const user = userEvent.setup();
    const { onConfirm, onCancel } = renderConfirm();

    await user.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('Escape dismisses via onCancel without confirming', async () => {
    const user = userEvent.setup();
    const { onConfirm, onCancel } = renderConfirm();

    await user.keyboard('{Escape}');

    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('locks both buttons and blocks dismissal while an async onConfirm is in flight', async () => {
    const user = userEvent.setup();
    let resolveAction: () => void = () => {};
    const { onCancel } = renderConfirm({
      confirmingLabel: 'Deleting…',
      onConfirm: () =>
        new Promise<void>((resolve) => {
          resolveAction = resolve;
        }),
    });

    await user.click(screen.getByRole('button', { name: 'Delete' }));

    expect(screen.getByRole('button', { name: 'Deleting…' })).toHaveAttribute('aria-busy', 'true');
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled();

    // Esc must not dismiss mid-flight — the parent would unmount the dialog
    // while the action is still running.
    await user.keyboard('{Escape}');
    expect(onCancel).not.toHaveBeenCalled();

    resolveAction();
    // Success keeps the busy state on (the parent unmounts the dialog).
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Deleting…' })).toBeInTheDocument();
    });
  });

  it('shows a rejection inline and re-enables the buttons so the user can retry or cancel', async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn().mockRejectedValue(new Error('Backend said no'));
    const { onCancel } = renderConfirm({ onConfirm });

    await user.click(screen.getByRole('button', { name: 'Delete' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Backend said no');
    expect(screen.getByRole('button', { name: 'Delete' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeEnabled();
    expect(onCancel).not.toHaveBeenCalled();

    // Retry clears the stale error before re-running the action.
    onConfirm.mockResolvedValue(undefined);
    await user.click(screen.getByRole('button', { name: 'Delete' }));
    await waitFor(() => {
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    });
    expect(onConfirm).toHaveBeenCalledTimes(2);
  });

  it('uses the default Confirm/Cancel labels when none are provided', () => {
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    render(
      <ConfirmModal title="Proceed?" onConfirm={onConfirm} onCancel={onCancel}>
        Body
      </ConfirmModal>
    );

    expect(screen.getByRole('button', { name: 'Confirm' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeInTheDocument();
  });
});
