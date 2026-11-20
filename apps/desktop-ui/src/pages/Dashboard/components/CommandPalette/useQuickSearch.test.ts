/**
 * useQuickSearch tiering — the command palette's keyword-first / debounced
 * hybrid behavior. Pins that the keyword tier fires immediately (mode
 * 'keyword'), the hybrid tier fires only after the debounce (mode 'hybrid'),
 * and their results merge stably: the keyword hit keeps its position and the
 * semantic-only hit is appended beneath it.
 */
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The API barrel's config module throws at import without these.
vi.hoisted(() => {
  vi.stubEnv('VITE_API_BASE_URL', '/api');
  vi.stubEnv('VITE_APP_NAME', 'Snaglet');
});

import {
  containersApi,
  paletteSearchApi,
  type ContainerTreeNode,
  type DocTreeNode,
  type PaletteAugmentedResponse,
  type PaletteEntryHit,
  type PaletteFileNodeItem,
  type PaletteSearchHit,
} from '@desktop/utils/api';
import { useQuickSearch } from './useQuickSearch';

const searchMock = vi.spyOn(paletteSearchApi, 'search');
const listTreeMock = vi.spyOn(containersApi, 'listTree');

function hit(id: string, title: string, channel: 'fts' | 'vector'): PaletteSearchHit {
  return {
    node_id: id,
    kind: 'doc',
    score: channel === 'fts' ? 0.9 : 0.4,
    channels: [channel],
    payload: { title, containerId: null, sortOrder: 0 },
  };
}

function response(
  hits: PaletteSearchHit[],
  semanticStatus: 'ready' | 'disabled'
): PaletteAugmentedResponse {
  return {
    byKind: { doc: hits },
    channelsUsed: hits.some((h) => h.channels.includes('vector')) ? ['fts', 'vector'] : ['fts'],
    semanticStatus,
    coverage: {},
    items: [],
    filesystem: [],
    files: [],
    meta: { query: '', kinds: [], workspaceCount: 0, filesystemCount: 0 },
  };
}

const flush = () => act(async () => {});
const advance = (ms: number) =>
  act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });

const keywordResponse = response([hit('doc-a', 'Alpha', 'fts')], 'disabled');
const hybridResponse = response(
  [hit('doc-a', 'Alpha', 'fts'), hit('doc-b', 'Bravo', 'vector')],
  'ready'
);

beforeEach(() => {
  vi.useFakeTimers();
  listTreeMock.mockResolvedValue([]);
  searchMock.mockReset();
  searchMock.mockImplementation((req) =>
    Promise.resolve(req.mode === 'keyword' ? keywordResponse : hybridResponse)
  );
});

afterEach(() => {
  vi.useRealTimers();
});

describe('useQuickSearch tiering', () => {
  it('renders keyword hits instantly, then appends semantic-only hits after the debounce', async () => {
    const { result } = renderHook(() => useQuickSearch());

    await act(async () => {
      await result.current.search('alpha', null);
    });
    await flush();

    // Instant tier only so far: one keyword request, keyword hit visible.
    expect(searchMock).toHaveBeenCalledTimes(1);
    expect(searchMock.mock.calls[0][0]).toMatchObject({ mode: 'keyword' });
    expect(result.current.results.map((r) => r.node.id)).toEqual(['doc-a']);
    // Semantic status is not reported until the hybrid tier resolves.
    expect(result.current.semanticStatus).toBe('unknown');

    // Debounced hybrid tier fires and merges below the keyword hit.
    await advance(300);
    await flush();

    expect(searchMock).toHaveBeenCalledTimes(2);
    expect(searchMock.mock.calls[1][0]).toMatchObject({ mode: 'hybrid' });
    expect(result.current.results.map((r) => r.node.id)).toEqual(['doc-a', 'doc-b']);
    expect(result.current.semanticStatus).toBe('ready');
  });

  it('does not fire the hybrid tier for queries under the min length', async () => {
    const { result } = renderHook(() => useQuickSearch());

    await act(async () => {
      await result.current.search('al', null);
    });
    await advance(1000);
    await flush();

    expect(searchMock).toHaveBeenCalledTimes(1);
    expect(searchMock.mock.calls[0][0]).toMatchObject({ mode: 'keyword' });
  });

  it('uses semantic mode without issuing a keyword request when vector is selected alone', async () => {
    const { result } = renderHook(() => useQuickSearch());

    await act(async () => {
      await result.current.search('concept', null, null, { keyword: false, vector: true });
    });
    await flush();

    expect(searchMock).not.toHaveBeenCalled();
    await advance(300);
    await flush();

    expect(searchMock).toHaveBeenCalledTimes(1);
    expect(searchMock.mock.calls[0][0]).toMatchObject({ mode: 'semantic' });
  });

  it('never schedules a third settled rerank request', async () => {
    const { result } = renderHook(() => useQuickSearch());

    await act(async () => {
      await result.current.search('bravo', null);
    });
    await advance(1000);
    await flush();

    expect(searchMock).toHaveBeenCalledTimes(2);
    expect(searchMock.mock.calls.map(([request]) => request.mode)).toEqual(['keyword', 'hybrid']);
    expect(searchMock.mock.calls.every(([request]) => !('settled' in request))).toBe(true);
    expect(result.current.results.map((item) => item.node.id)).toEqual(['doc-a', 'doc-b']);
  });
});

