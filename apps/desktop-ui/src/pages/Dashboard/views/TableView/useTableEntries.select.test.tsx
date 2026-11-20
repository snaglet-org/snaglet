import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  TableEntriesResponse,
  TableEntry,
  TableField,
  UpdateTableFieldRequest,
} from '@snaglet/shared/types';
import { emitTableEvent } from '@desktop/features/database';
import { FetchError } from '@desktop/utils/api';
import { useEntryDraft } from './useEntryDraft';
import { useTableEntries } from './useTableEntries';

type TablesApi = typeof import('@desktop/utils/api/tables').tablesApi;
const api = vi.hoisted(() => ({
  fields: vi.fn<TablesApi['fields']>(),
  updateField: vi.fn<TablesApi['updateField']>(),
  entries: vi.fn<TablesApi['entries']>(),
  entry: vi.fn<TablesApi['entry']>(),
  updateEntry: vi.fn<TablesApi['updateEntry']>(),
  createEntry: vi.fn<TablesApi['createEntry']>(),
}));
vi.mock('@desktop/features/database', async () =>
  vi.importActual('@desktop/features/database/tableEvents')
);
vi.mock('@desktop/utils/api', async () => {
  const core =
    await vi.importActual<typeof import('@desktop/utils/api/core')>('@desktop/utils/api/core');
  return { tablesApi: api, FetchError: core.FetchError };
});

const tableId = 'table-1111111111111-aaaaaaaaa';
const oldSchema = 'a'.repeat(64);
const newSchema = 'b'.repeat(64);
const oldRevision = 'c'.repeat(64);
const newRevision = 'd'.repeat(64);
const field: TableField = {
  range: false,
  id: 'field-1111111111111-aaaaaaaaa',
  tableId,
  columnName: 'status',
  name: 'status',
  type: 'select',
  nullable: false,
  defaultValue: [],
  referenceTableId: null,
  referenceKind: null,
  description: null,
  position: 0,
  revision: 1,
  managed: false,
  collapsed: false,
  isTitle: false,
  multiple: true,
  options: [{ id: 'opt-open', label: 'Open', color: 'blue' }],
};
const row = (index: number): TableEntry => ({
  id: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
  createdAt: '2026-01-01T00:00:00.000000Z',
  revision: oldRevision,
  values: { [field.id]: ['Open'] },
});
let fields: TableField[];
let rows: TableEntry[];
let schema: string;

function deferred<T>() {
  let complete: (value: T) => void = () => {};
  const promise = new Promise<T>((resolve) => {
    complete = resolve;
  });
  return { promise, resolve: complete };
}

function page(pageSize = 25): TableEntriesResponse {
  return {
    entries: structuredClone(rows.slice(0, pageSize)),
    fields: structuredClone(fields),
    schemaVersion: schema,
    totalCount: rows.length,
    relatedEntries: {},
    relatedItems: {},
    page: 1,
    pageSize,
  };
}

function updateOptions(input: UpdateTableFieldRequest) {
  fields = [
    {
      ...fields[0],
      revision: fields[0].revision + 1,
      options: (input.options ?? []).map((option) => ({
        id: option.id ?? 'opt-new',
        label: option.label,
        color: option.color ?? 'green',
      })),
    },
  ];
  schema = newSchema;
  // The server's row revision includes schemaVersion, even for unchanged values.
  rows = rows.map((entry) => ({ ...entry, revision: newRevision }));
  return { field: structuredClone(fields[0]) };
}

beforeEach(() => {
  vi.resetAllMocks();
  localStorage.clear();
  fields = [structuredClone(field)];
  rows = [row(1), row(2)];
  schema = oldSchema;
  api.fields.mockImplementation(async () => ({ fields: structuredClone(fields) }));
  api.updateField.mockImplementation(async (_table, _field, input) => updateOptions(input));
  api.entries.mockImplementation(async (_table, query) => page(query?.pageSize));
  api.entry.mockImplementation(async (_table, id) => {
    const entry = rows.find((entry) => entry.id === id);
    if (!entry) throw new FetchError('Entry not found', 404);
    return {
      entry: structuredClone(entry),
      schemaVersion: schema,
      relatedEntries: {},
      relatedItems: {},
    };
  });
  api.updateEntry.mockImplementation(async (_table, id, input) => {
    const entry = rows.find((entry) => entry.id === id);
    if (!entry) throw new FetchError('Entry not found', 404);
    if (input.schemaVersion !== schema) throw new FetchError('The table fields changed.', 409);
    if (input.expectedRevision !== entry.revision)
      throw new FetchError('This entry changed while you were editing it.', 409);
    const saved = { ...entry, values: { ...entry.values, ...input.values } };
    rows = rows.map((entry) => (entry.id === id ? saved : entry));
    return { entry: saved, schemaVersion: schema, relatedEntries: {}, relatedItems: {} };
  });
});
afterEach(cleanup);

