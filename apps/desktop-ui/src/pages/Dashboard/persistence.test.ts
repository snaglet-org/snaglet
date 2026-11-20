import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  LAYOUT_STORAGE_KEY,
  LAYOUT_STORAGE_VERSION,
  MAX_LAYOUT_SNAPSHOT_CHARS,
  itemsMissingFromTree,
  layoutFitsWorkspace,
  loadPersistedDashboard,
  savePersistedDashboard,
} from './persistence';
import type { LayoutNode } from './layout/paneTree';
import type { DetailSelection } from './selection/types';

beforeEach(() => window.localStorage.clear());
afterEach(() => vi.restoreAllMocks());

describe('pane ratio persistence repair', () => {
  it('repairs malformed persisted ratios and writes the corrected shape back once', () => {
    window.localStorage.setItem(
      LAYOUT_STORAGE_KEY,
      JSON.stringify({
        version: LAYOUT_STORAGE_VERSION,
        activeLeafId: 'leaf-1',
        layout: {
          kind: 'split',
          id: 'split-1',
          direction: 'horizontal',
          ratios: [23.347, 76.653],
          children: [
            {
              kind: 'leaf',
              id: 'leaf-1',
              selection: null,
              history: { entries: [], index: -1 },
            },
          ],
        },
      })
    );
    const setItem = vi.spyOn(Storage.prototype, 'setItem');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    const restored = loadPersistedDashboard();

    expect(restored?.layout).toMatchObject({ kind: 'split', ratios: [100] });
    expect(setItem).toHaveBeenCalledTimes(1);
    const persisted = JSON.parse(window.localStorage.getItem(LAYOUT_STORAGE_KEY) ?? '{}') as {
      layout?: { ratios?: number[] };
    };
    expect(persisted.layout?.ratios).toEqual([100]);
    expect(warn).toHaveBeenCalledWith(
      '[pane-layout] repaired invalid layout',
      expect.objectContaining({ source: 'persisted-load' })
    );
    setItem.mockRestore();
    warn.mockRestore();
  });

  it('does not rewrite or clone an already-valid persisted ratio vector on load', () => {
    window.localStorage.setItem(
      LAYOUT_STORAGE_KEY,
      JSON.stringify({
        version: LAYOUT_STORAGE_VERSION,
        activeLeafId: 'leaf-1',
        layout: {
          kind: 'split',
          id: 'split-1',
          direction: 'horizontal',
          ratios: [23.3474, 76.6526],
          children: [
            {
              kind: 'leaf',
              id: 'leaf-1',
              selection: null,
              history: { entries: [], index: -1 },
            },
            {
              kind: 'leaf',
              id: 'leaf-2',
              selection: null,
              history: { entries: [], index: -1 },
            },
          ],
        },
      })
    );
    const setItem = vi.spyOn(Storage.prototype, 'setItem');

    const restored = loadPersistedDashboard();

    expect(restored?.layout).toMatchObject({ ratios: [23.3474, 76.6526] });
    expect(setItem).not.toHaveBeenCalled();
    setItem.mockRestore();
  });

  it('normalizes a malformed snapshot before every direct save', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    savePersistedDashboard({
      activeLeafId: 'leaf-1',
      layout: {
        kind: 'split',
        id: 'split-1',
        direction: 'horizontal',
        ratios: [0, 100],
        children: [
          {
            kind: 'leaf',
            id: 'leaf-1',
            selection: null,
            history: { entries: [], index: -1 },
          },
          {
            kind: 'leaf',
            id: 'leaf-2',
            selection: null,
            history: { entries: [], index: -1 },
          },
        ],
      },
    });

    const persisted = JSON.parse(window.localStorage.getItem(LAYOUT_STORAGE_KEY) ?? '{}') as {
      layout?: { ratios?: number[] };
    };
    expect(persisted.layout?.ratios).toEqual([50, 50]);
    warn.mockRestore();
  });
});

