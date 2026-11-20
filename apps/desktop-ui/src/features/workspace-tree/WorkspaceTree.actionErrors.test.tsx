/**
 * A failed tree action (rename, create, move, paste) must not replace the
 * whole tree with its error text. The tree stays, the optimistic change is
 * reverted, and the error is reported as a toast.
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { LibraryTreeChild } from '@desktop/utils/api';
import { TOAST_EVENT_NAME, type ToastDetail } from '@desktop/utils/toast';

vi.hoisted(() => {
  vi.stubEnv('VITE_API_BASE_URL', '/api');
  vi.stubEnv('VITE_APP_NAME', 'Snaglet');
});

const listTree = vi.fn();
const updateDoc = vi.fn();

vi.mock('@desktop/utils/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@desktop/utils/api')>();
  return {
    ...actual,
    containersApi: { ...actual.containersApi, listTree: (...args: unknown[]) => listTree(...args) },
    docsApi: { ...actual.docsApi, update: (...args: unknown[]) => updateDoc(...args) },
  };
});

import { WorkspaceTree } from './WorkspaceTree';

const timestamp = '2026-01-01T00:00:00.000Z';
const docNode: LibraryTreeChild = {
  kind: 'doc',
  id: 'doc-1111111111111-aaaaaaaaa',
  containerId: null,
  title: 'Guide',
  content: '',
  sortOrder: 0,
  createdAt: timestamp,
  updatedAt: timestamp,
};

afterEach(() => {
  listTree.mockReset();
  updateDoc.mockReset();
});

describe('WorkspaceTree action errors', () => {
  it('keeps the tree and toasts when a rename fails', async () => {
    listTree.mockResolvedValue([docNode]);
    updateDoc.mockRejectedValue(new Error('Name already taken'));
    const toasts: string[] = [];
    const onToast = (event: Event) =>
      toasts.push((event as CustomEvent<ToastDetail>).detail.message);
    window.addEventListener(TOAST_EVENT_NAME, onToast);

    render(<WorkspaceTree onNodeClick={vi.fn()} />);
    fireEvent.doubleClick(await screen.findByText('Guide'));
    const input = screen.getByDisplayValue('Guide');
    fireEvent.change(input, { target: { value: 'Renamed' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    await waitFor(() => expect(toasts).toEqual(['Rename failed: Name already taken']));
    expect(screen.getByRole('tree')).toBeInTheDocument();
    expect(screen.getByText('Guide')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    window.removeEventListener(TOAST_EVENT_NAME, onToast);
  });

  it('shows the load error in place of the body only when no tree has loaded', async () => {
    listTree.mockRejectedValue(new Error('Server unreachable'));

    render(<WorkspaceTree onNodeClick={vi.fn()} />);

    expect(await screen.findByRole('alert')).toHaveTextContent('Server unreachable');
    expect(screen.queryByRole('tree')).not.toBeInTheDocument();
  });

  it('keeps a loaded tree when a later refresh fails', async () => {
    listTree
      .mockResolvedValueOnce([docNode])
      .mockRejectedValueOnce(new Error('Server unreachable'));

    const view = render(<WorkspaceTree onNodeClick={vi.fn()} refreshNonce={0} />);
    await screen.findByText('Guide');
    view.rerender(<WorkspaceTree onNodeClick={vi.fn()} refreshNonce={1} />);

    expect(await screen.findByRole('alert')).toHaveTextContent(
      "Couldn't refresh the workspace: Server unreachable"
    );
    expect(screen.getByRole('tree')).toBeInTheDocument();
    expect(screen.getByText('Guide')).toBeInTheDocument();
  });
});
