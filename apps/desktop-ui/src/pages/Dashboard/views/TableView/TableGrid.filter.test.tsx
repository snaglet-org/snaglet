import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState, type ComponentProps } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TableColumnSummary, TableEntryWhere, TableField } from '@snaglet/shared/types';
import { TableGrid } from './TableGrid';

const tableId = 'table-1111111111111-aaaaaaaaa';
const field = (name: string, position: number, extra: Partial<TableField> = {}): TableField => ({
  range: false,
  id: `field-1111111111111-${name.toLowerCase()}`,
  tableId,
  columnName: `f_${name.toLowerCase()}`,
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
  options: [
    { id: 'o-todo', label: 'To do', color: 'gray' },
    { id: 'o-done', label: 'Done', color: 'green' },
  ],
});
const tags = field('Tags', 2, {
  type: 'select',
  multiple: true,
  options: [{ id: 'o-red', label: 'Red', color: 'red' }],
});
const done = field('Done', 3, { type: 'checkbox' });
const points = field('Points', 4, { type: 'number' });
const due = field('Due', 5, { type: 'date' });
const link = field('Link', 6, { type: 'relation' });
const id = field('Id', 7, { type: 'uuid', managed: true });
const fields = [title, status, tags, done, points, due, link, id];
const columns: TableColumnSummary[] = fields.map((item) => ({
  name: item.columnName,
  dataType: item.type,
  nullable: true,
  managed: !!item.managed,
}));

/** A grid whose header filters drive real `where` state, like TableView does. */
function setup(
  initial: TableEntryWhere[] = [],
  props: Partial<ComponentProps<typeof TableGrid>> = {}
) {
  const changes: TableEntryWhere[][] = [];
  const onReorderColumns = vi.fn();
  const onSortChange = vi.fn();
  const Harness = () => {
    const [where, setWhere] = useState<TableEntryWhere[]>(initial);
    return (
      <TableGrid
        columns={columns}
        fields={fields}
        onEditField={vi.fn()}
        onReorderColumns={onReorderColumns}
        onSortChange={onSortChange}
        where={where}
        onFilterChange={(next) => {
          changes.push(next);
          setWhere(next);
        }}
        {...props}
      >
        <tr>
          {columns.map((column) => (
            <td key={column.name}>{column.name}</td>
          ))}
        </tr>
      </TableGrid>
    );
  };
  render(<Harness />);
  return { changes, last: () => changes[changes.length - 1], onReorderColumns, onSortChange };
}

const header = (name: string) => screen.getByRole('columnheader', { name });
const funnel = (name: string) =>
  header(name).querySelector<HTMLButtonElement>('[data-filter-toggle]');
const open = async (name: string) => {
  fireEvent.click(funnel(name) as HTMLButtonElement);
  return screen.findByRole('dialog', { name: `Filter ${name}` });
};

afterEach(() => vi.restoreAllMocks());

