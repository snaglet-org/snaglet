/**
 * The shared workspace tree feed: the sidebar tree and every pane's path
 * header ride one coalesced, single-flight full-tree request, so a burst of
 * realtime events costs a handful of fetches in total, not a handful per
 * reader, and every reader ends on the same last response.
 */
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LibraryTreeChild } from '@desktop/utils/api';
import { emitLibraryEvent } from '@desktop/utils/workspaceEvents';
import { useNodeAncestors } from '@desktop/pages/Dashboard/chrome/PathHeader/useNodeAncestors';
import { useTreeLibraryEvents } from './hooks/useTreeLibraryEvents';
import { useWorkspaceTreeRoots } from './hooks/useWorkspaceTreeRoots';

const api = vi.hoisted(() => ({ listTree: vi.fn() }));
vi.mock('@desktop/utils/api', () => ({ containersApi: { listTree: api.listTree } }));

const PROJECT_ID = 'container-1111111111111-aaaaaaaaa';
const FOLDER_ID = 'container-2222222222222-bbbbbbbbb';
const THREAD_ID = 'thread-1111111111111-aaaaaaaaa';
const DOC_ID = 'doc-1111111111111-aaaaaaaaa';

const container = (id: string, name: string, children: LibraryTreeChild[]): LibraryTreeChild =>
  ({ kind: 'container', id, name, category: null, children }) as LibraryTreeChild;

/** Tree version `n`: a project holding a thread, a folder holding a doc. */
const treeVersion = (n: number): LibraryTreeChild[] => [
  container(PROJECT_ID, `Test project ${n}`, [
    { kind: 'thread', id: THREAD_ID, title: 'Test thread' } as LibraryTreeChild,
  ]),
  container(FOLDER_ID, `Test folder ${n}`, [
    { kind: 'doc', id: DOC_ID, title: 'Test doc' } as LibraryTreeChild,
  ]),
];

/** Each fetch answers tree version `n` (its call number) after `latencyMs`. */
function answerWithVersions(latencyMs: number) {
  let n = 0;
  api.listTree.mockImplementation(() => {
    n += 1;
    const reply = treeVersion(n);
    return new Promise<LibraryTreeChild[]>((resolve) =>
      setTimeout(() => resolve(reply), latencyMs)
    );
  });
}

const advance = (ms: number) =>
  act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });

/** The sidebar tree (with its library-event wiring) and two pane path headers. */
function renderSidebarAndTwoHeaders() {
  return renderHook(
    ({ refreshNonce }: { refreshNonce: number }) => {
      const tree = useWorkspaceTreeRoots(refreshNonce);
      useTreeLibraryEvents({ setRoots: tree.setRoots, setReloadKey: tree.setReloadKey });
      const threadPath = useNodeAncestors(THREAD_ID);
      const docPath = useNodeAncestors(DOC_ID);
      return { tree, threadPath, docPath };
    },
    { initialProps: { refreshNonce: 0 } }
  );
}

/** Tree version `n` after the thread left its project for the top level. */
const treeWithThreadAtRoot = (n: number): LibraryTreeChild[] => [
  container(PROJECT_ID, `Test project ${n}`, []),
  container(FOLDER_ID, `Test folder ${n}`, [
    { kind: 'doc', id: DOC_ID, title: 'Test doc' } as LibraryTreeChild,
  ]),
  { kind: 'thread', id: THREAD_ID, title: 'Test thread' } as LibraryTreeChild,
];

const threadAtRoot = (roots: LibraryTreeChild[] | null): boolean =>
  (roots ?? []).some((node) => node.id === THREAD_ID);

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

/** Let pending microtasks run without moving the fake clock. */
const flushMicrotasks = () => act(async () => {});

const projectNameOf = (roots: LibraryTreeChild[] | null): string | null => {
  const node = roots?.[0];
  return node && node.kind === 'container' ? node.name : null;
};

