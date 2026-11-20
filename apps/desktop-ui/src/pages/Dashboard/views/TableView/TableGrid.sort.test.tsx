import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ComponentProps } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TableColumnSummary, TableEntrySort, TableField } from '@snaglet/shared/types';
import { TableGrid } from './TableGrid';
import { cycleColumnSort } from './tableSortRules';

const tableId = 'table-1111111111111-aaaaaaaaa';
const field = (name: string, position: number, extra: Partial<TableField> = {}): TableField => ({
  range: false,
  id: `field-1111111111111-${name}`,
  tableId,
  columnName: `f_${name}`,
  name,
  description: null,
  type: 'text',
  nullable: true,
  defaultValue: null,
  referenceTableId: null,
  referenceKind: null,
  position,
  managed: false,
  revision: 1,
  collapsed: false,
  isTitle: false,
  multiple: false,
  options: null,
  ...extra,
});
const title = field('Title', 0, { isTitle: true });
const status = field('Status', 1, {
  type: 'select',
  options: [{ id: 'opt-a', label: 'A', color: 'gray' }],
});
const due = field('Due', 2, { type: 'date' });
const tags = field('Tags', 3, { type: 'select', multiple: true, options: [] });
const link = field('Link', 4, { type: 'relation' });
const fields = [title, status, due, tags, link];
const columns: TableColumnSummary[] = fields.map((item) => ({
  name: item.columnName,
  dataType: item.type,
  nullable: true,
  managed: false,
}));

function setup(props: Partial<ComponentProps<typeof TableGrid>> = {}) {
  const onSortChange = vi.fn();
  const onReorderColumns = vi.fn();
  const onEditField = vi.fn();
  const view = render(
    <TableGrid
      columns={columns}
      fields={fields}
      onEditField={onEditField}
      onReorderColumns={onReorderColumns}
      onSortChange={onSortChange}
      {...props}
    >
      <tr>
        {columns.map((column) => (
          <td key={column.name}>{column.name}</td>
        ))}
      </tr>
    </TableGrid>
  );
  return { onSortChange, onReorderColumns, onEditField, view };
}

const toggles = () => document.querySelectorAll('[data-sort-toggle]');
const toggleIn = (name: string) =>
  screen.getByRole('columnheader', { name }).querySelector<HTMLButtonElement>('[data-sort-toggle]');

afterEach(() => vi.restoreAllMocks());

describe('cycleColumnSort', () => {
  const a = 'f-a';
  const b = 'f-b';
  it('cycles one column ascending → descending → off, replacing the sort', () => {
    const other: TableEntrySort[] = [{ fieldId: b, direction: 'desc' }];
    expect(cycleColumnSort(other, a)).toEqual([{ fieldId: a, direction: 'asc' }]);
    expect(cycleColumnSort([{ fieldId: a, direction: 'asc' }], a)).toEqual([
      { fieldId: a, direction: 'desc' },
    ]);
    expect(cycleColumnSort([{ fieldId: a, direction: 'desc' }], a)).toEqual([]);
    // A plain click on a level of a multi-level sort makes it the only one.
    expect(
      cycleColumnSort(
        [
          { fieldId: b, direction: 'asc' },
          { fieldId: a, direction: 'asc' },
        ],
        a
      )
    ).toEqual([{ fieldId: a, direction: 'desc' }]);
  });

  it('with Shift adds a level, steps it in place, then drops only that level', () => {
    const start: TableEntrySort[] = [{ fieldId: b, direction: 'desc' }];
    const added = cycleColumnSort(start, a, true);
    expect(added).toEqual([
      { fieldId: b, direction: 'desc' },
      { fieldId: a, direction: 'asc' },
    ]);
    const stepped = cycleColumnSort(added, a, true);
    expect(stepped).toEqual([
      { fieldId: b, direction: 'desc' },
      { fieldId: a, direction: 'desc' },
    ]);
    expect(cycleColumnSort(stepped, a, true)).toEqual(start);
    // Stepping the first level keeps its place ahead of the others.
    expect(cycleColumnSort(stepped, b, true)).toEqual([{ fieldId: a, direction: 'desc' }]);
  });
});

