import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { RemoveTableFieldModal } from './RemoveTableFieldModal';

function deferred() {
  let resolve: () => void = () => undefined;
  let reject: (error: Error) => void = () => undefined;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function setup(entryCount?: number) {
  const onArchive = vi.fn<() => Promise<void>>().mockResolvedValue();
  const onDelete = vi.fn<() => Promise<void>>().mockResolvedValue();
  const onCancel = vi.fn();
  render(
    <RemoveTableFieldModal
      fieldName="notes"
      entryCount={entryCount}
      onArchive={onArchive}
      onDelete={onDelete}
      onCancel={onCancel}
    />
  );
  return { onArchive, onDelete, onCancel };
}

describe('RemoveTableFieldModal', () => {
  it('names the column, explains both choices with the value count, and focuses Archive', async () => {
    setup(3);
    const dialog = screen.getByRole('dialog', { name: 'Remove column “notes”?' });
    expect(dialog).toHaveTextContent('hides the column but keeps its values');
    expect(dialog).toHaveTextContent('drops the column and its values in 3 entries');
    expect(dialog).toHaveTextContent('cannot be undone');
    await waitFor(() => expect(screen.getByRole('button', { name: 'Archive' })).toHaveFocus());
  });

  it('says "all of its values" when the count is unknown', () => {
    setup();
    expect(screen.getByRole('dialog')).toHaveTextContent('drops the column and all of its values');
  });

  it('Archive runs only the archive action; Delete forever only the delete', async () => {
    const user = userEvent.setup();
    const { onArchive, onDelete } = setup(1);
    await user.click(screen.getByRole('button', { name: 'Archive' }));
    expect(onArchive).toHaveBeenCalledOnce();
    expect(onDelete).not.toHaveBeenCalled();
  });

  it('Delete forever runs the delete action and locks the other buttons while it runs', async () => {
    const user = userEvent.setup();
    const pending = deferred();
    const { onArchive, onDelete, onCancel } = setup(1);
    onDelete.mockReturnValue(pending.promise);
    await user.click(screen.getByRole('button', { name: 'Delete forever' }));
    expect(onDelete).toHaveBeenCalledOnce();
    expect(onArchive).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Archive' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled();
    await user.keyboard('{Escape}');
    expect(onCancel).not.toHaveBeenCalled();
    pending.resolve();
  });

  it('shows a rejection inline and re-enables every button', async () => {
    const user = userEvent.setup();
    const { onArchive } = setup(2);
    onArchive.mockRejectedValueOnce(new Error('archive unavailable'));
    await user.click(screen.getByRole('button', { name: 'Archive' }));
    const dialog = screen.getByRole('dialog');
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('archive unavailable');
    expect(screen.getByRole('button', { name: 'Archive' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Delete forever' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeEnabled();
  });

  it('Cancel and Escape dismiss without acting', async () => {
    const user = userEvent.setup();
    const { onArchive, onDelete, onCancel } = setup(2);
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onCancel).toHaveBeenCalledTimes(1);
    await user.keyboard('{Escape}');
    expect(onCancel).toHaveBeenCalledTimes(2);
    expect(onArchive).not.toHaveBeenCalled();
    expect(onDelete).not.toHaveBeenCalled();
  });
});