describe('embedding selection persistence migration', () => {
  it('keeps the restored Embeddings tab and redirects removed subtabs to it', () => {
    window.localStorage.setItem(
      LAYOUT_STORAGE_KEY,
      JSON.stringify({
        version: LAYOUT_STORAGE_VERSION,
        activeLeafId: 'leaf-1',
        layout: {
          kind: 'leaf',
          id: 'leaf-1',
          selection: { kind: 'embeddings', tab: 'storage' },
          history: {
            entries: [
              { kind: 'embeddings', tab: 'embeddings' },
              { kind: 'embeddings', tab: 'storage' },
            ],
            index: 1,
          },
        },
      })
    );

    const restored = loadPersistedDashboard();

    expect(restored?.layout).toMatchObject({
      kind: 'leaf',
      selection: { kind: 'embeddings', tab: 'embeddings' },
      history: {
        entries: [
          { kind: 'embeddings', tab: 'embeddings' },
          { kind: 'embeddings', tab: 'embeddings' },
        ],
      },
    });
  });
});

describe('workspace selection persistence migration', () => {
  it('converts a v3 image wrapper to the current image selection', () => {
    window.localStorage.setItem(
      LAYOUT_STORAGE_KEY,
      JSON.stringify({
        version: 3,
        activeLeafId: 'leaf-1',
        layout: {
          kind: 'leaf',
          id: 'leaf-1',
          selection: {
            kind: 'library',
            node: {
              kind: 'image',
              id: 'image-1',
              name: 'Diagram',
            },
          },
          history: {
            entries: [
              {
                kind: 'library',
                node: {
                  kind: 'image',
                  id: 'image-1',
                  name: 'Diagram',
                },
              },
            ],
            index: 0,
          },
        },
      })
    );

    const restored = loadPersistedDashboard();

    expect(restored).toMatchObject({
      version: LAYOUT_STORAGE_VERSION,
      layout: {
        kind: 'leaf',
        selection: {
          kind: 'image',
          image_id: 'image-1',
          node: { kind: 'image', id: 'image-1', name: 'Diagram' },
        },
        history: {
          entries: [
            {
              kind: 'image',
              image_id: 'image-1',
            },
          ],
        },
      },
    });
  });

  it('keeps a converted task pane as an ID-based document for hydration', () => {
    window.localStorage.setItem(
      LAYOUT_STORAGE_KEY,
      JSON.stringify({
        version: 2,
        activeLeafId: 'leaf-1',
        layout: {
          kind: 'leaf',
          id: 'leaf-1',
          selection: { kind: 'task', task_id: 'doc-1' },
          history: {
            entries: [{ kind: 'task', task_id: 'doc-1' }],
            index: 0,
          },
        },
      })
    );

    expect(loadPersistedDashboard()).toMatchObject({
      version: LAYOUT_STORAGE_VERSION,
      layout: {
        kind: 'leaf',
        selection: { kind: 'doc', doc_id: 'doc-1' },
        history: { entries: [{ kind: 'doc', doc_id: 'doc-1' }] },
      },
    });
  });
});

describe('thread selections restore without container repair', () => {
  // Threads are not in the folder tree: a thread is scoped by `project_id` or
  // flat, so a stored thread selection has nothing to repair against a
  // container. A stored node that carries a `containerId` restores as-is and
  // hydrates by id.
  const THREAD_ID = 'thread-1111111111111-aaaaaaaaa';
  const CONTAINER_ID = 'container-1111111111111-aaaaaaaaa';
  const staleNode = {
    kind: 'thread',
    id: THREAD_ID,
    containerId: CONTAINER_ID,
    title: 'Test thread',
    sortOrder: 3,
    lastMessageAt: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: null,
  };

  it('restores a current-version thread pane saved with a stale container placement untouched', () => {
    const selection = { kind: 'thread', thread_id: THREAD_ID, node: staleNode };
    window.localStorage.setItem(
      LAYOUT_STORAGE_KEY,
      JSON.stringify({
        version: LAYOUT_STORAGE_VERSION,
        activeLeafId: 'leaf-1',
        layout: {
          kind: 'leaf',
          id: 'leaf-1',
          selection,
          history: { entries: [selection], index: 0 },
        },
      })
    );
    const setItem = vi.spyOn(Storage.prototype, 'setItem');

    expect(loadPersistedDashboard()).toEqual({
      version: LAYOUT_STORAGE_VERSION,
      activeLeafId: 'leaf-1',
      layout: {
        kind: 'leaf',
        id: 'leaf-1',
        selection,
        history: { entries: [selection], index: 0 },
      },
    });
    // Nothing was repaired, so nothing is written back on load.
    expect(setItem).not.toHaveBeenCalled();
  });

  it('migrates a pre-v4 wrapped thread selection to an id-based thread pane', () => {
    window.localStorage.setItem(
      LAYOUT_STORAGE_KEY,
      JSON.stringify({
        version: 3,
        activeLeafId: 'leaf-1',
        layout: {
          kind: 'leaf',
          id: 'leaf-1',
          selection: { kind: 'library', node: staleNode },
          history: { entries: [{ kind: 'library', node: staleNode }], index: 0 },
        },
      })
    );

    expect(loadPersistedDashboard()).toMatchObject({
      version: LAYOUT_STORAGE_VERSION,
      layout: {
        kind: 'leaf',
        selection: { kind: 'thread', thread_id: THREAD_ID, node: staleNode },
        history: { entries: [{ kind: 'thread', thread_id: THREAD_ID }], index: 0 },
      },
    });
  });
});

