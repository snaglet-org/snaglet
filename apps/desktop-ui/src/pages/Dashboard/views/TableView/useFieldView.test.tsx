import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  TableField,
  TableFieldResponse,
  UpdateTableFieldViewRequest,
} from '@snaglet/shared/types';
import { useFieldView, WIDTH_SAVE_DELAY_MS } from './useFieldView';

const api = vi.hoisted(() => ({
  setFieldView:
    vi.fn<
      (
        tableId: string,
        fieldId: string,
        input: UpdateTableFieldViewRequest
      ) => Promise<TableFieldResponse>
    >(),
}));
vi.mock('@desktop/utils/api', () => ({ tablesApi: api }));

const field: TableField = {
  range: false,
  id: 'field-1111111111111-aaaaaaaaa',
  tableId: 'table-1111111111111-aaaaaaaaa',
  name: 'notes',
  columnName: 'notes',
  description: null,
  type: 'text',
  nullable: true,
  defaultValue: null,
  referenceTableId: null,
  referenceKind: null,
  position: 2,
  managed: false,
  revision: 1,
  collapsed: false,
  isTitle: false,
  multiple: false,
  options: null,
};

function deferred<T>() {
  let complete: (value: T) => void;
  let fail: (reason: Error) => void;
  const promise = new Promise<T>((resolve, reject) => {
    complete = resolve;
    fail = reject;
  });
  return { promise, resolve: (value: T) => complete(value), reject: (error: Error) => fail(error) };
}

beforeEach(() => {
  vi.resetAllMocks();
});

