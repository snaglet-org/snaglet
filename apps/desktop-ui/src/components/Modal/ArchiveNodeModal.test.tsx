import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { archiveApi } from '@desktop/utils/api';
import { ArchiveNodeModal } from './ArchiveNodeModal';

vi.mock('@desktop/utils/api', () => ({
  archiveApi: {
    counts: vi.fn(),
    archive: vi.fn(),
    hardDelete: vi.fn(),
  },
}));

const counts = vi.mocked(archiveApi.counts);
const archive = vi.mocked(archiveApi.archive);
const hardDelete = vi.mocked(archiveApi.hardDelete);

const archivedNode = {
  id: 'doc-1',
  type: 'doc',
  title: 'Launch notes',
  archived: true,
  archived_at: '2026-07-29T12:00:00.000Z',
  container_id: 'container-1',
  project_id: null,
  sort_order: 0,
  created_at: '2026-07-01T12:00:00.000Z',
  updated_at: '2026-07-29T12:00:00.000Z',
};

const cascadeCounts = {
  sub_containers: 0,
  docs: 0,
  projects: 0,
  threads: 0,
  messages: 0,
  memories: 0,
};

function renderModal() {
  const onArchived = vi.fn();
  const onCancel = vi.fn();
  render(
    <ArchiveNodeModal
      node={{ id: 'doc-1', type: 'doc', label: 'Launch notes' }}
      onArchived={onArchived}
      onCancel={onCancel}
    />
  );
  return { onArchived, onCancel };
}

beforeEach(() => {
  vi.restoreAllMocks();
  counts.mockReset();
  archive.mockReset();
  hardDelete.mockReset();
  counts.mockResolvedValue({ node: archivedNode, counts: cascadeCounts });
});

describe('ArchiveNodeModal actions', () => {
  it('exposes named actions while guarding destructive actions until counts load', () => {
    counts.mockReturnValue(new Promise(() => {}));
    renderModal();

    expect(screen.getByRole('dialog', { name: 'Archive Launch notes' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Delete Permanently' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Archive' })).toBeDisabled();
  });

  it('cancels without archiving', async () => {
    const user = userEvent.setup();
    const { onArchived, onCancel } = renderModal();

    await user.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onArchived).not.toHaveBeenCalled();
    expect(archive).not.toHaveBeenCalled();
  });

  it('archives with an accurate loading name and disables the other actions', async () => {
    const user = userEvent.setup();
    let resolveArchive: (value: Awaited<ReturnType<typeof archiveApi.archive>>) => void = () => {};
    archive.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveArchive = resolve;
        })
    );
    const { onArchived } = renderModal();
    await screen.findByText(/30-day TTL/i);

    await user.click(screen.getByRole('button', { name: 'Archive' }));

    expect(archive).toHaveBeenCalledWith('doc-1');
    expect(screen.getByRole('button', { name: 'Archiving…' })).toHaveAttribute('aria-busy', 'true');
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Delete Permanently' })).toBeDisabled();

    resolveArchive({ node: archivedNode, affected: 1 });
    await waitFor(() => {
      expect(onArchived).toHaveBeenCalledWith({ node: archivedNode, affected: 1 });
    });
  });

  it('confirms through the in-app dialog and performs a permanent delete', async () => {
    const user = userEvent.setup();
    // The Tauri webview suppresses window.confirm — the flow must never
    // touch it (regression guard for the silently-dead delete button).
    const nativeConfirm = vi.spyOn(window, 'confirm');
    hardDelete.mockResolvedValue({ id: 'doc-1', deleted: 1, was: archivedNode });
    const { onArchived } = renderModal();
    await screen.findByText(/30-day TTL/i);

    await user.click(screen.getByRole('button', { name: 'Delete Permanently' }));

    // Nothing deleted yet — the stacked confirmation is the gate.
    expect(hardDelete).not.toHaveBeenCalled();
    const confirmDialog = screen.getByRole('dialog', { name: 'Delete permanently?' });
    expect(confirmDialog).toHaveTextContent(
      'Permanently delete "Launch notes" and all its contents? This cannot be undone.'
    );

    await user.click(within(confirmDialog).getByRole('button', { name: 'Delete Permanently' }));

    expect(nativeConfirm).not.toHaveBeenCalled();
    expect(hardDelete).toHaveBeenCalledWith('doc-1');
    await waitFor(() => {
      expect(onArchived).toHaveBeenCalledWith({ node: null, affected: 0 });
    });
  });

  it('canceling the permanent-delete confirmation deletes nothing and keeps the modal open', async () => {
    const user = userEvent.setup();
    const { onArchived, onCancel } = renderModal();
    await screen.findByText(/30-day TTL/i);

    await user.click(screen.getByRole('button', { name: 'Delete Permanently' }));
    const confirmDialog = screen.getByRole('dialog', { name: 'Delete permanently?' });
    await user.click(within(confirmDialog).getByRole('button', { name: 'Cancel' }));

    expect(hardDelete).not.toHaveBeenCalled();
    expect(onArchived).not.toHaveBeenCalled();
    expect(onCancel).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog', { name: 'Archive Launch notes' })).toBeInTheDocument();
    expect(screen.queryByRole('dialog', { name: 'Delete permanently?' })).not.toBeInTheDocument();
  });
});
