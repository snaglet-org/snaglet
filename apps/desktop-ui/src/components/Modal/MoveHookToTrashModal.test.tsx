import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { hooksWorkspacesApi } from '@desktop/utils/api';
import { MoveHookToTrashModal } from './MoveHookToTrashModal';

vi.mock('@desktop/utils/api', () => ({
  hooksWorkspacesApi: {
    get: vi.fn(),
    delete: vi.fn(),
  },
}));

const get = vi.mocked(hooksWorkspacesApi.get);
const del = vi.mocked(hooksWorkspacesApi.delete);

const workspace = {
  hookName: 'daily-digest',
  dir: '/Users/me/.snaglet/hooks/daily-digest',
  homeRelativeDir: '~/.snaglet/hooks/daily-digest',
  files: ['hook.ts'],
  hasBuild: true,
};

const deleteResult = {
  hookName: 'daily-digest',
  deletedRuns: 2,
  deletedRegistration: true,
  deletedSchedules: 1,
  trash: { disposition: 'system-trash' as const, fallbackDir: null },
};

function renderModal() {
  const onTrashed = vi.fn();
  const onCancel = vi.fn();
  render(
    <MoveHookToTrashModal hookName="daily-digest" onTrashed={onTrashed} onCancel={onCancel} />
  );
  return { onTrashed, onCancel };
}

beforeEach(() => {
  vi.restoreAllMocks();
  get.mockReset();
  del.mockReset();
  get.mockResolvedValue(workspace);
});

describe('MoveHookToTrashModal', () => {
  it('explains that hooks are not archivable and names the local code path (~-relative)', async () => {
    renderModal();

    expect(
      screen.getByRole('dialog', { name: 'Move script daily-digest to the Trash' })
    ).toBeTruthy();
    expect(screen.getByText(/you can.t archive this script/i)).toBeInTheDocument();
    expect(await screen.findByText('~/.snaglet/hooks/daily-digest')).toBeInTheDocument();
    expect(get).toHaveBeenCalledWith('daily-digest');
  });

  it("the 'delete' variant asks the move-to-Trash question directly — no archive framing — with the same path and action", async () => {
    const onTrashed = vi.fn();
    render(
      <MoveHookToTrashModal
        hookName="daily-digest"
        variant="delete"
        onTrashed={onTrashed}
        onCancel={vi.fn()}
      />
    );

    expect(screen.getByText('Move “daily-digest” to the Trash?')).toBeInTheDocument();
    expect(screen.queryByText(/you can.t archive this script/i)).not.toBeInTheDocument();
    expect(await screen.findByText('~/.snaglet/hooks/daily-digest')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Move to Trash' })).toBeInTheDocument();
  });

  it('guards the destructive action until the workspace info loads', () => {
    get.mockReturnValue(new Promise(() => {}));
    renderModal();

    expect(screen.getByRole('button', { name: 'Cancel' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Move to Trash' })).toBeDisabled();
  });

  it('cancels without calling the delete API', async () => {
    const user = userEvent.setup();
    const { onTrashed, onCancel } = renderModal();
    await screen.findByText('~/.snaglet/hooks/daily-digest');

    await user.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onTrashed).not.toHaveBeenCalled();
    expect(del).not.toHaveBeenCalled();
  });

  it('"Move to Trash" calls the delete API with an accurate loading name, then reports the outcome', async () => {
    const user = userEvent.setup();
    let resolveDelete: (value: typeof deleteResult) => void = () => {};
    del.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveDelete = resolve;
        })
    );
    const { onTrashed } = renderModal();
    await screen.findByText('~/.snaglet/hooks/daily-digest');

    await user.click(screen.getByRole('button', { name: 'Move to Trash' }));

    expect(del).toHaveBeenCalledWith('daily-digest');
    expect(screen.getByRole('button', { name: 'Moving to Trash…' })).toHaveAttribute(
      'aria-busy',
      'true'
    );
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled();

    resolveDelete(deleteResult);
    await waitFor(() => expect(onTrashed).toHaveBeenCalledWith(deleteResult));
  });

  it('surfaces a delete failure inline and stays open — never a silent close', async () => {
    const user = userEvent.setup();
    del.mockRejectedValue(new Error('Hook has a queued invocation'));
    const { onTrashed } = renderModal();
    await screen.findByText('~/.snaglet/hooks/daily-digest');

    await user.click(screen.getByRole('button', { name: 'Move to Trash' }));

    expect(await screen.findByText(/queued invocation/i)).toBeInTheDocument();
    expect(onTrashed).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Move to Trash' })).toBeEnabled();
  });
});
