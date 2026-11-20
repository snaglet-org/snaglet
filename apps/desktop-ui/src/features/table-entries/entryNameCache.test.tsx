import { act, cleanup, render, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ResolveTableEntriesResponse } from '@snaglet/shared/types';
import { emitTableEvent } from '@desktop/features/database/tableEvents';
import {
  __resetEntryNameCacheForTests,
  primeEntryPositions,
  untitledEntryLabel,
  useLiveEntryLabels,
  useLiveEntryName,
} from './entryNameCache';

const api = vi.hoisted(() => ({ resolveEntries: vi.fn(), entries: vi.fn() }));
vi.mock('@desktop/utils/api', () => ({ tablesApi: api }));

const tableId = 'table-1111111111111-aaaaaaaaa';
const entryId = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const id = `${tableId}/${entryId}`;
const resolved = (name: string): ResolveTableEntriesResponse => ({
  entries: [{ tableId, entryId, name, tableName: 'Reading list' }],
});
const deferred = () => {
  let resolve: (value: ResolveTableEntriesResponse) => void = () => {};
  const promise = new Promise<ResolveTableEntriesResponse>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

beforeEach(() => {
  __resetEntryNameCacheForTests();
  api.resolveEntries.mockReset().mockResolvedValue(resolved('Read the brief'));
  api.entries.mockReset().mockResolvedValue({ page: 3 });
});
afterEach(() => {
  cleanup();
  __resetEntryNameCacheForTests();
  vi.restoreAllMocks();
});

describe('entry name cache', () => {
  it.each(['Known name', ''])(
    'seeds a supplied page name %j without extra requests, then refreshes on events',
    async (name) => {
      const hook = renderHook(() => useLiveEntryName(id, name));
      expect(hook.result.current.name).toBe(name);
      await act(async () => {});
      expect(api.resolveEntries).not.toHaveBeenCalled();
      act(() => emitTableEvent({ type: 'table.entries.changed', tableId, entryId }));
      await waitFor(() => expect(hook.result.current.name).toBe('Read the brief'));
    }
  );

  it('does not overwrite a resolved name or missing entry with a stale supplied name', async () => {
    const existing = renderHook(() => useLiveEntryName(id));
    await waitFor(() => expect(existing.result.current.name).toBe('Read the brief'));
    const next = renderHook(() => useLiveEntryName(id, 'Old page'));
    expect(next.result.current.name).toBe('Read the brief');
    api.resolveEntries.mockResolvedValue({ entries: [] });
    act(() => emitTableEvent({ type: 'tables.invalidated' }));
    await waitFor(() => expect(existing.result.current.unavailable).toBe(true));
    const absent = renderHook(() => useLiveEntryName(id, 'Older page'));
    expect(absent.result.current.unavailable).toBe(true);
  });

  it('bounds inactive cached entries without evicting active chips', async () => {
    const active = renderHook(() => useLiveEntryName(id, 'Active'));
    function Name({ value }: { value: string }) {
      useLiveEntryName(value, 'Known');
      return null;
    }
    const ids = Array.from(
      { length: 1001 },
      (_, i) => `${tableId}/${i.toString(16).padStart(8, '0')}-bbbb-4ccc-8ddd-eeeeeeeeeeee`
    );
    const many = render(
      <>
        {ids.map((value) => (
          <Name key={value} value={value} />
        ))}
      </>
    );
    many.unmount();
    renderHook(() => useLiveEntryName(ids[0]));
    await waitFor(() => expect(api.resolveEntries).toHaveBeenCalledTimes(1));
    expect(api.resolveEntries.mock.calls[0][0]).toEqual([
      { tableId, entryId: ids[0].slice(tableId.length + 1) },
    ]);
    expect(active.result.current.name).toBe('Active');
  });
  it('deduplicates subscribers and batches distinct identities in one request', async () => {
    const first = renderHook(() => useLiveEntryName(id));
    const second = renderHook(() => useLiveEntryName(`${tableId}/${entryId.toUpperCase()}`));
    const missing = renderHook(() =>
      useLiveEntryName(`${tableId}/bbbbbbbb-bbbb-4ccc-8ddd-eeeeeeeeeeee`)
    );
    expect(first.result.current.name).toBeNull();
    await waitFor(() => expect(first.result.current.name).toBe('Read the brief'));
    expect(second.result.current).toEqual(first.result.current);
    expect(missing.result.current.unavailable).toBe(true);
    expect(api.resolveEntries).toHaveBeenCalledTimes(1);
    expect(api.resolveEntries.mock.calls[0][0]).toHaveLength(2);
  });

  it('limits batches to 200 and ignores disabled or invalid identities', async () => {
    function Name({ value }: { value: string | null }) {
      useLiveEntryName(value);
      return null;
    }
    const ids = Array.from(
      { length: 401 },
      (_, i) => `${tableId}/${i.toString(16).padStart(8, '0')}-bbbb-4ccc-8ddd-eeeeeeeeeeee`
    );
    render(
      <>
        {ids.map((value) => (
          <Name key={value} value={value} />
        ))}
        <Name value={null} />
        <Name value="bad" />
      </>
    );
    await waitFor(() => expect(api.resolveEntries).toHaveBeenCalledTimes(3));
    expect(api.resolveEntries.mock.calls.map(([refs]) => refs.length)).toEqual([200, 200, 1]);
  });

  it.each(['table.entries.changed', 'table.fields.changed', 'tables.invalidated'] as const)(
    'refreshes on %s including other rows in a deleted batch',
    async (type) => {
      const hook = renderHook(() => useLiveEntryName(id));
      await waitFor(() => expect(hook.result.current.name).toBe('Read the brief'));
      api.resolveEntries.mockResolvedValue(resolved('Updated name'));
      act(() =>
        emitTableEvent(
          type === 'tables.invalidated' ? { type } : { type, tableId, entryId: 'other-id' }
        )
      );
      await waitFor(() => expect(hook.result.current.name).toBe('Updated name'));
    }
  );

  it('fences an in-flight response after an invalidation and refreshes once', async () => {
    const stale = deferred();
    const fresh = deferred();
    api.resolveEntries.mockReturnValueOnce(stale.promise).mockReturnValueOnce(fresh.promise);
    const hook = renderHook(() => useLiveEntryName(id));
    await waitFor(() => expect(api.resolveEntries).toHaveBeenCalledTimes(1));
    act(() => {
      emitTableEvent({ type: 'table.entries.changed', tableId, entryId });
      emitTableEvent({ type: 'tables.invalidated' });
    });
    await act(async () => stale.resolve({ entries: [] }));
    expect(hook.result.current.unavailable).toBe(false);
    await waitFor(() => expect(api.resolveEntries).toHaveBeenCalledTimes(2));
    await act(async () => fresh.resolve(resolved('Fresh')));
    expect(hook.result.current.name).toBe('Fresh');
  });

  it('keeps known names on errors; only a successful absent result means unavailable', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const hook = renderHook(() => useLiveEntryName(id));
    await waitFor(() => expect(hook.result.current.name).toBe('Read the brief'));
    api.resolveEntries.mockRejectedValueOnce(new Error('Offline'));
    act(() => emitTableEvent({ type: 'tables.invalidated' }));
    await waitFor(() => expect(console.error).toHaveBeenCalled());
    expect(hook.result.current).toEqual({
      name: 'Read the brief',
      tableName: 'Reading list',
      unavailable: false,
      position: null,
    });
    api.resolveEntries.mockResolvedValue({ entries: [] });
    act(() => emitTableEvent({ type: 'tables.invalidated' }));
    await waitFor(() => expect(hook.result.current.unavailable).toBe(true));
  });

  it('refreshes inactive cached entries when remounted after an event', async () => {
    const hook = renderHook(() => useLiveEntryName(id));
    await waitFor(() => expect(hook.result.current.name).toBe('Read the brief'));
    hook.unmount();
    api.resolveEntries.mockResolvedValue(resolved('While away'));
    act(() => emitTableEvent({ type: 'tables.invalidated' }));
    await act(async () => {});
    expect(api.resolveEntries).toHaveBeenCalledTimes(1);
    const next = renderHook(() => useLiveEntryName(id));
    await waitFor(() => expect(next.result.current.name).toBe('While away'));
  });
});

