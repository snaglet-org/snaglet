import { act, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { LibraryTreeChild } from '@desktop/utils/api';
import { emitLibraryEvent } from '@desktop/utils/workspaceEvents';
import { labelOfNode } from '../treeUtils';
import { useTreeLibraryEvents } from './useTreeLibraryEvents';
import { useWorkspaceTreeRoots } from './useWorkspaceTreeRoots';

const listTree = vi.fn();

vi.mock('@desktop/utils/api', () => ({
  containersApi: { listTree: (...args: unknown[]) => listTree(...args) },
}));

const doc = (title: string): LibraryTreeChild =>
  ({
    kind: 'doc',
    id: 'doc-1',
    title,
    content: '',
    containerId: null,
    sortOrder: 0,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  }) as LibraryTreeChild;

const container = (category: null | 'project'): LibraryTreeChild =>
  ({
    kind: 'container',
    id: 'container-1',
    name: 'Work',
    parentId: null,
    category,
    folderPath: null,
    githubUrl: null,
    children: [],
    sortOrder: 0,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  }) as LibraryTreeChild;

function TreeBadgeHarness() {
  const { roots, setRoots, setReloadKey } = useWorkspaceTreeRoots(0);
  useTreeLibraryEvents({ setRoots, setReloadKey });

  const node = roots?.[0];
  if (!node) return <span>loading</span>;
  if (node.kind === 'doc') {
    return <span data-testid="doc-label">{labelOfNode(node)}</span>;
  }
  if (node.kind === 'container') {
    return <span data-testid="container-chip">{node.category ?? 'plain'}</span>;
  }
  return <span>unsupported</span>;
}

describe('workspace tree badge refresh', () => {
  beforeEach(() => {
    listTree.mockReset();
  });

  it('refetches and repaints a doc row after tree invalidation', async () => {
    listTree.mockResolvedValueOnce([doc('Guide')]).mockResolvedValueOnce([doc('Guide v2')]);
    render(<TreeBadgeHarness />);

    expect(await screen.findByTestId('doc-label')).toHaveTextContent('Guide');
    act(() => emitLibraryEvent({ type: 'tree-invalidated', ids: ['doc-1'] }));

    // The refetch may wait out the tree's short coalescing gap after the load.
    await waitFor(() => expect(screen.getByTestId('doc-label')).toHaveTextContent('Guide v2'));
    expect(listTree).toHaveBeenCalledTimes(2);
  });

  it('refetches the container category so the project badge repaints', async () => {
    listTree.mockResolvedValueOnce([container(null)]).mockResolvedValueOnce([container('project')]);
    render(<TreeBadgeHarness />);

    const chip = await screen.findByTestId('container-chip');
    expect(chip).toHaveTextContent('plain');
    act(() => emitLibraryEvent({ type: 'tree-invalidated', ids: ['container-1'] }));

    await waitFor(() => expect(screen.getByTestId('container-chip')).toHaveTextContent('project'));
    expect(listTree).toHaveBeenCalledTimes(2);
  });
});