describe('saved MCP singleton panes', () => {
  it('scrubs saved settings-level MCP panes, since connections open as item tabs', () => {
    window.localStorage.setItem(
      LAYOUT_STORAGE_KEY,
      JSON.stringify({
        version: LAYOUT_STORAGE_VERSION,
        activeLeafId: 'leaf-1',
        layout: {
          kind: 'leaf',
          id: 'leaf-1',
          selection: { kind: 'mcp' },
          history: {
            entries: [{ kind: 'mcp' }, { kind: 'mcp-server' }],
            index: 1,
          },
        },
      })
    );

    expect(loadPersistedDashboard()).toMatchObject({
      layout: {
        kind: 'leaf',
        selection: null,
        history: { entries: [], index: -1 },
      },
    });
  });
});

describe('saved Board and prototypes panes', () => {
  it('drops a saved discussion pane and its history, since there is no Board', () => {
    window.localStorage.setItem(
      LAYOUT_STORAGE_KEY,
      JSON.stringify({
        version: LAYOUT_STORAGE_VERSION,
        activeLeafId: 'leaf-1',
        layout: {
          kind: 'leaf',
          id: 'leaf-1',
          selection: { kind: 'board', board_id: 'discussion-1', post_id: 'post-1' },
          history: {
            entries: [
              { kind: 'board', board_id: null },
              { kind: 'board', board_id: 'discussion-1' },
            ],
            index: 1,
          },
        },
      })
    );

    expect(loadPersistedDashboard()).toMatchObject({
      layout: {
        kind: 'leaf',
        selection: null,
        history: { entries: [], index: -1 },
      },
    });
  });

  it('keeps the surviving history entries when the rest are Board or prototypes panes', () => {
    window.localStorage.setItem(
      LAYOUT_STORAGE_KEY,
      JSON.stringify({
        version: LAYOUT_STORAGE_VERSION,
        activeLeafId: 'leaf-1',
        layout: {
          kind: 'leaf',
          id: 'leaf-1',
          selection: { kind: 'calendar' },
          history: {
            entries: [
              { kind: 'board', board_id: null },
              { kind: 'prototypes' },
              { kind: 'calendar' },
            ],
            index: 2,
          },
        },
      })
    );

    expect(loadPersistedDashboard()).toMatchObject({
      layout: {
        kind: 'leaf',
        selection: { kind: 'calendar' },
        history: { entries: [{ kind: 'calendar' }], index: 0 },
      },
    });
  });

  it('drops a saved repeat-prototypes pane now that quotas are gone', () => {
    window.localStorage.setItem(
      LAYOUT_STORAGE_KEY,
      JSON.stringify({
        version: LAYOUT_STORAGE_VERSION,
        activeLeafId: 'leaf-1',
        layout: {
          kind: 'leaf',
          id: 'leaf-1',
          selection: { kind: 'prototypes' },
          history: { entries: [{ kind: 'prototypes' }], index: 0 },
        },
      })
    );

    expect(loadPersistedDashboard()).toMatchObject({
      layout: {
        kind: 'leaf',
        selection: null,
        history: { entries: [], index: -1 },
      },
    });
  });
});

