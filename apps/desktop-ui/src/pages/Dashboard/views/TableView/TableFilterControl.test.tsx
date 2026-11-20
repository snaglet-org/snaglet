import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import type { TableEntryWhere, TableField } from '@snaglet/shared/types';
import { TableFilterBar, TableFilterControl } from './TableFilterControl';
import { filterOperators, isComplete } from './tableFilterRules';
import { liveFilter, readTableFilter, writeTableFilter } from './boardViewPreference';

function field(
  id: string,
  name: string,
  type: string,
  extra: Partial<TableField> = {}
): TableField {
  return { id, name, type, managed: false, isTitle: false, options: null, ...extra } as TableField;
}

const FIELDS = [
  field('f-name', 'Name', 'text', { isTitle: true }),
  field('f-status', 'Status', 'select', {
    options: [
      { id: 'o1', label: 'todo', color: 'gray' },
      { id: 'o2', label: 'done', color: 'gray' },
    ],
  }),
  field('f-amount', 'Amount', 'number'),
  field('f-due', 'Due', 'date'),
  field('f-tags', 'Tags', 'select', {
    multiple: true,
    options: [{ id: 'o3', label: 'red', color: 'gray' }],
  }),
  field('f-ok', 'OK', 'checkbox'),
] as TableField[];

function setup(where: TableEntryWhere[] = []) {
  const onChange = vi.fn();
  render(<TableFilterControl fields={FIELDS} where={where} onChange={onChange} />);
  fireEvent.click(screen.getByRole('button', { name: /^Filter/ }));
  return onChange;
}

describe('TableFilterControl', () => {
  it('adds a condition on the first field with its first operator', () => {
    const onChange = setup();
    fireEvent.click(screen.getByRole('button', { name: '+ Add filter' }));
    expect(onChange).toHaveBeenCalledWith([{ fieldId: 'f-name', operator: 'contains', value: '' }]);
  });

  it('offers operators by type and resets the value when the field changes', () => {
    const onChange = setup([{ fieldId: 'f-amount', operator: 'gt', value: '5' }]);
    const ops = screen.getByRole('combobox', { name: 'Filter 1 condition' });
    expect(Array.from(ops.querySelectorAll('option')).map((o) => o.textContent)).toEqual([
      '=',
      '≠',
      '>',
      '≥',
      '<',
      '≤',
      'is empty',
      'is not empty',
    ]);
    fireEvent.change(screen.getByRole('combobox', { name: 'Filter 1 field' }), {
      target: { value: 'f-status' },
    });
    expect(onChange).toHaveBeenLastCalledWith([
      { fieldId: 'f-status', operator: 'is', value: 'todo' },
    ]);
  });

  it('drops the value for is empty and edits values', () => {
    const onChange = setup([{ fieldId: 'f-name', operator: 'contains', value: 'a' }]);
    fireEvent.change(screen.getByRole('textbox', { name: 'Filter 1 value' }), {
      target: { value: 'launch' },
    });
    expect(onChange).toHaveBeenLastCalledWith([
      { fieldId: 'f-name', operator: 'contains', value: 'launch' },
    ]);
    fireEvent.change(screen.getByRole('combobox', { name: 'Filter 1 condition' }), {
      target: { value: 'is_empty' },
    });
    expect(onChange).toHaveBeenLastCalledWith([
      { fieldId: 'f-name', operator: 'is_empty', value: undefined },
    ]);
  });

  it('counts only complete conditions on the button', () => {
    const onChange = vi.fn();
    render(
      <TableFilterControl
        fields={FIELDS}
        where={[
          { fieldId: 'f-name', operator: 'contains', value: '' },
          { fieldId: 'f-ok', operator: 'is', value: true },
        ]}
        onChange={onChange}
      />
    );
    expect(screen.getByRole('button', { name: 'Filter · 1' })).toBeTruthy();
  });
});

describe('TableFilterBar', () => {
  it('shows one pill per complete filter and removes it', () => {
    const onChange = vi.fn();
    const where: TableEntryWhere[] = [
      { fieldId: 'f-status', operator: 'is', value: 'done' },
      { fieldId: 'f-tags', operator: 'contains', value: 'red' },
      { fieldId: 'f-amount', operator: 'gt', value: 'x' },
    ];
    render(<TableFilterBar fields={FIELDS} where={where} onChange={onChange} />);
    expect(screen.getByTitle('Status is done')).toBeTruthy();
    expect(screen.getByTitle('Tags has red')).toBeTruthy();
    expect(screen.queryByText('Amount')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Remove Status filter' }));
    expect(onChange).toHaveBeenCalledWith(where.slice(1));
  });
});

describe('filters on a date range', () => {
  const trip = field('f-trip', 'Trip', 'date', { range: true });

  it('label the comparisons by the start and "is" as includes, sending the same operators', () => {
    const onChange = vi.fn();
    render(
      <TableFilterControl
        fields={[trip]}
        where={[{ fieldId: 'f-trip', operator: 'is', value: '2026-10-12' }]}
        onChange={onChange}
      />
    );
    fireEvent.click(screen.getByRole('button', { name: /^Filter/ }));
    const ops = screen.getByRole('combobox', { name: 'Filter 1 condition' });
    expect(Array.from(ops.querySelectorAll('option')).map((o) => o.textContent)).toEqual([
      'includes',
      'starts before',
      'starts after',
      'starts on or before',
      'starts on or after',
      'is empty',
      'is not empty',
    ]);
    fireEvent.change(ops, { target: { value: 'before' } });
    expect(onChange).toHaveBeenLastCalledWith([
      expect.objectContaining({ fieldId: 'f-trip', operator: 'before' }),
    ]);
  });

  it('read the same way in the pills', () => {
    render(
      <TableFilterBar
        fields={[trip, field('f-due', 'Due', 'date')]}
        where={[
          { fieldId: 'f-trip', operator: 'on_or_after', value: '2026-10-12' },
          { fieldId: 'f-due', operator: 'on_or_after', value: '2026-10-12' },
        ]}
        onChange={vi.fn()}
      />
    );
    expect(screen.getByTitle('Trip starts on or after 2026-10-12')).toBeTruthy();
    expect(screen.getByTitle('Due is on or after 2026-10-12')).toBeTruthy();
  });
});

describe('filter helpers', () => {
  it('validates values by type', () => {
    expect(isComplete({ fieldId: 'f-amount', operator: 'gt', value: '1.5' }, FIELDS[2])).toBe(true);
    expect(isComplete({ fieldId: 'f-amount', operator: 'gt', value: 'abc' }, FIELDS[2])).toBe(
      false
    );
    expect(
      isComplete({ fieldId: 'f-due', operator: 'before', value: '2026-01-02' }, FIELDS[3])
    ).toBe(true);
    expect(isComplete({ fieldId: 'f-name', operator: 'is_empty' }, FIELDS[0])).toBe(true);
    expect(filterOperators(FIELDS[5])).toEqual(['is']);
  });

  it('remembers filters per view and drops ones whose field is gone', () => {
    const where: TableEntryWhere[] = [
      { fieldId: 'f-ok', operator: 'is', value: false },
      { fieldId: 'f-gone', operator: 'is', value: 'x' },
    ];
    writeTableFilter('t-1', 'board', where);
    expect(readTableFilter('t-1', 'board')).toEqual(where);
    expect(readTableFilter('t-1', 'grid')).toEqual([]);
    expect(liveFilter(where, FIELDS)).toEqual([where[0]]);
    writeTableFilter('t-1', 'board', []);
    expect(readTableFilter('t-1', 'board')).toEqual([]);
  });
});
