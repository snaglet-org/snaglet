import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TableEntriesQuery, TableEntriesResponse, TableEntry } from '@snaglet/shared/types';
import { emitTableEvent } from '@desktop/features/database/tableEvents';
import { FetchError } from '@desktop/utils/api';
import { useTableEntries } from './useTableEntries';

const api = vi.hoisted(() => ({
  entries: vi.fn<(tableId: string, query: TableEntriesQuery) => Promise<TableEntriesResponse>>(),
}));
vi.mock('@desktop/utils/api', async () => {
  const { FetchError } = await import('@desktop/utils/api/core');
  return { tablesApi: api, FetchError };
});
vi.mock('@desktop/features/database', () => import('@desktop/features/database/tableEvents'));

const tableId = 'table-1111111111111-aaaaaaaaa';
const entryId = (index: number) => `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`;
const entry = (index: number): TableEntry => ({
  id: entryId(index),
  createdAt: '2026-01-01T00:00:00.000Z',
  revision: 'a'.repeat(64),
  values: {},
});
function response(page = 1, entries = [entry((page - 1) * 25 + 1)]): TableEntriesResponse {
  return {
    entries,
    totalCount: 100,
    page,
    pageSize: 25,
    fields: [],
    schemaVersion: 'b'.repeat(64),
    relatedEntries: {},
    relatedItems: {},
  };
}
function deferred<T>() {
  let resolve: (value: T) => void;
  let reject: (error: Error) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return {
    promise,
    resolve: (value: T) => resolve(value),
    reject: (error: Error) => reject(error),
  };
}
async function setup() {
  const view = renderHook(() => useTableEntries(tableId));
  await waitFor(() => expect(view.result.current.loading).toBe(false));
  return view;
}
beforeEach(() => {
  vi.resetAllMocks();
  localStorage.clear();
  api.entries.mockResolvedValue(response());
});
afterEach(cleanup);