describe('transient message-focus state is never persisted', () => {
  const thread = (extra: Record<string, unknown>) =>
    ({ kind: 'thread', thread_id: 't1', ...extra }) as unknown as Parameters<
      typeof savePersistedDashboard
    >[0]['layout'] extends infer L
      ? L extends { selection: infer S }
        ? S
        : never
      : never;

  function saveLeaf(selection: unknown, history: unknown[]) {
    savePersistedDashboard({
      activeLeafId: 'leaf-1',
      layout: {
        kind: 'leaf',
        id: 'leaf-1',
        selection: selection as never,
        history: { entries: history as never[], index: history.length - 1 },
      },
    });
    return window.localStorage.getItem(LAYOUT_STORAGE_KEY) ?? '';
  }

  it('strips focusMessageId and focusRequestId from the current selection', () => {
    const raw = saveLeaf(thread({ focusMessageId: 'm5', focusRequestId: 3 }), []);
    expect(raw).toContain('"thread_id":"t1"');
    expect(raw).not.toContain('focusMessageId');
    expect(raw).not.toContain('focusRequestId');
  });

  it('strips a nonce-only selection (request id without a message id)', () => {
    const raw = saveLeaf(thread({ focusRequestId: 9 }), []);
    expect(raw).toContain('"thread_id":"t1"');
    expect(raw).not.toContain('focusRequestId');
  });

  it('strips the hints from every back/forward history entry too', () => {
    const current = thread({ focusMessageId: 'm7', focusRequestId: 4 });
    const raw = saveLeaf(current, [
      thread({ focusMessageId: 'm5', focusRequestId: 3 }),
      { kind: 'doc', doc_id: 'doc-1' },
      current,
    ]);
    expect(raw).not.toContain('focusMessageId');
    expect(raw).not.toContain('focusRequestId');
    expect(raw).toContain('"doc_id":"doc-1"');
    // Entries are kept (only the hints are removed), so back/forward still works.
    const parsed = JSON.parse(raw) as {
      layout: { history: { entries: unknown[]; index: number } };
    };
    expect(parsed.layout.history.entries).toHaveLength(3);
    expect(parsed.layout.history.index).toBe(2);
  });

  it('leaves a selection without hints byte-for-byte alone', () => {
    const raw = saveLeaf(thread({}), [thread({})]);
    expect(raw).toContain('"thread_id":"t1"');
    expect(raw).not.toContain('focus');
  });
});

describe('transient entry-focus state is never persisted', () => {
  const tableId = 'table-1111111111111-aaaaaaaaa';
  const entryId = '00000000-0000-4000-8000-000000000001';

  it.each([
    { focusEntryId: entryId },
    { focusRequestId: 9 },
    { focusEntryId: entryId, focusRequestId: 9 },
    { openEntryId: entryId, focusRequestId: 9 },
  ])('strips each form of focus hint without changing live selection: %j', (hints) => {
    const selection = { kind: 'table' as const, table_id: tableId, ...hints };
    savePersistedDashboard({
      activeLeafId: 'leaf-1',
      layout: {
        kind: 'leaf',
        id: 'leaf-1',
        selection,
        history: { entries: [selection], index: 0 },
      },
    });
    const raw = window.localStorage.getItem(LAYOUT_STORAGE_KEY);
    expect(raw).not.toBeNull();
    expect(raw).not.toContain('focusEntryId');
    expect(raw).not.toContain('openEntryId');
    expect(raw).not.toContain('focusRequestId');
    expect(selection).toEqual({ kind: 'table', table_id: tableId, ...hints });
    const restored = loadPersistedDashboard();
    expect(restored?.layout).toEqual({
      kind: 'leaf',
      id: 'leaf-1',
      selection: { kind: 'table', table_id: tableId },
      history: { entries: [{ kind: 'table', table_id: tableId }], index: 0 },
    });
  });

  it('strips history-only entry hints within split panes while preserving navigation order', () => {
    const plainTable = { kind: 'table' as const, table_id: tableId };
    const entry = { ...plainTable, focusEntryId: entryId, focusRequestId: 4 };
    const settings = { kind: 'storage' as const };
    savePersistedDashboard({
      activeLeafId: 'leaf-2',
      layout: {
        kind: 'split',
        id: 'split-1',
        direction: 'horizontal',
        ratios: [50, 50],
        children: [
          {
            kind: 'leaf',
            id: 'leaf-1',
            selection: settings,
            history: { entries: [entry, settings], index: 1 },
          },
          {
            kind: 'leaf',
            id: 'leaf-2',
            selection: plainTable,
            history: { entries: [entry], index: 0 },
          },
        ],
      },
    });
    const raw = window.localStorage.getItem(LAYOUT_STORAGE_KEY);
    expect(raw).not.toContain('focusEntryId');
    expect(raw).not.toContain('focusRequestId');
    expect(loadPersistedDashboard()).toMatchObject({
      activeLeafId: 'leaf-2',
      layout: {
        children: [
          { selection: settings, history: { entries: [plainTable, settings], index: 1 } },
          { selection: plainTable, history: { entries: [plainTable], index: 0 } },
        ],
      },
    });
  });
});

