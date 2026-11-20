import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  TableEntry,
  TableEntryResponse,
  TableField,
  TableFieldResponse,
  TableEntriesResponse,
  UpdateTableEntryRequest,
  UpdateTableFieldRequest,
} from '@snaglet/shared/types';
import { FetchError } from '@desktop/utils/api';
import { useEntryDraft } from './useEntryDraft';

type TablesApi = typeof import('@desktop/utils/api/tables').tablesApi;
const api = vi.hoisted(() => ({
  fields: vi.fn<TablesApi['fields']>(),
  updateField: vi.fn<TablesApi['updateField']>(),
  entries: vi.fn<TablesApi['entries']>(),
  entry: vi.fn<TablesApi['entry']>(),
  updateEntry: vi.fn<TablesApi['updateEntry']>(),
  createEntry: vi.fn<TablesApi['createEntry']>(),
}));
const events = vi.hoisted(() => vi.fn());
vi.mock('@desktop/features/database', () => ({ emitTableEvent: events }));
vi.mock('@desktop/utils/api', async () => {
  const core =
    await vi.importActual<typeof import('@desktop/utils/api/core')>('@desktop/utils/api/core');
  return { tablesApi: api, FetchError: core.FetchError };
});

const tableId = 'table-1111111111111-aaaaaaaaa';
const schemaVersion = 'a'.repeat(64);
const refreshedSchema = 'e'.repeat(64);
const refreshedRevision = 'd'.repeat(64);
const field: TableField = {
  range: false,
  id: 'field-1111111111111-aaaaaaaaa',
  tableId,
  columnName: 'status',
  name: 'status',
  type: 'select',
  nullable: true,
  defaultValue: null,
  referenceTableId: null,
  referenceKind: null,
  description: null,
  position: 0,
  revision: 2,
  managed: false,
  collapsed: false,
  isTitle: false,
  multiple: false,
  options: [
    { id: 'opt-open', label: 'Open', color: 'blue' },
    { id: 'opt-review', label: 'Review', color: 'green' },
  ],
};
const notes: TableField = {
  ...field,
  id: 'field-2222222222222-bbbbbbbbb',
  columnName: 'notes',
  name: 'notes',
  type: 'text',
  nullable: false,
  defaultValue: '',
  options: null,
  position: 1,
};
const entry: TableEntry = {
  id: '00000000-0000-4000-8000-000000000001',
  createdAt: '2026-01-01T00:00:00.000000Z',
  revision: 'b'.repeat(64),
  values: { [field.id]: 'Open', [notes.id]: 'Original notes' },
};
const otherEntry: TableEntry = { ...entry, id: '00000000-0000-4000-8000-000000000002' };

let serverFields: TableField[];
let serverRows: Map<string, TableEntry>;
let serverSchema: string;
let saveCount: number;
let calls: string[];

function deferred<T>() {
  let complete: (value: T) => void = () => {};
  let fail: (reason: Error) => void = () => {};
  const promise = new Promise<T>((resolve, reject) => {
    complete = resolve;
    fail = reject;
  });
  return { promise, resolve: complete, reject: fail };
}

function rowResponse(row: TableEntry): TableEntryResponse {
  return {
    entry: structuredClone(row),
    schemaVersion: serverSchema,
    relatedEntries: {},
    relatedItems: {},
  };
}

function pageResponse(): TableEntriesResponse {
  return {
    entries: [],
    fields: structuredClone(serverFields),
    totalCount: serverRows.size,
    schemaVersion: serverSchema,
    relatedEntries: {},
    relatedItems: {},
    page: 1,
    pageSize: 1,
  };
}

