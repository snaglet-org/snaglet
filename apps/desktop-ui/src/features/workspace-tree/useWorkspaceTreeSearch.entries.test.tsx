import { act, renderHook } from '@testing-library/react';
import type { KeyboardEvent as ReactKeyboardEvent } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  PaletteAugmentedResponse,
  PaletteEntryHit,
  PaletteSearchHit,
} from '@desktop/utils/api';
import { useWorkspaceTreeSearch } from './useWorkspaceTreeSearch';

vi.hoisted(() => {
  vi.stubEnv('VITE_API_BASE_URL', '/api');
  vi.stubEnv('VITE_APP_NAME', 'Snaglet');
});

const tiered = vi.hoisted(() => ({
  state: { instant: null, enriched: null },
  options: [] as unknown[],
}));

vi.mock('@desktop/hooks/useTieredSearch', async () => {
  const actual = await vi.importActual<typeof import('@desktop/hooks/useTieredSearch')>(
    '@desktop/hooks/useTieredSearch'
  );
  return {
    ...actual,
    useTieredSearch: (options: unknown) => {
      tiered.options.push(options);
      return { ...tiered.state, instantLoading: false, enrichmentLoading: false };
    },
  };
});

function hit(kind: string, id: string, score = 1): PaletteSearchHit {
  return {
    node_id: id,
    kind,
    score,
    channels: ['fts'],
    payload: { title: id },
  } as PaletteSearchHit;
}

function entry(tableId: string, entryId: string, name: string): PaletteEntryHit {
  return {
    tableId,
    tableName: 'quotes',
    projectId: null,
    entryId,
    name,
    score: 0.5,
    createdAt: '2026-10-19T10:00:00.000000Z',
  };
}

function respond(byKind: Record<string, PaletteSearchHit[]>, entries: PaletteEntryHit[] = []) {
  tiered.state = {
    instant: { byKind, entries } as unknown as PaletteAugmentedResponse,
    enriched: null,
  } as never;
}

function setup(onOpenEntry = vi.fn(), onOpenTable = vi.fn()) {
  const onNodeClick = vi.fn();
  const onCrossViewReveal = vi.fn();
  const view = renderHook(() =>
    useWorkspaceTreeSearch({
      onNodeClick,
      onOpenEntry,
      onOpenTable,
      onCrossViewReveal,
      nodeIndexRef: { current: new Map() },
      pendingOpenIdRef: { current: null },
    })
  );
  act(() => view.result.current.handleSearchChange({ target: { value: 'courage' } } as never));
  return { view, onOpenEntry, onOpenTable, onNodeClick, onCrossViewReveal };
}

function key(init: Partial<KeyboardEvent> & { key: string }) {
  return {
    preventDefault: vi.fn(),
    metaKey: false,
    ctrlKey: false,
    ...init,
  } as unknown as ReactKeyboardEvent<HTMLInputElement>;
}

beforeEach(() => {
  tiered.options.length = 0;
  respond({});
});