describe('useFieldView', () => {
  it('shows the pending preference over reloads without changing schema metadata', async () => {
    const request = deferred<TableFieldResponse>();
    api.setFieldView.mockReturnValue(request.promise);
    const reload = vi.fn();
    const { result, rerender } = renderHook(
      ({ fields }) => useFieldView(field.tableId, fields, reload),
      { initialProps: { fields: [field] } }
    );

    act(() => void result.current.toggle(field));
    expect(result.current.fields).toEqual([{ ...field, collapsed: true }]);
    expect(result.current.pendingFieldIds.has(field.id)).toBe(true);
    rerender({ fields: [{ ...field, name: 'renamed_notes', revision: 2 }] });
    expect(result.current.fields).toEqual([
      { ...field, name: 'renamed_notes', revision: 2, collapsed: true },
    ]);
    expect(api.setFieldView).toHaveBeenCalledWith(field.tableId, field.id, { collapsed: true });

    await act(async () => request.resolve({ field: { ...field, collapsed: true } }));
    expect(reload).toHaveBeenCalledOnce();
    expect(result.current.pendingFieldIds.size).toBe(0);
    rerender({ fields: [{ ...field, collapsed: true }] });
    rerender({ fields: [{ ...field, collapsed: false }] });
    expect(result.current.fields[0].collapsed).toBe(false);
  });

  it('rolls back a failed toggle to the last successful view while its reload is delayed', async () => {
    api.setFieldView.mockResolvedValueOnce({ field: { ...field, collapsed: true } });
    const { result } = renderHook(() => useFieldView(field.tableId, [field], vi.fn()));
    await act(async () => result.current.toggle(field));
    expect(result.current.fields[0].collapsed).toBe(true);
    api.setFieldView.mockRejectedValueOnce(new Error('View save unavailable'));

    await act(async () => result.current.toggle(result.current.fields[0]));

    expect(result.current.fields[0].collapsed).toBe(true);
    expect(result.current.pendingFieldIds.size).toBe(0);
    expect(result.current.error).toBe('View save unavailable');
    expect(api.setFieldView).toHaveBeenLastCalledWith(field.tableId, field.id, {
      collapsed: false,
    });
  });

  it('preserves a newer view save over an older reorder response and its pending follow-up', async () => {
    api.setFieldView.mockResolvedValueOnce({ field: { ...field, collapsed: true } });
    const { result, rerender } = renderHook(
      ({ fields }) => useFieldView(field.tableId, fields, vi.fn()),
      { initialProps: { fields: [field] } }
    );
    const checkpoint = result.current.checkpoint();
    await act(async () => result.current.toggle(field));
    const nextRequest = deferred<TableFieldResponse>();
    api.setFieldView.mockReturnValueOnce(nextRequest.promise);
    act(() => void result.current.toggle(result.current.fields[0]));
    const reordered = result.current.reconcile([{ ...field, position: 0 }], checkpoint);
    expect(reordered).toEqual([{ ...field, position: 0, collapsed: true }]);
    rerender({ fields: reordered });
    expect(result.current.fields[0]).toEqual({ ...field, position: 0, collapsed: false });

    await act(async () => nextRequest.resolve({ field }));
    expect(result.current.fields[0].collapsed).toBe(false);
  });

  it('acknowledges rollback after its first save reload so later remote preferences remain visible', async () => {
    api.setFieldView.mockResolvedValueOnce({ field: { ...field, collapsed: true } });
    const { result, rerender } = renderHook(
      ({ fields }) => useFieldView(field.tableId, fields, vi.fn()),
      { initialProps: { fields: [field] } }
    );
    await act(async () => result.current.toggle(field));
    const expand = deferred<TableFieldResponse>();
    api.setFieldView.mockReturnValueOnce(expand.promise);
    act(() => void result.current.toggle(result.current.fields[0]));
    rerender({ fields: [{ ...field, collapsed: true }] });
    await act(async () => expand.reject(new Error('Expand unavailable')));
    expect(result.current.fields[0].collapsed).toBe(true);
    rerender({ fields: [field] });
    expect(result.current.fields[0].collapsed).toBe(false);
  });

  it('allows managed views, prevents duplicate requests, and ignores completion after unmount', async () => {
    const managed = { ...field, managed: true };
    const request = deferred<TableFieldResponse>();
    api.setFieldView.mockReturnValue(request.promise);
    const reload = vi.fn();
    const { result, unmount } = renderHook(() => useFieldView(field.tableId, [managed], reload));
    act(() => {
      void result.current.toggle(managed);
      void result.current.toggle(managed);
    });
    expect(api.setFieldView).toHaveBeenCalledOnce();
    unmount();
    request.resolve({ field: { ...managed, collapsed: true } });
    await waitFor(() => expect(api.setFieldView).toHaveBeenCalledOnce());
    expect(reload).not.toHaveBeenCalled();
  });

  it('keeps local intent over pre-save loads, then accepts a newer load even when the flag differs', async () => {
    let latestRequest = 2;
    const reload = vi.fn(() => {
      latestRequest += 1;
    });
    api.setFieldView.mockResolvedValueOnce({ field: { ...field, collapsed: true } });
    const { result, rerender } = renderHook(
      ({ fields, completedRequest }) =>
        useFieldView(field.tableId, fields, reload, {
          latestRequest: () => latestRequest,
          completedRequest,
        }),
      { initialProps: { fields: [field], completedRequest: 1 } }
    );
    await act(async () => result.current.toggle(field));
    expect(latestRequest).toBe(3);
    // Request 2 was already in flight at save completion. Even an apparent
    // match is not an authoritative acknowledgment of that save.
    rerender({ fields: [{ ...field, collapsed: true }], completedRequest: 2 });
    rerender({ fields: [field], completedRequest: 2 });
    expect(result.current.fields[0].collapsed).toBe(true);
    rerender({ fields: [field], completedRequest: 3 });
    expect(result.current.fields[0].collapsed).toBe(false);
  });

  it('uses the authoritative reload flag for older reorders without overriding future reorder snapshots', async () => {
    let latestRequest = 1;
    const reload = vi.fn(() => {
      latestRequest += 1;
    });
    api.setFieldView.mockResolvedValueOnce({ field: { ...field, collapsed: true } });
    const { result, rerender } = renderHook(
      ({ fields, completedRequest }) =>
        useFieldView(field.tableId, fields, reload, {
          latestRequest: () => latestRequest,
          completedRequest,
        }),
      { initialProps: { fields: [field], completedRequest: 1 } }
    );
    const oldReorder = result.current.checkpoint();
    await act(async () => result.current.toggle(field));
    rerender({ fields: [field], completedRequest: 2 });
    expect(result.current.fields[0].collapsed).toBe(false);
    expect(result.current.reconcile([{ ...field, collapsed: true }], oldReorder)[0].collapsed).toBe(
      false
    );
    const nextReorder = result.current.checkpoint();
    expect(
      result.current.reconcile([{ ...field, collapsed: true }], nextReorder)[0].collapsed
    ).toBe(true);
    latestRequest = 3;
    rerender({ fields: [{ ...field, collapsed: true }], completedRequest: 3 });
    expect(result.current.reconcile([field], nextReorder)[0].collapsed).toBe(true);
  });

  it('rolls back a pending follow-up to the acknowledged server flag, not a superseded local overlay', async () => {
    let latestRequest = 1;
    const reload = vi.fn(() => {
      latestRequest += 1;
    });
    api.setFieldView.mockResolvedValueOnce({ field: { ...field, collapsed: true } });
    const { result, rerender } = renderHook(
      ({ fields, completedRequest }) =>
        useFieldView(field.tableId, fields, reload, {
          latestRequest: () => latestRequest,
          completedRequest,
        }),
      { initialProps: { fields: [field], completedRequest: 1 } }
    );
    const checkpoint = result.current.checkpoint();
    await act(async () => result.current.toggle(field));
    const followUp = deferred<TableFieldResponse>();
    api.setFieldView.mockReturnValueOnce(followUp.promise);
    act(() => void result.current.toggle(result.current.fields[0]));
    rerender({ fields: [field], completedRequest: 2 });
    await act(async () => followUp.reject(new Error('Follow-up unavailable')));
    expect(result.current.fields[0].collapsed).toBe(false);
    expect(result.current.pendingFieldIds.size).toBe(0);
    expect(result.current.reconcile([{ ...field, collapsed: true }], checkpoint)[0].collapsed).toBe(
      false
    );
  });
});

