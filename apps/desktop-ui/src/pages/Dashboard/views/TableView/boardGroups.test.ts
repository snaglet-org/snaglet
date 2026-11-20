import { describe, expect, it } from 'vitest';
import type { TableEntry, TableField } from '@snaglet/shared/types';
import { groupBoardEntries, hasCardValue, NO_VALUE_KEY } from './boardGroups';

const tableId = 'table-1111111111111-aaaaaaaaa';
const status: TableField = {
  range: false,
  id: 'field-1111111111111-status',
  tableId,
  columnName: 'status',
  name: 'Status',
  description: null,
  type: 'select',
  nullable: true,
  defaultValue: null,
  referenceTableId: null,
  referenceKind: null,
  multiple: false,
  options: [
    { id: 'opt-todo', label: 'To do', color: 'gray' },
    { id: 'opt-doing', label: 'Doing', color: 'blue' },
    { id: 'opt-done', label: 'Done', color: 'green' },
  ],
  position: 1,
  managed: false,
  collapsed: false,
  isTitle: false,
  revision: 1,
};

const entry = (n: number, value: string | null): TableEntry => ({
  id: `00000000-0000-4000-8000-00000000000${n}`,
  createdAt: '2026-01-01T00:00:00.000000Z',
  revision: `rev-${n}`,
  values: { [status.id]: value },
});

describe('groupBoardEntries', () => {
  it('makes one column per option in option order, then "No <field>"', () => {
    const groups = groupBoardEntries(
      [entry(1, 'Done'), entry(2, null), entry(3, 'To do'), entry(4, 'Done')],
      status
    );
    expect(groups.map((group) => group.label)).toEqual(['To do', 'Doing', 'Done', 'No Status']);
    expect(groups.map((group) => group.entries.map((item) => item.id.slice(-1)))).toEqual([
      ['3'],
      [],
      ['1', '4'],
      ['2'],
    ]);
    expect(groups[3]).toMatchObject({ key: NO_VALUE_KEY, value: null, option: null });
    expect(groups[0]?.option).toEqual(status.options?.[0]);
  });

  it('keeps rows whose label the field no longer offers in their own trailing column', () => {
    const groups = groupBoardEntries([entry(1, 'Blocked'), entry(2, 'Doing')], status);
    expect(groups.map((group) => group.label)).toEqual([
      'To do',
      'Doing',
      'Done',
      'Blocked',
      'No Status',
    ]);
    expect(groups[3]).toMatchObject({ value: 'Blocked', option: null });
    expect(groups[3]?.entries).toHaveLength(1);
  });

  it('renders pending moves in their target column before the server confirms', () => {
    const rows = [entry(1, 'To do'), entry(2, 'Done')];
    const groups = groupBoardEntries(
      rows,
      status,
      new Map([
        [rows[0]!.id, 'Doing'],
        [rows[1]!.id, null],
      ])
    );
    expect(groups.map((group) => group.entries.length)).toEqual([0, 1, 0, 1]);
    expect(groups[1]?.entries[0]?.id).toBe(rows[0]!.id);
    expect(groups[3]?.entries[0]?.id).toBe(rows[1]!.id);
  });
});

describe('hasCardValue', () => {
  const text = { ...status, type: 'text' as const, options: null };
  const checkbox = { ...status, type: 'checkbox' as const, options: null };
  it('treats blanks, empty lists and unchecked boxes as empty', () => {
    expect(hasCardValue(text, null)).toBe(false);
    expect(hasCardValue(text, '  ')).toBe(false);
    expect(hasCardValue(text, 'note')).toBe(true);
    expect(hasCardValue(status, [])).toBe(false);
    expect(hasCardValue(status, ['Done'])).toBe(true);
    expect(hasCardValue(checkbox, false)).toBe(false);
    expect(hasCardValue(checkbox, true)).toBe(true);
  });
});
