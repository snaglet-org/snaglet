import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { TableCatalogEntry } from '@snaglet/shared/types';
import { emitTableEvent } from './tableEvents';
import { __resetTableCatalogForTests, useTableCatalog } from './useTableCatalog';

const api = vi.hoisted(() => ({ list: vi.fn() }));

vi.mock('@desktop/utils/api', async () => {
  const actual = await vi.importActual<typeof import('@desktop/utils/api')>('@desktop/utils/api');
  return { ...actual, tablesApi: { ...actual.tablesApi, list: api.list } };
});

const timestamp = '2026-01-01T00:00:00.000Z';

const entry = (
  id: string,
  name: string,
  origin: TableCatalogEntry['origin'] = 'custom'
): TableCatalogEntry => ({ id, name, origin, projectId: null, sortOrder: 0, createdAt: timestamp });

const readingList = entry('table-1111111111111-aaaaaaaaa', 'reading_list');
const budget = entry('table-2222222222222-bbbbbbbbb', 'budget');
const builtinDocs = entry('table-builtin-docs', 'Docs', 'builtin');

function deferred<T>() {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

const names = (tables: TableCatalogEntry[] | null) => tables?.map((table) => table.name);

beforeEach(() => {
  __resetTableCatalogForTests();
  api.list.mockReset().mockResolvedValue({ tables: [builtinDocs, readingList, budget] });
});

describe('useTableCatalog', () => {
  it('fetches once for two mounted readers and patches both on table.updated', async () => {
    const first = renderHook(() => useTableCatalog(true));
    const second = renderHook(() => useTableCatalog(true));
    expect(first.result.current.tables).toBeNull();

    await waitFor(() => expect(first.result.current.tables).toHaveLength(3));
    expect(second.result.current.tables).toBe(first.result.current.tables);
    expect(api.list).toHaveBeenCalledTimes(1);

    const renamed = { ...readingList, name: 'almanac' };
    act(() => emitTableEvent({ type: 'table.updated', table: renamed }));
    expect(names(first.result.current.tables)).toEqual(['Docs', 'almanac', 'budget']);
    expect(second.result.current.tables).toBe(first.result.current.tables);
    expect(api.list).toHaveBeenCalledTimes(1);
  });

  it('never fetches for a disabled reader but lets it read the cached list', async () => {
    const disabled = renderHook(() => useTableCatalog(false));
    await act(async () => undefined);
    expect(api.list).not.toHaveBeenCalled();
    expect(disabled.result.current.tables).toBeNull();

    renderHook(() => useTableCatalog(true));
    await waitFor(() => expect(disabled.result.current.tables).toHaveLength(3));
    expect(api.list).toHaveBeenCalledTimes(1);
  });

  it('loads once a reader becomes enabled and keeps the list when it is disabled again', async () => {
    const { result, rerender } = renderHook(({ enabled }) => useTableCatalog(enabled), {
      initialProps: { enabled: false },
    });
    await act(async () => undefined);
    expect(api.list).not.toHaveBeenCalled();

    rerender({ enabled: true });
    await waitFor(() => expect(result.current.tables).toHaveLength(3));
    rerender({ enabled: false });
    expect(result.current.tables).toHaveLength(3);
    expect(api.list).toHaveBeenCalledTimes(1);
  });

  it('reports a failed load and clears it on a successful reload', async () => {
    api.list.mockRejectedValueOnce(new Error('HTTP 502'));
    const { result } = renderHook(() => useTableCatalog(true));
    await waitFor(() => expect(result.current.error).toBe('HTTP 502'));
    expect(result.current.tables).toBeNull();

    act(() => result.current.reload());
    await waitFor(() => expect(result.current.tables).toHaveLength(3));
    expect(result.current.error).toBeNull();
  });

  it('drops archived rows, filters server-archived entries and re-adds a restored table once', async () => {
    api.list.mockResolvedValue({
      tables: [builtinDocs, readingList, { ...budget, state: 'archived', archivedAt: timestamp }],
    });
    const { result } = renderHook(() => useTableCatalog(true));
    await waitFor(() => expect(names(result.current.tables)).toEqual(['Docs', 'reading_list']));

    act(() => {
      emitTableEvent({ type: 'table.removed', tableId: readingList.id, state: 'archived' });
      emitTableEvent({ type: 'table.removed', tableId: readingList.id, state: 'archived' });
    });
    expect(names(result.current.tables)).toEqual(['Docs']);

    const restored = { ...readingList, name: 'reading_list_old' };
    act(() => {
      emitTableEvent({ type: 'table.restored', table: restored });
      emitTableEvent({ type: 'table.restored', table: restored });
    });
    expect(names(result.current.tables)).toEqual(['Docs', 'reading_list_old']);
  });

  it('merges events heard while the load is in flight into its result', async () => {
    const pending = deferred<{ tables: TableCatalogEntry[] }>();
    api.list.mockReturnValue(pending.promise);
    const { result } = renderHook(() => useTableCatalog(true));
    const created = entry('table-3333333333333-ccccccccc', 'notes');
    act(() => {
      emitTableEvent({ type: 'table.removed', tableId: readingList.id, state: 'archived' });
      emitTableEvent({ type: 'table.created', table: created });
    });

    await act(async () => pending.resolve({ tables: [builtinDocs, readingList, budget] }));
    expect(names(result.current.tables)).toEqual(['Docs', 'budget', 'notes']);
  });

  it('refetches on tables.invalidated only once a reader has asked for the list', async () => {
    renderHook(() => useTableCatalog(false));
    act(() => emitTableEvent({ type: 'tables.invalidated' }));
    await act(async () => undefined);
    expect(api.list).not.toHaveBeenCalled();

    const { result } = renderHook(() => useTableCatalog(true));
    await waitFor(() => expect(result.current.tables).toHaveLength(3));
    api.list.mockResolvedValue({ tables: [builtinDocs, budget] });
    act(() => emitTableEvent({ type: 'tables.invalidated' }));
    await waitFor(() => expect(names(result.current.tables)).toEqual(['Docs', 'budget']));
    expect(api.list).toHaveBeenCalledTimes(2);
  });
});
