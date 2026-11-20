import { fireEvent, render, screen } from '@testing-library/react';
import type { ComponentProps } from 'react';
import { describe, expect, it, vi } from 'vitest';
import type { TableColumnSummary, TableField } from '@snaglet/shared/types';
import { TableGrid } from './TableGrid';
import styles from './TableView.module.scss';

const tableId = 'table-1111111111111-aaaaaaaaa';
const field = (name: string, position: number, view: Partial<TableField> = {}): TableField => ({
  range: false,
  id: `field-1111111111111-${name}`,
  tableId,
  columnName: `f_${name.repeat(24).slice(0, 24)}`,
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
  ...view,
});
const columnsOf = (fields: TableField[]): TableColumnSummary[] =>
  fields.map((item) => ({
    name: item.columnName,
    dataType: item.type,
    nullable: true,
    managed: false,
  }));
/** Every header draws 200 px wide (jsdom has no layout). */
const DRAWN = 200;

function setup(
  fields: TableField[] = [field('a', 0), field('b', 1)],
  props: Partial<ComponentProps<typeof TableGrid>> = {}
) {
  const onResizeField = vi.fn();
  const onEditField = vi.fn();
  const onReorderColumns = vi.fn();
  const columns = columnsOf(fields);
  const view = render(
    <TableGrid
      columns={columns}
      fields={fields}
      onEditField={onEditField}
      onReorderColumns={onReorderColumns}
      onResizeField={onResizeField}
      {...props}
    >
      <tr>
        {columns.map((column) => (
          <td key={column.name} data-column={column.name}>
            {column.name}
          </td>
        ))}
      </tr>
    </TableGrid>
  );
  screen.getAllByRole('columnheader').forEach((header) => {
    Object.defineProperty(header, 'offsetWidth', { configurable: true, value: DRAWN });
  });
  const table = screen.getByRole('table');
  return { onResizeField, onEditField, onReorderColumns, view, table, columns };
}

const handle = (name: string) => screen.getByRole('separator', { name: `Resize ${name} column` });
const header = (name: string) => screen.getByRole('columnheader', { name });
const liveWidth = (table: HTMLElement) => table.style.getPropertyValue('--table-resize-width');