describe('positional Untitled labels', () => {
  it('formats a row number and falls back while it is unknown', () => {
    expect(untitledEntryLabel(4)).toBe('Untitled 4');
    expect(untitledEntryLabel(null)).toBe('Untitled');
    expect(untitledEntryLabel()).toBe('Untitled');
  });

  it('looks up the row number of unnamed entries only, one row per page', async () => {
    api.resolveEntries.mockResolvedValue(resolved(''));
    const hook = renderHook(() => useLiveEntryName(id));
    await waitFor(() => expect(hook.result.current.position).toBe(3));
    expect(hook.result.current.name).toBe('');
    expect(api.entries).toHaveBeenCalledTimes(1);
    expect(api.entries).toHaveBeenCalledWith(tableId, { focusEntryId: entryId, pageSize: 1 });

    const named = `${tableId}/bbbbbbbb-bbbb-4ccc-8ddd-eeeeeeeeeeee`;
    const other = renderHook(() => useLiveEntryName(named, 'Has a name'));
    await act(async () => {});
    expect(other.result.current.position).toBeNull();
    expect(api.entries).toHaveBeenCalledTimes(1);
  });

  it('reuses primed page positions and refreshes them after a table change', async () => {
    primeEntryPositions(tableId, [[entryId.toUpperCase(), 7]]);
    const hook = renderHook(() => useLiveEntryName(id, ''));
    expect(hook.result.current.position).toBe(7);
    await act(async () => {});
    expect(api.entries).not.toHaveBeenCalled();
    act(() => primeEntryPositions(tableId, [[entryId, 6]]));
    expect(hook.result.current.position).toBe(6);

    api.resolveEntries.mockResolvedValue(resolved(''));
    api.entries.mockResolvedValue({ page: 2 });
    act(() => emitTableEvent({ type: 'table.entries.changed', tableId, entryId: 'other-id' }));
    expect(hook.result.current.position).toBe(6);
    await waitFor(() => expect(hook.result.current.position).toBe(2));
  });

  it('keeps the last position when a lookup fails and stays quiet for deleted entries', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    api.entries.mockRejectedValueOnce(Object.assign(new Error('Entry not found'), { status: 404 }));
    const hook = renderHook(() => useLiveEntryName(id, ''));
    await waitFor(() => expect(api.entries).toHaveBeenCalledTimes(1));
    await act(async () => {});
    expect(hook.result.current.position).toBeNull();
    expect(error).not.toHaveBeenCalled();
    api.entries.mockRejectedValueOnce(new Error('Offline'));
    act(() => emitTableEvent({ type: 'tables.invalidated' }));
    await waitFor(() => expect(error).toHaveBeenCalled());
  });

  it('labels several entries of one table with their names or row numbers', async () => {
    const unnamed = 'bbbbbbbb-bbbb-4ccc-8ddd-eeeeeeeeeeee';
    api.entries.mockResolvedValue({ page: 5 });
    const hook = renderHook(() =>
      useLiveEntryLabels(tableId, [
        { id: entryId, name: 'Named' },
        { id: unnamed, name: '' },
        { id: 'not-a-uuid', name: '' },
      ])
    );
    expect(hook.result.current(entryId, 'Named')).toBe('Named');
    await waitFor(() => expect(hook.result.current(unnamed, '')).toBe('Untitled 5'));
    expect(hook.result.current('cccccccc-bbbb-4ccc-8ddd-eeeeeeeeeeee')).toBeUndefined();
    expect(api.entries).toHaveBeenCalledTimes(1);
  });
});
