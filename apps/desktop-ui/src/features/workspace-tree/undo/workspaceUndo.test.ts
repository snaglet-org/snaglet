import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LibraryTreeChild } from '@desktop/utils/api';
import {
  applyNodeMoveToTree,
  onLibraryEvent,
  type LibraryEvent,
} from '@desktop/utils/workspaceEvents';
import { TOAST_EVENT_NAME, type ToastDetail } from '@desktop/utils/toast';
import {
  __resetWorkspaceUndoForTests,
  __workspaceUndoDepthsForTests,
  canRedo,
  canUndo,
  recordCreate,
  recordMove,
  redoLast,
  undoLast,
  type UndoMoveItem,
} from './workspaceUndo';

const containerUpdate = vi.fn();
const containerGet = vi.fn();
const docUpdate = vi.fn();
const threadSetPlacement = vi.fn();
const imageMove = vi.fn();
const archiveNode = vi.fn();
const restoreNode = vi.fn();

vi.mock('@desktop/utils/api', () => ({
  containersApi: {
    update: (...args: unknown[]) => containerUpdate(...args),
    get: (...args: unknown[]) => containerGet(...args),
  },
  docsApi: { update: (...args: unknown[]) => docUpdate(...args) },
  threadsApi: { setPlacement: (...args: unknown[]) => threadSetPlacement(...args) },
  imagesApi: { move: (...args: unknown[]) => imageMove(...args) },
  archiveApi: {
    archive: (...args: unknown[]) => archiveNode(...args),
    restore: (...args: unknown[]) => restoreNode(...args),
  },
}));

let events: LibraryEvent[] = [];
let toasts: string[] = [];
let unsubscribe: (() => void) | null = null;

const onToast = (e: Event) => {
  toasts.push((e as CustomEvent<ToastDetail>).detail.message);
};

const eventTypes = () => events.map((e) => e.type);

const moveItem = (over: Partial<UndoMoveItem> = {}): UndoMoveItem => ({
  id: 'doc-1',
  kind: 'doc',
  label: 'Spec',
  from: { parentId: 'folder-a', sortOrder: 2 },
  to: { parentId: 'folder-b', sortOrder: undefined },
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  __resetWorkspaceUndoForTests();
  events = [];
  toasts = [];
  unsubscribe = onLibraryEvent((e) => events.push(e));
  window.addEventListener(TOAST_EVENT_NAME, onToast);
  containerGet.mockResolvedValue({ archived: false });
  containerUpdate.mockResolvedValue({});
  docUpdate.mockResolvedValue({});
  threadSetPlacement.mockResolvedValue({});
  imageMove.mockResolvedValue({});
  archiveNode.mockResolvedValue({});
  restoreNode.mockResolvedValue({});
});

afterEach(() => {
  unsubscribe?.();
  window.removeEventListener(TOAST_EVENT_NAME, onToast);
});

