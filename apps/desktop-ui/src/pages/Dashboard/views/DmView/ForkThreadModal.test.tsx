/**
 * ForkThreadModal — while a fork request is in flight, Escape and a backdrop
 * click must NOT dismiss the dialog (that would hide a failure). Once the
 * request settles, closing works again; an error is shown in place.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ThreadSummary } from '@desktop/utils/api';
import { ForkThreadModal } from './ForkThreadModal';

const forkMock = vi.fn();

vi.mock('@desktop/utils/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@desktop/utils/api')>();
  return {
    ...actual,
    threadsApi: { ...actual.threadsApi, fork: (...a: unknown[]) => forkMock(...a) },
  };
});

vi.mock('@desktop/features/database', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@desktop/features/database')>()),
  useProjectList: () => ({ projects: [], error: null, loading: false, reload: vi.fn() }),
}));

afterEach(() => {
  cleanup();
  forkMock.mockReset();
});

function renderModal() {
  const onClose = vi.fn();
  const onForked = vi.fn();
  render(
    <ForkThreadModal
      threadId="thread-1"
      defaultTitle="Agent · Home thread · Nov 6"
      onClose={onClose}
      onForked={onForked}
    />
  );
  return { onClose, onForked };
}

describe('ForkThreadModal — closing is blocked while the request is pending', () => {
  it('ignores Escape while forking, then surfaces the error without closing', async () => {
    const user = userEvent.setup();
    let reject: (e: Error) => void = () => {};
    forkMock.mockReturnValue(new Promise((_res, rej) => (reject = rej)));

    const { onClose, onForked } = renderModal();
    fireEvent.click(screen.getByRole('button', { name: 'Fork' }));
    await waitFor(() => expect(forkMock).toHaveBeenCalledTimes(1));

    // Escape during the in-flight request is swallowed.
    await user.keyboard('{Escape}');
    expect(onClose).not.toHaveBeenCalled();

    // The request fails: the error shows in place, the modal is still open.
    reject(new Error('Server said no'));
    expect(await screen.findByRole('alert')).toHaveTextContent('Server said no');
    expect(onClose).not.toHaveBeenCalled();
    expect(onForked).not.toHaveBeenCalled();

    // Now idle again, Escape closes.
    await user.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('ignores a backdrop click while forking', async () => {
    let reject: (e: Error) => void = () => {};
    forkMock.mockReturnValue(new Promise((_res, rej) => (reject = rej)));

    const { onClose } = renderModal();
    fireEvent.click(screen.getByRole('button', { name: 'Fork' }));
    await waitFor(() => expect(forkMock).toHaveBeenCalledTimes(1));

    const backdrop = screen.getByRole('dialog').parentElement!;
    fireEvent.pointerDown(backdrop);
    fireEvent.click(backdrop);
    expect(onClose).not.toHaveBeenCalled();

    reject(new Error('nope'));
    await screen.findByRole('alert');
  });

  it('forks and closes on success', async () => {
    forkMock.mockResolvedValue({ id: 'thread-forked', title: 'Forked' } as ThreadSummary);
    const { onClose, onForked } = renderModal();
    fireEvent.click(screen.getByRole('button', { name: 'Fork' }));
    await waitFor(() => expect(onForked).toHaveBeenCalledTimes(1));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('submits the fork when Enter is pressed in the title field', async () => {
    forkMock.mockResolvedValue({ id: 'thread-forked', title: 'Forked' } as ThreadSummary);
    renderModal();
    const input = screen.getByRole('textbox');
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(forkMock).toHaveBeenCalledTimes(1));
  });
});
