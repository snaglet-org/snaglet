import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { TableCatalogEntry } from '@snaglet/shared/types';
import type { ContainerTreeNode, DocTreeNode, LibraryTreeChild } from '@desktop/utils/api';
import { LAYOUT_STORAGE_KEY, LAYOUT_STORAGE_VERSION, PERSIST_DEBOUNCE_MS } from '../persistence';

const listTree = vi.fn<() => Promise<LibraryTreeChild[]>>();
const archiveCounts = vi.fn();
const cachedTable = vi.hoisted(() => vi.fn<(tableId: string) => TableCatalogEntry | null>());

vi.mock('@desktop/features/database/tableNameCache', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@desktop/features/database/tableNameCache')>()),
  getCachedTableEntry: (tableId: string) => cachedTable(tableId),
}));

vi.mock('@desktop/utils/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@desktop/utils/api')>();
  return {
    ...actual,
    containersApi: {
      ...actual.containersApi,
      listTree: () => listTree(),
    },
    archiveApi: { ...actual.archiveApi, counts: (id: string) => archiveCounts(id) },
  };
});

import { emitLibraryEvent } from '@desktop/utils/workspaceEvents';
import { useDashboardLayout } from './useDashboardLayout';
import { useRemovedNodeSync } from './useWorkspaceEventSync';
import { createLeaf, findLeaf, leafIds } from '../layout/paneTree';

const timestamp = '2026-07-29T12:00:00.000Z';

