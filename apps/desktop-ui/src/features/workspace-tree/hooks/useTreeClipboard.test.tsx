import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import type { LibraryTreeChild } from '@desktop/utils/api';

// Mock fns must be created in a hoisted block — vi.mock factories are hoisted
// above module-level consts. The env stubs guard the config module (throws at
// import without them).
const { clone, showToast } = vi.hoisted(() => {
  vi.stubEnv('VITE_API_BASE_URL', '/api');
  vi.stubEnv('VITE_APP_NAME', 'Snaglet');
  return { clone: vi.fn(), showToast: vi.fn() };
});

vi.mock('@desktop/utils/api', () => ({ cloneApi: { clone } }));
vi.mock('@desktop/utils/toast', () => ({ showToast }));

import { useTreeClipboard, __clearClipboardForTests } from './useTreeClipboard';

// Minimal tree nodes — the hook only reads id/kind/parent + label fields.
const DOC = {
  kind: 'doc',
  id: 'doc-1',
  containerId: 'cont-parent',
  title: 'Note',
} as unknown as LibraryTreeChild;

const CONTAINER = {
  kind: 'container',
  id: 'cont-target',
  parentId: 'root',
  name: 'Target',
  children: [],
} as unknown as LibraryTreeChild;

const PROJECT = {
  kind: 'container',
  id: 'container-1111111111111-aaaaaaaaa',
  parentId: null,
  name: 'Test project',
  category: 'project',
  children: [],
} as unknown as LibraryTreeChild;

const OTHER_PROJECT = {
  kind: 'container',
  id: 'container-2222222222222-bbbbbbbbb',
  parentId: null,
  name: 'Other project',
  category: 'project',
  children: [],
} as unknown as LibraryTreeChild;

const THREAD = {
  kind: 'thread',
  id: 'thread-1111111111111-aaaaaaaaa',
  projectId: PROJECT.id,
  title: 'Planning chat',
} as unknown as LibraryTreeChild;

const nodeIndex = new Map<string, LibraryTreeChild>([
  [DOC.id, DOC],
  [CONTAINER.id, CONTAINER],
  [PROJECT.id, PROJECT],
  [OTHER_PROJECT.id, OTHER_PROJECT],
  [THREAD.id, THREAD],
]);

function press(key: string, target?: HTMLElement) {
  const evt = new KeyboardEvent('keydown', { key, metaKey: true, bubbles: true, cancelable: true });
  (target ?? window).dispatchEvent(evt);
}

function setup(overrides?: Partial<Parameters<typeof useTreeClipboard>[0]>) {
  const setReloadKey = vi.fn();
  const setError = vi.fn();
  const props = {
    selectedIds: new Set<string>(),
    selectionAnchorId: null as string | null,
    nodeIndex,
    setReloadKey,
    setError,
    ...overrides,
  };
  const view = renderHook((p: Parameters<typeof useTreeClipboard>[0]) => useTreeClipboard(p), {
    initialProps: props,
  });
  return { view, setReloadKey, setError, props };
}

beforeEach(() => {
  vi.clearAllMocks();
  // The clipboard stash is module-level (shared across every mounted
  // instance) — reset it so one test's copy can't leak into the next.
  __clearClipboardForTests();
  clone.mockResolvedValue({
    root: { id: 'doc-new', kind: 'doc', title: 'Note (1)', parentId: 'cont-target', sortKey: '2' },
    count: 1,
  });
});