function acceptField(input: UpdateTableFieldRequest): TableFieldResponse {
  const current = serverFields.find((item) => item.id === field.id);
  if (!current) throw new Error('Missing select fixture');
  const next: TableField = {
    ...current,
    revision: current.revision + 1,
    options: (input.options ?? []).map((option, index) => ({
      id: option.id ?? `opt-created-${index}`,
      label: option.label,
      color: option.color ?? 'purple',
    })),
  };
  serverFields = serverFields.map((item) => (item.id === next.id ? next : item));
  serverSchema = refreshedSchema;
  for (const [id, row] of serverRows) serverRows.set(id, { ...row, revision: refreshedRevision });
  return { field: structuredClone(next) };
}

function acceptEntry(id: string, input: UpdateTableEntryRequest): TableEntryResponse {
  const current = serverRows.get(id);
  if (!current) throw new FetchError('Entry not found', 404);
  if (input.schemaVersion !== serverSchema || input.expectedRevision !== current.revision)
    throw new FetchError('Stale entry fixture', 409);
  const saved = {
    ...current,
    revision: (++saveCount).toString(16).padStart(64, '0'),
    values: { ...current.values, ...structuredClone(input.values) },
  };
  serverRows.set(id, saved);
  return rowResponse(saved);
}

async function setup(current: TableEntry | null = entry, fields: TableField[] = [field, notes]) {
  serverFields = structuredClone(fields);
  if (current) serverRows.set(current.id, structuredClone(current));
  const onSaved = vi.fn();
  const view = renderHook(() => useEntryDraft(tableId, onSaved));
  await act(async () => {
    expect(
      await view.result.current.begin(current, fields, schemaVersion, field.id, {
        beforeEntryId: current ? undefined : otherEntry.id,
      })
    ).toBe(true);
  });
  return { ...view, onSaved };
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.useFakeTimers();
  serverFields = structuredClone([field, notes]);
  serverRows = new Map([
    [entry.id, structuredClone(entry)],
    [otherEntry.id, structuredClone(otherEntry)],
  ]);
  serverSchema = schemaVersion;
  saveCount = 0;
  calls = [];
  api.fields.mockImplementation(async () => {
    calls.push('fields');
    return { fields: structuredClone(serverFields) };
  });
  api.updateField.mockImplementation(async (_table, _field, input) => {
    calls.push('updateField');
    return acceptField(input);
  });
  api.entries.mockImplementation(async () => {
    calls.push('entries');
    return pageResponse();
  });
  api.entry.mockImplementation(async (_table, id) => {
    calls.push('entry');
    const row = serverRows.get(id);
    if (!row) throw new FetchError('Entry not found', 404);
    return rowResponse(row);
  });
  api.updateEntry.mockImplementation(async (_table, id, input) => {
    calls.push('updateEntry');
    return acceptEntry(id, input);
  });
  api.createEntry.mockImplementation(async (_table, input) => {
    calls.push('createEntry');
    if (input.schemaVersion !== serverSchema) throw new FetchError('Stale schema fixture', 409);
    const row: TableEntry = { ...entry, id: input.id, values: structuredClone(input.values) };
    serverRows.set(row.id, row);
    return rowResponse(row);
  });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('select-option creation through the real entry draft', () => {
  it('waits for schema and row refresh, then writes the first choice with their fresh versions', async () => {
    const mutation = deferred<TableFieldResponse>();
    const page = deferred<TableEntriesResponse>();
    const row = deferred<TableEntryResponse>();
    api.updateField.mockReturnValueOnce(mutation.promise);
    api.entries.mockReturnValueOnce(page.promise);
    api.entry.mockReturnValueOnce(row.promise);
    const { result } = await setup();
    let creating: ReturnType<typeof result.current.addSelectOption> = Promise.resolve(null);
    act(() => {
      creating = result.current.addSelectOption(field.id, ' Done ');
    });
    await act(async () => {});
    expect(api.updateField).toHaveBeenCalledOnce();
    expect(result.current.reloading).toBe(true);
    expect(api.entries).not.toHaveBeenCalled();
    expect(api.updateEntry).not.toHaveBeenCalled();
    act(() => result.current.change(field.id, 'Review'));
    expect(result.current.draft?.values[field.id]).toBe('Open');

    const update = api.updateField.mock.calls[0][2];
    expect(update.expectedRevision).toBe(field.revision);
    await act(async () => mutation.resolve(acceptField(update)));
    expect(api.entries).toHaveBeenCalledExactlyOnceWith(tableId, { page: 1, pageSize: 1 });
    expect(api.entry).not.toHaveBeenCalled();
    await act(async () => page.resolve(pageResponse()));
    expect(api.entry).toHaveBeenCalledExactlyOnceWith(tableId, entry.id);
    expect(api.updateEntry).not.toHaveBeenCalled();
    const refreshed = serverRows.get(entry.id);
    if (!refreshed) throw new Error('Missing refreshed row');
    await act(async () => row.resolve(rowResponse(refreshed)));
    const created = await creating;
    expect(created?.option).toMatchObject({ label: 'Done', color: 'purple' });
    expect(result.current.draft).toMatchObject({
      schemaVersion: refreshedSchema,
      original: { revision: refreshedRevision },
    });
    expect(result.current.reloading).toBe(false);
    expect(api.updateEntry).not.toHaveBeenCalled();
    act(() => result.current.change(field.id, created?.option.label ?? null));
    await act(async () => {
      expect(await result.current.flush()).toBe(true);
    });
    expect(api.updateEntry).toHaveBeenCalledExactlyOnceWith(tableId, entry.id, {
      values: { [field.id]: 'Done' },
      schemaVersion: refreshedSchema,
      expectedRevision: refreshedRevision,
    });
  });

  it('flushes existing multi-select choices before creating and preserves them for the appended choice', async () => {
    const multiple: TableField = { ...field, multiple: true, nullable: false, defaultValue: [] };
    const original = { ...entry, values: { ...entry.values, [field.id]: ['Open'] } };
    const save = deferred<TableEntryResponse>();
    api.updateEntry.mockReturnValueOnce(save.promise);
    const { result } = await setup(original, [multiple, notes]);
    act(() => result.current.change(field.id, ['Open', 'Review']));
    let creating: ReturnType<typeof result.current.addSelectOption> = Promise.resolve(null);
    act(() => {
      creating = result.current.addSelectOption(field.id, 'Done');
    });
    await act(async () => {});
    expect(api.updateEntry).toHaveBeenCalledOnce();
    expect(api.fields).not.toHaveBeenCalled();
    await act(async () => save.resolve(acceptEntry(entry.id, api.updateEntry.mock.calls[0][2])));
    const created = await creating;
    expect(created?.option.label).toBe('Done');
    expect(result.current.draft?.values[field.id]).toEqual(['Open', 'Review']);
    expect(calls).toEqual(['fields', 'updateField', 'entries', 'entry']);
    act(() => result.current.change(field.id, ['Open', 'Review', 'Done']));
    await act(async () => {
      expect(await result.current.flush()).toBe(true);
    });
    expect(api.updateEntry).toHaveBeenLastCalledWith(tableId, entry.id, {
      values: { [field.id]: ['Open', 'Review', 'Done'] },
      schemaVersion: refreshedSchema,
      expectedRevision: refreshedRevision,
    });
    expect(api.updateEntry).toHaveBeenCalledTimes(2);
  });

  it('reuses an existing canonical option on a case-insensitive retry without rewriting the field', async () => {
    const { result } = await setup();
    serverSchema = refreshedSchema;
    serverRows.set(entry.id, { ...entry, revision: refreshedRevision });
    let created: Awaited<ReturnType<typeof result.current.addSelectOption>> = null;
    await act(async () => {
      created = await result.current.addSelectOption(field.id, '  rEvIeW  ');
    });
    expect(created).toMatchObject({ option: { id: 'opt-review', label: 'Review' } });
    expect(api.updateField).not.toHaveBeenCalled();
    expect(result.current.draft?.schemaVersion).toBe(refreshedSchema);
    act(() => result.current.change(field.id, 'Review'));
    await act(async () => {
      expect(await result.current.flush()).toBe(true);
    });
    expect(api.updateEntry).toHaveBeenCalledWith(
      tableId,
      entry.id,
      expect.objectContaining({
        schemaVersion: refreshedSchema,
        expectedRevision: refreshedRevision,
        values: { [field.id]: 'Review' },
      })
    );
  });

  it('lets a required-invalid ghost create an option, then creates its row once with the new schema', async () => {
    const required = { ...field, nullable: false, options: [] };
    const { result, onSaved } = await setup(null, [required, notes]);
    const draftId = result.current.draft?.id;
    await act(async () => vi.advanceTimersByTimeAsync(500));
    expect(api.createEntry).not.toHaveBeenCalled();
    await act(async () => {
      expect((await result.current.addSelectOption(field.id, 'New'))?.option.label).toBe('New');
    });
    expect(result.current.draft?.id).toBe(draftId);
    expect(result.current.draft?.values[field.id]).toBeNull();
    expect(api.createEntry).not.toHaveBeenCalled();
    act(() => result.current.change(field.id, 'New'));
    await act(async () => {
      expect(await result.current.flush()).toBe(true);
    });
    expect(api.createEntry).toHaveBeenCalledExactlyOnceWith(tableId, {
      id: draftId,
      values: { [field.id]: 'New', [notes.id]: '' },
      schemaVersion: refreshedSchema,
      beforeEntryId: otherEntry.id,
    });
    expect(onSaved).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ id: draftId }),
      true,
      otherEntry.id
    );
  });

  it('keeps an invalid ghost draft and its typed values when creating the option fails', async () => {
    const { result } = await setup(null, [{ ...field, nullable: false }, notes]);
    act(() => result.current.change(notes.id, 'Unsaved notes'));
    const before = result.current.draft;
    const failure = new FetchError('Field changed elsewhere', 409);
    api.updateField.mockRejectedValueOnce(failure);
    await act(async () => {
      await expect(result.current.addSelectOption(field.id, 'Done')).rejects.toBe(failure);
    });
    expect(result.current.draft).toEqual(before);
    expect(result.current.error).toBe('Field changed elsewhere');
    expect(result.current.conflict).toBe(true);
    expect(result.current.reloading).toBe(false);
    await act(async () => vi.advanceTimersByTimeAsync(1000));
    expect(api.createEntry).not.toHaveBeenCalled();
    expect(api.updateEntry).not.toHaveBeenCalled();
  });

  it('retries after a post-create refresh failure without duplicating the saved option', async () => {
    const { result } = await setup();
    const before = result.current.draft;
    api.entries.mockRejectedValueOnce(new Error('Refresh unavailable'));
    await act(async () => {
      await expect(result.current.addSelectOption(field.id, 'Done')).rejects.toThrow(
        'Refresh unavailable'
      );
    });
    expect(result.current.draft).toEqual(before);
    expect(result.current.error).toBe('Refresh unavailable');
    expect(api.updateEntry).not.toHaveBeenCalled();
    await act(async () => {
      expect((await result.current.addSelectOption(field.id, 'done'))?.option.label).toBe('Done');
    });
    expect(api.updateField).toHaveBeenCalledOnce();
    expect(result.current.error).toBeNull();
    expect(result.current.draft?.schemaVersion).toBe(refreshedSchema);
  });

  it('does not start a schema write when preflushing accepted choices fails', async () => {
    const { result } = await setup();
    act(() => result.current.change(field.id, 'Review'));
    api.updateEntry.mockRejectedValueOnce(new Error('Offline'));
    await act(async () => {
      await expect(result.current.addSelectOption(field.id, 'Done')).rejects.toThrow(
        'Save or discard'
      );
    });
    expect(result.current.draft?.values[field.id]).toBe('Review');
    expect(api.fields).not.toHaveBeenCalled();
    expect(api.updateField).not.toHaveBeenCalled();
    expect(result.current.reloading).toBe(false);
  });

  it('preserves stale-row recovery when the prerequisite value save returns 409', async () => {
    const { result } = await setup();
    act(() => result.current.change(field.id, 'Review'));
    api.updateEntry.mockRejectedValueOnce(new FetchError('This row changed elsewhere', 409));
    await act(async () => {
      await expect(result.current.addSelectOption(field.id, 'Done')).rejects.toThrow();
    });
    expect(result.current.conflict).toBe(true);
    expect(result.current.draft?.values[field.id]).toBe('Review');
    expect(api.fields).not.toHaveBeenCalled();
    expect(api.updateField).not.toHaveBeenCalled();
    expect(result.current.reloading).toBe(false);
  });

  it('does not let stale-row recovery interrupt an option retry already refreshing the draft', async () => {
    const { result } = await setup();
    api.updateField.mockRejectedValueOnce(new FetchError('Field changed elsewhere', 409));
    await act(async () => {
      await expect(result.current.addSelectOption(field.id, 'Done')).rejects.toThrow();
    });
    const mutation = deferred<TableFieldResponse>();
    api.updateField.mockReturnValueOnce(mutation.promise);
    let creating: ReturnType<typeof result.current.addSelectOption> = Promise.resolve(null);
    act(() => {
      creating = result.current.addSelectOption(field.id, 'Done');
    });
    await act(async () => {});
    // The earlier 409 still exposes the recovery action while the schema request waits.
    expect(result.current.conflict).toBe(true);
    expect(result.current.reloading).toBe(true);
    await act(async () => result.current.reloadLatest());
    const recoveryReads = api.entries.mock.calls.length;
    await act(async () => mutation.resolve(acceptField(api.updateField.mock.calls[1][2])));
    expect(recoveryReads).toBe(0);
    expect((await creating)?.option.label).toBe('Done');
    expect(result.current.draft?.schemaVersion).toBe(refreshedSchema);
    expect(result.current.conflict).toBe(false);
  });

  it('does not overwrite a concurrent edit when rebasing an invalid pending value after schema creation', async () => {
    const { result } = await setup();
    act(() => result.current.change(notes.id, null));
    api.entry.mockImplementationOnce(async () =>
      rowResponse({
        ...entry,
        revision: refreshedRevision,
        values: { ...entry.values, [notes.id]: 'Someone else edited this' },
      })
    );
    await act(async () => {
      await expect(result.current.addSelectOption(field.id, 'Done')).rejects.toThrow(
        'This row changed'
      );
    });
    expect(result.current.draft?.values[notes.id]).toBeNull();
    expect(result.current.draft?.schemaVersion).toBe(schemaVersion);
    expect(result.current.conflict).toBe(true);
    expect(api.updateEntry).not.toHaveBeenCalled();
  });

  it.each(['cancel', 'focus another cell', 'unmount'] as const)(
    '%s while the field write is pending cannot apply the choice or write to another row',
    async (action) => {
      const mutation = deferred<TableFieldResponse>();
      api.updateField.mockReturnValueOnce(mutation.promise);
      const { result, unmount } = await setup();
      let creating: ReturnType<typeof result.current.addSelectOption> = Promise.resolve(null);
      act(() => {
        creating = result.current.addSelectOption(field.id, 'Done');
      });
      await act(async () => {});
      expect(api.updateField).toHaveBeenCalledOnce();
      if (action === 'cancel') act(() => result.current.cancel());
      else if (action === 'focus another cell') act(() => result.current.focus(notes.id));
      else unmount();
      await act(async () => mutation.resolve(acceptField(api.updateField.mock.calls[0][2])));
      expect(await creating).toBeNull();
      expect(api.entries).not.toHaveBeenCalled();
      expect(api.entry).not.toHaveBeenCalled();
      expect(api.updateEntry).not.toHaveBeenCalled();
      expect(api.createEntry).not.toHaveBeenCalled();
      if (action === 'cancel') {
        expect(result.current.draft).toBeNull();
        await act(async () => {
          expect(
            await result.current.begin(otherEntry, serverFields, refreshedSchema, field.id)
          ).toBe(true);
        });
        expect(result.current.draft?.id).toBe(otherEntry.id);
        expect(result.current.draft?.values[field.id]).toBe('Open');
      }
    }
  );

  it('ignores a second option request until the first finishes', async () => {
    const mutation = deferred<TableFieldResponse>();
    api.updateField.mockReturnValueOnce(mutation.promise);
    const { result } = await setup();
    let first: ReturnType<typeof result.current.addSelectOption> = Promise.resolve(null);
    act(() => {
      first = result.current.addSelectOption(field.id, 'Done');
    });
    await act(async () => {});
    await act(async () => {
      expect(await result.current.addSelectOption(field.id, 'Other')).toBeNull();
    });
    expect(api.fields).toHaveBeenCalledOnce();
    expect(api.updateField).toHaveBeenCalledOnce();
    await act(async () => mutation.resolve(acceptField(api.updateField.mock.calls[0][2])));
    expect((await first)?.option.label).toBe('Done');
  });

  it.each(['cancel', 'unmount'] as const)(
    '%s cannot turn a pending required ghost option into an inserted row',
    async (action) => {
      const mutation = deferred<TableFieldResponse>();
      api.updateField.mockReturnValueOnce(mutation.promise);
      const { result, unmount } = await setup(null, [{ ...field, nullable: false }, notes]);
      let creating: ReturnType<typeof result.current.addSelectOption> = Promise.resolve(null);
      act(() => {
        creating = result.current.addSelectOption(field.id, 'Done');
      });
      await act(async () => {});
      expect(api.updateField).toHaveBeenCalledOnce();
      if (action === 'cancel') act(() => result.current.cancel());
      else unmount();
      await act(async () => mutation.resolve(acceptField(api.updateField.mock.calls[0][2])));
      expect(await creating).toBeNull();
      await act(async () => vi.advanceTimersByTimeAsync(1000));
      expect(api.createEntry).not.toHaveBeenCalled();
      expect(api.updateEntry).not.toHaveBeenCalled();
      expect(api.entries).not.toHaveBeenCalled();
    }
  );

  it.each(['entries', 'entry'] as const)(
    'discards a canceled option completion while the %s refresh is pending',
    async (stage) => {
      const page = deferred<TableEntriesResponse>();
      const row = deferred<TableEntryResponse>();
      if (stage === 'entries') api.entries.mockReturnValueOnce(page.promise);
      else api.entry.mockReturnValueOnce(row.promise);
      const { result, onSaved } = await setup();
      let creating: ReturnType<typeof result.current.addSelectOption> = Promise.resolve(null);
      act(() => {
        creating = result.current.addSelectOption(field.id, 'Done');
      });
      await act(async () => {});
      expect(api[stage]).toHaveBeenCalledOnce();
      act(() => result.current.cancel());
      const refreshed = serverRows.get(entry.id);
      if (!refreshed) throw new Error('Missing refreshed fixture');
      await act(async () => {
        if (stage === 'entries') page.resolve(pageResponse());
        else row.resolve(rowResponse(refreshed));
      });
      expect(await creating).toBeNull();
      expect(result.current.draft).toBeNull();
      expect(result.current.error).toBeNull();
      expect(onSaved).not.toHaveBeenCalled();
      expect(api.updateEntry).not.toHaveBeenCalled();
      expect(api.createEntry).not.toHaveBeenCalled();
    }
  );

  it('uses a concurrently renamed option label from the refreshed schema, not the create response', async () => {
    const { result } = await setup();
    api.entries.mockImplementationOnce(async () => {
      serverFields = serverFields.map((item) =>
        item.id === field.id
          ? {
              ...item,
              options:
                item.options?.map((option) =>
                  option.label === 'Done' ? { ...option, label: 'Finished' } : option
                ) ?? null,
            }
          : item
      );
      return pageResponse();
    });
    let created: Awaited<ReturnType<typeof result.current.addSelectOption>> = null;
    await act(async () => {
      created = await result.current.addSelectOption(field.id, 'Done');
    });
    expect(created).toMatchObject({ option: { label: 'Finished' } });
    act(() => result.current.change(field.id, 'Finished'));
    await act(async () => {
      expect(await result.current.flush()).toBe(true);
    });
    expect(api.updateEntry).toHaveBeenCalledWith(
      tableId,
      entry.id,
      expect.objectContaining({
        values: { [field.id]: 'Finished' },
        schemaVersion: refreshedSchema,
      })
    );
  });
});

