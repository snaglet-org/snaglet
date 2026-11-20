import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import type { ContainerTreeNode, LibraryTreeChild } from '@desktop/utils/api';
import { emitLibraryEvent } from '@desktop/utils/workspaceEvents';
import { useContainerContents } from './useContainerContents';

const api = vi.hoisted(() => ({ get: vi.fn(), listTree: vi.fn() }));
vi.mock('@desktop/utils/api', () => ({ containersApi: api }));
const folder = (id: string, children: LibraryTreeChild[] = []): ContainerTreeNode => ({
  kind: 'container',
  id,
  name: id,
  children,
  parentId: null,
  sortOrder: 0,
  folderPath: null,
  githubUrl: null,
  createdAt: '',
  updatedAt: '',
  category: null,
});
const thread = (id: string): LibraryTreeChild => ({
  kind: 'thread',
  id,
  projectId: null,
  title: id,
  sortOrder: 0,
  lastMessageAt: null,
  createdAt: '',
  updatedAt: null,
});
const stale = folder('container-a', [folder('container-old')]);
const fresh = folder('container-a', [folder('container-new', [folder('container-nested')])]);
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
beforeEach(() => {
  vi.resetAllMocks();
  api.get.mockImplementation(async (id: string) => folder(id));
  api.listTree.mockResolvedValue([fresh]);
});

it('reconciles a restored snapshot on mount, including nested counts, without an event', async () => {
  const { result } = renderHook(() => useContainerContents(stale));
  await waitFor(() => expect(result.current.children).toEqual(fresh.children));
  expect(api.get).toHaveBeenCalledWith(stale.id);
});

it('does not replace live children with a rerendered stale selection snapshot', async () => {
  const { result, rerender } = renderHook(({ node }) => useContainerContents(node), {
    initialProps: { node: stale },
  });
  await waitFor(() => expect(result.current.children).toEqual(fresh.children));
  rerender({ node: { ...stale, children: [...stale.children] } });
  expect(result.current.children).toEqual(fresh.children);
  expect(api.get).toHaveBeenCalledTimes(1);
});

it.each(['tree-invalidated', 'archive-changed'] as const)(
  'reconciles cards and nested counts after %s',
  async (type) => {
    const { result } = renderHook(() => useContainerContents(stale));
    await waitFor(() => expect(result.current.children).toEqual(fresh.children));
    api.listTree.mockResolvedValue([folder(stale.id)]);
    await act(async () => emitLibraryEvent({ type, ids: [] }));
    expect(result.current.children).toEqual([]);
  }
);

it('ignores the previous container response after navigation', async () => {
  const oldTree = deferred<LibraryTreeChild[]>();
  api.listTree.mockReturnValueOnce(oldTree.promise).mockResolvedValue([folder('container-b')]);
  const { result, rerender } = renderHook(({ node }) => useContainerContents(node), {
    initialProps: { node: stale },
  });
  await waitFor(() => expect(api.listTree).toHaveBeenCalledTimes(1));
  rerender({ node: folder('container-b') });
  await waitFor(() => expect(api.listTree).toHaveBeenCalledTimes(2));
  await act(async () => oldTree.resolve([fresh]));
  expect(result.current.children).toEqual([]);
});

it('ignores an older response after a newer realtime refresh', async () => {
  const oldTree = deferred<LibraryTreeChild[]>();
  api.listTree.mockReturnValueOnce(oldTree.promise);
  const { result } = renderHook(() => useContainerContents(stale));
  await waitFor(() => expect(api.listTree).toHaveBeenCalledTimes(1));
  await act(async () => emitLibraryEvent({ type: 'tree-invalidated', ids: [] }));
  expect(result.current.children).toEqual(fresh.children);
  await act(async () => oldTree.resolve([stale]));
  expect(result.current.children).toEqual(fresh.children);
});

it('does not let an in-flight read undo an optimistic move', async () => {
  const oldTree = deferred<LibraryTreeChild[]>();
  api.listTree.mockReturnValueOnce(oldTree.promise);
  const { result } = renderHook(() => useContainerContents(stale));
  await waitFor(() => expect(api.listTree).toHaveBeenCalledTimes(1));
  act(() =>
    emitLibraryEvent({ type: 'node-moved', kind: 'container', id: 'container-old', parentId: null })
  );
  expect(result.current.children).toEqual([]);
  await act(async () => oldTree.resolve([stale]));
  expect(result.current.children).toEqual([]);
  expect(api.listTree).toHaveBeenCalledTimes(1);
});

it('recovers from an offline mount on reconnect invalidation, using current project category', async () => {
  api.get.mockRejectedValueOnce(new Error('offline'));
  const { result } = renderHook(() => useContainerContents(stale));
  await act(async () => {});
  expect(result.current.children).toEqual(stale.children);
  api.get.mockResolvedValue({ ...fresh, category: 'project' });
  await act(async () => emitLibraryEvent({ type: 'tree-invalidated', ids: [] }));
  expect(api.listTree).toHaveBeenCalledWith(stale.id);
  expect(result.current.category).toBe('project');
  expect(result.current.children).toEqual(fresh.children);
});

it('unsubscribes and ignores pending reads on unmount', async () => {
  const record = deferred<ContainerTreeNode>();
  api.get.mockReturnValue(record.promise);
  const { unmount } = renderHook(() => useContainerContents(stale));
  unmount();
  await act(async () => record.resolve(fresh));
  act(() => emitLibraryEvent({ type: 'tree-invalidated', ids: [] }));
  expect(api.get).toHaveBeenCalledTimes(1);
  expect(api.listTree).not.toHaveBeenCalled();
});

it('clears old cards when the container is no longer present in the active tree', async () => {
  api.listTree.mockResolvedValue([]);
  const { result } = renderHook(() => useContainerContents(stale));
  await waitFor(() => expect(result.current.children).toEqual([]));
});

it('refreshes local creates and renames even when the selection snapshot does not change', async () => {
  const { result } = renderHook(() => useContainerContents(stale));
  await waitFor(() => expect(result.current.children).toEqual(fresh.children));
  const created = folder('container-created');
  api.listTree.mockResolvedValue([folder(stale.id, [created])]);
  await act(async () =>
    emitLibraryEvent({
      type: 'created',
      kind: 'container',
      id: created.id,
      node: created,
      parentId: stale.id,
    })
  );
  expect(result.current.children).toEqual([created]);
  const renamed = { ...created, name: 'New title' };
  api.listTree.mockResolvedValue([folder(stale.id, [renamed])]);
  await act(async () =>
    emitLibraryEvent({ type: 'renamed', kind: 'container', id: created.id, name: renamed.name })
  );
  expect(result.current.children).toEqual([renamed]);
});

it("lists a project's threads but never a plain folder's", async () => {
  const projectThread = {
    ...thread('thread-1'),
    projectId: 'container-a',
    containerId: 'container-a',
  };
  api.get.mockResolvedValue({ ...folder('container-a'), category: 'project' });
  api.listTree.mockResolvedValue([folder('container-a', [projectThread])]);
  const { result } = renderHook(() => useContainerContents(stale));
  await waitFor(() => expect(result.current.category).toBe('project'));
  expect(result.current.children).toEqual([projectThread]);
});

it('drops threads from a stale folder snapshot saved before threads left the tree', () => {
  api.get.mockReturnValue(new Promise(() => {}));
  const snapshot = folder('container-b', [thread('thread-old'), folder('container-child')]);
  const { result } = renderHook(() => useContainerContents(snapshot));
  expect(result.current.children).toEqual([folder('container-child')]);
});
