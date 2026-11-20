import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { TableField } from '@snaglet/shared/types';

const tables = vi.hoisted(() => ({
  fields: vi.fn(),
  setFieldCalendar: vi.fn(),
  updateField: vi.fn(),
}));
vi.mock('@desktop/utils/api', () => ({ tablesApi: tables }));
vi.mock('@desktop/features/database/tableEvents', () => ({ emitTableEvent: vi.fn() }));
const history = vi.hoisted(() => ({ stepTableHistory: vi.fn() }));
vi.mock('@desktop/features/database/tableHistory', () => history);

import { bindFieldToCalendar, setFieldBinding } from './bindField';

function field(extra: Partial<TableField>): TableField {
  return {
    id: 'f1',
    tableId: 't1',
    columnName: 'f1',
    name: 'Start',
    description: '',
    type: 'datetime',
    nullable: true,
    defaultValue: null,
    referenceTableId: null,
    referenceKind: null,
    multiple: false,
    options: null,
    position: 0,
    managed: false,
    revision: 3,
    collapsed: false,
    ...extra,
  } as TableField;
}

describe('bindField undo (reverse binding write with revision, calendar stack)', () => {
  beforeEach(() => {
    tables.fields.mockReset();
    tables.setFieldCalendar.mockReset();
    tables.updateField.mockReset();
    history.stepTableHistory.mockReset();
  });

  it('bind: undo writes the previous calendarId with the returned revision; redo re-applies', async () => {
    tables.fields.mockResolvedValue({ fields: [field({ calendarId: null, revision: 3 })] });
    tables.setFieldCalendar
      .mockResolvedValueOnce({ field: field({ calendarId: 'cal-9', revision: 4 }) })
      .mockResolvedValueOnce({ field: field({ calendarId: null, revision: 5 }) })
      .mockResolvedValueOnce({ field: field({ calendarId: 'cal-9', revision: 6 }) });

    const { step } = await bindFieldToCalendar('t1', 'f1', 'default', 'Show Tasks · Start');
    // Only the binding goes over the wire, never the field's definition.
    expect(tables.setFieldCalendar.mock.calls[0]).toEqual([
      't1',
      'f1',
      { calendarId: 'default', expectedRevision: 3 },
    ]);

    await step.undo();
    expect(tables.setFieldCalendar.mock.calls[1]).toEqual([
      't1',
      'f1',
      expect.objectContaining({ calendarId: null, expectedRevision: 4 }),
    ]);

    await step.redo!();
    // 'default' resolved to the real calendar id on redo.
    expect(tables.setFieldCalendar.mock.calls[2]).toEqual([
      't1',
      'f1',
      expect.objectContaining({ calendarId: 'cal-9', expectedRevision: 5 }),
    ]);
    expect(history.stepTableHistory).not.toHaveBeenCalled();
    expect(tables.updateField).not.toHaveBeenCalled();
  });

  it("binds Snaglet's managed created_at like any datetime field, and undoes it", async () => {
    const created = field({ id: 'created', name: 'created_at', managed: true, revision: 1 });
    tables.fields.mockResolvedValue({ fields: [created] });
    tables.setFieldCalendar
      .mockResolvedValueOnce({ field: { ...created, calendarId: 'cal-1', revision: 2 } })
      .mockResolvedValueOnce({ field: { ...created, revision: 3 } });
    const { field: bound, step } = await bindFieldToCalendar('t1', 'created', 'cal-1');
    expect(bound).toMatchObject({ managed: true, calendarId: 'cal-1' });
    expect(tables.setFieldCalendar.mock.calls[0]).toEqual([
      't1',
      'created',
      { calendarId: 'cal-1', expectedRevision: 1 },
    ]);
    await step.undo();
    expect(tables.setFieldCalendar.mock.calls[1]).toEqual([
      't1',
      'created',
      { calendarId: null, expectedRevision: 2 },
    ]);
    expect(tables.updateField).not.toHaveBeenCalled();
  });

  it('unbind sends null; undo restores the calendar', async () => {
    tables.fields.mockResolvedValue({ fields: [field({ calendarId: 'cal-1', revision: 8 })] });
    tables.setFieldCalendar
      .mockResolvedValueOnce({ field: field({ calendarId: null, revision: 9 }) })
      .mockResolvedValueOnce({ field: field({ calendarId: 'cal-1', revision: 10 }) });

    const { step } = await setFieldBinding('t1', 'f1', null, 'Hide Start');
    expect(tables.setFieldCalendar.mock.calls[0][2]).toMatchObject({
      calendarId: null,
      expectedRevision: 8,
    });
    await step.undo();
    expect(tables.setFieldCalendar.mock.calls[1][2]).toMatchObject({
      calendarId: 'cal-1',
      expectedRevision: 9,
    });
  });

  it('never sends an end field (a range field holds its own end)', async () => {
    for (const type of ['date', 'datetime'] as const) {
      tables.setFieldCalendar.mockReset();
      tables.fields.mockResolvedValue({ fields: [field({ type, range: true, revision: 1 })] });
      tables.setFieldCalendar.mockResolvedValue({
        field: field({ type, range: true, calendarId: 'c', revision: 2 }),
      });
      await bindFieldToCalendar('t1', 'f1', 'c');
      expect(tables.setFieldCalendar.mock.calls[0][2]).not.toHaveProperty('calendarEndFieldId');
    }
  });

  it('a refused undo (field edited since) rejects so the stack toasts', async () => {
    tables.fields.mockResolvedValue({ fields: [field({ revision: 1 })] });
    tables.setFieldCalendar
      .mockResolvedValueOnce({ field: field({ calendarId: 'c', revision: 2 }) })
      .mockRejectedValueOnce(new Error('This field changed'));
    const { step } = await bindFieldToCalendar('t1', 'f1', 'c');
    await expect(step.undo()).rejects.toThrow('This field changed');
  });
});