describe('useFieldView widths', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  const wait = (ms: number) => act(async () => void vi.advanceTimersByTime(ms));

  it('shows a width at once and saves only the last one, once, after a quiet spell', async () => {
    api.setFieldView.mockImplementation((_table, _field, input) =>
      Promise.resolve({ field: { ...field, width: input.width } })
    );
    const reload = vi.fn();
    const { result, rerender } = renderHook(
      ({ fields }) => useFieldView(field.tableId, fields, reload),
      { initialProps: { fields: [field] } }
    );

    act(() => result.current.resize(field, 200));
    expect(result.current.fields[0].width).toBe(200);
    await wait(WIDTH_SAVE_DELAY_MS - 1);
    act(() => result.current.resize(result.current.fields[0], 216));
    act(() => result.current.resize(result.current.fields[0], 232));
    expect(result.current.fields[0]).toEqual({ ...field, width: 232 });
    await wait(WIDTH_SAVE_DELAY_MS - 1);
    expect(api.setFieldView).not.toHaveBeenCalled();
    // A width is no schema change: nothing about the field but its width moves.
    rerender({ fields: [{ ...field, name: 'renamed_notes', revision: 2 }] });
    expect(result.current.fields[0]).toEqual({
      ...field,
      name: 'renamed_notes',
      revision: 2,
      width: 232,
    });

    await wait(1);
    expect(api.setFieldView).toHaveBeenCalledOnce();
    expect(api.setFieldView).toHaveBeenCalledWith(field.tableId, field.id, { width: 232 });
    expect(reload).toHaveBeenCalledOnce();
    rerender({ fields: [{ ...field, width: 232 }] });
    expect(result.current.fields[0].width).toBe(232);
    expect(result.current.pendingFieldIds.size).toBe(0);
  });

  it('returns a column to auto with null, leaving the width key out', async () => {
    const sized = { ...field, width: 300 };
    api.setFieldView.mockResolvedValueOnce({ field });
    const { result } = renderHook(() => useFieldView(field.tableId, [sized], vi.fn()));
    act(() => result.current.resize(sized, null));
    expect(result.current.fields[0]).toEqual(field);
    expect(result.current.fields[0]).not.toHaveProperty('width');
    await wait(WIDTH_SAVE_DELAY_MS);
    expect(api.setFieldView).toHaveBeenCalledWith(field.tableId, field.id, { width: null });
  });

  it('keeps a newer width set while the last one saved, and saves it next', async () => {
    const first = deferred<TableFieldResponse>();
    api.setFieldView.mockReturnValueOnce(first.promise);
    api.setFieldView.mockResolvedValueOnce({ field: { ...field, width: 240 } });
    const { result } = renderHook(() => useFieldView(field.tableId, [field], vi.fn()));
    act(() => result.current.resize(field, 200));
    await wait(WIDTH_SAVE_DELAY_MS);
    expect(api.setFieldView).toHaveBeenCalledOnce();
    expect(result.current.pendingFieldIds.has(field.id)).toBe(true);

    act(() => result.current.resize(result.current.fields[0], 240));
    await act(async () => first.resolve({ field: { ...field, width: 200 } }));
    expect(result.current.fields[0].width).toBe(240);
    await wait(WIDTH_SAVE_DELAY_MS);
    expect(api.setFieldView).toHaveBeenLastCalledWith(field.tableId, field.id, { width: 240 });
    expect(api.setFieldView).toHaveBeenCalledTimes(2);
  });

  it('puts the width back and says so when its save fails', async () => {
    api.setFieldView.mockRejectedValueOnce(new Error('Resize unavailable'));
    const sized = { ...field, width: 180 };
    const { result } = renderHook(() => useFieldView(field.tableId, [sized], vi.fn()));
    act(() => result.current.resize(sized, 320));
    expect(result.current.fields[0].width).toBe(320);
    await wait(WIDTH_SAVE_DELAY_MS);
    expect(result.current.fields[0].width).toBe(180);
    expect(result.current.error).toBe('Resize unavailable');
    expect(result.current.pendingFieldIds.size).toBe(0);
  });

  it('keeps a waiting width over a collapse toggle, and the toggle keeps the saved width', async () => {
    const sized = { ...field, width: 180 };
    api.setFieldView.mockImplementation((_table, _field, input) =>
      Promise.resolve({ field: { ...sized, ...input } })
    );
    const { result } = renderHook(() => useFieldView(field.tableId, [sized], vi.fn()));
    act(() => result.current.resize(sized, 260));
    await act(async () => result.current.toggle(result.current.fields[0]));
    expect(api.setFieldView).toHaveBeenCalledWith(field.tableId, field.id, { collapsed: true });
    expect(result.current.fields[0]).toMatchObject({ collapsed: true, width: 260 });
    await wait(WIDTH_SAVE_DELAY_MS);
    expect(api.setFieldView).toHaveBeenLastCalledWith(field.tableId, field.id, { width: 260 });
  });

  it('saves a waiting width when the grid goes away', async () => {
    api.setFieldView.mockResolvedValue({ field: { ...field, width: 200 } });
    const { result, unmount } = renderHook(() => useFieldView(field.tableId, [field], vi.fn()));
    act(() => result.current.resize(field, 200));
    unmount();
    expect(api.setFieldView).toHaveBeenCalledWith(field.tableId, field.id, { width: 200 });
    await wait(WIDTH_SAVE_DELAY_MS);
    expect(api.setFieldView).toHaveBeenCalledOnce();
  });

  it('carries a saved width over an older reorder response', async () => {
    api.setFieldView.mockResolvedValueOnce({ field: { ...field, width: 280 } });
    const { result } = renderHook(() => useFieldView(field.tableId, [field], vi.fn()));
    const checkpoint = result.current.checkpoint();
    act(() => result.current.resize(field, 280));
    await wait(WIDTH_SAVE_DELAY_MS);
    expect(result.current.reconcile([{ ...field, position: 0 }], checkpoint)).toEqual([
      { ...field, position: 0, width: 280 },
    ]);
  });
});