/** Same query/draft wiring as the grid; both hooks and the schema helper are real. */
async function createThenCancelWithPageRefreshPending() {
  const view = renderHook(() => {
    const query = useTableEntries(tableId);
    const edit = useEntryDraft(tableId, (entry, created, beforeEntryId) => {
      query.upsertEntry(entry, created ? { beforeEntryId } : undefined);
    });
    return { query, edit };
  });
  await waitFor(() => expect(view.result.current.query.loading).toBe(false));
  const backgroundPage = deferred<TableEntriesResponse>();
  const draftFields = deferred<TableEntriesResponse>();
  api.entries.mockImplementation((_table, query) =>
    query?.pageSize === 1 ? draftFields.promise : backgroundPage.promise
  );
  await act(async () => {
    expect(await view.result.current.edit.begin(rows[0], fields, schema, field.id)).toBe(true);
  });
  let creation: ReturnType<typeof view.result.current.edit.addSelectOption> = Promise.resolve(null);
  act(() => {
    creation = (async () => {
      const created = await view.result.current.edit.addSelectOption(field.id, 'Done');
      if (!created || !(await view.result.current.query.refreshPage())) return null;
      return created;
    })();
  });
  // One initial page, one private schema read, and the real event-triggered page reload.
  await waitFor(() => expect(api.entries).toHaveBeenCalledTimes(3));
  await act(async () => {
    draftFields.resolve(page(1));
  });
  await waitFor(() => expect(api.entries).toHaveBeenCalledTimes(4));
  await act(async () => backgroundPage.resolve(page()));
  expect((await creation)?.option.label).toBe('Done');
  act(() => {
    view.result.current.edit.change(field.id, ['Open', 'Done']);
    view.result.current.edit.cancel();
  });
  expect(api.updateEntry).not.toHaveBeenCalled();
  return view;
}

describe('select-option schema refresh across the grid query and draft', () => {
  it('retains the authoritative page schema and every row revision after canceling the choice', async () => {
    const { result } = await createThenCancelWithPageRefreshPending();
    expect(result.current.query.result?.fields[0].options?.map((option) => option.label)).toEqual([
      'Open',
      'Done',
    ]);
    expect(result.current.query.result?.schemaVersion).toBe(newSchema);
    expect(result.current.query.result?.entries.map((entry) => entry.revision)).toEqual([
      newRevision,
      newRevision,
    ]);
  });

  it('can edit an untouched row without a stale-schema or stale-revision 409 after cancellation', async () => {
    const { result } = await createThenCancelWithPageRefreshPending();
    const current = result.current.query.result;
    expect(current).not.toBeNull();
    if (!current) return;
    await act(async () => {
      expect(
        await result.current.edit.begin(
          current.entries[1],
          current.fields,
          current.schemaVersion,
          field.id
        )
      ).toBe(true);
    });
    act(() => result.current.edit.change(field.id, ['Done']));
    await act(async () => expect(await result.current.edit.flush()).toBe(true));
    expect(api.updateEntry).toHaveBeenCalledWith(tableId, row(2).id, {
      values: { [field.id]: ['Done'] },
      schemaVersion: newSchema,
      expectedRevision: newRevision,
    });
    expect(result.current.edit.conflict).toBe(false);
  });
});