describe('useQuickSearch freshness', () => {
  const treeDoc: DocTreeNode = {
    kind: 'doc',
    id: 'doc-1111111111111-aaaaaaaaa',
    containerId: null,
    title: 'Alpha notes',
    content: '',
    sortOrder: 0,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };

  it('retries the workspace tree after a failed read instead of caching it empty', async () => {
    listTreeMock.mockRejectedValueOnce(new Error('offline')).mockResolvedValue([treeDoc]);
    const { result } = renderHook(() => useQuickSearch());

    await act(async () => {
      await result.current.search('alpha', null);
    });
    expect(result.current.sections.find((section) => section.id === 'lexical')).toBeUndefined();

    await act(async () => {
      await result.current.search('alpha n', null);
    });
    const lexical = result.current.sections.find((section) => section.id === 'lexical');
    expect(lexical?.results.map((r) => r.node.id)).toEqual([treeDoc.id]);
  });

  it('keeps the newer query when an older keyword request resolves last', async () => {
    let resolveOlder: (value: PaletteAugmentedResponse) => void = () => undefined;
    searchMock.mockImplementation((req) =>
      req.query === 'old query'
        ? new Promise<PaletteAugmentedResponse>((resolve) => {
            resolveOlder = resolve;
          })
        : Promise.resolve(response([hit('doc-new', 'Newer', 'fts')], 'disabled'))
    );
    const { result } = renderHook(() => useQuickSearch());

    await act(async () => {
      void result.current.search('old query', null, null, { keyword: true, vector: false });
    });
    await act(async () => {
      await result.current.search('new query', null, null, { keyword: true, vector: false });
    });
    await flush();
    await act(async () => {
      resolveOlder(response([hit('doc-old', 'Older', 'fts')], 'disabled'));
    });
    await flush();

    expect(result.current.results.map((r) => r.node.id)).toEqual(['doc-new']);
  });
});