function hydratedDoc(): DocTreeNode {
  return {
    kind: 'doc',
    id: 'doc-1',
    containerId: null,
    title: 'Current title',
    content: 'Current content',
    sortOrder: 0,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

beforeEach(() => {
  window.localStorage.clear();
  listTree.mockReset();
  listTree.mockResolvedValue([]);
  archiveCounts.mockReset();
  cachedTable.mockReset();
  cachedTable.mockReturnValue(null);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('useDashboardLayout workspace-node hydration', () => {
  it('hydrates ID-only current and history selections from the workspace tree', async () => {
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
      children: [hydratedDoc()],
    };
    listTree.mockResolvedValue([container]);
    window.localStorage.setItem(
      LAYOUT_STORAGE_KEY,
      JSON.stringify({
        version: LAYOUT_STORAGE_VERSION,
        activeLeafId: 'leaf-1',
        layout: {
          kind: 'leaf',
          id: 'leaf-1',
          selection: { kind: 'doc', doc_id: 'doc-1' },
          history: {
            entries: [{ kind: 'doc', doc_id: 'doc-1' }],
            index: 0,
          },
        },
      })
    );

    const { result } = renderHook(() => useDashboardLayout());

    await waitFor(() => {
      expect(result.current.layout).toMatchObject({
        kind: 'leaf',
        selection: {
          kind: 'doc',
          doc_id: 'doc-1',
          node: {
            title: 'Current title',
            content: 'Current content',
          },
        },
        history: {
          entries: [
            {
              kind: 'doc',
              doc_id: 'doc-1',
              node: {
                title: 'Current title',
                content: 'Current content',
              },
            },
          ],
        },
      });
    });

    expect(listTree).toHaveBeenCalledTimes(1);
  });

  function restoreIdOnlyDoc() {
    window.localStorage.setItem(
      LAYOUT_STORAGE_KEY,
      JSON.stringify({
        version: LAYOUT_STORAGE_VERSION,
        activeLeafId: 'leaf-1',
        layout: {
          kind: 'leaf',
          id: 'leaf-1',
          selection: { kind: 'doc', doc_id: 'doc-1' },
          history: { entries: [{ kind: 'doc', doc_id: 'doc-1' }], index: 0 },
        },
      })
    );
  }

  const selectedDoc = (layout: unknown) =>
    (layout as { selection: { node?: { title: string } } }).selection;

  it('retries a failed tree read on a growing delay until it hydrates', async () => {
    vi.useFakeTimers();
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    listTree
      .mockRejectedValueOnce(new Error('HTTP 502'))
      .mockRejectedValueOnce(new Error('HTTP 502'));
    listTree.mockResolvedValue([hydratedDoc()]);
    restoreIdOnlyDoc();

    const { result } = renderHook(() => useDashboardLayout());
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(listTree).toHaveBeenCalledTimes(1);
    expect(selectedDoc(result.current.layout).node).toBeUndefined();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000);
    });
    expect(listTree).toHaveBeenCalledTimes(2);

    // Backoff: the third read waits twice as long.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000);
    });
    expect(listTree).toHaveBeenCalledTimes(2);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000);
    });
    expect(listTree).toHaveBeenCalledTimes(3);
    expect(selectedDoc(result.current.layout).node?.title).toBe('Current title');
  });

  it('retries an id the tree did not have on the next tree refresh', async () => {
    listTree.mockResolvedValueOnce([]);
    restoreIdOnlyDoc();
    const { result } = renderHook(() => useDashboardLayout());
    await waitFor(() => expect(listTree).toHaveBeenCalledTimes(1));
    expect(selectedDoc(result.current.layout).node).toBeUndefined();

    listTree.mockResolvedValue([hydratedDoc()]);
    act(() => emitLibraryEvent({ type: 'tree-invalidated', ids: [] }));

    await waitFor(() =>
      expect(selectedDoc(result.current.layout).node?.title).toBe('Current title')
    );
    expect(listTree).toHaveBeenCalledTimes(2);
  });

  it('takes a doc pane away with its archived folder and brings it back on restore', async () => {
    const folder = (id: string, parentId: string | null, children: LibraryTreeChild[]) =>
      ({
        kind: 'container',
        id,
        parentId,
        name: 'Folder',
        sortOrder: 0,
        category: null,
        folderPath: null,
        githubUrl: null,
        createdAt: timestamp,
        updatedAt: timestamp,
        children,
      }) satisfies ContainerTreeNode;
    // doc-1 sits two folders down: container-1 > container-2 > doc-1.
    const tree = [
      folder('container-1', null, [
        folder('container-2', 'container-1', [{ ...hydratedDoc(), containerId: 'container-2' }]),
      ]),
    ];
    listTree.mockResolvedValue(tree);
    restoreIdOnlyDoc();
    const { result } = renderHook(() => {
      const dashboard = useDashboardLayout();
      useRemovedNodeSync(dashboard.layout, dashboard.setLayout);
      return dashboard;
    });
    await waitFor(() =>
      expect(selectedDoc(result.current.layout).node?.title).toBe('Current title')
    );

    listTree.mockResolvedValue([]);
    archiveCounts.mockResolvedValue({ node: { id: 'doc-1', archived: true }, counts: {} });
    act(() => emitLibraryEvent({ type: 'archive-changed', ids: ['container-1'] }));
    await waitFor(() => expect(selectedDoc(result.current.layout).node).toBeUndefined());

    // A restore asks for a reload, which hydrates the pane again.
    listTree.mockResolvedValue(tree);
    act(() => emitLibraryEvent({ type: 'archive-changed', ids: ['container-1'], reload: true }));
    await waitFor(() =>
      expect(selectedDoc(result.current.layout).node?.title).toBe('Current title')
    );
  });
});

