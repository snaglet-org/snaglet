import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  CreateTableEntryRequest,
  TableEntry,
  TableEntryResponse,
  TableField,
  UpdateTableEntryRequest,
} from '@snaglet/shared/types';
import type { TableEvent } from '@desktop/features/database';
import { FetchError } from '@desktop/utils/api';
import { useEntryDraft } from './useEntryDraft';

const api = vi.hoisted(() => ({
  createEntry:
    vi.fn<(tableId: string, input: CreateTableEntryRequest) => Promise<TableEntryResponse>>(),
  updateEntry:
    vi.fn<
      (
        tableId: string,
        entryId: string,
        input: UpdateTableEntryRequest
      ) => Promise<TableEntryResponse>
    >(),
}));
const events = vi.hoisted(() => vi.fn<(event: TableEvent) => void>());
vi.mock('@desktop/features/database', () => ({ emitTableEvent: events }));
vi.mock('@desktop/utils/api', async () => {
  const core =
    await vi.importActual<typeof import('@desktop/utils/api/core')>('@desktop/utils/api/core');
  return { tablesApi: api, FetchError: core.FetchError };
});

const tableId = 'table-1111111111111-aaaaaaaaa';
const schemaVersion = 'a'.repeat(64);
const field: TableField = {
  range: false,
  id: 'field-1111111111111-aaaaaaaaa',
  tableId,
  columnName: 'summary',
  name: 'summary',
  description: null,
  type: 'text',
  nullable: false,
  defaultValue: null,
  referenceTableId: null,
  referenceKind: null,
  position: 2,
  managed: false,
  collapsed: false,
  isTitle: false,
  multiple: false,
  options: null,
  revision: 1,
};
const entry: TableEntry = {
  id: '00000000-0000-4000-8000-000000000001',
  createdAt: '2026-01-01T00:00:00.000000Z',
  revision: 'b'.repeat(64),
  values: { [field.id]: 'Original' },
};
function response(value: string, revision = 'c'.repeat(64)): TableEntryResponse {
  return {
    entry: { ...entry, revision, values: { [field.id]: value } },
    schemaVersion,
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
  const onSaved = vi.fn<(entry: TableEntry, created: boolean, beforeEntryId?: string) => void>();
  const view = renderHook(() => useEntryDraft(tableId, onSaved));
  await act(async () => {
    expect(await view.result.current.begin(entry, [field], schemaVersion, field.id)).toBe(true);
  });
  return { ...view, onSaved };
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.useFakeTimers();
  api.updateEntry.mockResolvedValue(response('Saved'));
  api.createEntry.mockImplementation((_tableId, input) =>
    Promise.resolve({
      ...response('Created'),
      entry: { ...entry, id: input.id, values: input.values },
    })
  );
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('useEntryDraft unmount and cancellation', () => {
  it('settles an ordered relation list after the server returns a separate array', async () => {
    const relation: TableField = {
      ...field,
      type: 'relation',
      multiple: true,
      defaultValue: [],
      referenceTableId: tableId,
    };
    const linked = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const original = { ...entry, values: { [field.id]: [] } };
    api.updateEntry.mockImplementationOnce(async () => ({
      ...response(''),
      entry: { ...entry, values: { [field.id]: [linked] } },
    }));
    // A broken comparison must fail rather than spinning an unbounded flush loop.
    api.updateEntry.mockRejectedValueOnce(new Error('Unexpected repeated write'));
    const { result } = renderHook(() => useEntryDraft(tableId, vi.fn()));
    await act(async () => {
      await result.current.begin(original, [relation], schemaVersion, field.id);
    });
    act(() => result.current.change(field.id, [linked]));
    await act(async () => {
      expect(await result.current.flush()).toBe(true);
    });
    expect(api.updateEntry).toHaveBeenCalledTimes(1);
    act(() => result.current.change(field.id, [linked.toUpperCase()]));
    await act(async () => vi.advanceTimersByTimeAsync(500));
    expect(api.updateEntry).toHaveBeenCalledTimes(1);
  });

  it('still saves a changed order after the first relation save finishes', async () => {
    const relation: TableField = {
      ...field,
      type: 'relation',
      multiple: true,
      defaultValue: [],
      referenceTableId: tableId,
    };
    const first = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const second = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    const save = deferred<TableEntryResponse>();
    api.updateEntry.mockReturnValueOnce(save.promise);
    api.updateEntry.mockImplementationOnce(async (_table, _entry, input) => ({
      ...response(''),
      entry: { ...entry, values: structuredClone(input.values) },
    }));
    const { result } = renderHook(() => useEntryDraft(tableId, vi.fn()));
    await act(async () => {
      await result.current.begin(
        { ...entry, values: { [field.id]: [] } },
        [relation],
        schemaVersion,
        field.id
      );
    });
    act(() => result.current.change(field.id, [first, second]));
    await act(async () => vi.advanceTimersByTimeAsync(450));
    act(() => result.current.change(field.id, [second, first]));
    await act(async () =>
      save.resolve({
        ...response(''),
        entry: { ...entry, revision: 'c'.repeat(64), values: { [field.id]: [first, second] } },
      })
    );
    await act(async () => {
      expect(await result.current.flush()).toBe(true);
    });
    expect(api.updateEntry).toHaveBeenCalledTimes(2);
    expect(api.updateEntry).toHaveBeenLastCalledWith(
      tableId,
      entry.id,
      expect.objectContaining({
        values: { [field.id]: [second, first] },
        expectedRevision: 'c'.repeat(64),
      })
    );
  });

  it('flushes an accepted pending edit on unmount before its 450ms debounce', async () => {
    const save = deferred<TableEntryResponse>();
    api.updateEntry.mockReturnValueOnce(save.promise);
    const { result, onSaved, unmount } = await setup();
    act(() => result.current.change(field.id, 'Pending edit'));
    await act(async () => vi.advanceTimersByTimeAsync(449));
    expect(api.updateEntry).not.toHaveBeenCalled();

    unmount();

    expect(api.updateEntry).toHaveBeenCalledExactlyOnceWith(tableId, entry.id, {
      values: { [field.id]: 'Pending edit' },
      expectedRevision: entry.revision,
      schemaVersion,
    });
    const saved = response('Pending edit');
    await act(async () => save.resolve(saved));
    expect(onSaved).toHaveBeenCalledExactlyOnceWith(saved.entry, false, undefined);
    expect(events).toHaveBeenCalledExactlyOnceWith({
      type: 'table.entries.changed',
      tableId,
      entryId: entry.id,
    });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('flushes a valid new row with its existing client id and insertion boundary', async () => {
    const onSaved = vi.fn();
    const { result, unmount } = renderHook(() => useEntryDraft(tableId, onSaved));
    await act(async () => {
      expect(
        await result.current.begin(null, [field], schemaVersion, field.id, {
          beforeEntryId: entry.id,
        })
      ).toBe(true);
    });
    const draftId = result.current.draft?.id;
    expect(draftId).toEqual(expect.any(String));
    act(() => result.current.change(field.id, 'New entry'));
    expect(api.createEntry).not.toHaveBeenCalled();

    await act(async () => unmount());

    expect(api.createEntry).toHaveBeenCalledExactlyOnceWith(tableId, {
      id: draftId,
      values: { [field.id]: 'New entry' },
      schemaVersion,
      beforeEntryId: entry.id,
    });
    expect(onSaved).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ id: draftId, values: { [field.id]: 'New entry' } }),
      true,
      entry.id
    );
    expect(vi.getTimerCount()).toBe(0);
  });

  it('drains a newer edit behind an in-flight save after unmount using the returned revision', async () => {
    const first = deferred<TableEntryResponse>();
    const second = deferred<TableEntryResponse>();
    api.updateEntry.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const { result, onSaved, unmount } = await setup();
    act(() => result.current.change(field.id, 'First edit'));
    await act(async () => vi.advanceTimersByTimeAsync(450));
    expect(api.updateEntry).toHaveBeenCalledOnce();
    act(() => result.current.change(field.id, 'Newest edit'));

    unmount();
    expect(api.updateEntry).toHaveBeenCalledOnce();
    const firstSaved = { ...response('First edit'), schemaVersion: 'd'.repeat(64) };
    await act(async () => first.resolve(firstSaved));

    expect(api.updateEntry).toHaveBeenCalledTimes(2);
    expect(api.updateEntry).toHaveBeenLastCalledWith(tableId, entry.id, {
      values: { [field.id]: 'Newest edit' },
      expectedRevision: firstSaved.entry.revision,
      schemaVersion: firstSaved.schemaVersion,
    });
    const secondSaved = response('Newest edit', 'e'.repeat(64));
    await act(async () => second.resolve(secondSaved));
    await act(async () => vi.runAllTimersAsync());
    expect(api.updateEntry).toHaveBeenCalledTimes(2);
    expect(onSaved).toHaveBeenNthCalledWith(1, firstSaved.entry, false, undefined);
    expect(onSaved).toHaveBeenNthCalledWith(2, secondSaved.entry, false, undefined);
    expect(events).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([
    ['conflict', () => new FetchError('Entry changed elsewhere', 409)],
    ['network failure', () => new Error('Save unavailable')],
  ] as const)('does not leak a canceled save %s into the next draft', async (_label, error) => {
    const save = deferred<TableEntryResponse>();
    api.updateEntry.mockReturnValueOnce(save.promise);
    const { result, onSaved } = await setup();
    act(() => result.current.change(field.id, 'Sent edit'));
    await act(async () => vi.advanceTimersByTimeAsync(450));
    act(() => {
      result.current.change(field.id, 'Unsent tail');
      result.current.cancel();
    });
    await act(async () => save.reject(error()));
    expect(result.current.draft).toBeNull();
    expect(result.current.error).toBeNull();
    expect(result.current.conflict).toBe(false);
    expect(result.current.fieldErrors).toEqual({});
    expect(result.current.saveState).toBe('idle');

    const nextEntry = { ...entry, id: '00000000-0000-4000-8000-000000000002' };
    await act(async () => {
      expect(await result.current.begin(nextEntry, [field], schemaVersion, field.id)).toBe(true);
    });
    expect(result.current.draft?.id).toBe(nextEntry.id);
    expect(result.current.error).toBeNull();
    expect(result.current.conflict).toBe(false);
    expect(result.current.fieldErrors).toEqual({});
    expect(result.current.saveState).toBe('idle');
    await act(async () => vi.advanceTimersByTimeAsync(1000));
    expect(api.updateEntry).toHaveBeenCalledOnce();
    expect(onSaved).not.toHaveBeenCalled();
    expect(events).not.toHaveBeenCalled();
  });

  it('does not flush a canceled pending edit on unmount or after its original deadline', async () => {
    const { result, onSaved, unmount } = await setup();
    act(() => result.current.change(field.id, 'Discard this'));
    await act(async () => vi.advanceTimersByTimeAsync(449));
    act(() => result.current.cancel());
    expect(result.current.draft).toBeNull();

    unmount();
    await act(async () => vi.runAllTimersAsync());

    expect(api.updateEntry).not.toHaveBeenCalled();
    expect(api.createEntry).not.toHaveBeenCalled();
    expect(onSaved).not.toHaveBeenCalled();
    expect(events).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('keeps a sent write after cancel and unmount but never persists its discarded tail', async () => {
    const save = deferred<TableEntryResponse>();
    api.updateEntry.mockReturnValueOnce(save.promise);
    const { result, onSaved, unmount } = await setup();
    act(() => result.current.change(field.id, 'Sent edit'));
    await act(async () => vi.advanceTimersByTimeAsync(450));
    act(() => {
      result.current.change(field.id, 'Discarded tail');
      result.current.cancel();
    });
    unmount();
    const saved = response('Sent edit');
    await act(async () => save.resolve(saved));
    await act(async () => vi.runAllTimersAsync());

    expect(api.updateEntry).toHaveBeenCalledOnce();
    expect(onSaved).toHaveBeenCalledExactlyOnceWith(saved.entry, false, undefined);
    expect(events).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('invalidates a queued row opening when unmount drains its preceding save', async () => {
    const save = deferred<TableEntryResponse>();
    api.updateEntry.mockReturnValueOnce(save.promise);
    const { result, onSaved, unmount } = await setup();
    act(() => result.current.change(field.id, 'Sent edit'));
    await act(async () => vi.advanceTimersByTimeAsync(450));
    const nextEntry = { ...entry, id: '00000000-0000-4000-8000-000000000002' };
    const opening = result.current.begin(nextEntry, [field], schemaVersion, field.id, {
      updateValue: () => 'Do not open this draft',
    });
    await act(async () => undefined);
    unmount();
    const saved = response('Sent edit');
    await act(async () => save.resolve(saved));

    await expect(opening).resolves.toBe(false);
    await act(async () => vi.runAllTimersAsync());
    expect(api.updateEntry).toHaveBeenCalledOnce();
    expect(onSaved).toHaveBeenCalledExactlyOnceWith(saved.entry, false, undefined);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('never sends invalid pending values while flushing on unmount', async () => {
    const { result, onSaved, unmount } = await setup();
    act(() => result.current.change(field.id, null));
    unmount();
    await act(async () => vi.runAllTimersAsync());
    expect(api.updateEntry).not.toHaveBeenCalled();
    expect(onSaved).not.toHaveBeenCalled();
    expect(events).not.toHaveBeenCalled();
  });

  it('does not manufacture a write when an unchanged existing draft unmounts', async () => {
    const { unmount } = await setup();
    unmount();
    await act(async () => vi.runAllTimersAsync());
    expect(api.updateEntry).not.toHaveBeenCalled();
    expect(api.createEntry).not.toHaveBeenCalled();
  });
});

describe('useEntryDraft save status', () => {
  it('reports nothing as saved when an untouched cell closes', async () => {
    const { result } = await setup();
    await act(async () => result.current.close());
    expect(result.current.saveState).toBe('idle');
    expect(result.current.draft).toBeNull();
    expect(api.updateEntry).not.toHaveBeenCalled();
  });

  it('clears Waiting to save when an edit is reverted before it is written', async () => {
    const { result } = await setup();
    act(() => result.current.change(field.id, 'Changed'));
    expect(result.current.saveState).toBe('dirty');
    act(() => result.current.change(field.id, 'Original'));
    await act(async () => vi.runAllTimersAsync());
    expect(result.current.saveState).toBe('idle');
    expect(api.updateEntry).not.toHaveBeenCalled();
  });

  it('keeps a newer save status when the previous Saved fades', async () => {
    const { result } = await setup();
    act(() => result.current.change(field.id, 'First'));
    await act(async () => vi.advanceTimersByTimeAsync(450));
    expect(result.current.saveState).toBe('saved');
    // A second edit lands while "Saved" still shows; its save hangs.
    const second = deferred<TableEntryResponse>();
    api.updateEntry.mockReturnValueOnce(second.promise);
    act(() => result.current.change(field.id, 'Second'));
    expect(result.current.saveState).toBe('dirty');
    await act(async () => vi.advanceTimersByTimeAsync(450));
    expect(result.current.saveState).toBe('saving');
    // The first save's fade must not hide the save still running.
    await act(async () => vi.advanceTimersByTimeAsync(1400));
    expect(result.current.saveState).toBe('saving');
    await act(async () => second.resolve(response('Second', 'd'.repeat(64))));
    expect(result.current.saveState).toBe('saved');
    await act(async () => vi.advanceTimersByTimeAsync(1400));
    expect(result.current.saveState).toBe('idle');
  });

  it('adds a created Select label from the latest draft, once', async () => {
    const tags: TableField = {
      ...field,
      type: 'select',
      multiple: true,
      defaultValue: [],
      options: [
        { id: 'opt-first', label: 'First', color: 'blue' },
        { id: 'opt-new', label: 'New', color: 'green' },
      ],
    };
    const { result } = renderHook(() => useEntryDraft(tableId, vi.fn()));
    const row = { ...entry, values: { [tags.id]: ['First'] } };
    await act(async () => {
      expect(await result.current.begin(row, [tags], schemaVersion, tags.id)).toBe(true);
    });
    const draftId = result.current.draft?.id ?? '';
    act(() => {
      expect(result.current.chooseSelectLabel(draftId, tags.id, 'New')).toBe(true);
      expect(result.current.chooseSelectLabel(draftId, tags.id, 'new')).toBe(true);
    });
    expect(result.current.draft?.values[tags.id]).toEqual(['First', 'New']);
    act(() => result.current.cancel());
    expect(result.current.chooseSelectLabel(draftId, tags.id, 'New')).toBe(false);
  });
});

describe('useEntryDraft date ranges', () => {
  const trip: TableField = { ...field, type: 'date', range: true, nullable: true };
  const original: TableEntry = { ...entry, values: { [trip.id]: '2026-10-12' } };

  it('saves a range value of a range field', async () => {
    api.updateEntry.mockResolvedValue(response('2026-10-12/2026-10-15'));
    const { result } = renderHook(() => useEntryDraft(tableId, vi.fn()));
    await act(async () => {
      await result.current.begin(original, [trip], schemaVersion, trip.id);
    });
    act(() => result.current.change(trip.id, '2026-10-12/2026-10-15'));
    await act(async () => {
      expect(await result.current.flush()).toBe(true);
    });
    expect(api.updateEntry).toHaveBeenCalledWith(tableId, entry.id, {
      values: { [trip.id]: '2026-10-12/2026-10-15' },
      schemaVersion,
      expectedRevision: entry.revision,
    });
  });

  it("keeps an end before the start out of the save, with the parser's sentence", async () => {
    const { result } = renderHook(() => useEntryDraft(tableId, vi.fn()));
    await act(async () => {
      await result.current.begin(original, [trip], schemaVersion, trip.id);
    });
    act(() => result.current.change(trip.id, '2026-10-15/2026-10-12'));
    await act(async () => {
      expect(await result.current.flush()).toBe(false);
    });
    expect(api.updateEntry).not.toHaveBeenCalled();
    expect(result.current.fieldErrors[trip.id]).toBe('The end is before the start.');
  });
});