describe('sidebar search: table rows and tables', () => {
  it('asks for table rows, unless the search is scoped to a kind', () => {
    const { view } = setup();
    expect(tiered.options[tiered.options.length - 1]).toMatchObject({
      includeEntries: true,
      query: 'courage',
    });
    act(() =>
      view.result.current.handleSearchChange({ target: { value: 'docs: courage' } } as never)
    );
    expect(tiered.options[tiered.options.length - 1]).toMatchObject({
      includeEntries: false,
      kinds: ['doc'],
    });
  });

  it('`table:` alone keeps the rows: its results are the tables, then their rows', () => {
    const { view } = setup();
    act(() =>
      view.result.current.handleSearchChange({ target: { value: 'table: courage' } } as never)
    );
    expect(tiered.options[tiered.options.length - 1]).toMatchObject({
      includeEntries: true,
      kinds: ['table'],
    });
  });

  it('lists the rows the server returned, a few at most', () => {
    respond(
      {},
      Array.from({ length: 8 }, (_, i) => entry('table-1', `row-${i}`, `Quote ${i}`))
    );
    const { view } = setup();
    expect(view.result.current.entryResults.map((e) => e.entryId)).toEqual([
      'row-0',
      'row-1',
      'row-2',
      'row-3',
      'row-4',
    ]);
  });

  it('picking a row opens its window, ⌘/Ctrl highlights it in its table, and closes the search', () => {
    respond({}, [entry('table-1', 'row-1', 'Courage is…')]);
    const { view, onOpenEntry } = setup();
    act(() => view.result.current.handleEntryResultClick(view.result.current.entryResults[0]!));
    expect(onOpenEntry).toHaveBeenLastCalledWith('table-1', 'row-1', 'window');
    expect(view.result.current.searchOpen).toBe(false);
    expect(view.result.current.searchQuery).toBe('Courage is…');
    act(() =>
      view.result.current.handleEntryResultClick(view.result.current.entryResults[0]!, {
        secondary: true,
      })
    );
    expect(onOpenEntry).toHaveBeenLastCalledWith('table-1', 'row-1', 'highlight');
  });

  it('arrow keys walk the node hits and then the rows; Enter opens the active one', () => {
    respond({ doc: [hit('doc', 'doc-1')] }, [entry('table-1', 'row-1', 'Courage is…')]);
    const { view, onOpenEntry, onNodeClick } = setup();
    expect(view.result.current.searchResults).toHaveLength(1);
    // Down once: from the doc (0) to the row (1).
    act(() => view.result.current.handleSearchKeyDown(key({ key: 'ArrowDown' })));
    expect(view.result.current.searchActiveIndex).toBe(1);
    act(() => view.result.current.handleSearchKeyDown(key({ key: 'Enter' })));
    expect(onOpenEntry).toHaveBeenCalledWith('table-1', 'row-1', 'window');
    expect(onNodeClick).not.toHaveBeenCalled();
    // ⌘+Enter highlights; Down again wraps to the doc.
    respond({ doc: [hit('doc', 'doc-1')] }, [entry('table-1', 'row-1', 'Courage is…')]);
    act(() => view.result.current.setSearchOpen(true));
    act(() => view.result.current.setSearchActiveIndex(1));
    act(() => view.result.current.handleSearchKeyDown(key({ key: 'Enter', metaKey: true })));
    expect(onOpenEntry).toHaveBeenLastCalledWith('table-1', 'row-1', 'highlight');
    act(() => view.result.current.setSearchActiveIndex(1));
    act(() => view.result.current.handleSearchKeyDown(key({ key: 'ArrowDown' })));
    expect(view.result.current.searchActiveIndex).toBe(0);
  });

  it('keeps up to two table hits in the list when other kinds fill it', () => {
    respond({
      message: Array.from({ length: 10 }, (_, i) => hit('message', `message-${i}`, 5)),
      table: [hit('table', 'table-a', 1), hit('table', 'table-b', 1), hit('table', 'table-c', 1)],
    });
    const { view } = setup();
    const kinds = view.result.current.searchResults.map((r) => r.kind);
    expect(kinds).toHaveLength(8);
    expect(kinds.filter((k) => k === 'table')).toHaveLength(2);
    expect(
      view.result.current.searchResults.filter((r) => r.kind === 'table').map((r) => r.node_id)
    ).toEqual(['table-a', 'table-b']);
  });

  it('`entry:` becomes a chip that scopes the search to table rows', () => {
    respond({ doc: [hit('doc', 'doc-1')] }, [entry('table-1', 'row-1', 'Courage is…')]);
    const { view } = setup();
    act(() =>
      view.result.current.handleSearchChange({ target: { value: 'entry: courage' } } as never)
    );
    expect(view.result.current.entryFilter).toBe(true);
    expect(view.result.current.searchQuery).toBe('courage');
    expect(view.result.current.searchResults).toEqual([]);
    expect(tiered.options[tiered.options.length - 1]).toMatchObject({ query: 'entry: courage' });
    act(() => view.result.current.removeEntryFilter());
    expect(view.result.current.entryFilter).toBe(false);
  });

  it('`table:work_items:entry:` scopes the row search to that table', () => {
    const { view } = setup();
    act(() =>
      view.result.current.handleSearchChange({
        target: { value: 'table:work_items:entry:courage' },
      } as never)
    );
    expect(view.result.current.entryFilter).toBe(true);
    expect(view.result.current.entryTable).toBe('work_items');
    expect(view.result.current.searchQuery).toBe('courage');
    expect(tiered.options[tiered.options.length - 1]).toMatchObject({
      query: 'table:"work_items" entry: courage',
    });
    act(() => view.result.current.removeEntryFilter());
    expect(view.result.current.entryTable).toBeNull();
  });

  it('after a `table:` chip, `work_items:entry:` turns it into the scoped row search', () => {
    const { view } = setup();
    act(() => view.result.current.handleSearchChange({ target: { value: 'table:' } } as never));
    expect(view.result.current.searchFilterKinds).toEqual(['table']);
    act(() =>
      view.result.current.handleSearchChange({ target: { value: 'work_items:entry:x' } } as never)
    );
    expect(view.result.current.searchFilterKinds).toEqual([]);
    expect(view.result.current.entryTable).toBe('work_items');
    expect(view.result.current.searchQuery).toBe('x');
  });

  it('a picked table is revealed in the tree and opened, not sent to the Database view', () => {
    respond({ table: [hit('table', 'table-a')] });
    const { view, onOpenTable, onCrossViewReveal } = setup();
    const before = view.result.current.searchRevealNonce;
    act(() => view.result.current.handleSearchResultClick(view.result.current.searchResults[0]!));
    expect(onOpenTable).toHaveBeenCalledWith('table-a');
    expect(onCrossViewReveal).not.toHaveBeenCalled();
    expect(view.result.current.searchRevealId).toBe('table-a');
    expect(view.result.current.searchRevealNonce).toBe(before + 1);
    expect(view.result.current.searchOpen).toBe(false);
  });

  it('a picked row also reveals its table in the tree', () => {
    respond({}, [entry('table-1', 'row-1', 'Courage is…')]);
    const { view, onOpenEntry } = setup();
    act(() => view.result.current.handleEntryResultClick(view.result.current.entryResults[0]!));
    expect(onOpenEntry).toHaveBeenCalledWith('table-1', 'row-1', 'window');
    expect(view.result.current.searchRevealId).toBe('table-1');
  });
});
