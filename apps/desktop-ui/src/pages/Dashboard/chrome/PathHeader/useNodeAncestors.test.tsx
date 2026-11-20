import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import type { LibraryTreeChild } from '@desktop/utils/api';
import { emitLibraryEvent } from '@desktop/utils/workspaceEvents';
import { useNodeAncestors } from './useNodeAncestors';

function useAncestorNames(nodeId: string | null): string[] {
  return useNodeAncestors(nodeId).map((ancestor) => ancestor.name);
}

const api = vi.hoisted(() => ({ listTree: vi.fn() }));
vi.mock('@desktop/utils/api', () => ({ containersApi: api }));

const THREAD_ID = 'thread-1111111111111-aaaaaaaaa';
const PROJECT_ID = 'container-1111111111111-aaaaaaaaa';

function project(name: string, children: LibraryTreeChild[]): LibraryTreeChild {
  return {
    kind: 'container',
    id: PROJECT_ID,
    name,
    category: 'project',
    children,
  } as LibraryTreeChild;
}
function thread(): LibraryTreeChild {
  return { kind: 'thread', id: THREAD_ID, title: 'Test thread' } as LibraryTreeChild;
}

beforeEach(() => {
  vi.resetAllMocks();
});

it('follows a thread out of its project when the tree reports a move', async () => {
  api.listTree.mockResolvedValue([project('Project A', [thread()])]);
  const { result } = renderHook(() => useAncestorNames(THREAD_ID));
  await waitFor(() => expect(result.current).toEqual(['Project A']));

  // The thread became flat: it now sits at the root beside the project.
  api.listTree.mockResolvedValue([project('Project A', []), thread()]);
  await act(async () =>
    emitLibraryEvent({ type: 'node-moved', kind: 'thread', id: THREAD_ID, parentId: null })
  );
  await waitFor(() => expect(result.current).toEqual([]));
  expect(api.listTree).toHaveBeenCalledTimes(2);
});

it('re-reads the path after a tree invalidation and ignores unrelated events', async () => {
  api.listTree.mockResolvedValue([project('Project A', [thread()])]);
  const { result } = renderHook(() => useAncestorNames(THREAD_ID));
  await waitFor(() => expect(result.current).toEqual(['Project A']));

  api.listTree.mockResolvedValue([project('Project A (renamed)', [thread()])]);
  await act(async () =>
    emitLibraryEvent({ type: 'doc-saved', id: 'doc-1111111111111-aaaaaaaaa', content: '' })
  );
  expect(api.listTree).toHaveBeenCalledTimes(1);
  await act(async () => emitLibraryEvent({ type: 'tree-invalidated', ids: [THREAD_ID] }));
  await waitFor(() => expect(result.current).toEqual(['Project A (renamed)']));
});

it('does not fetch without a node id', () => {
  const { result } = renderHook(() => useAncestorNames(null));
  expect(result.current).toEqual([]);
  expect(api.listTree).not.toHaveBeenCalled();
});