beforeEach(() => {
  vi.useFakeTimers();
  vi.resetAllMocks();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('shared workspace tree feed', () => {
  it('a burst of 50 events with the sidebar and two pane headers mounted costs a handful of fetches in total', async () => {
    answerWithVersions(30);
    const { result, rerender } = renderSidebarAndTwoHeaders();
    await advance(1000);
    const afterMount = api.listTree.mock.calls.length;
    // Three readers mounted in one commit share the first load.
    expect(afterMount).toBe(1);
    expect(result.current.threadPath.map((ancestor) => ancestor.name)).toEqual([
      `Test project ${afterMount}`,
    ]);

    // Each event as the realtime bridge delivers it: a `tree-invalidated`
    // library event (the headers request, the sidebar bumps `reloadKey`),
    // then the dashboard's `refreshNonce` bump.
    for (let i = 1; i <= 50; i += 1) {
      act(() => emitLibraryEvent({ type: 'tree-invalidated', ids: [] }));
      rerender({ refreshNonce: i });
      await advance(2);
    }
    await advance(1000);

    const total = api.listTree.mock.calls.length;
    expect(total - afterMount).toBeLessThanOrEqual(2);
    expect(total).toBeLessThanOrEqual(3);
    // All three readers end on the same, last response.
    expect(projectNameOf(result.current.tree.roots)).toBe(`Test project ${total}`);
    expect(result.current.threadPath.map((ancestor) => ancestor.name)).toEqual([
      `Test project ${total}`,
    ]);
    expect(result.current.docPath.map((ancestor) => ancestor.name)).toEqual([
      `Test folder ${total}`,
    ]);
  });

  it('keeps an optimistic undo move in the sidebar when a header fetch sent before the write lands', async () => {
    api.listTree.mockResolvedValueOnce(treeVersion(1));
    const { result } = renderSidebarAndTwoHeaders();
    await advance(1000);
    const preWrite = deferred<LibraryTreeChild[]>();
    const postWrite = deferred<LibraryTreeChild[]>();
    api.listTree.mockReturnValueOnce(preWrite.promise).mockReturnValueOnce(postWrite.promise);

    // Undo replays a move: the sidebar patches the row at once, and the path
    // headers ask for the tree before the write has reached the server.
    act(() =>
      emitLibraryEvent({ type: 'node-moved', kind: 'thread', id: THREAD_ID, parentId: null })
    );
    await flushMicrotasks();
    expect(api.listTree).toHaveBeenCalledTimes(2);
    expect(threadAtRoot(result.current.tree.roots)).toBe(true);

    // That fetch answers with the tree from before the write.
    await act(async () => preWrite.resolve(treeVersion(1)));
    expect(threadAtRoot(result.current.tree.roots)).toBe(true);

    // The sidebar asked for a follow-up, which lands.
    await advance(1000);
    expect(api.listTree).toHaveBeenCalledTimes(3);
    await act(async () => postWrite.resolve(treeWithThreadAtRoot(3)));
    expect(threadAtRoot(result.current.tree.roots)).toBe(true);
    expect(projectNameOf(result.current.tree.roots)).toBe('Test project 3');
    expect(result.current.threadPath.map((ancestor) => ancestor.name)).toEqual([]);
  });

  it('times out a hung tree request so later invalidations fetch again', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    api.listTree.mockResolvedValueOnce(treeVersion(1));
    const { result } = renderSidebarAndTwoHeaders();
    await advance(1000);
    api.listTree
      .mockReturnValueOnce(new Promise<LibraryTreeChild[]>(() => {}))
      .mockResolvedValueOnce(treeVersion(3));

    act(() => emitLibraryEvent({ type: 'tree-invalidated', ids: [] }));
    await advance(1000);
    expect(api.listTree).toHaveBeenCalledTimes(2);
    // Hung: further invalidations only queue behind it.
    act(() => emitLibraryEvent({ type: 'tree-invalidated', ids: [] }));
    await advance(1000);
    expect(api.listTree).toHaveBeenCalledTimes(2);

    await advance(30_000);
    const hungInit = api.listTree.mock.calls[1]?.[1] as RequestInit | undefined;
    expect(hungInit?.signal?.aborted).toBe(true);
    // The queued follow-up ran and landed; every reader moved on.
    expect(api.listTree).toHaveBeenCalledTimes(3);
    expect(projectNameOf(result.current.tree.roots)).toBe('Test project 3');
    expect(result.current.tree.error).toBeNull();
    expect(result.current.threadPath.map((ancestor) => ancestor.name)).toEqual(['Test project 3']);
    expect(consoleError).toHaveBeenCalledWith(
      'useNodeAncestors: failed to load workspace tree',
      expect.objectContaining({ message: 'The workspace tree request timed out' })
    );
    consoleError.mockRestore();
  });

  it('keeps the last result of each reader when a refetch fails', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    api.listTree.mockResolvedValue(treeVersion(1));
    const { result } = renderSidebarAndTwoHeaders();
    await advance(1000);
    api.listTree.mockRejectedValueOnce(new Error('Server unreachable'));

    act(() => emitLibraryEvent({ type: 'tree-invalidated', ids: [] }));
    await advance(0);

    expect(projectNameOf(result.current.tree.roots)).toBe('Test project 1');
    expect(result.current.tree.error).toBe('Server unreachable');
    expect(result.current.threadPath.map((ancestor) => ancestor.name)).toEqual(['Test project 1']);
    expect(result.current.docPath.map((ancestor) => ancestor.name)).toEqual(['Test folder 1']);
    expect(consoleError).toHaveBeenCalledWith(
      'useNodeAncestors: failed to load workspace tree',
      expect.any(Error)
    );
    consoleError.mockRestore();
  });

  it('keeps serving the readers still mounted after one closes, and stops with the last', async () => {
    answerWithVersions(30);
    const header = renderHook(() => useNodeAncestors(THREAD_ID));
    const sidebar = renderHook(() => useWorkspaceTreeRoots(0));
    await advance(1000);
    const before = api.listTree.mock.calls.length;

    header.unmount();
    act(() => sidebar.result.current.setReloadKey((k) => k + 1));
    await advance(1000);
    expect(api.listTree).toHaveBeenCalledTimes(before + 1);
    expect(projectNameOf(sidebar.result.current.roots)).toBe(`Test project ${before + 1}`);

    act(() => sidebar.result.current.setReloadKey((k) => k + 1));
    await advance(50);
    // Inside the gap after that fetch: this one waits on a timer.
    act(() => sidebar.result.current.setReloadKey((k) => k + 1));
    sidebar.unmount();
    expect(vi.getTimerCount()).toBe(0);
    await advance(1000);
    expect(api.listTree).toHaveBeenCalledTimes(before + 2);
  });
});
