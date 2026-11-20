import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { TableCatalogEntry } from '@snaglet/shared/types';

const api = vi.hoisted(() => ({ list: vi.fn(), archived: vi.fn() }));

vi.mock('@desktop/utils/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@desktop/utils/api')>();
  return {
    ...actual,
    tablesApi: { ...actual.tablesApi, list: api.list },
    archiveApi: { ...actual.archiveApi, tables: api.archived },
  };
});

const entry = (id: string, name: string): TableCatalogEntry => ({
  id,
  name,
  origin: 'custom',
  projectId: null,
  sortOrder: 0,
  createdAt: '2026-01-01T00:00:00.000Z',
});
const readingList = entry('table-1111111111111-aaaaaaaaa', 'Reading list');
const budget = entry('table-2222222222222-bbbbbbbbb', 'Budget');

const UNKNOWN = { name: null, unavailable: false, archived: false };
const UNAVAILABLE = { name: null, unavailable: true, archived: false };
const live = (name: string) => ({ name, unavailable: false, archived: false });
const archivedName = (name: string) => ({ name, unavailable: false, archived: true });

/** Fresh module state per test: the cache is module-level by design. */
async function load() {
  const [{ useLiveTableName, getCachedTableEntry }, { emitTableEvent }] = await Promise.all([
    import('./tableNameCache'),
    import('./tableEvents'),
  ]);
  return { useLiveTableName, getCachedTableEntry, emitTableEvent };
}

describe('tableNameCache', () => {
  beforeEach(() => {
    vi.resetModules();
    api.list.mockReset().mockResolvedValue({ tables: [readingList] });
    api.archived.mockReset().mockResolvedValue({ tables: [] });
  });

  it('loads once for many chips and reads unknown until the catalog lands', async () => {
    const { useLiveTableName } = await load();
    const first = renderHook(() => useLiveTableName(readingList.id));
    const second = renderHook(() => useLiveTableName(budget.id));
    expect(first.result.current).toEqual(UNKNOWN);

    await waitFor(() => expect(first.result.current).toEqual(live('Reading list')));
    expect(second.result.current).toEqual(UNAVAILABLE);
    expect(api.list).toHaveBeenCalledTimes(1);
  });

  it('makes a table created after the load available without refetching', async () => {
    const { useLiveTableName, getCachedTableEntry, emitTableEvent } = await load();
    const hook = renderHook(() => useLiveTableName(budget.id));
    await waitFor(() => expect(hook.result.current.unavailable).toBe(true));

    act(() => emitTableEvent({ type: 'table.created', table: budget }));
    expect(hook.result.current).toEqual(live('Budget'));
    expect(getCachedTableEntry(budget.id)).toEqual(budget);
    expect(api.list).toHaveBeenCalledTimes(1);
  });

  it('refetches on tables.invalidated so a table that is gone reads unavailable', async () => {
    const { useLiveTableName, emitTableEvent } = await load();
    const hook = renderHook(() => useLiveTableName(readingList.id));
    await waitFor(() => expect(hook.result.current.name).toBe('Reading list'));

    api.list.mockResolvedValue({ tables: [budget] });
    act(() => emitTableEvent({ type: 'tables.invalidated' }));
    await waitFor(() => expect(hook.result.current).toEqual(UNAVAILABLE));
    expect(api.list).toHaveBeenCalledTimes(2);
  });

  it('keeps a rename heard while the load is in flight over the older response', async () => {
    let resolve: (value: { tables: TableCatalogEntry[] }) => void = () => undefined;
    api.list.mockReturnValue(new Promise((r) => (resolve = r)));
    const { useLiveTableName, emitTableEvent } = await load();
    const hook = renderHook(() => useLiveTableName(readingList.id));
    await waitFor(() => expect(api.list).toHaveBeenCalled());

    act(() =>
      emitTableEvent({ type: 'table.updated', table: { ...readingList, name: 'Book club' } })
    );
    await act(async () => resolve({ tables: [readingList] }));
    expect(hook.result.current).toEqual(live('Book club'));
  });

  it('keeps an archived table readable by name, from the archive list', async () => {
    api.archived.mockResolvedValue({
      tables: [{ ...budget, state: 'archived', archivedAt: '2026-01-02T00:00:00.000Z' }],
    });
    const { useLiveTableName, getCachedTableEntry } = await load();
    const hook = renderHook(() => useLiveTableName(budget.id));

    await waitFor(() => expect(hook.result.current).toEqual(archivedName('Budget')));
    // Only active tables count as cached catalog entries (e.g. for renames).
    expect(getCachedTableEntry(budget.id)).toBeNull();
  });

  it('marks a table archived in place, back on restore, and unavailable once deleted', async () => {
    const { useLiveTableName, emitTableEvent } = await load();
    const hook = renderHook(() => useLiveTableName(readingList.id));
    await waitFor(() => expect(hook.result.current).toEqual(live('Reading list')));

    act(() =>
      emitTableEvent({ type: 'table.removed', tableId: readingList.id, state: 'archived' })
    );
    expect(hook.result.current).toEqual(archivedName('Reading list'));

    act(() =>
      emitTableEvent({ type: 'table.restored', table: { ...readingList, name: 'Reading notes' } })
    );
    expect(hook.result.current).toEqual(live('Reading notes'));

    act(() => emitTableEvent({ type: 'table.removed', tableId: readingList.id, state: 'deleted' }));
    expect(hook.result.current).toEqual(UNAVAILABLE);
    expect(api.list).toHaveBeenCalledTimes(1);
  });

  it('reads the name of a table archived elsewhere that it never saw', async () => {
    const { useLiveTableName, emitTableEvent } = await load();
    const hook = renderHook(() => useLiveTableName(budget.id));
    await waitFor(() => expect(hook.result.current).toEqual(UNAVAILABLE));

    api.archived.mockResolvedValue({ tables: [{ ...budget, state: 'archived' }] });
    act(() => emitTableEvent({ type: 'table.removed', tableId: budget.id, state: 'archived' }));

    await waitFor(() => expect(hook.result.current).toEqual(archivedName('Budget')));
    expect(api.list).toHaveBeenCalledTimes(2);
  });

  it('falls back to unavailable when the archive list cannot be read', async () => {
    api.archived.mockRejectedValue(new Error('HTTP 502'));
    const { useLiveTableName } = await load();
    const active = renderHook(() => useLiveTableName(readingList.id));
    const missing = renderHook(() => useLiveTableName(budget.id));

    await waitFor(() => expect(active.result.current).toEqual(live('Reading list')));
    expect(missing.result.current).toEqual(UNAVAILABLE);
  });
});
