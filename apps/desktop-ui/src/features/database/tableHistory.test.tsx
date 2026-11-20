import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  TableHistoryResponse,
  TableHistoryStep,
  TableHistoryStepRequest,
  TableHistoryStepResponse,
} from '@snaglet/shared/types';
import { FetchError } from '@desktop/utils/api/core';
import { emitTableEvent } from './tableEvents';
import {
  __resetTableHistoryForTests,
  stepTableHistory,
  tableHistoryErrorMessage,
  useTableHistory,
} from './tableHistory';

const api = vi.hoisted(() => ({
  history: vi.fn<(limit?: number) => Promise<TableHistoryResponse>>(),
  stepHistory:
    vi.fn<
      (
        direction: 'undo' | 'redo',
        input?: TableHistoryStepRequest
      ) => Promise<TableHistoryStepResponse>
    >(),
}));
const toast = vi.hoisted(() => vi.fn());
vi.mock('@desktop/utils/api', async () => {
  const core =
    await vi.importActual<typeof import('@desktop/utils/api/core')>('@desktop/utils/api/core');
  return { tablesApi: api, FetchError: core.FetchError };
});
vi.mock('@desktop/utils/toast', () => ({ showToast: toast }));

const TABLE = 'table-1111111111111-aaaaaaaaa';
const OTHER = 'table-1111111111111-bbbbbbbbb';
const actor = { kind: 'user' as const, id: 'user-test', name: 'Test User' };
function step(n: number, label: string, tableId = TABLE): TableHistoryStep {
  return {
    id: `step-${n}`,
    actor,
    kind: 'entry.update',
    label,
    tableIds: [tableId],
    state: 'done',
    seq: n,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}
function history(undo: TableHistoryStep | null, redo: TableHistoryStep | null = null) {
  return { actor, steps: undo ? [undo] : [], undo, redo, depth: 100 };
}
function conflict(details: Record<string, unknown>, message = 'Conflict') {
  return new FetchError(message, 409, details);
}

const first = step(1, 'Edit title in test_items');
const second = step(2, 'Add field notes to test_items');

beforeEach(() => {
  vi.resetAllMocks();
  __resetTableHistoryForTests();
  api.history.mockResolvedValue(history(second));
});
afterEach(() => __resetTableHistoryForTests());

async function mounted() {
  const view = renderHook(() => useTableHistory());
  await waitFor(() => expect(view.result.current.undo).toEqual(second));
  return view;
}

describe('table undo history store', () => {
  it('reads the caller’s next steps and re-reads when that stack changes', async () => {
    const { result } = await mounted();
    expect(api.history).toHaveBeenCalledWith(1);
    expect(result.current).toEqual({ undo: second, redo: null, busy: false });

    api.history.mockResolvedValue(history(first, second));
    act(() =>
      emitTableEvent({ type: 'table.history.changed', stack: { kind: 'agent', id: 'agent-a' } })
    );
    expect(api.history).toHaveBeenCalledTimes(1);
    act(() =>
      emitTableEvent({ type: 'table.history.changed', stack: { kind: 'user', id: 'user-test' } })
    );
    await waitFor(() => expect(result.current.redo).toEqual(second));
    expect(result.current.undo).toEqual(first);

    act(() => emitTableEvent({ type: 'tables.invalidated' }));
    await waitFor(() => expect(api.history).toHaveBeenCalledTimes(3));
  });

  it('undoes the step a control showed, then shows what comes next', async () => {
    const { result } = await mounted();
    api.stepHistory.mockResolvedValue({ step: second, undo: first, redo: second });
    await act(() => stepTableHistory('undo', { expected: second, tableId: TABLE }));
    expect(api.stepHistory).toHaveBeenCalledWith('undo', { stepId: 'step-2' });
    expect(result.current).toEqual({ undo: first, redo: second, busy: false });
    expect(toast).not.toHaveBeenCalled();
  });

  it('runs repeated presses in order, each on the stack the last one left', async () => {
    const { result } = await mounted();
    api.history
      .mockResolvedValueOnce(history(second))
      .mockResolvedValueOnce(history(first, second));
    api.stepHistory
      .mockResolvedValueOnce({ step: second, undo: first, redo: second })
      .mockResolvedValueOnce({ step: first, undo: null, redo: first });
    await act(async () => {
      void stepTableHistory('undo');
      await stepTableHistory('undo');
    });
    expect(api.stepHistory.mock.calls).toEqual([
      ['undo', { stepId: 'step-2' }],
      ['undo', { stepId: 'step-1' }],
    ]);
    expect(result.current).toEqual({ undo: null, redo: first, busy: false });
  });

  it('names a step taken in another table', async () => {
    await mounted();
    const elsewhere = step(3, 'Delete 2 entries from other_items', OTHER);
    api.history.mockResolvedValue(history(elsewhere));
    api.stepHistory.mockResolvedValue({ step: elsewhere, undo: null, redo: elsewhere });
    await act(() => stepTableHistory('undo', { tableId: TABLE }));
    expect(toast).toHaveBeenCalledWith('Undone: Delete 2 entries from other_items');
  });

  it('explains a refused step, changes nothing and reads the stack again', async () => {
    const { result } = await mounted();
    api.stepHistory.mockRejectedValue(
      conflict(
        {
          reason: 'conflict',
          conflicts: [{ kind: 'entry', tableId: TABLE, id: 'x', message: 'An entry changed.' }],
        },
        'An entry of test_items changed since. Undo refuses to overwrite it.'
      )
    );
    api.history.mockResolvedValue(history(first));
    await act(() => stepTableHistory('undo', { expected: second }));
    expect(toast).toHaveBeenCalledWith(
      "Can't undo “Add field notes to test_items”: the data changed since, so nothing was undone. An entry of test_items changed since. Undo refuses to overwrite it.",
      { durationMs: 6000 }
    );
    expect(result.current).toEqual({ undo: first, redo: null, busy: false });
  });

  it('words stale, empty and name conflicts for the toast', () => {
    expect(tableHistoryErrorMessage('undo', first, conflict({ reason: 'stale' }))).toBe(
      'Your table history changed, so nothing was undone. Try again.'
    );
    expect(tableHistoryErrorMessage('redo', null, conflict({ reason: 'empty' }))).toBe(
      'Nothing to redo.'
    );
    const removed =
      "That step's table was permanently deleted, so it was removed from your history. Press Undo again for the step before it.";
    expect(
      tableHistoryErrorMessage(
        'undo',
        first,
        conflict({ reason: 'discarded', step: first }, removed)
      )
    ).toBe(removed);
    expect(
      tableHistoryErrorMessage(
        'undo',
        first,
        conflict({
          reason: 'nameTaken',
          names: [{ kind: 'field', id: 'field-1', tableId: TABLE, name: 'title' }],
        })
      )
    ).toBe(
      "Can't undo “Edit title in test_items”: the name “title” is used by another field now. Rename that one and try again."
    );
    expect(
      tableHistoryErrorMessage(
        'undo',
        first,
        conflict(
          { reason: 'conflict', conflicts: [] },
          'The tables are busy. Nothing was changed; try again.'
        )
      )
    ).toBe(
      "Can't undo “Edit title in test_items”: The tables are busy. Nothing was changed; try again."
    );
    expect(tableHistoryErrorMessage('undo', first, new Error('offline'))).toBe(
      "Can't undo “Edit title in test_items”: offline"
    );
  });

  it('saves first: a blocked save cancels, and a save takes the newest step', async () => {
    const { result } = await mounted();
    await act(() => stepTableHistory('undo', { prepare: async () => 'blocked' }));
    expect(api.stepHistory).not.toHaveBeenCalled();

    const saved = step(3, 'Edit title in test_items');
    api.history.mockResolvedValue(history(saved));
    api.stepHistory.mockResolvedValue({ step: saved, undo: second, redo: saved });
    await act(() => stepTableHistory('undo', { expected: second, prepare: async () => 'saved' }));
    expect(api.stepHistory).toHaveBeenCalledWith('undo', { stepId: 'step-3' });
    expect(result.current.undo).toEqual(second);
  });
});
