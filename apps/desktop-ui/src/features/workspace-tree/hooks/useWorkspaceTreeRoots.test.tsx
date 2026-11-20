/**
 * useWorkspaceTreeRoots coalesces tree refetches: the first load and the
 * first change after a quiet spell fetch at once, a burst of invalidations
 * shares a couple of fetches, only one fetch is ever in flight, every
 * response is applied, and the per-node lazy caches drop once per landed
 * refetch rather than once per event.
 */
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ContainerTreeNode, LibraryTreeChild } from '@desktop/utils/api';

const api = vi.hoisted(() => ({
  listTree: vi.fn(),
  listByProject: vi.fn(),
  listAgents: vi.fn(),
  listParticipants: vi.fn(),
}));

vi.mock('@desktop/utils/api', () => ({
  containersApi: { listTree: api.listTree },
  filesApi: { listByProject: api.listByProject },
  agentsApi: { list: api.listAgents },
}));
vi.mock('@desktop/utils/api/threads', () => ({
  threadsApi: { listParticipants: api.listParticipants },
}));

import { useTreeLazyData } from './useTreeLazyData';
import { useWorkspaceTreeRoots } from './useWorkspaceTreeRoots';

const GAP_MS = 120;
const DOC_ID = 'doc-1111111111111-aaaaaaaaa';
const PROJECT_ID = 'container-1111111111111-aaaaaaaaa';

const doc = (title: string): LibraryTreeChild =>
  ({
    kind: 'doc',
    id: DOC_ID,
    title,
    content: '',
    containerId: null,
    sortOrder: 0,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  }) as LibraryTreeChild;

const project = (name: string): ContainerTreeNode => ({
  kind: 'container',
  id: PROJECT_ID,
  parentId: null,
  name,
  sortOrder: 0,
  category: 'project',
  folderPath: '/tmp/test-project',
  githubUrl: null,
  createdBy: null,
  lastEditedBy: null,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  children: [],
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** The title of the single doc root, or null before a load. */
const titleOf = (roots: LibraryTreeChild[] | null): string | null => {
  const node = roots?.[0];
  return node && node.kind === 'doc' ? node.title : null;
};

/** Each fetch answers `Version <n>` (n = its call number) after `latencyMs`. */
function answerWithVersions(latencyMs: number) {
  let n = 0;
  api.listTree.mockImplementation(() => {
    n += 1;
    const reply = [doc(`Version ${n}`)];
    return new Promise<LibraryTreeChild[]>((resolve) =>
      setTimeout(() => resolve(reply), latencyMs)
    );
  });
}

const advance = (ms: number) =>
  act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });

/** Let pending microtasks run without moving the fake clock. */
const flushMicrotasks = () => act(async () => {});

function renderRoots() {
  return renderHook(
    ({ refreshNonce }: { refreshNonce: number }) => useWorkspaceTreeRoots(refreshNonce),
    { initialProps: { refreshNonce: 0 } }
  );
}