describe('useDashboardLayout invariant and persistence boundary', () => {
  it('normalizes every externally supplied layout before exposing state', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { result } = renderHook(() => useDashboardLayout());
    const first = createLeaf({ kind: 'thread', thread_id: 'A' });
    const second = createLeaf({ kind: 'thread', thread_id: 'B' });

    act(() => {
      result.current.setLayout({
        kind: 'split',
        id: 'malformed-split',
        direction: 'horizontal',
        children: [first, second],
        ratios: [0, 100],
      });
    });

    expect(result.current.layout).toMatchObject({ kind: 'split', ratios: [50, 50] });
    expect(warn).toHaveBeenCalledWith(
      '[pane-layout] repaired invalid layout',
      expect.objectContaining({ source: 'state-update' })
    );
    warn.mockRestore();
  });

  it('cancels superseded persistence timers and writes only the latest captured snapshot', () => {
    vi.useFakeTimers();
    const setItem = vi.spyOn(Storage.prototype, 'setItem');
    const { result } = renderHook(() => useDashboardLayout());

    act(() => {
      result.current.setLayout(createLeaf({ kind: 'thread', thread_id: 'first' }));
    });
    act(() => {
      vi.advanceTimersByTime(200);
      result.current.setLayout(createLeaf({ kind: 'thread', thread_id: 'latest' }));
    });
    act(() => vi.advanceTimersByTime(250));

    expect(setItem).toHaveBeenCalledTimes(1);
    const persisted = JSON.parse(window.localStorage.getItem(LAYOUT_STORAGE_KEY) ?? '{}') as {
      layout?: { selection?: { thread_id?: string } };
    };
    expect(persisted.layout?.selection?.thread_id).toBe('latest');
    setItem.mockRestore();
    vi.useRealTimers();
  });

  it('cancels the pending persistence timer on unmount', () => {
    vi.useFakeTimers();
    const setItem = vi.spyOn(Storage.prototype, 'setItem');
    const view = renderHook(() => useDashboardLayout());

    view.unmount();
    act(() => vi.advanceTimersByTime(500));

    expect(setItem).not.toHaveBeenCalled();
    setItem.mockRestore();
    vi.useRealTimers();
  });

  it('resets only pane layout state and the active leaf pointer', () => {
    window.localStorage.setItem(
      LAYOUT_STORAGE_KEY,
      JSON.stringify({
        version: LAYOUT_STORAGE_VERSION,
        activeLeafId: 'leaf-active',
        layout: {
          kind: 'leaf',
          id: 'leaf-active',
          selection: { kind: 'providers' },
          history: { entries: [{ kind: 'providers' }], index: 0 },
        },
      })
    );
    const { result } = renderHook(() => useDashboardLayout());

    act(() => result.current.resetPaneLayout());

    expect(result.current.layout).toMatchObject({ kind: 'leaf', selection: null });
    expect(result.current.activeLeafId).toBeNull();
  });
});