describe('useQuickSearch entries', () => {
  // Scores as the server gives them: 1 for the whole Name, 0.9 for its start,
  // 0.8 inside it, 0.2–0.7 for fuzzy or another field.
  const entry = (n: number, name: string, score = 0.8): PaletteEntryHit => ({
    tableId: 'table-1111111111111-aaaaaaaaa',
    tableName: 'item_list',
    projectId: null,
    entryId: `00000000-0000-4000-8000-00000000000${n}`,
    name,
    score,
    createdAt: '2026-01-01T00:00:00.000Z',
  });

  const threadHit = (id: string, title: string): PaletteSearchHit => ({
    node_id: id,
    kind: 'thread',
    score: 0.9,
    channels: ['fts'],
    payload: { title, projectId: null, sortOrder: 0 },
  });

  /** A keyword answer with Docs and Threads sections plus these rows. */
  function answerWithEntries(entries: PaletteEntryHit[]) {
    const docsAndThreads: PaletteAugmentedResponse = {
      ...keywordResponse,
      byKind: {
        doc: [hit('doc-a', 'Orchid notes', 'fts')],
        thread: [threadHit('thread-a', 'Orchid chat')],
      },
    };
    searchMock.mockImplementation((req) =>
      Promise.resolve(req.mode === 'keyword' ? { ...docsAndThreads, entries } : hybridResponse)
    );
  }

  async function searchUnfiltered(term: string) {
    const { result } = renderHook(() => useQuickSearch());
    await act(async () => {
      await result.current.search(term, null, null, { keyword: true, vector: false });
    });
    await flush();
    return result;
  }

  it('asks an unfiltered keyword search for a short Entries section, listed after every kind', async () => {
    answerWithEntries([entry(1, 'Big orchid plan'), entry(2, '', 0.2)]);
    const result = await searchUnfiltered('orchid');

    expect(searchMock.mock.calls[0][0]).toMatchObject({ mode: 'keyword', includeEntries: true });
    expect(result.current.sections.map((section) => section.label)).toEqual([
      'Docs',
      'Threads',
      'Entries',
    ]);
    const entries = result.current.sections[2]!.results;
    expect(entries.map((r) => r.label)).toEqual([
      'Big orchid plan · item_list',
      'Untitled · item_list',
    ]);
    expect(entries[0]).toMatchObject({ kindLabel: 'Entry', node: { kind: 'entry' } });
  });

  it('lists strong Name matches right after the first section and the rest at the bottom, once each', async () => {
    answerWithEntries([
      entry(1, 'Orchid', 1),
      entry(2, 'Orchid plan', 0.9),
      entry(3, 'Big orchid plan', 0.8),
      entry(4, '', 0.2),
    ]);
    const result = await searchUnfiltered('orchid');

    expect(result.current.sections.map((section) => section.label)).toEqual([
      'Docs',
      'Entries',
      'Threads',
      'More entries',
    ]);
    const ids = result.current.results.map((r) => r.node.id);
    expect(ids).toEqual([
      'doc-a',
      entry(1, '').entryId,
      entry(2, '').entryId,
      'thread-a',
      entry(3, '').entryId,
      entry(4, '').entryId,
    ]);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('moves every row up when all of them are strong, and lists them alone when nothing else matches', async () => {
    answerWithEntries([entry(1, 'Orchid plan', 0.9)]);
    const result = await searchUnfiltered('orchid');
    expect(result.current.sections.map((section) => section.label)).toEqual([
      'Docs',
      'Entries',
      'Threads',
    ]);

    searchMock.mockImplementation(() =>
      Promise.resolve({
        ...response([], 'disabled'),
        entries: [entry(1, 'Orchid plan', 0.9), entry(2, 'Big orchid plan')],
      })
    );
    await act(async () => {
      await result.current.search('orchid p', null, null, { keyword: true, vector: false });
    });
    await flush();
    expect(result.current.sections.map((section) => section.label)).toEqual(['Entries']);
    expect(result.current.results.map((r) => r.label)).toEqual([
      'Orchid plan · item_list',
      'Big orchid plan · item_list',
    ]);
  });

  it('does not ask a kind-filtered search for entries', async () => {
    const { result } = renderHook(() => useQuickSearch());

    await act(async () => {
      await result.current.search('orchid', ['doc'], null, { keyword: true, vector: false });
    });
    await flush();

    expect(searchMock.mock.calls[0][0]).not.toHaveProperty('includeEntries');
  });

  it('asks a table-only filter for rows too, but no other filter', async () => {
    const { result } = renderHook(() => useQuickSearch());
    await act(async () => {
      await result.current.search('orchid', ['table'], null, { keyword: true, vector: false });
    });
    await flush();
    expect(searchMock.mock.calls[0][0]).toMatchObject({ kinds: ['table'], includeEntries: true });
    searchMock.mockClear();
    await act(async () => {
      await result.current.search('orchid', ['table', 'doc'], null, {
        keyword: true,
        vector: false,
      });
    });
    await flush();
    expect(searchMock.mock.calls[0][0]).not.toHaveProperty('includeEntries');
  });

  it('sends an entry filter as one keyword request with its table quoted', async () => {
    searchMock.mockImplementation(() =>
      Promise.resolve({
        ...response([], 'disabled'),
        entries: [entry(1, 'Orchid plan', 0.9), entry(2, 'Big orchid plan', 0.8)],
      })
    );
    const { result } = renderHook(() => useQuickSearch());

    await act(async () => {
      await result.current.search('orchid plan', null, null, undefined, { table: 'Item list' });
    });
    await advance(1000);
    await flush();

    // No semantic tier and no workspace tree walk for rows.
    expect(searchMock).toHaveBeenCalledTimes(1);
    expect(searchMock.mock.calls[0][0]).toMatchObject({
      query: 'table:"Item list" entry: orchid plan',
      mode: 'keyword',
    });
    // Strong and weak rows alike stay one Entries section, in server order.
    expect(result.current.sections.map((section) => section.label)).toEqual(['Entries']);
    expect(result.current.results.map((r) => r.label)).toEqual([
      'Orchid plan · item_list',
      'Big orchid plan · item_list',
    ]);

    await act(async () => {
      await result.current.search('', null, null, undefined, { table: null });
    });
    expect(searchMock.mock.calls[1][0]).toMatchObject({ query: 'entry:', mode: 'keyword' });
  });
});

describe('useQuickSearch matches found only by meaning', () => {
  const meaningHit: PaletteSearchHit = {
    node_id: 'doc-1111111111111-aaaaaaaaa',
    kind: 'doc',
    score: 0.01,
    channels: ['vector'],
    vectorSimilarity: 0.45,
    payload: { title: 'Nearby doc', containerId: null, sortOrder: 0 },
  };
  const meaningFile: PaletteFileNodeItem = {
    type: 'file-node',
    nodeId: 'file-1111111111111-aaaaaaaaa',
    relativePath: 'notes/loose-ends.md',
    absolutePath: '/tmp/project/notes/loose-ends.md',
    projectId: 'project-1',
    sizeBytes: 512,
    updatedAt: '2026-01-01T00:00:00.000Z',
    score: 0.42,
  };

  beforeEach(() => {
    searchMock.mockImplementation((req) =>
      Promise.resolve(
        req.mode === 'keyword'
          ? response([], 'disabled')
          : { ...response([meaningHit], 'ready'), files: [meaningFile] }
      )
    );
  });

  it('shows the semantic tier results when nothing matched the words', async () => {
    const { result } = renderHook(() => useQuickSearch());

    await act(async () => {
      await result.current.search('zzqv', null);
    });
    await advance(300);
    await flush();

    expect(searchMock.mock.calls.map(([request]) => request.mode)).toEqual(['keyword', 'hybrid']);
    expect(result.current.sections.map((section) => section.label)).toEqual(['Docs']);
    expect(result.current.results.map((r) => r.node.id)).toEqual(['doc-1111111111111-aaaaaaaaa']);
    expect(result.current.fileResults).toEqual([meaningFile]);
  });
});

describe('useQuickSearch result locations', () => {
  const stamp = '2026-01-01T00:00:00.000Z';
  const backups: DocTreeNode = {
    kind: 'doc',
    id: 'doc-1111111111111-aaaaaaaaa',
    containerId: 'container-features',
    title: 'Backups',
    content: '',
    sortOrder: 0,
    createdAt: stamp,
    updatedAt: stamp,
  };
  const looseDoc: DocTreeNode = {
    ...backups,
    id: 'doc-2222222222222-bbbbbbbbb',
    containerId: null,
    title: 'Backup plan',
  };
  const tree: ContainerTreeNode[] = [
    {
      kind: 'container',
      id: 'container-onboarding',
      parentId: null,
      name: 'Onboarding',
      sortOrder: 0,
      createdAt: stamp,
      updatedAt: stamp,
      category: null,
      folderPath: null,
      githubUrl: null,
      children: [
        {
          kind: 'container',
          id: 'container-features',
          parentId: 'container-onboarding',
          name: 'Features',
          sortOrder: 0,
          createdAt: stamp,
          updatedAt: stamp,
          category: null,
          folderPath: null,
          githubUrl: null,
          children: [backups],
        },
      ],
    },
  ];
  const restoreHit: PaletteSearchHit = {
    node_id: 'doc-3333333333333-ccccccccc',
    kind: 'doc',
    score: 0.9,
    channels: ['fts'],
    payload: { title: 'Restore', containerId: 'container-onboarding', sortOrder: 0 },
  };

  it('says where each result lives in the workspace tree', async () => {
    listTreeMock.mockResolvedValue([...tree, looseDoc]);
    searchMock.mockImplementation(() => Promise.resolve(response([restoreHit], 'disabled')));
    const { result } = renderHook(() => useQuickSearch());

    await act(async () => {
      await result.current.search('backup', null, null, { keyword: true, vector: false });
    });
    await flush();

    const locations = Object.fromEntries(
      result.current.results.map((r) => [r.label, r.location] as const)
    );
    expect(locations).toEqual({
      Backups: 'Onboarding / Features',
      'Backup plan': 'Workspace',
      Restore: 'Onboarding',
    });
  });

  it('loads the tree for paths when only search by meaning is on', async () => {
    listTreeMock.mockResolvedValue(tree);
    searchMock.mockImplementation(() => Promise.resolve(response([restoreHit], 'ready')));
    const { result } = renderHook(() => useQuickSearch());

    await act(async () => {
      await result.current.search('restoring', null, null, { keyword: false, vector: true });
    });
    await advance(300);
    await flush();

    expect(result.current.results.map((r) => [r.label, r.location])).toEqual([
      ['Restore', 'Onboarding'],
    ]);
  });

  it('labels the name matches for people, not by the engine that found them', async () => {
    listTreeMock.mockResolvedValue([looseDoc]);
    searchMock.mockImplementation(() => Promise.resolve(response([], 'disabled')));
    const { result } = renderHook(() => useQuickSearch());

    await act(async () => {
      await result.current.search('backup', null, null, { keyword: true, vector: false });
    });
    await flush();

    expect(result.current.sections.map((section) => section.label)).toEqual(['Best matches']);
  });
});