describe('useTableEntries entry focus navigation', () => {
  it('seeks the entry, adopts the returned page, and exposes one completed focus request', async () => {
    const { result } = await setup();
    api.entries.mockResolvedValueOnce(response(3));
    act(() => result.current.focusEntry(entryId(51)));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(api.entries).toHaveBeenLastCalledWith(tableId, {
      focusEntryId: entryId(51),
      pageSize: 25,
    });
    expect(result.current.page).toBe(3);
    expect(result.current.result?.entries).toEqual([entry(51)]);
    expect(result.current.focusedEntry).toEqual({
      id: entryId(51),
      request: result.current.completedRequest,
    });
    expect(result.current.focusError).toBeNull();
  });

  it('re-seeks the same entry for each explicit request without remounting', async () => {
    const { result } = await setup();
    api.entries.mockResolvedValue(response(3));
    act(() => result.current.focusEntry(entryId(51)));
    await waitFor(() => expect(result.current.focusedEntry).not.toBeNull());
    const firstRequest = result.current.focusedEntry?.request;
    act(() => result.current.focusEntry(entryId(51)));
    await waitFor(() => expect(result.current.focusedEntry?.id).toBe(entryId(51)));
    expect(result.current.focusedEntry?.request).not.toBe(firstRequest);
    expect(api.entries).toHaveBeenCalledTimes(3);
    expect(api.entries).toHaveBeenLastCalledWith(tableId, {
      focusEntryId: entryId(51),
      pageSize: 25,
    });
  });

  it('lets ordinary paging and page-size changes leave the focus target behind', async () => {
    const { result } = await setup();
    api.entries.mockResolvedValueOnce(response(3));
    act(() => result.current.focusEntry(entryId(51)));
    await waitFor(() => expect(result.current.page).toBe(3));
    api.entries.mockResolvedValueOnce(response(4));
    act(() => result.current.setPage(4));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(api.entries).toHaveBeenLastCalledWith(tableId, { page: 4, pageSize: 25 });
    expect(result.current.focusedEntry).toBeNull();
    api.entries.mockResolvedValueOnce({ ...response(1), pageSize: 10 });
    act(() => result.current.changePageSize(10));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(api.entries).toHaveBeenLastCalledWith(tableId, { page: 1, pageSize: 10 });
    expect(result.current.page).toBe(1);
  });

  it('refreshes the current page on table events without seeking or re-flashing a consumed target', async () => {
    const { result } = await setup();
    api.entries.mockResolvedValue(response(3));
    act(() => result.current.focusEntry(entryId(51)));
    await waitFor(() => expect(result.current.page).toBe(3));
    const focused = result.current.focusedEntry;
    const events = [
      { type: 'table.entries.changed', tableId, entryId: entryId(70) },
      { type: 'table.fields.changed', tableId },
      { type: 'tables.invalidated' },
    ] as const;
    for (const event of events) {
      act(() => emitTableEvent(event));
      await waitFor(() => expect(result.current.loading).toBe(false));
      expect(api.entries).toHaveBeenLastCalledWith(tableId, { page: 3, pageSize: 25 });
      expect(result.current.focusedEntry).toBe(focused);
    }
    expect(api.entries).toHaveBeenCalledTimes(5);
    act(() =>
      emitTableEvent({
        type: 'table.entries.changed',
        tableId: 'table-2222222222222-bbbbbbbbb',
        entryId: entryId(1),
      })
    );
    expect(api.entries).toHaveBeenCalledTimes(5);
  });

  it('ignores an older seek response after a later target has loaded', async () => {
    const { result } = await setup();
    const older = deferred<TableEntriesResponse>();
    const newer = deferred<TableEntriesResponse>();
    api.entries.mockReturnValueOnce(older.promise).mockReturnValueOnce(newer.promise);
    act(() => result.current.focusEntry(entryId(26)));
    act(() => result.current.focusEntry(entryId(76)));
    await act(async () => newer.resolve(response(4)));
    const completed = result.current.completedRequest;
    await act(async () => older.resolve(response(2)));
    expect(result.current.page).toBe(4);
    expect(result.current.result?.entries).toEqual([entry(76)]);
    expect(result.current.focusedEntry?.id).toBe(entryId(76));
    expect(result.current.completedRequest).toBe(completed);
  });

  it('ignores a superseded seek failure after normal paging', async () => {
    const { result } = await setup();
    const seek = deferred<TableEntriesResponse>();
    api.entries.mockReturnValueOnce(seek.promise).mockResolvedValueOnce(response(2));
    act(() => result.current.focusEntry(entryId(76)));
    act(() => result.current.setPage(2));
    await waitFor(() => expect(result.current.loading).toBe(false));
    await act(async () => seek.reject(new FetchError('Entry not found', 404)));
    expect(result.current.page).toBe(2);
    expect(result.current.result?.page).toBe(2);
    expect(result.current.focusError).toBeNull();
    expect(result.current.error).toBeNull();
    expect(result.current.focusedEntry).toBeNull();
  });

  it('restarts an uncompleted seek after invalidation and refuses the stale response', async () => {
    const { result } = await setup();
    const older = deferred<TableEntriesResponse>();
    const refreshed = deferred<TableEntriesResponse>();
    api.entries.mockReturnValueOnce(older.promise).mockReturnValueOnce(refreshed.promise);
    act(() => result.current.focusEntry(entryId(51)));
    act(() => emitTableEvent({ type: 'tables.invalidated' }));
    expect(api.entries).toHaveBeenCalledTimes(3);
    expect(api.entries).toHaveBeenLastCalledWith(tableId, {
      focusEntryId: entryId(51),
      pageSize: 25,
    });
    await act(async () => refreshed.resolve(response(3)));
    await act(async () => older.resolve(response(2, [entry(51)])));
    expect(result.current.page).toBe(3);
    expect(result.current.result?.page).toBe(3);
  });

  it('retains a usable loaded page when the target is gone and clears the notice on paging', async () => {
    const { result } = await setup();
    api.entries.mockResolvedValueOnce(response(2));
    act(() => result.current.setPage(2));
    await waitFor(() => expect(result.current.loading).toBe(false));
    const loaded = result.current.result;
    api.entries.mockRejectedValueOnce(new FetchError('Entry not found', 404));
    act(() => result.current.focusEntry(entryId(99)));
    await waitFor(() => expect(result.current.focusError).toBe('Entry not found'));
    expect(result.current.result).toBe(loaded);
    expect(result.current.page).toBe(2);
    expect(result.current.error).toBeNull();
    expect(result.current.loading).toBe(false);
    const saved = { ...entry(26), values: { name: 'Still editable' }, revision: 'c'.repeat(64) };
    act(() => result.current.upsertEntry(saved));
    expect(result.current.result?.entries).toEqual([saved]);
    api.entries.mockResolvedValueOnce(response(2, [saved]));
    act(() => result.current.reload());
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(api.entries).toHaveBeenLastCalledWith(tableId, { page: 2, pageSize: 25 });
    api.entries.mockResolvedValueOnce(response(3));
    act(() => result.current.setPage(3));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.focusError).toBeNull();
    expect(result.current.page).toBe(3);
  });

  it('loads ordinary rows when a fresh-pane seek fails before the first page finishes', async () => {
    const initial = deferred<TableEntriesResponse>();
    api.entries
      .mockReturnValueOnce(initial.promise)
      .mockRejectedValueOnce(new FetchError('Entry not found', 404))
      .mockResolvedValueOnce(response());
    const { result } = renderHook(() => useTableEntries(tableId));
    act(() => result.current.focusEntry(entryId(99)));
    await waitFor(() => expect(result.current.result?.entries).toEqual([entry(1)]));
    expect(api.entries).toHaveBeenCalledTimes(3);
    expect(api.entries).toHaveBeenLastCalledWith(tableId, { page: 1, pageSize: 25 });
    expect(result.current.focusError).toBe('Entry not found');
    expect(result.current.error).toBeNull();
    expect(result.current.loading).toBe(false);
    await act(async () => initial.resolve(response(4)));
    expect(result.current.page).toBe(1);
    expect(result.current.result?.page).toBe(1);
  });
});