describe('useDashboardLayout split activation', () => {
  it('activates the leaf inserted by a successful split', () => {
    const { result } = renderHook(() => useDashboardLayout());
    const originalId = leafIds(result.current.layout)[0];

    act(() => {
      result.current.callbacks.onSplit(originalId, 'right', { kind: 'providers' });
    });

    expect(result.current.activeLeafId).not.toBe(originalId);
    expect(findLeaf(result.current.layout, result.current.activeLeafId ?? '')?.selection).toEqual({
      kind: 'providers',
    });
  });

  it('preserves layout and active leaf when the split target is missing', () => {
    const { result } = renderHook(() => useDashboardLayout());
    const originalLayout = result.current.layout;
    const originalId = leafIds(originalLayout)[0];

    act(() => result.current.callbacks.onSelectLeaf(originalId));
    act(() => {
      result.current.callbacks.onSplit('leaf-missing', 'right', { kind: 'providers' });
    });

    expect(result.current.layout).toBe(originalLayout);
    expect(result.current.activeLeafId).toBe(originalId);
  });

  it('resolves rapid drops from the actual previous tree and activates an existing leaf', () => {
    const { result } = renderHook(() => useDashboardLayout());
    const originalId = leafIds(result.current.layout)[0];

    act(() => {
      result.current.callbacks.onSplit(originalId, 'right', { kind: 'providers' });
    });
    const firstInsertedId = result.current.activeLeafId;
    expect(firstInsertedId).not.toBeNull();
    expect(findLeaf(result.current.layout, firstInsertedId ?? '')?.selection).toEqual({
      kind: 'providers',
    });

    act(() => {
      result.current.callbacks.onSplit(originalId, 'right', { kind: 'storage' });
    });

    const ids = leafIds(result.current.layout);
    expect(ids).toHaveLength(3);
    expect(result.current.activeLeafId).not.toBeNull();
    expect(result.current.activeLeafId).not.toBe(firstInsertedId);
    expect(ids).toContain(firstInsertedId);
    expect(ids).toContain(result.current.activeLeafId);
    expect(findLeaf(result.current.layout, result.current.activeLeafId ?? '')?.selection).toEqual({
      kind: 'storage',
    });
  });

  it('preserves the active pane for an intentional programmatic split', () => {
    const { result } = renderHook(() => useDashboardLayout());
    const originalId = leafIds(result.current.layout)[0];
    let insertedId: string | null = null;

    act(() => result.current.callbacks.onSelectLeaf(originalId));
    act(() => {
      insertedId = result.current.navigatePaneByKey(originalId, { kind: 'providers' }, null, {
        mode: 'split',
        splitZone: 'right',
      });
    });

    expect(leafIds(result.current.layout)).toHaveLength(2);
    expect(insertedId).not.toBeNull();
    expect(insertedId).not.toBe(originalId);
    expect(findLeaf(result.current.layout, insertedId ?? '')?.selection).toEqual({
      kind: 'providers',
    });
    expect(result.current.activeLeafId).toBe(originalId);
  });

  it('activates the target pane for an intentional programmatic replace', () => {
    const { result } = renderHook(() => useDashboardLayout());
    const originalId = leafIds(result.current.layout)[0];
    let replacedId: string | null = null;

    act(() => {
      result.current.callbacks.onSplit(originalId, 'right', { kind: 'storage' });
    });
    expect(result.current.activeLeafId).not.toBe(originalId);

    act(() => {
      replacedId = result.current.navigatePaneByKey(originalId, { kind: 'providers' }, null, {
        mode: 'replace',
      });
    });

    expect(replacedId).toBe(originalId);
    expect(result.current.activeLeafId).toBe(originalId);
    expect(findLeaf(result.current.layout, originalId)?.selection).toEqual({ kind: 'providers' });
  });
});

describe('useDashboardLayout active pane', () => {
  function threePanes() {
    const view = renderHook(() => useDashboardLayout());
    const [first] = leafIds(view.result.current.layout);
    act(() => view.result.current.callbacks.onSplit(first, 'right', { kind: 'providers' }));
    const second = view.result.current.activeLeafId ?? '';
    act(() => view.result.current.callbacks.onSplit(second, 'right', { kind: 'storage' }));
    const third = view.result.current.activeLeafId ?? '';
    expect(leafIds(view.result.current.layout)).toEqual([first, second, third]);
    return { ...view, first, second, third };
  }

  it('activates the pane before the closed active pane', () => {
    const { result, first, second } = threePanes();

    act(() => result.current.callbacks.onSelectLeaf(second));
    act(() => result.current.callbacks.onCloseLeaf(second));

    expect(result.current.activeLeafId).toBe(first);
  });

  it('activates the pane after the closed active pane when it was first', () => {
    const { result, first, second } = threePanes();

    act(() => result.current.callbacks.onSelectLeaf(first));
    act(() => result.current.callbacks.onCloseLeaf(first));

    expect(result.current.activeLeafId).toBe(second);
  });

  it('keeps the active pane when another pane closes', () => {
    const { result, first, third } = threePanes();

    act(() => result.current.callbacks.onCloseLeaf(first));

    expect(result.current.activeLeafId).toBe(third);
  });

  it('opens into the pane active at call time, not the one active when the opener was made', () => {
    const { result, first, third } = threePanes();
    const openProfile = result.current.openProfile;
    expect(result.current.activeLeafId).toBe(third);

    // An opener held across an await (an agent fetch) runs after the user
    // has moved to another pane.
    act(() => result.current.callbacks.onSelectLeaf(first));
    act(() => openProfile());

    expect(findLeaf(result.current.layout, first)?.selection).toEqual({ kind: 'profile' });
    expect(findLeaf(result.current.layout, third)?.selection).toEqual({ kind: 'storage' });
    expect(result.current.activeLeafId).toBe(first);
  });

  it('clears the active pane when the last pane closes', () => {
    const { result } = renderHook(() => useDashboardLayout());
    const [only] = leafIds(result.current.layout);

    act(() => result.current.callbacks.onSelectLeaf(only));
    act(() => result.current.callbacks.onCloseLeaf(only));

    expect(result.current.activeLeafId).toBeNull();
    expect(leafIds(result.current.layout)).toHaveLength(1);
  });
});

