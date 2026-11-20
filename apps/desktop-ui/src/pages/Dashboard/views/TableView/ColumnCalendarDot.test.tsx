import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Calendar, TableColumnSummary, TableField } from '@snaglet/shared/types';
import { __resetCalendarStoreForTests } from '@desktop/features/calendar/calendarStore';
import { TableGrid } from './TableGrid';

const calApi = vi.hoisted(() => ({ list: vi.fn() }));
vi.mock('@desktop/features/calendar/calendarApi', () => ({ calendarApi: calApi }));

const work: Calendar = {
  id: 'cal-work',
  title: 'Work',
  description: '',
  timeZone: 'UTC',
  color: 'green',
  isDefault: false,
  sortOrder: 0,
  revision: 1,
  createdAt: '',
  updatedAt: '',
  boundFields: [],
};

const field = (name: string, position: number, extra: Partial<TableField> = {}): TableField =>
  ({
    id: `field-1111111111111-${name}`,
    tableId: 'table-1111111111111-abcdefghi',
    columnName: `f_${name}`,
    name,
    description: null,
    type: 'date',
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
  }) as TableField;

function renderGrid(fields: TableField[]) {
  const columns: TableColumnSummary[] = fields.map((f) => ({
    name: f.columnName,
    dataType: f.type,
    nullable: true,
    managed: false,
  }));
  render(
    <TableGrid columns={columns} fields={fields} emptyTitle="No entries yet">
      <tr>
        {columns.map((c) => (
          <td key={c.name}>{c.name}</td>
        ))}
      </tr>
    </TableGrid>
  );
}

beforeEach(() => __resetCalendarStoreForTests({ calendars: [work] }));
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

describe('column header calendar dot', () => {
  it('marks a field shown on a calendar with that calendar’s color and name', () => {
    renderGrid([field('Due', 0, { calendarId: 'cal-work' }), field('Started', 1)]);

    const dots = screen.getAllByRole('img', { name: /^Shown on/ });
    expect(dots).toHaveLength(1);
    expect(dots[0]).toHaveAccessibleName('Shown on Work');
    expect(dots[0]).toHaveAttribute('title', 'Shown on Work');
    expect(dots[0]).toHaveAttribute('data-cal-color', 'green');
    expect(screen.getByRole('columnheader', { name: /Due/ })).toContainElement(dots[0]);
    expect(calApi.list).not.toHaveBeenCalled();
  });

  it('paints a custom or theme color inline', () => {
    __resetCalendarStoreForTests({
      calendars: [
        { ...work, color: '#3a7bd5' },
        { ...work, id: 'cal-home', title: 'Home', color: 'theme:agent' },
      ],
    });
    renderGrid([
      field('Due', 0, { calendarId: 'cal-work' }),
      field('Started', 1, { calendarId: 'cal-home' }),
    ]);

    const custom = screen.getByRole('img', { name: 'Shown on Work' });
    expect(custom).toHaveAttribute('data-cal-color', '#3a7bd5');
    expect(custom.style.getPropertyValue('--cal-accent')).toBe('#3a7bd5');
    const theme = screen.getByRole('img', { name: 'Shown on Home' });
    expect(theme).toHaveAttribute('data-cal-color', 'theme:agent');
    expect(theme.style.getPropertyValue('--cal-accent')).toBe('var(--agent)');
  });

  it('falls back to a generic label while the calendar is unknown', () => {
    renderGrid([field('Due', 0, { calendarId: 'cal-gone' })]);

    const dot = screen.getByRole('img', { name: 'Shown on a calendar' });
    expect(dot).not.toHaveAttribute('data-cal-color');
  });
});