describe('workspace selections persist by id only', () => {
  const timestamp = '2026-01-01T00:00:00.000Z';
  const doc = (id: string) => ({
    kind: 'doc' as const,
    id,
    containerId: 'container-1',
    title: `Doc ${id}`,
    content: 'x'.repeat(2_000),
    sortOrder: 0,
    createdAt: timestamp,
    updatedAt: timestamp,
  });
  const container = (id: string, childCount: number) => ({
    kind: 'container' as const,
    id,
    parentId: null,
    name: 'Project',
    sortOrder: 0,
    category: 'project' as const,
    folderPath: null,
    githubUrl: null,
    createdAt: timestamp,
    updatedAt: timestamp,
    children: Array.from({ length: childCount }, (_, i) => doc(`doc-${i}`)),
  });
  const containerSelection = (id: string, childCount = 50) => ({
    kind: 'container' as const,
    container_id: id,
    node: container(id, childCount),
  });

  it('drops hydrated nodes from the current selection and every history entry', () => {
    const current = containerSelection('container-1');
    const history = [
      containerSelection('container-0'),
      { kind: 'doc' as const, doc_id: 'doc-1', node: doc('doc-1') },
      current,
    ];
    savePersistedDashboard({
      activeLeafId: 'leaf-1',
      layout: {
        kind: 'leaf',
        id: 'leaf-1',
        selection: current,
        history: { entries: history, index: 2 },
      },
    });

    const raw = window.localStorage.getItem(LAYOUT_STORAGE_KEY) ?? '';
    expect(raw.length).toBeLessThan(1_000);
    expect(raw).not.toContain('"node"');
    expect(JSON.parse(raw)).toMatchObject({
      layout: {
        selection: { kind: 'container', container_id: 'container-1' },
        history: {
          entries: [
            { kind: 'container', container_id: 'container-0' },
            { kind: 'doc', doc_id: 'doc-1' },
            { kind: 'container', container_id: 'container-1' },
          ],
          index: 2,
        },
      },
    });
    // The live selection keeps its render cache.
    expect(current.node.children).toHaveLength(50);
  });

  it('compacts an oversized legacy snapshot on load and writes it back once', () => {
    const entries = Array.from({ length: 50 }, (_, i) => containerSelection(`container-${i}`, 5));
    window.localStorage.setItem(
      LAYOUT_STORAGE_KEY,
      JSON.stringify({
        version: LAYOUT_STORAGE_VERSION,
        activeLeafId: 'leaf-1',
        layout: {
          kind: 'leaf',
          id: 'leaf-1',
          selection: entries[49],
          history: { entries, index: 49 },
        },
      })
    );
    expect(window.localStorage.getItem(LAYOUT_STORAGE_KEY)?.length).toBeGreaterThan(
      MAX_LAYOUT_SNAPSHOT_CHARS
    );
    const setItem = vi.spyOn(Storage.prototype, 'setItem');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    const restored = loadPersistedDashboard();

    expect(restored?.layout).toEqual({
      kind: 'leaf',
      id: 'leaf-1',
      selection: { kind: 'container', container_id: 'container-49' },
      history: {
        entries: entries.map((entry) => ({ kind: 'container', container_id: entry.container_id })),
        index: 49,
      },
    });
    expect(setItem).toHaveBeenCalledTimes(1);
    expect(window.localStorage.getItem(LAYOUT_STORAGE_KEY)?.length).toBeLessThan(10_000);
    expect(warn).toHaveBeenCalledWith(
      '[pane-layout] compacting oversized layout snapshot',
      expect.objectContaining({ budget: MAX_LAYOUT_SNAPSHOT_CHARS })
    );
  });
});