describe('array equality follows the field value contract', () => {
  it('saves a select label case correction and does not repeat a cloned array response', async () => {
    const select: TableField = {
      ...field,
      multiple: true,
      nullable: false,
      defaultValue: [],
      options: [{ id: 'opt-open', label: 'open', color: 'blue' }],
    };
    const original = { ...entry, values: { ...entry.values, [field.id]: ['Open'] } };
    const { result } = await setup(original, [select, notes]);
    act(() => result.current.change(field.id, ['open']));
    expect(result.current.draft?.values[field.id]).toEqual(['open']);
    await act(async () => {
      expect(await result.current.flush()).toBe(true);
    });
    expect(api.updateEntry).toHaveBeenCalledExactlyOnceWith(tableId, entry.id, {
      values: { [field.id]: ['open'] },
      schemaVersion,
      expectedRevision: entry.revision,
    });
    act(() => result.current.change(field.id, ['open']));
    await act(async () => vi.advanceTimersByTimeAsync(1000));
    expect(api.updateEntry).toHaveBeenCalledOnce();
  });

  it('keeps case-insensitive UUID equality for multiple relations', async () => {
    const uuid = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const relation: TableField = {
      ...field,
      type: 'relation',
      multiple: true,
      nullable: false,
      defaultValue: [],
      options: null,
      referenceTableId: tableId,
    };
    const original = { ...entry, values: { ...entry.values, [field.id]: [uuid] } };
    const { result } = await setup(original, [relation, notes]);
    act(() => result.current.change(field.id, [uuid.toUpperCase()]));
    await act(async () => {
      expect(await result.current.flush()).toBe(true);
    });
    expect(api.updateEntry).not.toHaveBeenCalled();
    expect(result.current.draft?.values[field.id]).toEqual([uuid]);
  });

  it('does not discard a case-only select edit made during a previous save', async () => {
    const select: TableField = { ...field, multiple: true, nullable: false, defaultValue: [] };
    const original = { ...entry, values: { ...entry.values, [field.id]: [] } };
    const pending = deferred<TableEntryResponse>();
    api.updateEntry.mockReturnValueOnce(pending.promise);
    const { result } = await setup(original, [select, notes]);
    act(() => result.current.change(field.id, ['Open']));
    await act(async () => vi.advanceTimersByTimeAsync(450));
    act(() => result.current.change(field.id, ['open']));
    await act(async () => pending.resolve(acceptEntry(entry.id, api.updateEntry.mock.calls[0][2])));
    expect(result.current.draft?.values[field.id]).toEqual(['open']);
    await act(async () => {
      expect(await result.current.flush()).toBe(false);
    });
    expect(result.current.fieldErrors[field.id]).toContain('"open" is not an option');
    expect(api.updateEntry).toHaveBeenCalledOnce();
  });
});