describe('TableGrid column resize', () => {
  it('follows the pointer past a 4 px threshold, divided by the pane zoom, and commits once on release', () => {
    const { onResizeField, onEditField, onReorderColumns, table } = setup();
    // The pane body renders at 0.8: 80 viewport px are 100 of the table's own px.
    Object.defineProperty(table, 'currentCSSZoom', { configurable: true, value: 0.8 });
    const fieldA = field('a', 0);

    fireEvent.pointerDown(handle('a'), { button: 0, clientX: 200, clientY: 20 });
    fireEvent.pointerMove(window, { clientX: 203, clientY: 20 });
    expect(header('a')).not.toHaveAttribute('data-column-resizing');
    expect(liveWidth(table)).toBe('');

    fireEvent.pointerMove(window, { clientX: 280, clientY: 20 });
    // Header and body cells of the column take the live width; nothing saves yet.
    expect(liveWidth(table)).toBe('300px');
    expect(header('a')).toHaveAttribute('data-column-resizing');
    expect(screen.getByRole('cell', { name: fieldA.columnName })).toHaveAttribute(
      'data-column-resizing'
    );
    expect(header('b')).not.toHaveAttribute('data-column-resizing');
    expect(handle('a')).toHaveAttribute('data-active', 'true');
    expect(onResizeField).not.toHaveBeenCalled();

    fireEvent.pointerMove(window, { clientX: 320, clientY: 20 });
    expect(liveWidth(table)).toBe('350px');
    fireEvent.pointerUp(window, { clientX: 320, clientY: 20 });
    expect(onResizeField).toHaveBeenCalledOnce();
    expect(onResizeField).toHaveBeenCalledWith(fieldA, 350);
    expect(header('a')).not.toHaveAttribute('data-column-resizing');
    expect(liveWidth(table)).toBe('');

    // The click that ends the drag neither opens the field nor reorders it.
    fireEvent.click(screen.getByRole('button', { name: 'Edit field a' }));
    expect(onEditField).not.toHaveBeenCalled();
    expect(onReorderColumns).not.toHaveBeenCalled();
  });

  it('keeps a width within 64–800 px', () => {
    const { onResizeField } = setup();
    fireEvent.pointerDown(handle('a'), { button: 0, clientX: 200, clientY: 20 });
    fireEvent.pointerMove(window, { clientX: -400, clientY: 20 });
    fireEvent.pointerUp(window, { clientX: -400, clientY: 20 });
    fireEvent.pointerDown(handle('b'), { button: 0, clientX: 400, clientY: 20 });
    fireEvent.pointerMove(window, { clientX: 2000, clientY: 20 });
    fireEvent.pointerUp(window, { clientX: 2000, clientY: 20 });
    expect(onResizeField.mock.calls.map(([, width]) => width)).toEqual([64, 800]);
  });

  it('cancels with Escape, puts the column back, and still swallows the release click', () => {
    const { onResizeField, onEditField, table } = setup();
    fireEvent.pointerDown(handle('a'), { button: 0, clientX: 200, clientY: 20 });
    fireEvent.pointerMove(window, { clientX: 260, clientY: 20 });
    expect(liveWidth(table)).toBe('260px');

    fireEvent.keyDown(window, { key: 'Escape' });
    expect(liveWidth(table)).toBe('');
    expect(header('a')).not.toHaveAttribute('data-column-resizing');
    fireEvent.pointerMove(window, { clientX: 300, clientY: 20 });
    expect(liveWidth(table)).toBe('');
    fireEvent.pointerUp(window, { clientX: 300, clientY: 20 });
    fireEvent.click(screen.getByRole('button', { name: 'Edit field a' }));

    expect(onResizeField).not.toHaveBeenCalled();
    expect(onEditField).not.toHaveBeenCalled();
  });

  it('treats a press without travel as a click, which neither resizes nor is swallowed', () => {
    const { onResizeField, onEditField } = setup();
    fireEvent.pointerDown(handle('a'), { button: 0, clientX: 200, clientY: 20 });
    fireEvent.pointerMove(window, { clientX: 202, clientY: 30 });
    fireEvent.pointerUp(window, { clientX: 202, clientY: 30 });
    expect(onResizeField).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Edit field a' }));
    expect(onEditField).toHaveBeenCalledOnce();
  });

  it('draws a set width on the header and resets it to auto on a double-click of the edge', () => {
    const sized = field('a', 0, { width: 240 });
    const { onResizeField } = setup([sized, field('b', 1)]);
    expect(header('a')).toHaveStyle({ width: '240px', minWidth: '240px', maxWidth: '240px' });
    expect(header('b').style.width).toBe('');
    expect(handle('a')).toHaveAttribute('aria-valuenow', '240');
    expect(handle('b')).toHaveAttribute('aria-valuetext', 'Auto width');

    fireEvent.doubleClick(handle('a'));
    expect(onResizeField).toHaveBeenCalledWith(sized, null);
    // An auto column is already auto.
    fireEvent.doubleClick(handle('b'));
    expect(onResizeField).toHaveBeenCalledOnce();
  });

  it('steps 16 px with Alt+←/→ on the focused edge, resets with Alt+0, and never reorders', () => {
    const sized = field('b', 1, { width: 240 });
    const { onResizeField, onReorderColumns } = setup([field('a', 0), sized]);
    handle('a').focus();
    expect(handle('a')).toHaveFocus();

    // An auto column steps from the width it is drawn at.
    fireEvent.keyDown(handle('a'), { key: 'ArrowRight', altKey: true });
    fireEvent.keyDown(handle('b'), { key: 'ArrowLeft', altKey: true });
    // macOS Alt+0 types "º": the physical key decides.
    fireEvent.keyDown(handle('b'), { key: 'º', code: 'Digit0', altKey: true });
    // Without Alt the arrows do nothing here.
    fireEvent.keyDown(handle('b'), { key: 'ArrowLeft' });

    expect(onResizeField.mock.calls).toEqual([
      [field('a', 0), DRAWN + 16],
      [sized, 224],
      [sized, null],
    ]);
    expect(onReorderColumns).not.toHaveBeenCalled();
  });

  it('stops at the limits from the keyboard', () => {
    const { onResizeField } = setup([field('a', 0, { width: 800 }), field('b', 1, { width: 64 })]);
    fireEvent.keyDown(handle('a'), { key: 'ArrowRight', altKey: true });
    fireEvent.keyDown(handle('b'), { key: 'ArrowLeft', altKey: true });
    expect(onResizeField).not.toHaveBeenCalled();
  });

  it('gives a collapsed column no handle and no width, though it has one set', () => {
    setup([field('a', 0, { collapsed: true, width: 300 }), field('b', 1)]);
    expect(screen.queryByRole('separator', { name: 'Resize a column' })).not.toBeInTheDocument();
    expect(header('a').style.width).toBe('');
    expect(header('a').style.minWidth).toBe('');
    expect(handle('b')).toBeInTheDocument();
  });

  it('lets the table keep its set sizes once every column has a fixed width', () => {
    const fields = [field('a', 0, { width: 240 }), field('b', 1)];
    const { view, table } = setup(fields);
    // An auto column still takes the pane's spare room.
    expect(table).not.toHaveClass(styles.gridCollapsed);
    view.rerender(
      <TableGrid
        columns={columnsOf(fields)}
        fields={[fields[0], field('b', 1, { collapsed: true })]}
        onResizeField={vi.fn()}
      />
    );
    expect(table).toHaveClass(styles.gridCollapsed);
  });

  it('offers no resize while field controls are locked, or without a handler', () => {
    const { onResizeField, view } = setup(undefined, { fieldControlsDisabled: true });
    expect(handle('a')).toHaveAttribute('aria-disabled', 'true');
    expect(handle('a')).toHaveAttribute('tabindex', '-1');
    fireEvent.pointerDown(handle('a'), { button: 0, clientX: 200, clientY: 20 });
    fireEvent.pointerMove(window, { clientX: 280, clientY: 20 });
    fireEvent.pointerUp(window, { clientX: 280, clientY: 20 });
    fireEvent.keyDown(handle('a'), { key: 'ArrowRight', altKey: true });
    fireEvent.doubleClick(handle('a'));
    expect(onResizeField).not.toHaveBeenCalled();
    view.unmount();

    setup(undefined, { onResizeField: undefined });
    expect(screen.queryByRole('separator')).not.toBeInTheDocument();
  });

  it('drops a resize in progress when the grid unmounts', () => {
    const { onResizeField, view } = setup();
    fireEvent.pointerDown(handle('a'), { button: 0, clientX: 200, clientY: 20 });
    fireEvent.pointerMove(window, { clientX: 260, clientY: 20 });
    view.unmount();
    fireEvent.pointerUp(window, { clientX: 260, clientY: 20 });
    expect(onResizeField).not.toHaveBeenCalled();
    expect(document.body.style.cursor).toBe('');
  });
});
