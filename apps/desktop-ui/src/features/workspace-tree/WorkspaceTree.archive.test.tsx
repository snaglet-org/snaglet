/**
 * Archiving from the workspace tree never asks first: the row menu's Archive
 * and the Delete key archive at once, the toast's Undo restores the rows in
 * place, and keyboard focus moves to the row that took their place.
 */
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LibraryTreeChild } from '@desktop/utils/api';
import { TOAST_EVENT_NAME, type ToastDetail } from '@desktop/utils/toast';

vi.hoisted(() => {
  vi.stubEnv('VITE_API_BASE_URL', '/api');
  vi.stubEnv('VITE_APP_NAME', 'Snaglet');
});

const listTree = vi.fn();
const archive = vi.fn();
const restore = vi.fn();
const counts = vi.fn();

vi.mock('@desktop/utils/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@desktop/utils/api')>();
  return {
    ...actual,
    containersApi: { ...actual.containersApi, listTree: (...args: unknown[]) => listTree(...args) },
    archiveApi: {
      ...actual.archiveApi,
      archive: (...args: unknown[]) => archive(...args),
      restore: (...args: unknown[]) => restore(...args),
      counts: (...args: unknown[]) => counts(...args),
    },
  };
});

import { WorkspaceTree } from './WorkspaceTree';

const timestamp = '2026-01-01T00:00:00.000Z';
const doc = (id: string, title: string, sortOrder: number): LibraryTreeChild => ({
  kind: 'doc',
  id,
  containerId: null,
  title,
  content: '',
  sortOrder,
  createdAt: timestamp,
  updatedAt: timestamp,
});
const ALPHA = doc('doc-1111111111111-aaaaaaaaa', 'Alpha', 0);
const BETA = doc('doc-2222222222222-bbbbbbbbb', 'Beta', 1);

let toasts: ToastDetail[] = [];
const onToast = (event: Event) => toasts.push((event as CustomEvent<ToastDetail>).detail);

beforeEach(() => {
  toasts = [];
  window.localStorage.clear();
  window.addEventListener(TOAST_EVENT_NAME, onToast);
  listTree.mockResolvedValue([ALPHA, BETA]);
  archive.mockResolvedValue({ node: null, affected: 1 });
  restore.mockResolvedValue({ node: null, affected: 1 });
});

afterEach(() => {
  window.removeEventListener(TOAST_EVENT_NAME, onToast);
  listTree.mockReset();
  archive.mockReset();
  restore.mockReset();
  counts.mockReset();
});

describe('WorkspaceTree archive', () => {
  it('archives from the row menu without a confirmation and restores it with Undo', async () => {
    render(<WorkspaceTree onNodeClick={vi.fn()} />);
    fireEvent.contextMenu(await screen.findByText('Alpha'));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Archive' }));

    await waitFor(() => expect(screen.queryByText('Alpha')).not.toBeInTheDocument());
    expect(archive).toHaveBeenCalledWith(ALPHA.id);
    expect(counts).not.toHaveBeenCalled();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(toasts.map((t) => t.message)).toEqual(['Archived “Alpha”']);

    listTree.mockResolvedValue([ALPHA, BETA]);
    act(() => toasts[0].action?.run());
    expect(await screen.findByText('Alpha')).toBeInTheDocument();
    expect(restore).toHaveBeenCalledWith(ALPHA.id);
  });

  it('archives the focused row with Delete and moves focus to the row below', async () => {
    render(<WorkspaceTree onNodeClick={vi.fn()} />);
    const row = (await screen.findByRole('treeitem', { name: 'Alpha' })) as HTMLElement;
    row.focus();
    fireEvent.keyDown(row, { key: 'Delete' });

    await waitFor(() => expect(screen.queryByText('Alpha')).not.toBeInTheDocument());
    expect(archive).toHaveBeenCalledWith(ALPHA.id);
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByRole('treeitem', { name: 'Beta' }))
    );
  });

  it('archives the whole selection with Delete on a selected row', async () => {
    render(<WorkspaceTree onNodeClick={vi.fn()} />);
    fireEvent.click(await screen.findByText('Alpha'));
    fireEvent.click(screen.getByText('Beta'), { metaKey: true });
    fireEvent.keyDown(screen.getByRole('treeitem', { name: 'Beta' }), { key: 'Delete' });

    await waitFor(() => expect(screen.queryByText('Beta')).not.toBeInTheDocument());
    expect(screen.queryByText('Alpha')).not.toBeInTheDocument();
    expect(archive.mock.calls.map(([id]) => id)).toEqual([ALPHA.id, BETA.id]);
    expect(toasts.map((t) => t.message)).toEqual(['Archived 2 items']);
  });
});
