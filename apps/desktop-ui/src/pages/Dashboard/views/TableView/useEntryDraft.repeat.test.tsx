import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TableEntry, TableEntryResponse, TableField } from '@snaglet/shared/types';
import { useEntryDraft } from './useEntryDraft';

type TablesApi = typeof import('@desktop/utils/api/tables').tablesApi;
const api = vi.hoisted(() => ({
  updateEntry: vi.fn<TablesApi['updateEntry']>(),
  createEntry: vi.fn<TablesApi['createEntry']>(),
}));
vi.mock('@desktop/features/database', () => ({ emitTableEvent: vi.fn() }));
vi.mock('@desktop/utils/api', async () => {
  const core =
    await vi.importActual<typeof import('@desktop/utils/api/core')>('@desktop/utils/api/core');
  return { tablesApi: api, FetchError: core.FetchError };
});
vi.mock('./repeatAdvanceToast', () => ({ noteRepeatAdvance: vi.fn(async () => false) }));

const tableId = 'table-1111111111111-aaaaaaaaa';
const schemaVersion = 'a'.repeat(64);
function f(extra: Partial<TableField>): TableField {
  return {
    range: false,
    id: 'field-1111111111111-aaaaaaaaa',
    tableId,
    columnName: 'due',
    name: 'due',
    type: 'date',
    nullable: true,
    defaultValue: null,
    referenceTableId: null,
    referenceKind: null,
    description: null,
    position: 0,
    revision: 1,
    managed: false,
    collapsed: false,
    isTitle: false,
    multiple: false,
    options: null,
    ...extra,
  };
}
const status = f({
  id: 'field-2222222222222-bbbbbbbbb',
  columnName: 'status',
  name: 'status',
  type: 'select',
  position: 1,
  options: [
    { id: 'opt-todo', label: 'To do', color: 'gray' },
    { id: 'opt-done', label: 'Done', color: 'green' },
  ],
});
const due = f({
  recurrence: {
    statusFieldId: status.id,
    doneOptionIds: ['opt-done'],
    resetOptionId: 'opt-todo',
  },
});
const notes = f({
  id: 'field-3333333333333-ccccccccc',
  columnName: 'notes',
  name: 'notes',
  type: 'text',
  position: 2,
});
const fields = [due, status, notes];
const entry: TableEntry = {
  id: '00000000-0000-4000-8000-000000000001',
  createdAt: '2026-01-01T00:00:00.000000Z',
  revision: 'b'.repeat(64),
  values: { [due.id]: '2026-10-05', [status.id]: 'To do', [notes.id]: null },
};
/** The server's answer to Done: the date moved one week on and the status reset. */
const advanced: TableEntryResponse = {
  entry: {
    ...entry,
    revision: 'c'.repeat(64),
    values: { ...entry.values, [due.id]: '2026-10-12', [status.id]: 'To do' },
  },
  schemaVersion,
  relatedEntries: {},
  relatedItems: {},
};

function deferred<T>() {
  let complete: (value: T) => void = () => undefined;
  const promise = new Promise<T>((resolve) => {
    complete = resolve;
  });
  return { promise, resolve: (value: T) => complete(value) };
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.useFakeTimers();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('useEntryDraft: a save the server changes more than was sent (repeat done-advance)', () => {
  it('a cell of the same row opened while Done saves shows the advanced row and never writes it back', async () => {
    const first = deferred<TableEntryResponse>();
    api.updateEntry.mockImplementationOnce(() => first.promise);
    api.updateEntry.mockImplementation(async (_table, _id, input) => ({
      ...advanced,
      entry: {
        ...advanced.entry,
        revision: 'd'.repeat(64),
        values: { ...advanced.entry.values, ...input.values },
      },
    }));
    const view = renderHook(() => useEntryDraft(tableId, vi.fn()));
    await act(async () => {
      await view.result.current.begin(entry, fields, schemaVersion, status.id);
    });
    // The status cell commits Done and closes; its save is in flight.
    let closing: Promise<void> = Promise.resolve();
    act(() => {
      view.result.current.change(status.id, 'Done');
      closing = view.result.current.close();
    });
    expect(api.updateEntry).toHaveBeenCalledTimes(1);
    expect(api.updateEntry.mock.calls[0]![2].values).toEqual({ [status.id]: 'Done' });
    // Meanwhile the user opens another cell of the same row.
    await act(async () => {
      await view.result.current.begin(entry, fields, schemaVersion, notes.id);
    });
    await act(async () => {
      first.resolve(advanced);
      await closing;
      await vi.runAllTimersAsync();
    });
    // The draft follows the server: the new date, the reset status.
    expect(view.result.current.draft?.values[due.id]).toBe('2026-10-12');
    expect(view.result.current.draft?.values[status.id]).toBe('To do');
    // Nothing writes Done and the previous date back.
    expect(api.updateEntry).toHaveBeenCalledTimes(1);

    // The next edit sends only itself.
    act(() => view.result.current.change(notes.id, 'Called the landlord'));
    await act(async () => {
      await view.result.current.flush();
    });
    expect(api.updateEntry).toHaveBeenCalledTimes(2);
    expect(api.updateEntry.mock.calls[1]![2]).toMatchObject({
      values: { [notes.id]: 'Called the landlord' },
      expectedRevision: advanced.entry.revision,
    });
  });
});