describe('useDashboardLayout message-focus navigation', () => {
  const thread = (id: string) =>
    ({ kind: 'thread', id, containerId: null, title: id, sortOrder: 0 }) as unknown as Parameters<
      ReturnType<typeof useDashboardLayout>['openThreadWithFocusMessage']
    >[0];

  it('stamps every message hit with a fresh request id, even for the same thread and message', () => {
    const { result } = renderHook(() => useDashboardLayout());
    const active = () => findLeaf(result.current.layout, result.current.activeLeafId!)!.selection;

    act(() => result.current.openThreadWithFocusMessage(thread('t1'), 'm5'));
    const first = active();
    expect(first).toMatchObject({ kind: 'thread', thread_id: 't1', focusMessageId: 'm5' });
    const firstRequest = (first as { focusRequestId?: number }).focusRequestId;
    expect(typeof firstRequest).toBe('number');

    act(() => result.current.openThreadWithFocusMessage(thread('t1'), 'm5'));
    const second = active();
    expect(second).toMatchObject({ kind: 'thread', thread_id: 't1', focusMessageId: 'm5' });
    expect((second as { focusRequestId?: number }).focusRequestId).not.toBe(firstRequest);
  });

  it('never persists the focus hint or the request id', () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => useDashboardLayout());

    act(() => result.current.openThreadWithFocusMessage(thread('t1'), 'm5'));
    act(() => {
      vi.advanceTimersByTime(PERSIST_DEBOUNCE_MS + 1);
    });

    const raw = window.localStorage.getItem(LAYOUT_STORAGE_KEY);
    expect(raw).not.toBeNull();
    expect(raw).not.toContain('focusMessageId');
    expect(raw).not.toContain('focusRequestId');
    expect(raw).toContain('"thread_id":"t1"');
  });
});

describe('useDashboardLayout agent tab navigation', () => {
  const agent = { id: 'test-agent-a', name: 'Ada' } as unknown as Parameters<
    ReturnType<typeof useDashboardLayout>['openAgent']
  >[0];

  it('opens an agent plainly, with no tab hint', () => {
    const { result } = renderHook(() => useDashboardLayout());
    act(() => result.current.openAgent(agent));
    const selection = findLeaf(result.current.layout, result.current.activeLeafId!)!.selection;
    expect(selection).toEqual({ kind: 'agent', agent });
  });

  it('stamps a named tab with a fresh request id on every open', () => {
    const { result } = renderHook(() => useDashboardLayout());
    const active = () =>
      findLeaf(result.current.layout, result.current.activeLeafId!)!.selection as {
        focusTab?: string;
        focusRequestId?: number;
      };

    act(() => result.current.openAgent(agent, { tab: 'overview' }));
    const first = active();
    expect(first).toMatchObject({ kind: 'agent', focusTab: 'overview' });
    expect(typeof first.focusRequestId).toBe('number');

    act(() => result.current.openAgent(agent, { tab: 'overview' }));
    expect(active().focusRequestId).not.toBe(first.focusRequestId);
  });

  it('never persists the tab hint or its request id', () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => useDashboardLayout());

    act(() => result.current.openAgent(agent, { tab: 'overview' }));
    act(() => {
      vi.advanceTimersByTime(PERSIST_DEBOUNCE_MS + 1);
    });

    const raw = window.localStorage.getItem(LAYOUT_STORAGE_KEY);
    expect(raw).not.toBeNull();
    expect(raw).toContain('"test-agent-a"');
    expect(raw).not.toContain('focusTab');
    expect(raw).not.toContain('focusRequestId');
  });
});