describe('layout snapshot storage limits', () => {
  const agentSelection = (i: number) =>
    ({
      kind: 'agent',
      agent: { id: `test-agent-${i}`, name: 'Test Agent', systemPrompt: 'p'.repeat(20_000) },
    }) as unknown as Exclude<DetailSelection, null>;

  function agentLeaf(count: number) {
    const entries = Array.from({ length: count }, (_, i) => agentSelection(i));
    return {
      kind: 'leaf' as const,
      id: 'leaf-1',
      selection: entries[count - 1],
      history: { entries, index: count - 1 },
    };
  }

  function storedHistory(): { entries: Array<{ agent: { id: string } }>; index: number } {
    const parsed = JSON.parse(window.localStorage.getItem(LAYOUT_STORAGE_KEY) ?? '{}') as {
      layout: { history: { entries: Array<{ agent: { id: string } }>; index: number } };
    };
    return parsed.layout.history;
  }

  it('trims pane history when the snapshot exceeds the size budget', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    savePersistedDashboard({ activeLeafId: 'leaf-1', layout: agentLeaf(40) });

    const history = storedHistory();
    expect(history.entries).toHaveLength(10);
    expect(history.index).toBe(9);
    expect(history.entries[9].agent.id).toBe('test-agent-39');
    expect(warn).toHaveBeenCalledWith(
      '[pane-layout] saved layout with trimmed pane history',
      expect.objectContaining({ reason: 'size-budget' })
    );
  });

  it('falls back to shorter history when the browser rejects the write for quota', () => {
    const quota = new DOMException('The quota has been exceeded.', 'QuotaExceededError');
    const realSetItem = Storage.prototype.setItem;
    const setItem = vi
      .spyOn(Storage.prototype, 'setItem')
      .mockImplementationOnce(() => {
        throw quota;
      })
      .mockImplementationOnce(() => {
        throw quota;
      })
      .mockImplementation(function (this: Storage, key: string, value: string) {
        realSetItem.call(this, key, value);
      });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    savePersistedDashboard({ activeLeafId: 'leaf-1', layout: agentLeaf(5) });

    expect(setItem).toHaveBeenCalledTimes(3);
    const history = storedHistory();
    expect(history.entries.map((entry) => entry.agent.id)).toEqual(['test-agent-4']);
    expect(history.index).toBe(0);
    expect(warn).toHaveBeenCalledWith(
      '[pane-layout] saved layout with trimmed pane history',
      expect.objectContaining({
        historyDepth: 1,
        reason: 'QuotaExceededError: The quota has been exceeded.',
      })
    );
  });

  it('reports an unwritable snapshot once instead of failing silently or throwing', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('The quota has been exceeded.', 'QuotaExceededError');
    });
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const layout = agentLeaf(2);

    expect(() => savePersistedDashboard({ activeLeafId: 'leaf-1', layout })).not.toThrow();
    savePersistedDashboard({ activeLeafId: 'leaf-1', layout });

    expect(error).toHaveBeenCalledTimes(1);
    expect(error).toHaveBeenCalledWith(
      '[pane-layout] could not persist layout snapshot; open panes will not survive a reload',
      'QuotaExceededError: The quota has been exceeded.'
    );
  });
});