describe('workspaceUndo — move replay', () => {
  it('undoes a reparent back to the exact prior parent + slot, then redoes it', async () => {
    recordMove([moveItem()]);
    expect(canUndo()).toBe(true);

    await undoLast();
    expect(docUpdate).toHaveBeenCalledWith('doc-1', { containerId: 'folder-a', sortOrder: 2 });
    expect(eventTypes()).toEqual(['node-moved', 'tree-invalidated']);
    expect(events[0]).toMatchObject({ id: 'doc-1', parentId: 'folder-a', sortOrder: 2 });
    expect(canUndo()).toBe(false);
    expect(canRedo()).toBe(true);

    await redoLast();
    // Redo re-applies the original append (no positional intent).
    expect(docUpdate).toHaveBeenLastCalledWith('doc-1', { containerId: 'folder-b' });
    expect(canUndo()).toBe(true);
    expect(canRedo()).toBe(false);
  });

  it('undoes a same-parent reorder to the prior slot, then redoes it', async () => {
    recordMove([
      moveItem({
        id: 'box-1',
        kind: 'container',
        from: { parentId: 'folder-a', sortOrder: 1 },
        to: { parentId: 'folder-a', sortOrder: 4 },
      }),
    ]);

    await undoLast();
    expect(containerUpdate).toHaveBeenCalledWith('box-1', { parentId: 'folder-a', sortOrder: 1 });

    await redoLast();
    expect(containerUpdate).toHaveBeenLastCalledWith('box-1', {
      parentId: 'folder-a',
      sortOrder: 4,
    });
  });

  it('undoes a thread move by re-attaching it to its prior project, then redoes it', async () => {
    recordMove([
      moveItem({
        id: 'thread-1111111111111-aaaaaaaaa',
        kind: 'thread',
        label: 'Planning chat',
        from: { parentId: 'container-1111111111111-aaaaaaaaa', sortOrder: 0 },
        to: { parentId: 'container-2222222222222-bbbbbbbbb', sortOrder: undefined },
      }),
    ]);

    await undoLast();
    // The prior project is probed like any destination container, then the
    // thread goes back to its old slot there — never a container or doc write.
    expect(containerGet).toHaveBeenCalledWith('container-1111111111111-aaaaaaaaa');
    expect(threadSetPlacement).toHaveBeenCalledWith('thread-1111111111111-aaaaaaaaa', {
      projectId: 'container-1111111111111-aaaaaaaaa',
      sortOrder: 0,
    });
    expect(docUpdate).not.toHaveBeenCalled();
    expect(events[0]).toMatchObject({
      type: 'node-moved',
      kind: 'thread',
      parentId: 'container-1111111111111-aaaaaaaaa',
    });

    await redoLast();
    expect(threadSetPlacement).toHaveBeenLastCalledWith('thread-1111111111111-aaaaaaaaa', {
      projectId: 'container-2222222222222-bbbbbbbbb',
    });
  });

  it('undoes a thread made flat back into its project, and names the project when it is gone', async () => {
    recordMove([
      moveItem({
        id: 'thread-1111111111111-aaaaaaaaa',
        kind: 'thread',
        from: { parentId: 'container-1111111111111-aaaaaaaaa', sortOrder: 0 },
        to: { parentId: null, sortOrder: undefined },
      }),
    ]);
    containerGet.mockResolvedValue({ archived: true });

    await undoLast();
    expect(threadSetPlacement).not.toHaveBeenCalled();
    expect(toasts).toEqual(["Couldn't undo — the project it was in is gone"]);
  });

  it('fails cleanly on a stale undo target without touching sort_order', async () => {
    containerGet.mockResolvedValue({ archived: true });
    recordMove([moveItem()]);

    await undoLast();
    expect(docUpdate).not.toHaveBeenCalled();
    // Optimistic apply happened, then the rollback refetch.
    expect(eventTypes()).toEqual(['node-moved', 'tree-invalidated']);
    expect(toasts).toEqual(["Couldn't undo — the container it was in is gone"]);
    // The failed entry is dropped from both stacks.
    expect(canUndo()).toBe(false);
    expect(canRedo()).toBe(false);
  });

  it('rolls back to server truth and toasts when the server rejects the move', async () => {
    docUpdate.mockRejectedValue(new Error('nope'));
    recordMove([moveItem()]);

    await undoLast();
    expect(eventTypes()).toEqual(['node-moved', 'tree-invalidated']);
    expect(toasts).toEqual(["Couldn't undo — nope"]);
    expect(canRedo()).toBe(false);
  });

  it('serializes replays so rapid repeats cannot double-run', async () => {
    let resolveUpdate!: () => void;
    docUpdate.mockImplementation(() => new Promise<void>((res) => (resolveUpdate = res)));
    recordMove([moveItem({ id: 'doc-a' })]);
    recordMove([moveItem({ id: 'doc-b' })]);

    const first = undoLast();
    const second = undoLast(); // in-flight guard: must not pop the next entry
    await second;
    expect(__workspaceUndoDepthsForTests().undo).toBe(1);

    await vi.waitFor(() => expect(docUpdate).toHaveBeenCalledTimes(1));
    resolveUpdate();
    await first;
    expect(docUpdate).toHaveBeenCalledTimes(1);
    expect(__workspaceUndoDepthsForTests()).toEqual({ undo: 1, redo: 1 });
  });
});