describe('useDashboardLayout table drafts', () => {
  const projectId = 'container-1111111111111-aaaaaaaaa';
  const activeSelection = (result: { current: ReturnType<typeof useDashboardLayout> }) =>
    findLeaf(result.current.layout, result.current.activeLeafId ?? '')?.selection;

  it('opens a draft in a project, or a workspace-wide one, each with a fresh table id', () => {
    const { result } = renderHook(() => useDashboardLayout());

    act(() => result.current.openTableDraft(projectId));
    const linked = activeSelection(result);
    expect(linked).toEqual({
      kind: 'table-draft',
      draft_id: expect.stringMatching(/^table-/),
      project_id: projectId,
    });

    act(() => result.current.openTableDraft(null));
    const unlinked = activeSelection(result);
    expect(unlinked).toEqual({ kind: 'table-draft', draft_id: expect.stringMatching(/^table-/) });

    act(() => result.current.openTableDraft());
    const bare = activeSelection(result);
    expect(bare).toEqual({ kind: 'table-draft', draft_id: expect.stringMatching(/^table-/) });

    const ids = [linked, unlinked, bare].map((s) => (s?.kind === 'table-draft' ? s.draft_id : ''));
    expect(new Set(ids).size).toBe(3);
  });
});

describe('useDashboardLayout entry-focus navigation', () => {
  const tableId = 'table-1111111111111-aaaaaaaaa';
  const firstEntryId = '00000000-0000-4000-8000-000000000001';
  const secondEntryId = '00000000-0000-4000-8000-000000000002';

  it('reuses the table pane and gives every entry navigation a fresh request id', () => {
    vi.spyOn(Date, 'now').mockReturnValue(1000);
    const { result } = renderHook(() => useDashboardLayout());
    const active = () => {
      const leaf = findLeaf(result.current.layout, result.current.activeLeafId ?? '');
      if (leaf?.selection?.kind !== 'table') throw new Error('Expected an active table pane');
      return { leaf, selection: leaf.selection };
    };
    act(() => result.current.openTableEntry(tableId, firstEntryId));
    const first = active();
    expect(first.selection).toMatchObject({
      kind: 'table',
      table_id: tableId,
      focusEntryId: firstEntryId,
      focusRequestId: expect.any(Number),
    });
    act(() => result.current.openTableEntry(tableId, firstEntryId));
    const repeated = active();
    expect(repeated.leaf.id).toBe(first.leaf.id);
    expect(repeated.selection.focusRequestId).not.toBe(first.selection.focusRequestId);
    act(() => result.current.openTableEntry(tableId, secondEntryId));
    const next = active();
    expect(next.leaf.id).toBe(first.leaf.id);
    expect(next.selection.focusEntryId).toBe(secondEntryId);
    expect(next.selection.focusRequestId).not.toBe(repeated.selection.focusRequestId);
    expect(leafIds(result.current.layout)).toHaveLength(1);
    expect(next.leaf.history.entries).toHaveLength(1);
    expect(listTree).not.toHaveBeenCalled();
  });

  it('opens an entry window, not a grid seek, when asked for the window', () => {
    const { result } = renderHook(() => useDashboardLayout());
    act(() => result.current.openTableEntry(tableId, firstEntryId, 'window'));
    const selection = findLeaf(result.current.layout, result.current.activeLeafId ?? '')?.selection;
    expect(selection).toMatchObject({
      kind: 'table',
      table_id: tableId,
      openEntryId: firstEntryId,
      focusRequestId: expect.any(Number),
    });
    expect(selection).not.toHaveProperty('focusEntryId');
  });

  it('paints the table title from the catalog cache, as a table chip does', () => {
    const table: TableCatalogEntry = {
      id: tableId,
      name: 'Tasks',
      origin: 'custom',
      projectId: null,
      sortOrder: 0,
      createdAt: timestamp,
    };
    cachedTable.mockImplementation((id) => (id === tableId ? table : null));
    const { result } = renderHook(() => useDashboardLayout());
    act(() => result.current.openTableEntry(tableId, firstEntryId));
    expect(
      findLeaf(result.current.layout, result.current.activeLeafId ?? '')?.selection
    ).toMatchObject({ kind: 'table', table_id: tableId, table, focusEntryId: firstEntryId });
  });

  it('clears the entry hint when the table itself is opened again', () => {
    const { result } = renderHook(() => useDashboardLayout());
    act(() => result.current.openTableEntry(tableId, firstEntryId));
    const leafId = result.current.activeLeafId;
    act(() => result.current.openTableById(tableId));
    expect(result.current.activeLeafId).toBe(leafId);
    expect(findLeaf(result.current.layout, leafId ?? '')?.selection).toEqual({
      kind: 'table',
      table_id: tableId,
    });
  });

  it('persists table identity without entry-focus hints in current selection or history', () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => useDashboardLayout());
    act(() => result.current.openTableEntry(tableId, firstEntryId));
    act(() => result.current.openTableEntry('table-2222222222222-bbbbbbbbb', secondEntryId));
    act(() => vi.advanceTimersByTime(PERSIST_DEBOUNCE_MS + 1));
    const raw = window.localStorage.getItem(LAYOUT_STORAGE_KEY);
    expect(raw).not.toBeNull();
    expect(raw).toContain(tableId);
    expect(raw).toContain('table-2222222222222-bbbbbbbbb');
    expect(raw).not.toContain('focusEntryId');
    expect(raw).not.toContain('focusRequestId');
    expect(raw).not.toContain(firstEntryId);
    expect(raw).not.toContain(secondEntryId);
  });
});

