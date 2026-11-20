import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import type { TableEntrySort, TableField } from '@snaglet/shared/types';
import { TableSortBar, TableSortControl } from './TableSortControl';
import { directionLabels } from './tableSortRules';
import { liveSort, readTableSort, writeTableSort } from './boardViewPreference';

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
  field('f-status', 'Status', 'select', { options: [] }),
  field('f-due', 'Due', 'date'),
  field('f-tags', 'Tags', 'select', { multiple: true, options: [] }),
  field('f-link', 'Link', 'relation'),
];

function setup(sort: TableEntrySort[] = []) {
  const onChange = vi.fn();
  render(<TableSortControl fields={FIELDS} sort={sort} onChange={onChange} />);
  return onChange;
}

describe('TableSortControl', () => {
  it('adds the first unused sortable field ascending', () => {
    const onChange = setup();
    fireEvent.click(screen.getByRole('button', { name: 'Sort' }));
    fireEvent.click(screen.getByRole('button', { name: '+ Add sort' }));
    expect(onChange).toHaveBeenCalledWith([{ fieldId: 'f-name', direction: 'asc' }]);
  });

  it('offers only single-value, orderable fields not already used', () => {
    setup([
      { fieldId: 'f-name', direction: 'asc' },
      { fieldId: 'f-due', direction: 'desc' },
    ]);
    fireEvent.click(screen.getByRole('button', { name: 'Sort' }));
    const second = screen.getByRole('combobox', { name: 'Sort 2 field' });
    const options = Array.from(second.querySelectorAll('option')).map((o) => o.textContent);
    expect(options).toEqual(['Status', 'Due']);
  });

  it('labels directions by type and reorders and removes levels', () => {
    const onChange = setup([
      { fieldId: 'f-name', direction: 'asc' },
      { fieldId: 'f-due', direction: 'desc' },
    ]);
    fireEvent.click(screen.getByRole('button', { name: 'Sort' }));
    expect(screen.getByRole('option', { name: 'Newest first' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Move Due up' }));
    expect(onChange).toHaveBeenLastCalledWith([
      { fieldId: 'f-due', direction: 'desc' },
      { fieldId: 'f-name', direction: 'asc' },
    ]);
    fireEvent.click(screen.getByRole('button', { name: 'Remove Name' }));
    expect(onChange).toHaveBeenLastCalledWith([{ fieldId: 'f-due', direction: 'desc' }]);
  });

  it('words directions per field type', () => {
    expect(directionLabels(field('n', 'n', 'number'))).toEqual({ asc: '1 → 9', desc: '9 → 1' });
    expect(directionLabels(field('c', 'c', 'checkbox')).desc).toBe('Checked first');
    expect(directionLabels(field('s', 's', 'select')).asc).toBe('Option order');
  });
});

describe('TableSortBar', () => {
  it('shows each sort as a pill that reverses on click and removes on ×', () => {
    const onChange = vi.fn();
    const sort: TableEntrySort[] = [
      { fieldId: 'f-status', direction: 'asc' },
      { fieldId: 'f-due', direction: 'desc' },
    ];
    render(<TableSortBar fields={FIELDS} sort={sort} onChange={onChange} />);
    expect(screen.getByRole('list', { name: 'Active sorts' }).textContent).toContain('Status');
    fireEvent.click(screen.getByRole('button', { name: 'Due, Newest first. Reverse' }));
    expect(onChange).toHaveBeenLastCalledWith([
      { fieldId: 'f-status', direction: 'asc' },
      { fieldId: 'f-due', direction: 'asc' },
    ]);
    fireEvent.click(screen.getByRole('button', { name: 'Remove Status sort' }));
    expect(onChange).toHaveBeenLastCalledWith([{ fieldId: 'f-due', direction: 'desc' }]);
    fireEvent.click(screen.getByRole('button', { name: 'Clear all' }));
    expect(onChange).toHaveBeenLastCalledWith([]);
  });

  it('renders nothing without sorts', () => {
    const { container } = render(<TableSortBar fields={FIELDS} sort={[]} onChange={vi.fn()} />);
    expect(container.innerHTML).toBe('');
  });
});

describe('sort preferences', () => {
  it('keeps Grid and Board sorts apart per table', () => {
    writeTableSort('t1', 'grid', [{ fieldId: 'f-name', direction: 'asc' }]);
    writeTableSort('t1', 'board', [{ fieldId: 'f-due', direction: 'desc' }]);
    expect(readTableSort('t1', 'grid')).toEqual([{ fieldId: 'f-name', direction: 'asc' }]);
    expect(readTableSort('t1', 'board')).toEqual([{ fieldId: 'f-due', direction: 'desc' }]);
    expect(readTableSort('t2', 'grid')).toEqual([]);
    writeTableSort('t1', 'grid', []);
    expect(readTableSort('t1', 'grid')).toEqual([]);
  });

  it('drops levels whose field is gone, unsortable or repeated', () => {
    expect(
      liveSort(
        [
          { fieldId: 'f-gone', direction: 'asc' },
          { fieldId: 'f-tags', direction: 'asc' },
          { fieldId: 'f-due', direction: 'asc' },
          { fieldId: 'f-due', direction: 'desc' },
        ],
        FIELDS
      )
    ).toEqual([{ fieldId: 'f-due', direction: 'asc' }]);
  });
});
