import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { TableField } from '@snaglet/shared/types';
import { TableHiddenFields } from './TableHiddenFields';

const field = (name: string, position: number): TableField => ({
  range: false,
  id: `field-1111111111111-${name}`,
  tableId: 'table-1111111111111-aaaaaaaaa',
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
  collapsed: true,
  isTitle: false,
  multiple: false,
  options: null,
});

describe('TableHiddenFields', () => {
  it('renders nothing while every field is shown', () => {
    const { container } = render(<TableHiddenFields fields={[]} onShow={vi.fn()} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('lists hidden fields and shows one, or all at once', async () => {
    const user = userEvent.setup();
    const onShow = vi.fn();
    const a = field('Status', 1);
    const b = field('Due', 2);
    render(<TableHiddenFields fields={[a, b]} onShow={onShow} />);
    await user.click(screen.getByRole('button', { name: 'Hidden fields: 2 hidden fields' }));
    const panel = screen.getByRole('dialog', { name: 'Hidden fields' });
    const rows = within(panel).getAllByRole('listitem');
    expect(rows.map((row) => row.firstElementChild?.textContent)).toEqual(['Status', 'Due']);
    expect(within(rows[0]).getByRole('button', { name: 'Show field Status' })).toBeInTheDocument();
    await user.click(within(panel).getByRole('button', { name: 'Show field Due' }));
    expect(onShow).toHaveBeenLastCalledWith(b);
    await user.click(within(panel).getByRole('button', { name: 'Show all' }));
    expect(onShow.mock.calls.slice(1).map(([shown]) => shown)).toEqual([a, b]);
  });

  it('offers no Show all for one field and disables a field whose write is pending', async () => {
    const user = userEvent.setup();
    const a = field('Status', 1);
    render(<TableHiddenFields fields={[a]} onShow={vi.fn()} pendingFieldIds={new Set([a.id])} />);
    await user.click(screen.getByRole('button', { name: 'Hidden fields: 1 hidden field' }));
    expect(screen.queryByRole('button', { name: 'Show all' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Show field Status' })).toBeDisabled();
  });
});