describe('useDashboardLayout threads and automations by id', () => {
  const threadId = 'thread-1111111111111-aaaaaaaaa';
  const activeSelection = (result: { current: ReturnType<typeof useDashboardLayout> }) =>
    findLeaf(result.current.layout, result.current.activeLeafId ?? '')?.selection;

  it('names a thread pane from a known title at once', () => {
    const { result } = renderHook(() => useDashboardLayout());
    act(() => result.current.openThreadById(threadId, 'Test thread'));
    expect(activeSelection(result)).toMatchObject({
      kind: 'thread',
      thread_id: threadId,
      node: { kind: 'thread', id: threadId, title: 'Test thread' },
    });
  });

  it('opens a thread with no known title by id, and the workspace tree names it', async () => {
    listTree.mockResolvedValue([
      {
        kind: 'thread',
        id: threadId,
        projectId: null,
        title: 'Test thread',
        sortOrder: 0,
        lastMessageAt: null,
        createdAt: timestamp,
        updatedAt: timestamp,
      },
    ]);
    const { result } = renderHook(() => useDashboardLayout());
    act(() => result.current.openThreadById(threadId));
    expect(activeSelection(result)).toEqual({ kind: 'thread', thread_id: threadId });
    await waitFor(() =>
      expect(activeSelection(result)).toMatchObject({ node: { title: 'Test thread' } })
    );
  });

  it('opens an automation, and the New automation form', () => {
    const { result } = renderHook(() => useDashboardLayout());
    act(() => result.current.openAutomation('automation-1', 'Morning check'));
    expect(activeSelection(result)).toEqual({
      kind: 'automation-detail',
      automation_id: 'automation-1',
      name: 'Morning check',
    });
    act(() => result.current.openAutomationCreate());
    expect(activeSelection(result)).toEqual({ kind: 'automation-create' });
  });
});