describe('workspaceUndo — create replay', () => {
  it('archives a created node on undo and restores it on redo', async () => {
    recordCreate({ id: 'doc-9', kind: 'doc', label: 'Notes', parentId: 'folder-a' });

    await undoLast();
    expect(archiveNode).toHaveBeenCalledWith('doc-9');
    expect(events[0]).toMatchObject({ type: 'archive-changed', ids: ['doc-9'] });

    await redoLast();
    // Restore only after confirming the original parent still exists.
    expect(containerGet).toHaveBeenCalledWith('folder-a');
    expect(restoreNode).toHaveBeenCalledWith('doc-9');
    expect(events[events.length - 1]).toMatchObject({
      type: 'archive-changed',
      ids: ['doc-9'],
      reload: true,
    });
    expect(canUndo()).toBe(true);
  });

  it('skips the parent probe for a root-level create on redo', async () => {
    recordCreate({ id: 'box-9', kind: 'container', label: 'Scratch', parentId: null });
    await undoLast();
    await redoLast();
    expect(containerGet).not.toHaveBeenCalled();
    expect(restoreNode).toHaveBeenCalledWith('box-9');
  });

  it('refuses redo-create into a parent that is gone', async () => {
    containerGet.mockRejectedValue(new Error('HTTP 404'));
    recordCreate({ id: 'doc-9', kind: 'doc', label: 'Notes', parentId: 'folder-a' });
    await undoLast();

    await redoLast();
    expect(restoreNode).not.toHaveBeenCalled();
    expect(toasts[toasts.length - 1]).toContain("Couldn't redo");
    expect(canRedo()).toBe(false);
  });

  it('rolls back the optimistic prune when the archive call fails', async () => {
    archiveNode.mockRejectedValue(new Error('locked'));
    recordCreate({ id: 'doc-9', kind: 'doc', label: 'Notes', parentId: null });

    await undoLast();
    expect(eventTypes()).toEqual(['archive-changed', 'tree-invalidated']);
    expect(toasts).toEqual(["Couldn't undo — locked"]);
    expect(canRedo()).toBe(false);
  });
});

describe('workspaceUndo — stack discipline', () => {
  it('clears the redo stack when a fresh action lands', async () => {
    recordMove([moveItem({ id: 'doc-a' })]);
    await undoLast();
    expect(canRedo()).toBe(true);

    recordMove([moveItem({ id: 'doc-b' })]);
    expect(canRedo()).toBe(false);

    await redoLast();
    expect(docUpdate).toHaveBeenCalledTimes(1); // only the undo ran
  });

  it('keeps the rest of the redo stack across a redo', async () => {
    recordMove([moveItem({ id: 'doc-a' })]);
    recordMove([moveItem({ id: 'doc-b' })]);
    await undoLast();
    await undoLast();
    expect(__workspaceUndoDepthsForTests()).toEqual({ undo: 0, redo: 2 });

    await redoLast();
    expect(__workspaceUndoDepthsForTests()).toEqual({ undo: 1, redo: 1 });
  });

  it('bounds the undo stack at 100 actions, evicting the oldest first', async () => {
    for (let i = 0; i < 101; i++) {
      recordMove([moveItem({ id: `doc-${i}` })]);
    }
    expect(__workspaceUndoDepthsForTests().undo).toBe(100);

    // Drain the stack: the newest entry comes back first and the very first
    // recorded move (doc-0) is the one that fell off.
    for (let i = 100; i >= 1; i--) {
      await undoLast();
      expect(docUpdate).toHaveBeenLastCalledWith(`doc-${i}`, expect.anything());
    }
    expect(canUndo()).toBe(false);
    expect(docUpdate).not.toHaveBeenCalledWith('doc-0', expect.anything());
  });
});