describe('awaited authoritative page refresh', () => {
  async function setup() {
    const view = renderHook(() => useTableEntries(tableId));
    await waitFor(() => expect(view.result.current.loading).toBe(false));
    return view;
  }

  it('returns and adopts every row revision together with the refreshed schema', async () => {
    const { result } = await setup();
    schema = newSchema;
    rows = rows.map((entry) => ({ ...entry, revision: newRevision }));
    const fresh = page();
    await act(async () => expect(await result.current.refreshPage()).toEqual(fresh));
    expect(result.current.result).toEqual(fresh);
    expect(result.current.loading).toBe(false);
  });

  it('rejects on failure and leaves the previous page available with an error', async () => {
    const { result } = await setup();
    const previous = result.current.result;
    api.entries.mockRejectedValueOnce(new Error('Page refresh unavailable'));
    await act(async () => {
      await expect(result.current.refreshPage()).rejects.toThrow('Page refresh unavailable');
    });
    expect(result.current.result).toEqual(previous);
    expect(result.current.error).toBe('Page refresh unavailable');
    expect(result.current.loading).toBe(false);
  });

  it('waits for a newer read instead of adopting a page read before a save landed', async () => {
    const { result } = await setup();
    const pending = deferred<TableEntriesResponse>();
    api.entries.mockReturnValueOnce(pending.promise);
    let refreshing: ReturnType<typeof result.current.refreshPage> = Promise.resolve(null);
    act(() => {
      refreshing = result.current.refreshPage();
    });
    const stale = page();
    const saved = { ...row(1), revision: newRevision, values: { [field.id]: [] } };
    rows = [saved, ...rows.slice(1)];
    act(() => result.current.upsertEntry(saved));
    await act(async () => pending.resolve(stale));
    expect(result.current.result?.entries[0]).toEqual(saved);
    let refreshed: TableEntriesResponse | null = null;
    await act(async () => {
      refreshed = await refreshing;
    });
    expect(refreshed).toEqual(page());
    expect(result.current.result?.entries[0]).toEqual(saved);
  });

  it('resolves with a realtime reload that supersedes it instead of reporting failure', async () => {
    const { result } = await setup();
    const pending = deferred<TableEntriesResponse>();
    api.entries.mockReturnValueOnce(pending.promise);
    let refreshing: ReturnType<typeof result.current.refreshPage> = Promise.resolve(null);
    act(() => {
      refreshing = result.current.refreshPage();
    });
    const stale = page();
    schema = newSchema;
    rows = rows.map((entry) => ({ ...entry, revision: newRevision }));
    const fresh = page();
    act(() => emitTableEvent({ type: 'table.fields.changed', tableId }));
    await waitFor(() => expect(result.current.result).toEqual(fresh));
    await act(async () => pending.resolve(stale));
    expect(await refreshing).toEqual(fresh);
    expect(result.current.result).toEqual(fresh);
  });

  it('rejects with the error of a newer read that fails after superseding it', async () => {
    const { result } = await setup();
    const pending = deferred<TableEntriesResponse>();
    api.entries.mockReturnValueOnce(pending.promise);
    let refreshing: ReturnType<typeof result.current.refreshPage> = Promise.resolve(null);
    act(() => {
      refreshing = result.current.refreshPage();
    });
    api.entries.mockRejectedValueOnce(new Error('Realtime reload unavailable'));
    act(() => emitTableEvent({ type: 'table.fields.changed', tableId }));
    await waitFor(() => expect(result.current.error).toBe('Realtime reload unavailable'));
    const rejected = expect(refreshing).rejects.toThrow('Realtime reload unavailable');
    await act(async () => pending.resolve(page()));
    await rejected;
  });

  it('returns null after unmount instead of releasing a stale creation callback', async () => {
    const { result, unmount } = await setup();
    const pending = deferred<TableEntriesResponse>();
    api.entries.mockReturnValueOnce(pending.promise);
    let refreshing: ReturnType<typeof result.current.refreshPage> = Promise.resolve(null);
    act(() => {
      refreshing = result.current.refreshPage();
    });
    unmount();
    await act(async () => pending.resolve(page()));
    expect(await refreshing).toBeNull();
  });

  it('does not replace a newly selected page with an earlier refresh response', async () => {
    rows = Array.from({ length: 26 }, (_, index) => row(index + 1));
    const { result } = await setup();
    const pending = deferred<TableEntriesResponse>();
    api.entries.mockReturnValueOnce(pending.promise);
    let refreshing: ReturnType<typeof result.current.refreshPage> = Promise.resolve(null);
    act(() => {
      refreshing = result.current.refreshPage();
    });
    const second = { ...page(), entries: [rows[25]], page: 2 };
    api.entries.mockResolvedValueOnce(second);
    act(() => result.current.setPage(2));
    await waitFor(() => expect(result.current.result?.page).toBe(2));
    await act(async () => pending.resolve(page()));
    // The newer page satisfies the refresh, and the older response is never adopted.
    expect(await refreshing).toEqual(second);
    expect(result.current.result).toEqual(second);
  });
});
