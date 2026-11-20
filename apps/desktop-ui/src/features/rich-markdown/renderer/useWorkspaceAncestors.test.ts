import { renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { emitLibraryEvent } from '@desktop/utils/workspaceEvents';
import { useWorkspaceAncestors, useWorkspaceTree } from './useWorkspaceAncestors';

const api = vi.hoisted(() => ({
  listTree: vi.fn(),
}));

vi.mock('@desktop/utils/api', () => ({
  containersApi: { listTree: api.listTree },
}));

const container = (id: string, name: string, children: unknown[]) =>
  ({ id, kind: 'container', name, children }) as never;
const doc = (id: string) => ({ id, kind: 'doc', title: id }) as never;

describe('useWorkspaceAncestors', () => {
  it('re-resolves a chip path after the node is moved (structural invalidation)', async () => {
    api.listTree.mockResolvedValue([container('c1', 'Projects', [doc('d1')])]);
    const hook = renderHook(() => useWorkspaceAncestors('d1'));
    await waitFor(() => expect(hook.result.current).toEqual(['Projects']));

    // Moving the doc must invalidate the cached tree, not only renames, or
    // the chip keeps its stale path.
    api.listTree.mockResolvedValue([
      container('c1', 'Projects', []),
      container('c2', 'Archive', [doc('d1')]),
    ]);
    emitLibraryEvent({ type: 'node-moved', kind: 'doc', id: 'd1', parentId: 'c2' });
    await waitFor(() => expect(hook.result.current).toEqual(['Archive']));
  });

  it('resolves nodes created after the first fetch once the tree is invalidated', async () => {
    api.listTree.mockResolvedValue([container('c1', 'Projects', [])]);
    const hook = renderHook(() => useWorkspaceAncestors('d2'));
    // Loaded but not found -> [].
    await waitFor(() => expect(hook.result.current).toEqual([]));

    api.listTree.mockResolvedValue([container('c1', 'Projects', [doc('d2')])]);
    emitLibraryEvent({ type: 'tree-invalidated', ids: ['d2'] });
    await waitFor(() => expect(hook.result.current).toEqual(['Projects']));
  });
});

describe('useWorkspaceTree', () => {
  it('loads the shared tree only when enabled, and reloads it after a rename', async () => {
    api.listTree.mockClear();
    emitLibraryEvent({ type: 'tree-invalidated', ids: [] });
    api.listTree.mockResolvedValue([doc('d3')]);
    const idle = renderHook(() => useWorkspaceTree(false));
    expect(idle.result.current).toBeNull();
    expect(api.listTree).not.toHaveBeenCalled();

    const hook = renderHook(() => useWorkspaceTree(true));
    await waitFor(() => expect(hook.result.current).toEqual([doc('d3')]));

    api.listTree.mockResolvedValue([doc('d4')]);
    emitLibraryEvent({ type: 'renamed', kind: 'doc', id: 'd4', name: 'd4' });
    await waitFor(() => expect(hook.result.current).toEqual([doc('d4')]));
  });
});