/** Mount, let the first load land, and wait out the gap so the hook is idle. */
async function renderLoaded() {
  const hook = renderRoots();
  await advance(1000);
  return hook;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.resetAllMocks();
  api.listByProject.mockResolvedValue([]);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('useWorkspaceTreeRoots', () => {
  it('starts the first load at once and applies it', async () => {
    const first = deferred<LibraryTreeChild[]>();
    api.listTree.mockReturnValueOnce(first.promise);

    const { result } = renderRoots();
    await flushMicrotasks();

    // No timer advanced: the load started with the mount itself.
    expect(api.listTree).toHaveBeenCalledTimes(1);
    expect(result.current.roots).toBeNull();
    await act(async () => first.resolve([doc('Version 1')]));
    expect(titleOf(result.current.roots)).toBe('Version 1');
    expect(result.current.error).toBeNull();
  });

  it('refetches at once for the first change after a quiet spell (a local write)', async () => {
    api.listTree.mockResolvedValue([doc('Version 1')]);
    const { result } = await renderLoaded();

    act(() => result.current.setReloadKey((k) => k + 1));
    await flushMicrotasks();

    // No timer advanced: the fetch started with the bump itself.
    expect(api.listTree).toHaveBeenCalledTimes(2);
  });

  it('a burst of 50 invalidations within 100 ms costs at most 3 fetches and ends on the last response', async () => {
    answerWithVersions(30);
    const { result, rerender } = await renderLoaded();
    expect(api.listTree).toHaveBeenCalledTimes(1);

    // Both triggers, as the realtime bridge fires them: library events bump
    // `reloadKey`, the dashboard's tree-event handler bumps `refreshNonce`.
    let nonce = 0;
    for (let i = 0; i < 50; i += 1) {
      if (i % 2 === 0) act(() => result.current.setReloadKey((k) => k + 1));
      else rerender({ refreshNonce: (nonce += 1) });
      await advance(2);
    }
    await advance(1000);

    const fetches = api.listTree.mock.calls.length;
    expect(fetches).toBeLessThanOrEqual(3);
    expect(titleOf(result.current.roots)).toBe(`Version ${fetches}`);
    expect(result.current.error).toBeNull();
  });

  it('keeps slow fetches single-flight through a burst and applies each response', async () => {
    answerWithVersions(400);
    const { result } = await renderLoaded();

    for (let i = 0; i < 50; i += 1) {
      act(() => result.current.setReloadKey((k) => k + 1));
      await advance(2);
    }
    // The burst's first fetch is still in flight: nothing else started.
    expect(api.listTree).toHaveBeenCalledTimes(2);

    await advance(400);
    // Its response landed (not discarded as stale) and one follow-up runs.
    expect(titleOf(result.current.roots)).toBe('Version 2');
    expect(api.listTree).toHaveBeenCalledTimes(3);

    await advance(1000);
    expect(api.listTree).toHaveBeenCalledTimes(3);
    expect(titleOf(result.current.roots)).toBe('Version 3');
  });

  it('runs exactly one follow-up for invalidations that arrive while a fetch is in flight', async () => {
    api.listTree.mockResolvedValueOnce([doc('Version 1')]);
    const { result, rerender } = await renderLoaded();
    const second = deferred<LibraryTreeChild[]>();
    const third = deferred<LibraryTreeChild[]>();
    api.listTree.mockReturnValueOnce(second.promise).mockReturnValueOnce(third.promise);

    act(() => result.current.setReloadKey((k) => k + 1));
    await flushMicrotasks();
    expect(api.listTree).toHaveBeenCalledTimes(2);
    act(() => result.current.setReloadKey((k) => k + 1));
    rerender({ refreshNonce: 1 });
    act(() => result.current.setReloadKey((k) => k + 1));
    await advance(1000);
    expect(api.listTree).toHaveBeenCalledTimes(2);

    await act(async () => second.resolve([doc('Version 2')]));
    expect(titleOf(result.current.roots)).toBe('Version 2');
    await advance(GAP_MS);
    expect(api.listTree).toHaveBeenCalledTimes(3);

    await act(async () => third.resolve([doc('Version 3')]));
    await advance(1000);
    expect(api.listTree).toHaveBeenCalledTimes(3);
    expect(titleOf(result.current.roots)).toBe('Version 3');
  });

  it('sets aside a response that predates a patch made while it was in flight, then lands the follow-up', async () => {
    api.listTree.mockResolvedValueOnce([doc('Version 1')]);
    const { result } = await renderLoaded();
    const stale = deferred<LibraryTreeChild[]>();
    const fresh = deferred<LibraryTreeChild[]>();
    api.listTree.mockReturnValueOnce(stale.promise).mockReturnValueOnce(fresh.promise);

    act(() => result.current.setReloadKey((k) => k + 1));
    await flushMicrotasks();
    expect(api.listTree).toHaveBeenCalledTimes(2);
    // An optimistic patch (a rename, say) after that fetch started.
    act(() => result.current.setRoots([doc('Patched')]));

    await act(async () => stale.resolve([doc('Version 2')]));
    expect(titleOf(result.current.roots)).toBe('Patched');

    await advance(GAP_MS);
    expect(api.listTree).toHaveBeenCalledTimes(3);
    await act(async () => fresh.resolve([doc('Version 3')]));
    expect(titleOf(result.current.roots)).toBe('Version 3');
    await advance(1000);
    expect(api.listTree).toHaveBeenCalledTimes(3);
  });

  it('keeps the loaded tree and reports the error when a refetch fails', async () => {
    api.listTree
      .mockResolvedValueOnce([doc('Version 1')])
      .mockRejectedValueOnce(new Error('Server unreachable'))
      .mockResolvedValueOnce([doc('Version 3')]);
    const { result, rerender } = await renderLoaded();

    rerender({ refreshNonce: 1 });
    await advance(0);
    expect(titleOf(result.current.roots)).toBe('Version 1');
    expect(result.current.error).toBe('Server unreachable');

    await advance(1000);
    rerender({ refreshNonce: 2 });
    await advance(0);
    expect(titleOf(result.current.roots)).toBe('Version 3');
    expect(result.current.error).toBeNull();
  });

  it('leaves roots null when the first load fails', async () => {
    api.listTree.mockRejectedValueOnce(new Error('Server unreachable'));

    const { result } = renderRoots();
    await advance(0);

    expect(result.current.roots).toBeNull();
    expect(result.current.error).toBe('Server unreachable');
  });

  it('cancels a pending refetch on unmount', async () => {
    api.listTree.mockResolvedValue([doc('Version 1')]);
    const { result, unmount } = await renderLoaded();

    act(() => result.current.setReloadKey((k) => k + 1));
    await advance(0);
    act(() => result.current.setReloadKey((k) => k + 1));
    // The second bump waits out the gap on a timer.
    expect(api.listTree).toHaveBeenCalledTimes(2);

    unmount();
    expect(vi.getTimerCount()).toBe(0);
    await advance(1000);
    expect(api.listTree).toHaveBeenCalledTimes(2);
  });

  it('ignores a response that lands after unmount and starts no follow-up', async () => {
    api.listTree.mockResolvedValueOnce([doc('Version 1')]);
    const { result, unmount } = await renderLoaded();
    const late = deferred<LibraryTreeChild[]>();
    api.listTree.mockReturnValueOnce(late.promise);

    act(() => result.current.setReloadKey((k) => k + 1));
    await flushMicrotasks();
    // Arrives while that fetch is in flight: a follow-up is queued.
    act(() => result.current.setReloadKey((k) => k + 1));
    expect(api.listTree).toHaveBeenCalledTimes(2);
    unmount();

    await act(async () => late.resolve([doc('Version 2')]));
    await advance(1000);
    expect(api.listTree).toHaveBeenCalledTimes(2);
    expect(titleOf(result.current.roots)).toBe('Version 1');
  });

  it('moves loadedReloadKey once per landed refetch, not once per reloadKey bump', async () => {
    answerWithVersions(30);
    const seen: number[] = [];
    const { result, rerender } = renderHook(
      ({ refreshNonce }: { refreshNonce: number }) => {
        const tree = useWorkspaceTreeRoots(refreshNonce);
        if (seen[seen.length - 1] !== tree.loadedReloadKey) seen.push(tree.loadedReloadKey);
        return tree;
      },
      { initialProps: { refreshNonce: 0 } }
    );
    await advance(1000);

    for (let i = 0; i < 20; i += 1) {
      act(() => result.current.setReloadKey((k) => k + 1));
      await advance(2);
    }
    await advance(1000);
    expect(result.current.reloadKey).toBe(20);
    expect(result.current.loadedReloadKey).toBe(20);
    expect(seen.length).toBeLessThanOrEqual(3);

    // A refetch only `refreshNonce` asked for leaves it where it is.
    rerender({ refreshNonce: 1 });
    await advance(1000);
    expect(result.current.loadedReloadKey).toBe(20);
  });
});

describe('useTreeLazyData behind the coalesced tree', () => {
  it('refetches the files of an expanded project once per landed tree refetch, not per event', async () => {
    let n = 0;
    api.listTree.mockImplementation(() => {
      n += 1;
      const reply: LibraryTreeChild[] = [project(`Test project ${n}`)];
      return new Promise<LibraryTreeChild[]>((resolve) => setTimeout(() => resolve(reply), 30));
    });
    const expanded = new Set([PROJECT_ID]);
    const { result } = renderHook(() => {
      const tree = useWorkspaceTreeRoots(0);
      const lazy = useTreeLazyData({
        roots: tree.roots,
        expanded,
        reloadKey: tree.loadedReloadKey,
      });
      return { tree, lazy };
    });
    await advance(1000);
    expect(api.listByProject).toHaveBeenCalledTimes(1);

    for (let i = 0; i < 20; i += 1) {
      act(() => result.current.tree.setReloadKey((k) => k + 1));
      await advance(2);
    }
    await advance(1000);

    const treeFetches = api.listTree.mock.calls.length;
    expect(treeFetches).toBeLessThanOrEqual(3);
    // The first load's backfill, then one per refetch that landed.
    expect(api.listByProject).toHaveBeenCalledTimes(treeFetches);
    expect(result.current.lazy.projectFiles.get(PROJECT_ID)).toEqual([]);
  });
});