describe('applyNodeMoveToTree', () => {
  const doc = (id: string, containerId: string | null, sortOrder: number): LibraryTreeChild =>
    ({
      kind: 'doc',
      id,
      title: id,
      content: '',
      containerId,
      sortOrder,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    }) as LibraryTreeChild;

  const box = (
    id: string,
    parentId: string | null,
    sortOrder: number,
    children: LibraryTreeChild[] = []
  ): LibraryTreeChild =>
    ({
      kind: 'container',
      id,
      name: id,
      parentId,
      children,
      sortOrder,
      category: null,
      folderPath: null,
      githubUrl: null,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    }) as LibraryTreeChild;

  it('reorders within the same parent', () => {
    const tree = [box('a', null, 0, [doc('d1', 'a', 0), doc('d2', 'a', 1), doc('d3', 'a', 2)])];
    const next = applyNodeMoveToTree(tree, { id: 'd3', parentId: 'a', sortOrder: 0 });
    const a = next[0];
    expect(a.kind === 'container' && a.children.map((c) => c.id)).toEqual(['d3', 'd1', 'd2']);
  });

  it('reparents into another container and stamps the node fields', () => {
    const tree = [box('a', null, 0, [doc('d1', 'a', 0)]), box('b', null, 1)];
    const next = applyNodeMoveToTree(tree, { id: 'd1', parentId: 'b', sortOrder: 0 });
    const [a, b] = next;
    expect(a.kind === 'container' && a.children).toHaveLength(0);
    expect(b.kind === 'container' && b.children.map((c) => c.id)).toEqual(['d1']);
    const moved = b.kind === 'container' ? b.children[0] : null;
    expect(moved).toMatchObject({ containerId: 'b', sortOrder: 0 });
  });

  it('detaches only when the destination is outside this tree', () => {
    const tree = [box('a', null, 0, [doc('d1', 'a', 0)])];
    const next = applyNodeMoveToTree(tree, { id: 'd1', parentId: 'elsewhere' });
    const a = next[0];
    expect(a.kind === 'container' && a.children).toHaveLength(0);
  });

  it('returns the tree unchanged when the node is unknown and no snapshot is given', () => {
    const tree = [box('a', null, 0)];
    expect(applyNodeMoveToTree(tree, { id: 'ghost', parentId: 'a' })).toBe(tree);
  });

  it('inserts from the snapshot when the tree no longer holds the node', () => {
    const tree = [box('a', null, 0)];
    const next = applyNodeMoveToTree(tree, {
      id: 'd1',
      parentId: 'a',
      sortOrder: 0,
      node: doc('d1', 'elsewhere', 3),
    });
    const a = next[0];
    expect(a.kind === 'container' && a.children.map((c) => c.id)).toEqual(['d1']);
  });

  it('moves a thread between projects by stamping projectId, not a folder placement', () => {
    const thread = {
      kind: 'thread',
      id: 'thread-1111111111111-aaaaaaaaa',
      projectId: 'a',
      title: 'Planning chat',
      sortOrder: 0,
      lastMessageAt: null,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: null,
    } as LibraryTreeChild;
    const tree = [box('a', null, 0, [thread]), box('b', null, 1)];
    const next = applyNodeMoveToTree(tree, { id: thread.id, parentId: 'b' });
    const [a, b] = next;
    expect(a.kind === 'container' && a.children).toHaveLength(0);
    expect(b.kind === 'container' && b.children[0]).toMatchObject({
      kind: 'thread',
      projectId: 'b',
    });
  });

  it('moves a thread to the root when it goes flat', () => {
    const thread = {
      kind: 'thread',
      id: 'thread-1111111111111-aaaaaaaaa',
      projectId: 'a',
      title: 'Planning chat',
      sortOrder: 0,
    } as LibraryTreeChild;
    const next = applyNodeMoveToTree([box('a', null, 0, [thread])], {
      id: thread.id,
      parentId: null,
    });
    expect(next.map((n) => n.id)).toEqual(['a', thread.id]);
    expect(next[1]).toMatchObject({ projectId: null });
  });

  it('treats rootParentId as the top level (ContainerView panes)', () => {
    const children = [doc('d1', 'pane', 0), box('sub', 'pane', 1)];
    const next = applyNodeMoveToTree(
      children,
      { id: 'd1', parentId: 'pane', sortOrder: 2 },
      { rootParentId: 'pane' }
    );
    expect(next.map((c) => c.id)).toEqual(['sub', 'd1']);
    expect(next[1]).toMatchObject({ containerId: 'pane', sortOrder: 2 });
  });
});
