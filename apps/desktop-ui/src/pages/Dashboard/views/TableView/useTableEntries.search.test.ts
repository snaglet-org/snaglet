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

beforeEach(() => {
  vi.resetAllMocks();
  localStorage.clear();
  api.entries.mockImplementation((_id, query) =>
    Promise.resolve({
      entries: [entry(1), entry(2)],
      totalCount: 60,
      page: query.page ?? 1,
      pageSize: 25,
      fields: [],
      schemaVersion: 'b'.repeat(64),
      relatedEntries: {},
      relatedItems: {},
      ...(query.q && { rowNumbers: { [id(1)]: 7, [id(2)]: 9 } }),
    })
  );
});

async function setup(initialQuery?: string) {
  const view = renderHook(() => useTableEntries(tableId, { initialQuery }));
  await waitFor(() => expect(view.result.current.loading).toBe(false));
  return view;
}
const lastQuery = () => api.entries.mock.lastCall?.[1];

describe('useTableEntries search', () => {
  it('reads the first page of matches and reports a filtered page', async () => {
    const { result } = await setup();
    expect(result.current.filtered).toBe(false);
    act(() => result.current.setPage(3));
    await waitFor(() => expect(lastQuery()).toEqual({ page: 3, pageSize: 25 }));
    act(() => result.current.setQuery('  alpha  '));
    await waitFor(() => expect(result.current.filtered).toBe(true));
    expect(lastQuery()).toEqual({ page: 1, pageSize: 25, q: 'alpha' });
    expect(result.current.q).toBe('alpha');
    act(() => result.current.setPage(2));
    await waitFor(() => expect(lastQuery()).toEqual({ page: 2, pageSize: 25, q: 'alpha' }));
    const calls = api.entries.mock.calls.length;
    act(() => result.current.setQuery('alpha '));
    expect(api.entries).toHaveBeenCalledTimes(calls);
  });

  it('keeps saved entries listed until the query changes', async () => {
    const { result } = await setup('alpha');
    expect(lastQuery()).toEqual({ page: 1, pageSize: 25, q: 'alpha' });
    act(() => {
      result.current.keepEntry(id(9));
      result.current.keepEntry(id(8));
      result.current.keepEntry(id(9));
    });
    act(() => result.current.reload());
    await waitFor(() =>
      expect(lastQuery()).toEqual({ page: 1, pageSize: 25, q: 'alpha', keep: [id(9), id(8)] })
    );
    act(() => result.current.setQuery('beta'));
    await waitFor(() => expect(lastQuery()).toEqual({ page: 1, pageSize: 25, q: 'beta' }));
    act(() => result.current.setQuery(''));
    await waitFor(() => expect(result.current.filtered).toBe(false));
    act(() => result.current.keepEntry(id(9)));
    act(() => result.current.reload());
    await waitFor(() => expect(lastQuery()).toEqual({ page: 1, pageSize: 25 }));
  });

  it('clears the search to open an entry in the whole table', async () => {
    const { result } = await setup('alpha');
    act(() => result.current.focusEntry(id(2)));
    await waitFor(() => expect(lastQuery()).toEqual({ focusEntryId: id(2), pageSize: 25 }));
    expect(result.current.q).toBe('');
    await waitFor(() => expect(result.current.filtered).toBe(false));
  });
});