describe('TableGrid header filter', () => {
  it('offers a filter on filterable fields only', () => {
    setup();
    for (const name of ['Title', 'Status', 'Tags', 'Done', 'Points', 'Due', 'Link'])
      expect(funnel(name)).toHaveAccessibleName(`Filter ${name}`);
    expect(funnel('Id')).toBeNull();
  });

  it('has no filters without onFilterChange, and none on a collapsed column', () => {
    setup([], {
      onFilterChange: undefined,
    });
    expect(document.querySelectorAll('[data-filter-toggle]')).toHaveLength(0);
  });

  it('skips a collapsed column', () => {
    const collapsedFields = fields.map((item) =>
      item.id === points.id ? { ...item, collapsed: true } : item
    );
    setup([], { fields: collapsedFields });
    expect(
      document.querySelector(`[data-field-id="${points.id}"] [data-filter-toggle]`)
    ).toBeNull();
  });

  it('select: one click on an option filters the column with "is" and closes', async () => {
    const { last } = setup();
    const panel = await open('Status');
    fireEvent.click(within(panel).getByRole('button', { name: 'Done' }));
    expect(last()).toEqual([{ fieldId: status.id, operator: 'is', value: 'Done' }]);
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(funnel('Status')).toHaveAttribute('data-active', 'true');
    expect(funnel('Status')).toHaveAccessibleName('Status filter: is Done. Change filter');
  });

  it('multi-select picks "has" (contains)', async () => {
    const { last } = setup();
    fireEvent.click(within(await open('Tags')).getByRole('button', { name: 'Red' }));
    expect(last()).toEqual([{ fieldId: tags.id, operator: 'contains', value: 'Red' }]);
    expect(funnel('Tags')).toHaveAccessibleName('Tags filter: has Red. Change filter');
  });

  it('checkbox: checked / unchecked', async () => {
    const { last } = setup();
    const panel = await open('Done');
    expect(within(panel).queryByRole('button', { name: 'is empty' })).toBeNull();
    fireEvent.click(within(panel).getByRole('button', { name: 'Unchecked' }));
    expect(last()).toEqual([{ fieldId: done.id, operator: 'is', value: false }]);
  });

  it('text: a contains box applied with Enter', async () => {
    const user = userEvent.setup();
    const { last } = setup();
    const panel = await open('Title');
    expect(within(panel).getByRole('combobox', { name: 'Title condition' })).toHaveValue(
      'contains'
    );
    const box = within(panel).getByRole('textbox', { name: 'Title value' });
    expect(within(panel).getByRole('button', { name: 'Apply' })).toBeDisabled();
    await user.type(box, 'plan{Enter}');
    expect(last()).toEqual([{ fieldId: title.id, operator: 'contains', value: 'plan' }]);
  });

  it('number: comparison + value', async () => {
    const { last } = setup();
    const panel = await open('Points');
    fireEvent.change(within(panel).getByRole('combobox', { name: 'Points condition' }), {
      target: { value: 'gte' },
    });
    const box = within(panel).getByRole('textbox', { name: 'Points value' });
    fireEvent.change(box, { target: { value: 'abc' } });
    expect(within(panel).getByRole('button', { name: 'Apply' })).toBeDisabled();
    fireEvent.change(box, { target: { value: '3' } });
    fireEvent.click(within(panel).getByRole('button', { name: 'Apply' }));
    expect(last()).toEqual([{ fieldId: points.id, operator: 'gte', value: '3' }]);
  });

  it('date: before / after / on with the filterOperators wording', async () => {
    const { last } = setup();
    const panel = await open('Due');
    const select = within(panel).getByRole('combobox', { name: 'Due condition' });
    expect(
      within(select)
        .getAllByRole('option')
        .map((option) => option.textContent)
    ).toEqual(['is', 'is before', 'is after', 'is on or before', 'is on or after']);
    fireEvent.change(select, { target: { value: 'before' } });
    const input = within(panel).getByLabelText('Due value');
    fireEvent.change(input, { target: { value: '2026-10-20' } });
    fireEvent.click(within(panel).getByRole('button', { name: 'Apply' }));
    expect(last()).toEqual([{ fieldId: due.id, operator: 'before', value: '2026-10-20' }]);
  });

  it('relation: only is empty / is not empty', async () => {
    const { last } = setup();
    const panel = await open('Link');
    expect(within(panel).queryByRole('button', { name: 'Apply' })).toBeNull();
    fireEvent.click(within(panel).getByRole('button', { name: 'is not empty' }));
    expect(last()).toEqual([{ fieldId: link.id, operator: 'is_not_empty' }]);
  });

  it("replaces only that column's condition and keeps the others", async () => {
    const other: TableEntryWhere = { fieldId: done.id, operator: 'is', value: true };
    const { last } = setup([other, { fieldId: status.id, operator: 'is', value: 'To do' }]);
    const panel = await open('Status');
    expect(within(panel).getByRole('button', { name: 'To do' })).toHaveAttribute(
      'aria-pressed',
      'true'
    );
    fireEvent.click(within(panel).getByRole('button', { name: 'Done' }));
    expect(last()).toEqual([other, { fieldId: status.id, operator: 'is', value: 'Done' }]);
  });

  it('opens a text filter with its current condition filled in', async () => {
    setup([{ fieldId: title.id, operator: 'starts_with', value: 'Q' }]);
    const panel = await open('Title');
    expect(within(panel).getByRole('combobox', { name: 'Title condition' })).toHaveValue(
      'starts_with'
    );
    expect(within(panel).getByRole('textbox', { name: 'Title value' })).toHaveValue('Q');
  });

  it("clears from the header (× and Clear filter) remove only that column's conditions", async () => {
    const other: TableEntryWhere = { fieldId: done.id, operator: 'is', value: true };
    const { last } = setup([
      { fieldId: points.id, operator: 'gt', value: '1' },
      other,
      { fieldId: points.id, operator: 'lt', value: '9' },
    ]);
    expect(funnel('Points')).toHaveAttribute('data-active', 'true');
    fireEvent.click(within(header('Points')).getByRole('button', { name: 'Clear Points filter' }));
    expect(last()).toEqual([other]);
    expect(funnel('Points')).not.toHaveAttribute('data-active');
    expect(
      within(header('Points')).queryByRole('button', { name: 'Clear Points filter' })
    ).toBeNull();

    const panel = await open('Done');
    fireEvent.click(within(panel).getByRole('button', { name: 'Clear filter' }));
    expect(last()).toEqual([]);
  });

  it('keyboard: Tab reaches it, Enter opens, Esc closes and returns focus', async () => {
    const user = userEvent.setup();
    setup();
    const toggle = funnel('Status') as HTMLButtonElement;
    const sort = header('Status').querySelector<HTMLButtonElement>('[data-sort-toggle]');
    sort?.focus();
    await user.tab();
    expect(toggle).toHaveFocus();
    await user.keyboard('{Enter}');
    expect(await screen.findByRole('dialog', { name: 'Filter Status' })).toBeInTheDocument();
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(toggle).toHaveFocus();
    await user.keyboard(' ');
    expect(await screen.findByRole('dialog', { name: 'Filter Status' })).toBeInTheDocument();
  });

  it('typing in the box never reorders columns (Alt+Arrow stays in the input)', async () => {
    const { onReorderColumns } = setup();
    const panel = await open('Title');
    const box = within(panel).getByRole('textbox', { name: 'Title value' });
    fireEvent.keyDown(box, { key: 'ArrowRight', altKey: true });
    fireEvent.keyDown(funnel('Title') as HTMLButtonElement, { key: 'ArrowRight', altKey: true });
    expect(onReorderColumns).not.toHaveBeenCalled();
  });

  it('a press on the filter never starts a header drag or opens the field; sort still works', () => {
    const onEditField = vi.fn();
    const { onSortChange } = setup([], { onEditField });
    const toggle = funnel('Status') as HTMLButtonElement;
    fireEvent.pointerDown(toggle, { button: 0, clientX: 10, clientY: 10 });
    fireEvent.pointerMove(window, { clientX: 200, clientY: 10 });
    fireEvent.pointerUp(window, { clientX: 200, clientY: 10 });
    expect(onEditField).not.toHaveBeenCalled();
    fireEvent.click(header('Status').querySelector('[data-sort-toggle]') as HTMLButtonElement);
    expect(onSortChange).toHaveBeenCalledWith([{ fieldId: status.id, direction: 'asc' }]);
  });
});
