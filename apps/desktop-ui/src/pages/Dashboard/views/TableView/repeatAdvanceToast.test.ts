import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TableEntry, TableField, TableHistoryStep } from '@snaglet/shared/types';
import { TOAST_EVENT_NAME, type ToastDetail } from '@desktop/utils/toast';
import {
  advanceDateText,
  noteRepeatAdvance,
  repeatAdvanceMessage,
  repeatAdvances,
} from './repeatAdvanceToast';

const history = vi.hoisted(() => ({
  history: vi.fn(),
  step: vi.fn(async () => undefined),
}));
vi.mock('@desktop/utils/api', async () => {
  const actual = await vi.importActual<typeof import('@desktop/utils/api')>('@desktop/utils/api');
  return { ...actual, tablesApi: { ...actual.tablesApi, history: history.history } };
});
vi.mock('@desktop/features/database/tableHistory', async () => ({
  ...(await vi.importActual<typeof import('@desktop/features/database/tableHistory')>(
    '@desktop/features/database/tableHistory'
  )),
  stepTableHistory: history.step,
}));
const repeatsApi = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock('@desktop/utils/api/tableRepeats', () => ({ tableRepeatsApi: repeatsApi }));

const tableId = 'table-1111111111111-aaaaaaaaa';
const base: TableField = {
  id: 'field-1111111111111-name',
  tableId,
  columnName: 'name',
  name: 'Name',
  type: 'text',
  nullable: true,
  defaultValue: null,
  isTitle: true,
  position: 0,
  options: null,
  multiple: false,
} as unknown as TableField;
const name = base;
const status = { ...base, id: 'field-status', name: 'Status', type: 'select', isTitle: false };
const due = {
  ...base,
  id: 'field-due',
  name: 'Due',
  type: 'date',
  isTitle: false,
  recurrence: {
    statusFieldId: 'field-status',
    doneOptionIds: ['opt-done'],
    resetOptionId: 'opt-todo',
  },
} as unknown as TableField;
const fields = [name, status, due] as TableField[];

const entry = (values: TableEntry['values']): TableEntry => ({
  id: 'entry-1',
  createdAt: '2026-01-01T00:00:00.000000Z',
  revision: 'r1',
  values: { [name.id]: 'Pay rent', [status.id]: 'To do', [due.id]: '2026-10-12', ...values },
});

const step: TableHistoryStep = {
  id: 'step-1',
  label: 'Update Pay rent',
  tableIds: [tableId],
  state: 'done',
  seq: 7,
  createdAt: '2026-10-12T00:00:00Z',
} as unknown as TableHistoryStep;

let toasts: ToastDetail[];
const listener = (e: Event) => toasts.push((e as CustomEvent<ToastDetail>).detail);
beforeEach(() => {
  toasts = [];
  vi.clearAllMocks();
  window.addEventListener(TOAST_EVENT_NAME, listener);
});
afterEach(() => window.removeEventListener(TOAST_EVENT_NAME, listener));

describe('repeatAdvanceToast', () => {
  const before = entry({});
  const after = { ...entry({ [due.id]: '2026-10-19' }), revision: 'r2' };
  const patch = { [status.id]: 'Done' };

  it('finds a repeating date the server moved on because the patch set its status', () => {
    expect(repeatAdvances(fields, before, after, patch)).toEqual([
      { field: due, from: '2026-10-12', to: '2026-10-19' },
    ]);
    // The patch wrote the date itself, or didn't touch the status, or nothing moved.
    expect(repeatAdvances(fields, before, after, { ...patch, [due.id]: '2026-10-19' })).toEqual([]);
    expect(repeatAdvances(fields, before, after, { [name.id]: 'x' })).toEqual([]);
    expect(repeatAdvances(fields, before, before, patch)).toEqual([]);
  });

  it('says "done for <date> · next <date>"', () => {
    expect(repeatAdvanceMessage('Pay rent', repeatAdvances(fields, before, after, patch))).toBe(
      'Pay rent done for Mon, Oct 12 · next Mon, Oct 19'
    );
  });

  it('offers Undo for the exact table-history step', async () => {
    history.history.mockResolvedValue({ undo: step, redo: null });
    expect(await noteRepeatAdvance({ tableId, fields, before, after, patch })).toBe(true);
    expect(toasts).toHaveLength(1);
    expect(toasts[0]!.message).toBe('Pay rent done for Mon, Oct 12 · next Mon, Oct 19');
    toasts[0]!.action!.run();
    expect(history.step).toHaveBeenCalledWith('undo', { expected: step, tableId });
  });

  it('without the step, points at the table history and offers no Undo', async () => {
    history.history.mockRejectedValue(new Error('offline'));
    await noteRepeatAdvance({ tableId, fields, before, after, patch });
    expect(toasts[0]!.action).toBeUndefined();
    expect(toasts[0]!.message).toMatch(/To undo it, use the table's history\.$/);
  });

  it('names a range by its start, and a resize with the status still counts', () => {
    const trip = { ...due, id: 'field-trip', name: 'Trip', range: true } as TableField;
    const slot = {
      ...due,
      id: 'field-slot',
      name: 'Slot',
      type: 'datetime',
      range: true,
    } as unknown as TableField;
    const from = entry({
      [trip.id]: '2026-10-12/2026-10-14',
      [slot.id]: '2026-10-12T13:00:00.000000Z/2026-10-12T14:00:00.000000Z',
    });
    const to = entry({
      [trip.id]: '2026-10-19/2026-10-22',
      [slot.id]: '2026-10-19T13:00:00.000000Z/2026-10-19T14:00:00.000000Z',
    });
    const all = [name, status, trip, slot] as TableField[];
    // The patch resized the trip (same start) and set the status: it advanced.
    const advances = repeatAdvances(all, from, to, {
      ...patch,
      [trip.id]: '2026-10-12/2026-10-15',
    });
    expect(advances.map((a) => a.field.id)).toEqual([trip.id, slot.id]);
    expect(repeatAdvanceMessage('Pay rent', advances.slice(0, 1))).toBe(
      'Pay rent done for Mon, Oct 12 · next Mon, Oct 19'
    );
    expect(advanceDateText(slot, to.values[slot.id] as string)).toMatch(/^Mon, Oct 19, /);
    // Moving the start is the writer's own choice.
    expect(
      repeatAdvances(all, from, to, { ...patch, [trip.id]: '2026-10-13/2026-10-15' }).map(
        (a) => a.field.id
      )
    ).toEqual([slot.id]);
  });

  it('stays quiet when nothing advanced', async () => {
    expect(await noteRepeatAdvance({ tableId, fields, before, after: before, patch })).toBe(false);
    expect(toasts).toEqual([]);
    expect(history.history).not.toHaveBeenCalled();
  });
});
