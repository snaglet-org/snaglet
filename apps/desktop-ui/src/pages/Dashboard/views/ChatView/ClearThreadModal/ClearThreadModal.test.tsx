import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ClearThreadModal } from './ClearThreadModal';

const clear = vi.hoisted(() => vi.fn());
vi.mock('@desktop/utils/api', () => ({
  threadsApi: { clear },
}));

describe('ClearThreadModal', () => {
  it('names the thread and states the irreversible consequence before clearing', () => {
    render(<ClearThreadModal threadId="thread-1" threadTitle="Planning room" onClose={vi.fn()} />);

    expect(screen.getByText(/Planning room/)).toBeInTheDocument();
    expect(
      screen.getByText(/permanently deletes every message and message embedding/i)
    ).toBeVisible();
    expect(screen.getByText(/can.t be undone/i)).toBeVisible();
    expect(screen.getByRole('button', { name: 'Clear thread' })).toBeInTheDocument();
  });

  it('announces a failed clear and stays open', async () => {
    clear.mockRejectedValueOnce(new Error('Thread is busy'));
    const onClose = vi.fn();
    render(<ClearThreadModal threadId="thread-1" threadTitle="Planning room" onClose={onClose} />);

    fireEvent.click(screen.getByRole('button', { name: 'Clear thread' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Thread is busy');
    expect(onClose).not.toHaveBeenCalled();
  });
});