describe('TableGrid header sort toggle', () => {
  it('offers a toggle on sortable fields only', () => {
    setup();
    expect(toggles()).toHaveLength(3);
    expect(toggleIn('Title')).not.toBeNull();
    expect(toggleIn('Status')).not.toBeNull();
    expect(toggleIn('Due')).not.toBeNull();
    // Multi-select and relation fields cannot be a sort level.
    expect(toggleIn('Tags')).toBeNull();
    expect(toggleIn('Link')).toBeNull();
  });

  it('is absent without a sort handler and on collapsed columns', () => {
    const { view } = setup({ onSortChange: undefined });
    expect(toggles()).toHaveLength(0);
    view.unmount();
    setup({
      fields: fields.map((item) => (item === status ? { ...item, collapsed: true } : item)),
    });
    expect(toggleIn('Status')).toBeNull();
  });

  it('words the next step by field type and replaces the sort on click', () => {
    const { onSortChange } = setup();
    const select = screen.getByRole('button', { name: 'Sort Status Option order' });
    expect(select).toHaveAttribute('aria-pressed', 'false');
    expect(select.title).toContain('Sort Status Option order');
    expect(screen.getByRole('button', { name: 'Sort Title A → Z' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Sort Due Oldest first' })).toBeInTheDocument();
    fireEvent.click(select);
    expect(onSortChange).toHaveBeenLastCalledWith([{ fieldId: status.id, direction: 'asc' }]);
  });

  it('cycles ascending → descending → off as the sort it is given changes', () => {
    const { onSortChange, view } = setup();
    const rerender = (sort: TableEntrySort[]) =>
      view.rerender(
        <TableGrid columns={columns} fields={fields} sort={sort} onSortChange={onSortChange} />
      );

    fireEvent.click(toggleIn('Due')!);
    expect(onSortChange).toHaveBeenLastCalledWith([{ fieldId: due.id, direction: 'asc' }]);
    rerender(onSortChange.mock.lastCall![0]);
    const asc = screen.getByRole('button', { name: 'Due sorted Oldest first. Sort Newest first' });
    expect(asc).toHaveAttribute('aria-pressed', 'true');
    expect(asc).toHaveAttribute('data-active', 'true');
    expect(asc.querySelector('[data-sort-direction]')).toHaveAttribute(
      'data-sort-direction',
      'asc'
    );
    // The sort direction shows as a leaf glyph.
    expect(asc.querySelector('[data-sort-direction] svg[data-open]')).toBeInTheDocument();

    fireEvent.click(asc);
    expect(onSortChange).toHaveBeenLastCalledWith([{ fieldId: due.id, direction: 'desc' }]);
    rerender(onSortChange.mock.lastCall![0]);
    const desc = screen.getByRole('button', { name: 'Due sorted Newest first. Clear sort' });
    expect(desc.querySelector('[data-sort-direction]')).toHaveAttribute(
      'data-sort-direction',
      'desc'
    );

    fireEvent.click(desc);
    expect(onSortChange).toHaveBeenLastCalledWith([]);
    rerender([]);
    expect(toggleIn('Due')).not.toHaveAttribute('data-active');
  });

  it('adds or steps a level with Shift and numbers the levels', () => {
    const sort: TableEntrySort[] = [{ fieldId: title.id, direction: 'asc' }];
    const { onSortChange, view } = setup({ sort });
    // A single level shows no number.
    expect(toggleIn('Title')).toHaveTextContent('');

    fireEvent.click(toggleIn('Status')!, { shiftKey: true });
    const levels = onSortChange.mock.lastCall![0] as TableEntrySort[];
    expect(levels).toEqual([
      { fieldId: title.id, direction: 'asc' },
      { fieldId: status.id, direction: 'asc' },
    ]);
    view.rerender(
      <TableGrid columns={columns} fields={fields} sort={levels} onSortChange={onSortChange} />
    );
    expect(toggleIn('Title')).toHaveTextContent('1');
    expect(toggleIn('Status')).toHaveTextContent('2');
    expect(
      screen.getByRole('button', {
        name: 'Status sorted Option order, level 2. Sort Reverse order',
      })
    ).toBeInTheDocument();

    fireEvent.click(toggleIn('Status')!, { shiftKey: true });
    expect(onSortChange).toHaveBeenLastCalledWith([
      { fieldId: title.id, direction: 'asc' },
      { fieldId: status.id, direction: 'desc' },
    ]);
  });

  it('works from the keyboard, with Shift+Enter adding a level', async () => {
    const { onSortChange, onEditField } = setup({
      sort: [{ fieldId: title.id, direction: 'asc' }],
    });
    const toggle = toggleIn('Due')!;
    toggle.focus();
    await userEvent.keyboard('{Enter}');
    expect(onSortChange).toHaveBeenLastCalledWith([{ fieldId: due.id, direction: 'asc' }]);
    await userEvent.keyboard('{Shift>}{Enter}{/Shift}');
    expect(onSortChange).toHaveBeenLastCalledWith([
      { fieldId: title.id, direction: 'asc' },
      { fieldId: due.id, direction: 'asc' },
    ]);
    await userEvent.keyboard(' ');
    expect(onSortChange).toHaveBeenCalledTimes(3);
    expect(onEditField).not.toHaveBeenCalled();
  });

  it('never starts a column drag or opens the field settings', () => {
    const { onSortChange, onReorderColumns, onEditField } = setup();
    const toggle = toggleIn('Title')!;
    fireEvent.pointerDown(toggle, { button: 0, clientX: 90, clientY: 20 });
    fireEvent.pointerMove(window, { clientX: 400, clientY: 20 });
    fireEvent.pointerUp(window, { clientX: 400, clientY: 20 });
    expect(document.querySelector('[data-column-drag-ghost]')).toBeNull();
    fireEvent.click(toggle);
    expect(onSortChange).toHaveBeenCalledOnce();
    expect(onReorderColumns).not.toHaveBeenCalled();
    expect(onEditField).not.toHaveBeenCalled();
    // The header itself still opens the field.
    fireEvent.click(screen.getByRole('button', { name: 'Edit field Title' }));
    expect(onEditField).toHaveBeenCalledOnce();
  });
});