describe('useTreeClipboard', () => {
  it('leaves shortcuts already handled by an editor alone', () => {
    setup({ selectedIds: new Set(['doc-1']), selectionAnchorId: 'doc-1' });
    press('c');
    showToast.mockClear();
    for (const key of ['c', 'v']) {
      const event = new KeyboardEvent('keydown', { key, metaKey: true, cancelable: true });
      event.preventDefault();
      window.dispatchEvent(event);
    }
    expect(showToast).not.toHaveBeenCalled();
    expect(clone).not.toHaveBeenCalled();
  });
  it('Cmd+C copies the selected node and toasts, without hitting the API', () => {
    setup({ selectedIds: new Set(['doc-1']), selectionAnchorId: 'doc-1' });
    press('c');
    expect(clone).not.toHaveBeenCalled();
    expect(showToast).toHaveBeenCalledWith('"Note" copied');
  });

  it('Cmd+V pastes the copied node into the selected container', async () => {
    const { view, setReloadKey, setError } = setup({
      selectedIds: new Set(['doc-1']),
      selectionAnchorId: 'doc-1',
    });
    press('c');
    // Now select the container as the paste target.
    view.rerender({
      selectedIds: new Set(['cont-target']),
      selectionAnchorId: 'cont-target',
      nodeIndex,
      setReloadKey,
      setError,
    });
    press('v');
    await waitFor(() => expect(clone).toHaveBeenCalledTimes(1));
    expect(clone).toHaveBeenCalledWith({ sourceId: 'doc-1', targetContainerId: 'cont-target' });
    await waitFor(() => expect(showToast).toHaveBeenCalledWith('"Note (1)" pasted'));
    expect(setReloadKey).toHaveBeenCalled();
  });

  it('Cmd+V with nothing selected falls back to the copied node’s parent', async () => {
    const { view, setReloadKey, setError } = setup({
      selectedIds: new Set(['doc-1']),
      selectionAnchorId: 'doc-1',
    });
    press('c');
    view.rerender({
      selectedIds: new Set<string>(),
      selectionAnchorId: null,
      nodeIndex,
      setReloadKey,
      setError,
    });
    press('v');
    await waitFor(() => expect(clone).toHaveBeenCalledTimes(1));
    expect(clone).toHaveBeenCalledWith({ sourceId: 'doc-1', targetContainerId: 'cont-parent' });
  });

  it('Cmd+V with an empty clipboard is a no-op', () => {
    setup({ selectedIds: new Set(['cont-target']), selectionAnchorId: 'cont-target' });
    press('v');
    expect(clone).not.toHaveBeenCalled();
  });

  it('ignores Cmd+C while focus is in a text input (native copy wins)', () => {
    setup({ selectedIds: new Set(['doc-1']), selectionAnchorId: 'doc-1' });
    const input = document.createElement('input');
    document.body.appendChild(input);
    press('c', input);
    expect(showToast).not.toHaveBeenCalled();
    input.remove();
  });

  it('does nothing on Cmd+C when the selection is empty (native copy wins)', () => {
    setup({ selectedIds: new Set<string>(), selectionAnchorId: null });
    press('c');
    expect(showToast).not.toHaveBeenCalled();
  });

  it('ignores Cmd+C when document text is highlighted, even with a tree node selected (native copy wins)', () => {
    setup({ selectedIds: new Set(['doc-1']), selectionAnchorId: 'doc-1' });
    // Highlight text inside a rendered (non-editable) element — a doc viewer,
    // thread message, etc. The tree copy must yield to the browser's copy.
    const viewer = document.createElement('div');
    viewer.textContent = 'some rendered doc text';
    document.body.appendChild(viewer);
    const range = document.createRange();
    range.selectNodeContents(viewer);
    const sel = window.getSelection();
    sel?.removeAllRanges();
    sel?.addRange(range);
    try {
      press('c', viewer);
      expect(showToast).not.toHaveBeenCalled();

      // Once the highlight is cleared, the same keystroke copies the tree node again.
      sel?.removeAllRanges();
      press('c', viewer);
      expect(showToast).toHaveBeenCalledWith('"Note" copied');
    } finally {
      sel?.removeAllRanges();
      viewer.remove();
    }
  });

  // Context-menu helpers: the same stash/clone path as the keyboard
  // gesture, but targeted at an explicitly right-clicked node.
  describe('context-menu helpers', () => {
    it('copyNode stashes an arbitrary node (independent of selection) and toasts', async () => {
      const { view } = setup();
      view.result.current.copyNode(DOC);
      expect(clone).not.toHaveBeenCalled();
      expect(showToast).toHaveBeenCalledWith('"Note" copied');
      await waitFor(() => expect(view.result.current.canPaste).toBe(true));
    });

    it('copyNode refuses an image (not cloneable)', () => {
      const IMAGE = { kind: 'image', id: 'img-1', name: 'Pic' } as unknown as LibraryTreeChild;
      const { view } = setup();
      const ok = view.result.current.copyNode(IMAGE);
      expect(ok).toBe(false);
      expect(view.result.current.canPaste).toBe(false);
    });

    it('duplicateNode clones beside the original (into its parent) without stashing', async () => {
      const { view } = setup();
      await view.result.current.duplicateNode(DOC);
      expect(clone).toHaveBeenCalledWith({ sourceId: 'doc-1', targetContainerId: 'cont-parent' });
      expect(view.result.current.canPaste).toBe(false); // no stash
      await waitFor(() => expect(showToast).toHaveBeenCalledWith('"Note (1)" duplicated'));
    });

    it('pasteRelativeTo a container pastes INTO it', async () => {
      const { view } = setup();
      view.result.current.copyNode(DOC);
      await view.result.current.pasteRelativeTo(CONTAINER);
      expect(clone).toHaveBeenCalledWith({ sourceId: 'doc-1', targetContainerId: 'cont-target' });
    });

    it('pasteRelativeTo a doc pastes beside it (into its parent)', async () => {
      const { view } = setup();
      view.result.current.copyNode(CONTAINER);
      await view.result.current.pasteRelativeTo(DOC);
      expect(clone).toHaveBeenCalledWith({
        sourceId: 'cont-target',
        targetContainerId: 'cont-parent',
      });
    });
  });

  // Cross-surface sharing: the tree sidebar and ContainerView each mount
  // their own hook instance; a copy in one must be pasteable in the other.
  describe('shared clipboard across instances', () => {
    it('copying in one instance flips canPaste in another, and that instance can paste it', async () => {
      const { view: tree } = setup();
      const { view: containerView } = setup();
      expect(containerView.result.current.canPaste).toBe(false);

      tree.result.current.copyNode(DOC);
      await waitFor(() => expect(containerView.result.current.canPaste).toBe(true));

      await containerView.result.current.pasteRelativeTo(CONTAINER);
      expect(clone).toHaveBeenCalledWith({ sourceId: 'doc-1', targetContainerId: 'cont-target' });
    });
  });
  describe('thread paste targets a project scope', () => {
    it('pastes a copied thread into its own project when the anchor is a plain folder', async () => {
      const { view } = setup();
      view.result.current.copyNode(THREAD);
      await view.result.current.pasteRelativeTo(CONTAINER);
      expect(clone).toHaveBeenCalledWith({ sourceId: THREAD.id, targetContainerId: PROJECT.id });
    });

    it('pastes a copied thread into the anchored project', async () => {
      const { view } = setup();
      view.result.current.copyNode(THREAD);
      await view.result.current.pasteRelativeTo(OTHER_PROJECT);
      expect(clone).toHaveBeenCalledWith({
        sourceId: THREAD.id,
        targetContainerId: OTHER_PROJECT.id,
      });
    });

    it('Cmd+V with a folder selected still keeps a thread in its project', async () => {
      const { view } = setup({
        selectedIds: new Set([CONTAINER.id]),
        selectionAnchorId: CONTAINER.id,
      });
      view.result.current.copyNode(THREAD);
      press('v');
      await waitFor(() =>
        expect(clone).toHaveBeenCalledWith({ sourceId: THREAD.id, targetContainerId: PROJECT.id })
      );
    });

    it('duplicates a thread beside itself in the same project', async () => {
      const { view } = setup();
      await view.result.current.duplicateNode(THREAD);
      expect(clone).toHaveBeenCalledWith({ sourceId: THREAD.id, targetContainerId: PROJECT.id });
    });
  });
});
