import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { TableEntriesQuery, TableEntriesResponse, TableEntry } from '@snaglet/shared/types';
import { useTableEntries } from './useTableEntries';

const api = vi.hoisted(() => ({
  entries: vi.fn<(tableId: string, query: TableEntriesQuery) => Promise<TableEntriesResponse>>(),
}));
vi.mock('@desktop/utils/api', () => ({ tablesApi: api }));
vi.mock('@desktop/features/database', () => ({ subscribeTableEvents: () => () => undefined }));

const tableId = 'table-1111111111111-aaaaaaaaa';
const id = (index: number) => `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`;
const entry = (index: number): TableEntry => ({
  id: id(index),
  createdAt: '2026-01-01T00:00:00.000000Z',
  revision: 'a'.repeat(64),
  values: {},
});
function response(
  entries: TableEntry[],
  totalCount = entries.length,
  page = 1
): TableEntriesResponse {
  return {
    entries,
    totalCount,
    page,
    pageSize: 25,
    fields: [],
    schemaVersion: 'b'.repeat(64),
    relatedEntries: {},
    relatedItems: {},
  };
}
function deferred<T>() {
  let complete: (value: T) => void;
  let fail: (error: Error) => void;
  const promise = new Promise<T>((resolve, reject) => {
    complete = resolve;
    fail = reject;
  });
  return { promise, resolve: (value: T) => complete(value), reject: (error: Error) => fail(error) };
}
async function setup() {
  const view = renderHook(() => useTableEntries(tableId));
  await waitFor(() => expect(view.result.current.loading).toBe(false));
  return view;
}
beforeEach(() => {
  vi.resetAllMocks();
  localStorage.clear();
  api.entries.mockResolvedValue(response([entry(1), entry(2), entry(3)]));
});

describe('useTableEntries confirmed deletion', () => {
  it('does not let an older page read replace a just-saved value and revision', async () => {
    const { result } = await setup();
    const stale = deferred<TableEntriesResponse>();
    api.entries.mockReturnValueOnce(stale.promise);
    act(() => result.current.reload());
    await waitFor(() => expect(api.entries).toHaveBeenCalledTimes(2));
    const saved = { ...entry(1), values: { done: true }, revision: 'c'.repeat(64) };
    await act(async () => {
      result.current.upsertEntry(saved);
      stale.resolve(response([entry(1), entry(2), entry(3)]));
    });
    expect(result.current.result?.entries[0]).toEqual(saved);
    expect(result.current.loading).toBe(false);
    api.entries.mockResolvedValueOnce(response([saved, entry(2), entry(3)]));
    act(() => result.current.reload());
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.result?.entries[0]).toEqual(saved);
  });

  it('removes known rows immediately and only deducts each displayed row once', async () => {
    const { result } = await setup();
    act(() => result.current.removeEntries([id(1), id(1), id(9)]));
    expect(result.current.result?.entries.map((row) => row.id)).toEqual([id(2), id(3)]);
    expect(result.current.result?.totalCount).toBe(2);
    act(() => result.current.removeEntries([id(1)]));
    expect(result.current.result?.totalCount).toBe(2);
    expect(api.entries).toHaveBeenCalledOnce();
  });

  it('ignores a pre-delete fetch even if it resolves before a replacement request begins', async () => {
    const { result } = await setup();
    const stale = deferred<TableEntriesResponse>();
    api.entries.mockReturnValueOnce(stale.promise);
    act(() => result.current.reload());
    await waitFor(() => expect(api.entries).toHaveBeenCalledTimes(2));

    await act(async () => {
      result.current.removeEntries([id(1)]);
      stale.resolve(response([entry(1), entry(2), entry(3)]));
    });
    expect(result.current.result?.entries.map((row) => row.id)).toEqual([id(2), id(3)]);
    expect(result.current.result?.totalCount).toBe(2);
    expect(result.current.loading).toBe(false);
  });

  it('ignores a pre-delete request error instead of replacing successful local state', async () => {
    const { result } = await setup();
    const stale = deferred<TableEntriesResponse>();
    api.entries.mockReturnValueOnce(stale.promise);
    act(() => result.current.reload());
    await waitFor(() => expect(api.entries).toHaveBeenCalledTimes(2));
    await act(async () => {
      result.current.removeEntries([id(1)]);
      stale.reject(new Error('Old request failed'));
    });
    expect(result.current.error).toBeNull();
    expect(result.current.result?.totalCount).toBe(2);
  });

  it('keeps deletion and page clamping after the refresh fails', async () => {
    api.entries.mockImplementation((_id, query) =>
      Promise.resolve(
        query.page === 2
          ? response([entry(26)], 26, 2)
          : response(
              Array.from({ length: 25 }, (_, index) => entry(index + 1)),
              26
            )
      )
    );
    const { result } = await setup();
    act(() => result.current.setPage(2));
    await waitFor(() => expect(result.current.result?.page).toBe(2));
    api.entries.mockRejectedValue(new Error('Refresh unavailable'));
    act(() => {
      result.current.removeEntries([id(26)]);
      result.current.reload();
    });
    await waitFor(() => expect(result.current.error).toBe('Refresh unavailable'));
    expect(result.current.page).toBe(1);
    expect(result.current.result?.totalCount).toBe(25);
    expect(result.current.result?.entries).toEqual([]);
  });

  it('accepts a newly reused id from an authoritative post-delete fetch', async () => {
    const { result } = await setup();
    act(() => result.current.removeEntries([id(1)]));
    const reused = { ...entry(1), revision: 'c'.repeat(64) };
    api.entries.mockResolvedValueOnce(response([reused, entry(2), entry(3)]));
    act(() => result.current.reload());
    await waitFor(() => expect(result.current.result?.entries[0]).toEqual(reused));
    expect(result.current.result?.totalCount).toBe(3);
  });

  it('preserves queued append totals and follows their new last page', async () => {
    api.entries.mockResolvedValue(
      response(Array.from({ length: 24 }, (_, index) => entry(index + 1)))
    );
    const { result } = await setup();
    const refresh = deferred<TableEntriesResponse>();
    api.entries.mockReturnValue(refresh.promise);
    act(() => {
      result.current.upsertEntry(entry(25), {});
      result.current.upsertEntry(entry(26), {});
    });
    expect(result.current.result?.totalCount).toBe(26);
    expect(result.current.page).toBe(2);
    await act(async () => refresh.resolve(response([entry(26)], 26, 2)));
    expect(result.current.result?.entries).toEqual([entry(26)]);
  });
});

describe('useTableEntries pasted entries', () => {
  it('inserts them in order right after the anchor, once each', async () => {
    const { result } = await setup();
    act(() =>
      result.current.insertEntries([entry(7), entry(8), entry(2)], { afterEntryId: id(1) })
    );
    expect(result.current.result?.entries.map((row) => row.id)).toEqual([
      id(1),
      id(7),
      id(8),
      id(2),
      id(3),
    ]);
    expect(result.current.result?.totalCount).toBe(5);
    expect(result.current.page).toBe(1);
  });

  it('follows appended entries to the last page', async () => {
    api.entries.mockResolvedValue(response([entry(1), entry(2)], 25));
    const { result } = await setup();
    act(() => result.current.insertEntries([entry(26)], { follow: true }));
    const shown = result.current.result?.entries ?? [];
    expect(shown[shown.length - 1]?.id).toBe(id(26));
    await waitFor(() => expect(result.current.page).toBe(2));
  });
});
