import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useState } from 'react';
import { act, renderHook, waitFor } from '@testing-library/react';

const archiveCounts = vi.hoisted(() => vi.fn());
const listTree = vi.hoisted(() => vi.fn());

vi.mock('@desktop/utils/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@desktop/utils/api')>();
  return {
    ...actual,
    archiveApi: { ...actual.archiveApi, counts: (id: string) => archiveCounts(id) },
    containersApi: { ...actual.containersApi, listTree: () => listTree() },
  };
});
import type {
  ContainerTreeNode,
  DocTreeNode,
  ImageTreeNode,
  ThreadTreeNode,
} from '@desktop/utils/api';
import { applyWorkspaceEventToSelection } from './useWorkspaceEventSync';
import { useRemovedNodeSync, useWorkspaceEventSync } from './useWorkspaceEventSync';
import { emitLibraryEvent } from '@desktop/utils/workspaceEvents';
import {
  createLeaf,
  findLeaf,
  leafIds,
  replaceLeafSelection,
  splitLeaf,
  type LayoutNode,
} from '../layout/paneTree';

const timestamp = '2026-07-29T12:00:00.000Z';

function doc(content = 'before'): DocTreeNode {
  return {
    kind: 'doc',
    id: 'doc-1',
    containerId: 'container-1',
    title: 'Document',
    content,
    sortOrder: 0,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

function thread(title = 'Before'): ThreadTreeNode {
  return {
    kind: 'thread',
    id: 'thread-1',
    projectId: null,
    title,
    sortOrder: 0,
    lastMessageAt: null,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

function image(): ImageTreeNode {
  return {
    kind: 'image',
    id: 'image-1',
    containerId: null,
    name: 'Chart',
    description: null,
    tags: [],
    mimeType: 'image/png',
    sizeBytes: 10,
    sortOrder: 0,
    url: '/api/images/image-1/content',
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

describe('applyWorkspaceEventToSelection', () => {
  it('updates an open document body and preserves its navigation focus', () => {
    const selection = {
      kind: 'doc' as const,
      doc_id: 'doc-1',
      node: doc(),
      focusMessageId: 'message-1',
    };

    const updated = applyWorkspaceEventToSelection(selection, {
      type: 'doc-saved',
      id: 'doc-1',
      content: 'after',
      updatedAt: '2026-07-29T12:01:00.000Z',
    });

    expect(updated).toMatchObject({
      kind: 'doc',
      doc_id: 'doc-1',
      focusMessageId: 'message-1',
      node: {
        content: 'after',
        updatedAt: '2026-07-29T12:01:00.000Z',
      },
    });
  });

  it('updates a thread title without dropping its focused agent', () => {
    const updated = applyWorkspaceEventToSelection(
      {
        kind: 'thread',
        thread_id: 'thread-1',
        node: thread(),
        focusAgentId: 'agent-1',
      },
      { type: 'renamed', kind: 'thread', id: 'thread-1', name: 'After' }
    );

    expect(updated).toMatchObject({
      kind: 'thread',
      focusAgentId: 'agent-1',
      node: { title: 'After' },
    });
  });

  it('patches a document cached inside an open container', () => {
    const container: ContainerTreeNode = {
      kind: 'container',
      id: 'container-1',
      parentId: null,
      name: 'Research',
      sortOrder: 0,
      category: null,
      folderPath: null,
      githubUrl: null,
      createdAt: timestamp,
      updatedAt: timestamp,
      children: [doc()],
    };

    const updated = applyWorkspaceEventToSelection(
      { kind: 'container', container_id: container.id, node: container },
      { type: 'doc-saved', id: 'doc-1', content: 'agent edit' }
    );

    expect(updated?.kind).toBe('container');
    if (!updated || updated.kind !== 'container') return;
    expect(updated.node?.children[0]).toMatchObject({ kind: 'doc', content: 'agent edit' });
  });

  it('updates image metadata from realtime workspace events', () => {
    const updated = applyWorkspaceEventToSelection(
      { kind: 'image', image_id: 'image-1', node: image() },
      {
        type: 'image-metadata-saved',
        id: 'image-1',
        description: 'Updated description',
        tags: ['chart', 'research'],
        updatedAt: '2026-07-29T12:02:00.000Z',
      }
    );

    expect(updated).toMatchObject({
      kind: 'image',
      node: {
        description: 'Updated description',
        tags: ['chart', 'research'],
        updatedAt: '2026-07-29T12:02:00.000Z',
      },
    });
  });

  it('renames an open image', () => {
    const updated = applyWorkspaceEventToSelection(
      { kind: 'image', image_id: 'image-1', node: image() },
      { type: 'renamed', kind: 'image', id: 'image-1', name: 'Sunset' }
    );
    expect(updated).toMatchObject({ kind: 'image', node: { name: 'Sunset' } });
  });

  it('follows a renamed file in a pane opened by path, whose id is the path', () => {
    const updated = applyWorkspaceEventToSelection(
      {
        kind: 'file',
        node: {
          kind: 'file',
          id: '/tmp/test-project/photo.png',
          containerId: null,
          projectId: '',
          relativePath: '/tmp/test-project/photo.png',
          name: 'photo.png',
          absolutePath: '/tmp/test-project/photo.png',
          sizeBytes: 0,
          updatedAt: '',
        },
      },
      {
        type: 'file-renamed',
        fromPath: '/tmp/test-project/photo.png',
        toPath: '/tmp/test-project/Sunset.png',
        name: 'Sunset.png',
      }
    );
    expect(updated).toMatchObject({
      node: {
        id: '/tmp/test-project/Sunset.png',
        relativePath: '/tmp/test-project/Sunset.png',
        absolutePath: '/tmp/test-project/Sunset.png',
        name: 'Sunset.png',
      },
    });
  });

  it('leaves a pane showing another file as it is', () => {
    const selection = {
      kind: 'file' as const,
      node: {
        kind: 'file' as const,
        id: '/tmp/test-project/other.png',
        containerId: null,
        projectId: '',
        relativePath: '/tmp/test-project/other.png',
        name: 'other.png',
        absolutePath: '/tmp/test-project/other.png',
        sizeBytes: 0,
        updatedAt: '',
      },
    };
    expect(
      applyWorkspaceEventToSelection(selection, {
        type: 'file-renamed',
        fromPath: '/tmp/test-project/photo.png',
        toPath: '/tmp/test-project/Sunset.png',
        name: 'Sunset.png',
      })
    ).toBe(selection);
  });

  it('returns the same selection for unrelated events', () => {
    const selection = { kind: 'doc' as const, doc_id: 'doc-1', node: doc() };
    expect(
      applyWorkspaceEventToSelection(selection, {
        type: 'doc-saved',
        id: 'another-doc',
        content: 'irrelevant',
      })
    ).toBe(selection);
  });
});

describe('useWorkspaceEventSync', () => {
  it('patches the visible pane and its back-navigation history from one event', () => {
    const initial = createLeaf({ kind: 'doc', doc_id: 'doc-1', node: doc() });
    const { result } = renderHook(() => {
      const [layout, setLayout] = useState<LayoutNode>(initial);
      useWorkspaceEventSync(setLayout);
      return layout;
    });

    act(() => {
      emitLibraryEvent({
        type: 'doc-saved',
        id: 'doc-1',
        content: 'updated by another actor',
        updatedAt: '2026-07-29T12:03:00.000Z',
      });
    });

    expect(result.current).toMatchObject({
      kind: 'leaf',
      selection: {
        kind: 'doc',
        node: { content: 'updated by another actor' },
      },
      history: {
        entries: [
          {
            kind: 'doc',
            node: { content: 'updated by another actor' },
          },
        ],
      },
    });
  });
});

describe('useRemovedNodeSync', () => {
  beforeEach(() => {
    archiveCounts.mockReset();
    listTree.mockReset();
    listTree.mockResolvedValue([]);
  });

  function renderSync(initial: LayoutNode) {
    return renderHook(() => {
      const [layout, setLayout] = useState<LayoutNode>(initial);
      useRemovedNodeSync(layout, setLayout);
      return layout;
    });
  }

  // A doc pane that later moved on to a thread, so the doc is a history entry.
  function docThenThread(): LayoutNode {
    const leaf = createLeaf({ kind: 'doc', doc_id: 'doc-1', node: doc() });
    return replaceLeafSelection(leaf, leaf.id, {
      kind: 'thread',
      thread_id: 'thread-1',
      node: thread(),
    });
  }

  it('drops a deleted item from the pane and its history so neither renders a stale copy', () => {
    const initial = createLeaf({ kind: 'doc', doc_id: 'doc-1', node: doc() });
    const { result } = renderSync(initial);

    act(() => emitLibraryEvent({ type: 'deleted', kind: 'doc', id: 'doc-1' }));

    expect(result.current).toMatchObject({
      selection: { kind: 'doc', doc_id: 'doc-1', node: undefined },
      history: { entries: [{ kind: 'doc', doc_id: 'doc-1', node: undefined }] },
    });
  });

  it('drops an archived item once the server confirms the archive', async () => {
    archiveCounts.mockResolvedValue({ node: { id: 'doc-1', archived: true }, counts: {} });
    const { result } = renderSync(docThenThread());

    act(() => emitLibraryEvent({ type: 'archive-changed', ids: ['doc-1'] }));

    await waitFor(() =>
      expect(result.current).toMatchObject({
        history: { entries: [{ kind: 'doc', node: undefined }, { kind: 'thread' }] },
      })
    );
    expect(archiveCounts).toHaveBeenCalledWith('doc-1');
  });

  it('keeps an item that only moved', async () => {
    archiveCounts.mockResolvedValue({ node: { id: 'doc-1', archived: false }, counts: {} });
    const initial = docThenThread();
    const { result } = renderSync(initial);

    act(() => emitLibraryEvent({ type: 'archive-changed', ids: ['doc-1'] }));

    await waitFor(() => expect(archiveCounts).toHaveBeenCalledTimes(1));
    await act(async () => {});
    expect(result.current).toBe(initial);
  });

  it('does not look up ids no pane shows', async () => {
    listTree.mockResolvedValue([doc()]);
    renderSync(createLeaf({ kind: 'doc', doc_id: 'doc-1', node: doc() }));

    act(() => emitLibraryEvent({ type: 'archive-changed', ids: ['doc-2'] }));

    await waitFor(() => expect(listTree).toHaveBeenCalledTimes(1));
    await act(async () => {});
    expect(archiveCounts).not.toHaveBeenCalled();
  });

  function docIn(id: string, containerId: string): DocTreeNode {
    return { ...doc(), id, containerId };
  }

  /** One pane per doc, side by side. */
  function panesOn(...docs: DocTreeNode[]): LayoutNode {
    const [first, ...rest] = docs;
    let layout: LayoutNode = createLeaf({ kind: 'doc', doc_id: first.id, node: first });
    for (const node of rest) {
      const ids = leafIds(layout);
      layout = splitLeaf(layout, ids[ids.length - 1], 'right', {
        kind: 'doc',
        doc_id: node.id,
        node,
      });
    }
    return layout;
  }

  function shownDocs(layout: LayoutNode) {
    return leafIds(layout).map((id) => {
      const selection = findLeaf(layout, id)?.selection;
      return selection?.kind === 'doc' ? { id: selection.doc_id, cached: !!selection.node } : null;
    });
  }

  it('drops items inside an archived folder, down to its grandchildren', async () => {
    // container-1 holds doc-1 and container-2, which holds doc-2.
    const child = docIn('doc-1', 'container-1');
    const grandchild = docIn('doc-2', 'container-2');
    const unrelated = docIn('doc-3', 'container-3');
    listTree.mockResolvedValue([unrelated]);
    archiveCounts.mockImplementation(async (id: string) => ({
      node: { id, archived: true },
      counts: {},
    }));
    const { result } = renderSync(panesOn(child, grandchild, unrelated));

    act(() => emitLibraryEvent({ type: 'archive-changed', ids: ['container-1'] }));

    await waitFor(() =>
      expect(shownDocs(result.current)).toEqual([
        { id: 'doc-1', cached: false },
        { id: 'doc-2', cached: false },
        { id: 'doc-3', cached: true },
      ])
    );
    expect(archiveCounts.mock.calls.map(([id]) => id).sort()).toEqual(['doc-1', 'doc-2']);
  });

  it('keeps an item the tree lacks when the server says it is live', async () => {
    archiveCounts.mockResolvedValue({ node: { id: 'doc-1', archived: false }, counts: {} });
    const initial = panesOn(doc());
    const { result } = renderSync(initial);

    act(() => emitLibraryEvent({ type: 'archive-changed', ids: ['container-1'] }));

    await waitFor(() => expect(archiveCounts).toHaveBeenCalledWith('doc-1'));
    await act(async () => {});
    expect(result.current).toBe(initial);
  });

  it('reads no tree for an event that names no node', () => {
    renderSync(panesOn(doc()));

    act(() => emitLibraryEvent({ type: 'archive-changed', ids: [], reload: true }));

    expect(listTree).not.toHaveBeenCalled();
    expect(archiveCounts).not.toHaveBeenCalled();
  });
});