describe('calendar pane persistence', () => {
  it('restores a Calendar pane and its history entry as-is', () => {
    const calendar: DetailSelection = { kind: 'calendar' };
    window.localStorage.setItem(
      LAYOUT_STORAGE_KEY,
      JSON.stringify({
        version: LAYOUT_STORAGE_VERSION,
        activeLeafId: 'leaf-1',
        layout: {
          kind: 'leaf',
          id: 'leaf-1',
          selection: calendar,
          history: { entries: [calendar], index: 0 },
        },
      })
    );
    expect(loadPersistedDashboard()).toMatchObject({
      layout: {
        kind: 'leaf',
        selection: { kind: 'calendar' },
        history: { entries: [{ kind: 'calendar' }], index: 0 },
      },
    });
  });
});

describe('layouts belong to the workspace they were saved for', () => {
  const docPane = (id: string, selection: DetailSelection): LayoutNode => ({
    kind: 'leaf',
    id,
    selection,
    history: selection ? { entries: [selection], index: 0 } : { entries: [], index: -1 },
  });
  const split = (...children: LayoutNode[]): LayoutNode => ({
    kind: 'split',
    id: 'split-1',
    direction: 'horizontal',
    ratios: children.map(() => 100 / children.length),
    children,
  });

  it('stamps the saved layout with the workspace id and restores it', () => {
    const layout = docPane('leaf-1', { kind: 'doc', doc_id: 'doc-1' });
    savePersistedDashboard({ layout, activeLeafId: 'leaf-1', workspaceId: 'workspace-a' });
    const stored = JSON.parse(window.localStorage.getItem(LAYOUT_STORAGE_KEY) ?? '{}') as {
      workspaceId?: string;
    };
    expect(stored.workspaceId).toBe('workspace-a');
    expect(loadPersistedDashboard()?.workspaceId).toBe('workspace-a');
  });

  it('saves no stamp while the workspace id is unknown', () => {
    savePersistedDashboard({ layout: docPane('leaf-1', null), activeLeafId: null });
    const stored = JSON.parse(window.localStorage.getItem(LAYOUT_STORAGE_KEY) ?? '{}') as object;
    expect('workspaceId' in stored).toBe(false);
    expect(loadPersistedDashboard()).not.toHaveProperty('workspaceId');
  });

  it('restores a layout saved for the same workspace and refuses one saved for another', () => {
    expect(layoutFitsWorkspace({ workspaceId: 'workspace-a' }, 'workspace-a')).toBe(true);
    expect(layoutFitsWorkspace({ workspaceId: 'workspace-a' }, 'workspace-b')).toBe(false);
  });

  it('keeps a layout saved before layouts carried a stamp, and any layout while the id is unknown', () => {
    expect(layoutFitsWorkspace({}, 'workspace-b')).toBe(true);
    expect(layoutFitsWorkspace({ workspaceId: 'workspace-a' }, null)).toBe(true);
  });

  it('names the items when every pane shows a workspace item the tree no longer lists', () => {
    const layout = split(
      docPane('leaf-1', { kind: 'doc', doc_id: 'doc-gone' }),
      docPane('leaf-2', { kind: 'thread', thread_id: 'thread-gone' }),
      docPane('leaf-3', null)
    );
    expect(itemsMissingFromTree(layout, new Map())).toEqual(['doc-gone', 'thread-gone']);
  });

  it('finds nothing missing when a pane shows an item the tree has, or something else', () => {
    const tree = new Map([['doc-here', {}]]);
    const withLiveDoc = split(
      docPane('leaf-1', { kind: 'doc', doc_id: 'doc-gone' }),
      docPane('leaf-2', { kind: 'doc', doc_id: 'doc-here' })
    );
    expect(itemsMissingFromTree(withLiveDoc, tree)).toBeNull();
    const withHome = split(
      docPane('leaf-1', { kind: 'doc', doc_id: 'doc-gone' }),
      docPane('leaf-2', { kind: 'hub' })
    );
    expect(itemsMissingFromTree(withHome, tree)).toBeNull();
    expect(itemsMissingFromTree(docPane('leaf-1', null), tree)).toBeNull();
  });
});
