import { act, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ComponentProps } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TableColumnSummary, TableField } from '@snaglet/shared/types';
import {
  __setActiveTableFieldDragForTests,
  readTableFieldDragPayload,
  TABLE_FIELD_MIME,
} from '@desktop/features/database/tableFieldDrag';
import { TableGrid } from './TableGrid';
import styles from './TableView.module.scss';

const tableId = 'table-1111111111111-aaaaaaaaa';
const field = (name: string, position: number): TableField => ({
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
});
const fields = [field('a', 0), field('b', 1), field('c', 2)];
const columns: TableColumnSummary[] = fields.map((item) => ({
  name: item.columnName,
  dataType: item.type,
  nullable: true,
  managed: false,
}));
const WIDTH = 100;

function setup(props: Partial<ComponentProps<typeof TableGrid>> = {}) {
  const onReorderColumns = vi.fn();
  const onEditField = vi.fn();
  const view = render(
    <TableGrid
      columns={columns}
      fields={fields}
      onEditField={onEditField}
      onReorderColumns={onReorderColumns}
      emptyTitle="No entries yet"
      {...props}
    >
      <tr>
        {props.leadingHeader && <td>Row selection</td>}
        {columns.map((column) => (
          <td key={column.name} data-column={column.name}>
            {column.name}
          </td>
        ))}
      </tr>
    </TableGrid>
  );
  // jsdom has no layout: give the headers a 100px-wide, side-by-side geometry.
  screen.getAllByRole('columnheader').forEach((header, index) => {
    Object.defineProperty(header, 'offsetLeft', { configurable: true, value: index * WIDTH });
    Object.defineProperty(header, 'offsetWidth', { configurable: true, value: WIDTH });
  });
  return { onReorderColumns, onEditField, view };
}

function header(index: number) {
  return screen.getAllByRole('columnheader')[index];
}

const ghost = () => document.querySelector('[data-column-drag-ghost]');

beforeEach(() => {
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
    this: HTMLElement
  ) {
    if (this.tagName === 'TH') {
      const index = Array.from(this.parentElement?.children ?? []).indexOf(this);
      return new DOMRect(index * WIDTH, 0, WIDTH, 40);
    }
    if (this.dataset.fieldInsert !== undefined) {
      const parent = this.closest('th');
      const index = Array.from(parent?.parentElement?.children ?? []).indexOf(parent as Element);
      const boundary = (index + (this.dataset.fieldInsert === 'append' ? 1 : 0)) * WIDTH;
      return new DOMRect(boundary - 12, -16, 24, 24);
    }
    if (this.tagName === 'TABLE') return new DOMRect(0, 0, WIDTH * 3, 80);
    if (this.tagName === 'TR') return new DOMRect(0, 0, WIDTH * 3, 40);
    // The scroller is wide enough that these drags never reach its edge zones.
    return new DOMRect(0, 0, 1000, 400);
  });
});

afterEach(() => vi.restoreAllMocks());

describe('TableGrid column drag', () => {
  it('floats a copy of the column, previews the order, and drops it into the new slot', () => {
    const { onReorderColumns, onEditField } = setup();
    fireEvent.pointerDown(header(0), { button: 0, clientX: 50, clientY: 20 });
    fireEvent.pointerMove(window, { clientX: 70, clientY: 20 });
    fireEvent.pointerMove(window, { clientX: 260, clientY: 20 });

    expect(ghost()).toHaveTextContent('a');
    // The pressed column is the dimmed placeholder, slid to its landing spot.
    expect(header(0)).toHaveStyle({ opacity: '0.3', transform: `translateX(${WIDTH * 2}px)` });
    expect(header(1)).toHaveStyle({ transform: `translateX(-${WIDTH}px)` });

    fireEvent.pointerUp(window, { clientX: 260, clientY: 20 });
    expect(onReorderColumns).toHaveBeenCalledWith([
      columns[1].name,
      columns[2].name,
      columns[0].name,
    ]);
    expect(ghost()).toBeNull();
    expect(header(0).style.transform).toBe('');
    // The click that ends a drag does not open the field editor.
    fireEvent.click(screen.getByRole('button', { name: 'Edit field a' }));
    expect(onEditField).not.toHaveBeenCalled();
  });

  it('treats a press without travel as a click that opens the field', () => {
    const { onReorderColumns, onEditField } = setup();
    const button = screen.getByRole('button', { name: 'Edit field b' });
    fireEvent.pointerDown(button, { button: 0, clientX: 150, clientY: 20 });
    fireEvent.pointerMove(window, { clientX: 152, clientY: 21 });
    fireEvent.pointerUp(window, { clientX: 152, clientY: 21 });
    fireEvent.click(button);
    expect(ghost()).toBeNull();
    expect(onReorderColumns).not.toHaveBeenCalled();
    expect(onEditField).toHaveBeenCalledOnce();
  });

  it('cancels with Escape and leaves the order untouched', () => {
    const { onReorderColumns } = setup();
    fireEvent.pointerDown(header(2), { button: 0, clientX: 250, clientY: 20 });
    fireEvent.pointerMove(window, { clientX: 20, clientY: 20 });
    expect(ghost()).not.toBeNull();
    fireEvent.keyDown(window, { key: 'Escape' });
    fireEvent.pointerUp(window, { clientX: 20, clientY: 20 });
    expect(onReorderColumns).not.toHaveBeenCalled();
    expect(ghost()).toBeNull();
    expect(header(2).style.opacity).toBe('');
    expect(header(2).style.transform).toBe('');
  });

  it('leaves the leading selection column fixed and excludes it from the dragged copy', () => {
    const { onReorderColumns } = setup({ leadingHeader: <button>Select rows</button> });
    fireEvent.pointerDown(header(1), { button: 0, clientX: 150, clientY: 20 });
    fireEvent.pointerMove(window, { clientX: 370, clientY: 20 });
    expect(header(0).style.transform).toBe('');
    expect(screen.getByText('Row selection').style.transform).toBe('');
    expect(ghost()).not.toHaveTextContent('Row selection');
    expect(ghost()).toHaveTextContent(columns[0].name);
    fireEvent.pointerUp(window, { clientX: 370, clientY: 20 });
    expect(onReorderColumns).toHaveBeenCalledWith([
      columns[1].name,
      columns[2].name,
      columns[0].name,
    ]);
  });

  it('uses data-column indexes for keyboard reordering with a leading column', () => {
    const { onReorderColumns } = setup({ leadingHeader: 'Selection' });
    fireEvent.keyDown(screen.getByRole('button', { name: 'Edit field a' }), {
      key: 'ArrowRight',
      altKey: true,
    });
    expect(onReorderColumns).toHaveBeenCalledWith([
      columns[1].name,
      columns[0].name,
      columns[2].name,
    ]);
  });

  it('removes drag listeners and the preview when the grid unmounts', () => {
    const { view, onReorderColumns } = setup();
    fireEvent.pointerDown(header(0), { button: 0, clientX: 50, clientY: 20 });
    fireEvent.pointerMove(window, { clientX: 270, clientY: 20 });
    expect(ghost()).not.toBeNull();
    view.unmount();
    expect(ghost()).toBeNull();
    fireEvent.pointerUp(window, { clientX: 270, clientY: 20 });
    expect(onReorderColumns).not.toHaveBeenCalled();
  });
});

describe('TableGrid column trash handle', () => {
  afterEach(() => __setActiveTableFieldDragForTests(null));

  it('shows a trash handle on custom columns only, never on managed ones', () => {
    const onRemoveField = vi.fn();
    const managed = {
      ...fields[0],
      managed: true,
      columnName: 'id',
      name: 'id',
      type: 'uuid' as const,
    };
    setup({
      fields: [managed, fields[1], fields[2]],
      columns: [{ ...columns[0], name: 'id', managed: true }, columns[1], columns[2]],
      onRemoveField,
      onHideField: vi.fn(),
    });
    expect(screen.queryByRole('button', { name: 'Remove field id' })).not.toBeInTheDocument();
    const remove = screen.getByRole('button', { name: 'Remove field b' });
    expect(remove).toHaveAttribute('data-field-remove-trigger');
    expect(remove).toHaveAttribute('aria-haspopup', 'dialog');
    expect(remove).toHaveAttribute('draggable', 'true');
    expect(header(1)).toContainElement(remove);
    expect(screen.getByRole('columnheader', { name: 'b' })).toBe(header(1));
  });

  it('is absent without a remove handler', () => {
    setup();
    expect(screen.queryByRole('button', { name: /Remove field/ })).not.toBeInTheDocument();
  });

  it('asks the pane to remove the column on click, without starting a reorder', () => {
    const onRemoveField = vi.fn();
    const { onReorderColumns, onEditField } = setup({ onRemoveField });
    const remove = screen.getByRole('button', { name: 'Remove field a' });
    fireEvent.pointerDown(remove, { button: 0, clientX: 90, clientY: 20 });
    fireEvent.pointerMove(window, { clientX: 250, clientY: 20 });
    fireEvent.pointerUp(window, { clientX: 250, clientY: 20 });
    fireEvent.click(remove);
    expect(onRemoveField).toHaveBeenCalledWith(fields[0], remove);
    expect(onReorderColumns).not.toHaveBeenCalled();
    expect(onEditField).not.toHaveBeenCalled();
    expect(ghost()).toBeNull();
  });

  it('drags the column as a table-field payload for the sidebar trash', () => {
    setup({ onRemoveField: vi.fn() });
    const remove = screen.getByRole('button', { name: 'Remove field c' });
    const setData = vi.fn();
    const dataTransfer = { setData, effectAllowed: 'none', types: [] as string[] };
    fireEvent.dragStart(remove, { dataTransfer });
    expect(setData).toHaveBeenCalledWith(
      TABLE_FIELD_MIME,
      JSON.stringify({ tableId, fieldId: fields[2].id, name: 'c' })
    );
    expect(readTableFieldDragPayload(dataTransfer as unknown as DataTransfer)).toEqual({
      tableId,
      fieldId: fields[2].id,
      name: 'c',
    });
    fireEvent.dragEnd(remove, { dataTransfer });
    expect(readTableFieldDragPayload(dataTransfer as unknown as DataTransfer)).toBeNull();
  });

  it('is disabled, not draggable and inert while field controls are locked', () => {
    const onRemoveField = vi.fn();
    setup({ onRemoveField, fieldControlsDisabled: true });
    const remove = screen.getByRole('button', { name: 'Remove field a' });
    expect(remove).toHaveAttribute('aria-disabled', 'true');
    expect(remove).toHaveAttribute('draggable', 'false');
    fireEvent.click(remove);
    expect(onRemoveField).not.toHaveBeenCalled();
  });
});

describe('TableGrid field controls', () => {
  it('marks the title column independently of its name and retains its collapsed strip', () => {
    const titleFields = [{ ...fields[0], isTitle: true, collapsed: true }, ...fields.slice(1)];
    setup({ fields: titleFields });
    expect(header(0)).toHaveAttribute('data-title-field', 'true');
    expect(header(0)).toHaveAttribute('data-field-collapsed', 'true');
    expect(header(0)).toHaveClass(styles.collapsedColumn);
    expect(header(1)).not.toHaveAttribute('data-title-field');
  });

  it('preserves the field header and edit trigger when a physical column is renamed', () => {
    const { view, onEditField } = setup();
    const trigger = screen.getByRole('button', { name: 'Edit field a' });
    const originalHeader = trigger.closest('th');
    trigger.focus();
    const renamed = { ...fields[0], name: 'renamed', columnName: 'renamed' };
    view.rerender(
      <TableGrid
        columns={[{ ...columns[0], name: renamed.columnName }, ...columns.slice(1)]}
        fields={[renamed, ...fields.slice(1)]}
        onEditField={onEditField}
        emptyTitle="No entries yet"
      />
    );
    const currentTrigger = screen.getByRole('button', { name: 'Edit field renamed' });
    expect(currentTrigger).toBe(trigger);
    expect(currentTrigger).toHaveFocus();
    expect(currentTrigger).toHaveAttribute('data-field-edit-trigger');
    expect(currentTrigger.closest('th')).toBe(originalHeader);
    expect(originalHeader).toHaveAttribute('data-field-id', renamed.id);
  });

  it('inserts at a boundary or appends from the final header edge without starting a drag', () => {
    const onAddField = vi.fn();
    const { onReorderColumns, onEditField } = setup({ onAddField });
    const before = screen.getByRole('button', { name: 'Insert field before b' });
    fireEvent.pointerDown(before, { button: 0, pointerType: 'touch', clientX: 100, clientY: 20 });
    fireEvent.pointerMove(window, { clientX: 170, clientY: 20 });
    fireEvent.pointerUp(window);
    fireEvent.click(before);
    expect(onAddField).toHaveBeenCalledWith(before, fields[1].id);
    expect(ghost()).toBeNull();
    expect(onReorderColumns).not.toHaveBeenCalled();
    expect(onEditField).not.toHaveBeenCalled();
    const append = screen.getByRole('button', { name: 'Add field at end' });
    fireEvent.click(append);
    expect(onAddField).toHaveBeenLastCalledWith(append, undefined);
  });

  it('shows only the nearest boundary and keeps keyboard focus discoverable', () => {
    setup({ onAddField: vi.fn() });
    const beforeB = screen.getByRole('button', { name: 'Insert field before b' });
    const beforeC = screen.getByRole('button', { name: 'Insert field before c' });
    fireEvent.pointerMove(header(1), { clientX: 102, clientY: 20 });
    expect(beforeB).toHaveAttribute('data-visible', 'true');
    expect(beforeC).toHaveAttribute('data-visible', 'false');
    fireEvent.pointerMove(header(2), { clientX: 198, clientY: 20 });
    expect(beforeB).toHaveAttribute('data-visible', 'false');
    expect(beforeC).toHaveAttribute('data-visible', 'true');
    const scroller = screen.getByRole('table').parentElement;
    if (!scroller) throw new Error('Expected the table scroll boundary');
    fireEvent.scroll(scroller);
    expect(beforeC).toHaveAttribute('data-visible', 'false');
    fireEvent.pointerLeave(header(2).parentElement as HTMLElement);
    fireEvent.focus(beforeB);
    expect(beforeB).toHaveAttribute('data-visible', 'true');
    expect(beforeC).toHaveAttribute('data-visible', 'false');
  });

  it('offers an accessible insertion path before any columns exist', () => {
    const onAddField = vi.fn();
    render(<TableGrid columns={[]} onAddField={onAddField} emptyTitle="Start a table" />);
    const first = screen.getByRole('button', { name: 'Add first field' });
    expect(first).toHaveAttribute('data-visible', 'true');
    fireEvent.click(first);
    expect(onAddField).toHaveBeenCalledWith(first, undefined);
  });

  it('lets keyboard users discover and activate boundary insertion without a hover', async () => {
    const user = userEvent.setup();
    const onAddField = vi.fn();
    setup({ onAddField });
    await user.tab();
    const first = screen.getByRole('button', { name: 'Insert field before a' });
    expect(first).toHaveFocus();
    expect(first).toHaveAttribute('data-visible', 'true');
    await user.keyboard('{Enter}');
    expect(onAddField).toHaveBeenCalledWith(first, fields[0].id);
  });

  it('hides a field from the eye-off button in its header, never dragging the column', () => {
    const onHideField = vi.fn();
    const { onReorderColumns } = setup({ onHideField });
    const hide = screen.getByRole('button', { name: 'Hide field b' });
    expect(hide).toHaveAttribute('data-column-control');
    expect(hide.querySelector('[data-hide-icon]')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Toggle field/ })).not.toBeInTheDocument();
    fireEvent.pointerDown(hide, { button: 0, clientX: 110, clientY: 20 });
    fireEvent.pointerMove(window, { clientX: 260, clientY: 20 });
    fireEvent.pointerUp(window);
    fireEvent.click(hide);
    expect(onHideField).toHaveBeenCalledWith(fields[1]);
    expect(onReorderColumns).not.toHaveBeenCalled();
  });

  it('keeps the last shown field from being hidden', () => {
    const onHideField = vi.fn();
    setup({ columns: [columns[0]], fields: [fields[0]], onHideField });
    const hide = screen.getByRole('button', { name: 'Hide field a' });
    expect(hide).toHaveAttribute('aria-disabled', 'true');
    expect(hide).toHaveAttribute('title', 'The last shown field can’t be hidden');
    fireEvent.click(hide);
    expect(onHideField).not.toHaveBeenCalled();
  });

  it('offers no hide buttons for unregistered built-in columns', () => {
    render(<TableGrid columns={columns} onHideField={vi.fn()} emptyTitle="No rows" />);
    expect(screen.queryByRole('button', { name: /Hide field/ })).not.toBeInTheDocument();
  });

  it('uses a single-line name with a type glyph and exposes full metadata on keyboard focus', () => {
    const current = { ...fields[0], nullable: false, description: 'A useful name' };
    setup({ fields: [current, fields[1], fields[2]] });
    const edit = screen.getByRole('button', { name: 'Edit field a' });
    expect(edit).toHaveTextContent(/^a$/);
    expect(edit.querySelector('[data-field-type="text"] svg')).toBeInTheDocument();
    expect(edit).toHaveAccessibleDescription('Text · Required · A useful name');
    expect(header(0)).toHaveAccessibleDescription('Text · Required · A useful name');
    fireEvent.focus(edit);
    expect(screen.getByRole('tooltip')).toHaveTextContent('Text · Required · A useful name');
  });

  it('names a range column in its header details', () => {
    const rangeFields: TableField[] = [
      { ...field('trip', 0), type: 'date', range: true },
      { ...field('slot', 1), type: 'datetime', range: true },
    ];
    render(
      <TableGrid
        columns={rangeFields.map((item) => ({
          name: item.columnName,
          dataType: item.type,
          nullable: true,
          managed: false,
        }))}
        fields={rangeFields}
        emptyTitle="No entries"
      />
    );
    expect(screen.getByRole('columnheader', { name: /trip/ })).toHaveAccessibleDescription(
      'Date range'
    );
    expect(screen.getByRole('columnheader', { name: /slot/ })).toHaveAccessibleDescription(
      'Date and time range'
    );
  });

  it('keeps system columns narrow and muted while a collapsed system column stays a strip', () => {
    const systemFields: TableField[] = [
      { ...field('id', 0), columnName: 'id', type: 'uuid', managed: true },
      { ...field('created_at', 1), columnName: 'created_at', type: 'datetime', managed: true },
    ];
    const systemColumns = systemFields.map((item) => ({
      name: item.columnName,
      dataType: item.type,
      nullable: item.nullable,
      managed: item.managed,
    }));
    const props = {
      columns: systemColumns,
      fields: systemFields,
      onHideField: vi.fn(),
      emptyTitle: 'No entries',
    };
    const view = render(<TableGrid {...props} />);
    const idHeader = screen.getByRole('columnheader', { name: /id/ });
    const dateHeader = screen.getByRole('columnheader', { name: /created_at/ });
    expect(idHeader).toHaveClass(styles.systemIdColumn, styles.columnManaged);
    expect(dateHeader).toHaveClass(styles.systemDateColumn, styles.columnManaged);
    expect(idHeader).toHaveAccessibleDescription('UUID · Managed by Snaglet');
    expect(dateHeader).toHaveAccessibleDescription('Date and time · Managed by Snaglet');
    expect(screen.getByRole('table').querySelector('col[data-system-column="id"]')).toHaveClass(
      styles.systemIdColumn
    );
    view.rerender(
      <TableGrid {...props} fields={systemFields.map((item) => ({ ...item, collapsed: true }))} />
    );
    expect(idHeader).toHaveClass(styles.collapsedColumn);
    expect(idHeader).not.toHaveClass(styles.systemIdColumn);
    expect(dateHeader).toHaveClass(styles.collapsedColumn);
    expect(dateHeader).not.toHaveClass(styles.systemDateColumn);
    expect(screen.queryByRole('button', { name: 'Hide field id' })).not.toBeInTheDocument();
    expect(idHeader.querySelector('[data-field-type]')).not.toBeInTheDocument();
  });

  it.each(['number', 'date', 'checkbox', 'relation', 'jsonb'])(
    'renders a compact glyph without a subtitle for the %s type',
    (type) => {
      render(
        <TableGrid
          columns={[{ name: 'value', dataType: type, nullable: true, managed: false }]}
          emptyTitle="No entries"
        />
      );
      const column = screen.getByRole('columnheader', { name: 'value' });
      expect(column).toHaveTextContent(/^value$/);
      expect(column.querySelector(`[data-field-type="${type}"] svg`)).toBeInTheDocument();
      expect(column).toHaveAccessibleDescription(type.charAt(0).toUpperCase() + type.slice(1));
    }
  );

  it('blocks controls during field edits and pending view writes without hiding the headers', () => {
    const { onReorderColumns } = setup({
      onAddField: vi.fn(),
      onHideField: vi.fn(),
      pendingFieldIds: new Set([fields[1].id]),
    });
    expect(screen.getByRole('button', { name: 'Hide field b' })).toHaveAttribute(
      'aria-disabled',
      'true'
    );
    expect(screen.getByRole('button', { name: 'Edit field b' })).toHaveAttribute(
      'aria-disabled',
      'true'
    );
    expect(screen.getByRole('button', { name: 'Hide field a' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Add field at end' })).toHaveAttribute(
      'aria-disabled',
      'true'
    );
    fireEvent.pointerDown(header(0), { button: 0, clientX: 50, clientY: 20 });
    fireEvent.pointerMove(window, { clientX: 270, clientY: 20 });
    fireEvent.pointerUp(window);
    expect(onReorderColumns).not.toHaveBeenCalled();
  });

  it('disables all mutations while a field editor owns the header', () => {
    const { onReorderColumns, onEditField } = setup({
      onAddField: vi.fn(),
      onHideField: vi.fn(),
      fieldControlsDisabled: true,
    });
    for (const button of screen.getAllByRole('button')) {
      if (
        button.hasAttribute('data-field-edit-trigger') ||
        button.hasAttribute('data-field-insert')
      ) {
        expect(button).toHaveAttribute('aria-disabled', 'true');
        fireEvent.click(button);
      } else expect(button).toBeDisabled();
    }
    expect(onEditField).not.toHaveBeenCalled();
    fireEvent.keyDown(header(0), { key: 'ArrowRight', altKey: true });
    expect(onReorderColumns).not.toHaveBeenCalled();
  });

  it('keeps the open dialog trigger focusable and clickable without enabling other field changes', async () => {
    const { onEditField } = setup({
      fieldControlsDisabled: true,
      editingDisabled: true,
      fieldEditorId: 'summary-field-editor',
      editingFieldId: fields[0].id,
    });
    const active = screen.getByRole('button', { name: 'Edit field a' });
    const inactive = screen.getByRole('button', { name: 'Edit field b' });
    expect(active).toHaveAttribute('aria-haspopup', 'dialog');
    expect(active).toHaveAttribute('aria-expanded', 'true');
    expect(active).toHaveAttribute('aria-controls', 'summary-field-editor');
    expect(active).not.toHaveAttribute('aria-disabled');
    expect(active.tabIndex).toBe(0);
    expect(active).toBeEnabled();
    await userEvent.click(active);
    expect(active).toHaveFocus();
    expect(onEditField).toHaveBeenCalledWith(fields[0], active);
    expect(inactive).toHaveAttribute('aria-expanded', 'false');
    expect(inactive).toHaveAttribute('aria-disabled', 'true');
    await userEvent.click(inactive);
    expect(onEditField).toHaveBeenCalledTimes(1);
  });

  it('keeps the active add trigger visible, focusable and clickable to close its dialog', async () => {
    const onAddField = vi.fn();
    setup({
      onAddField,
      fieldControlsDisabled: true,
      editingDisabled: true,
      insertingFieldBoundary: fields[1].id,
      fieldEditorId: 'new-field-dialog',
    });
    const active = screen.getByRole('button', { name: 'Insert field before b' });
    expect(active).toHaveAttribute('aria-haspopup', 'dialog');
    expect(active).toHaveAttribute('aria-expanded', 'true');
    expect(active).toHaveAttribute('aria-controls', 'new-field-dialog');
    expect(active).toHaveAttribute('data-visible', 'true');
    expect(active).not.toHaveAttribute('aria-disabled');
    expect(active.tabIndex).toBe(0);
    expect(screen.getByRole('button', { name: 'Add field at end' })).toHaveAttribute(
      'tabindex',
      '-1'
    );
    await userEvent.click(active);
    expect(active).toHaveFocus();
    expect(onAddField).toHaveBeenCalledWith(active, fields[1].id);
    await userEvent.click(screen.getByRole('button', { name: 'Add field at end' }));
    expect(onAddField).toHaveBeenCalledTimes(1);
  });

  it('keeps column names separate from their contextual controls in the accessibility tree', () => {
    setup({ onAddField: vi.fn(), onHideField: vi.fn() });
    expect(screen.getByRole('columnheader', { name: 'a' })).toBe(header(0));
    expect(screen.getByRole('columnheader', { name: 'b' })).toBe(header(1));
  });

  it('keeps a focused hide button inert while its write is pending', async () => {
    const onHideField = vi.fn();
    const { view } = setup({ onHideField });
    const hide = screen.getByRole('button', { name: 'Hide field a' });
    act(() => hide.focus());
    const props = { columns, fields, onHideField, emptyTitle: 'No entries' };
    view.rerender(<TableGrid {...props} pendingFieldIds={new Set([fields[0].id])} />);
    expect(screen.getByRole('button', { name: 'Hide field a' })).toBe(hide);
    expect(hide).toHaveFocus();
    expect(hide).toHaveAttribute('aria-disabled', 'true');
    expect(hide).toHaveAttribute('aria-busy', 'true');
    await userEvent.keyboard('{Enter}');
    fireEvent.click(hide);
    expect(onHideField).not.toHaveBeenCalled();
  });

  it('prioritizes the hovered boundary over an older focused boundary', () => {
    setup({ onAddField: vi.fn() });
    const beforeB = screen.getByRole('button', { name: 'Insert field before b' });
    const beforeC = screen.getByRole('button', { name: 'Insert field before c' });
    fireEvent.focus(beforeB);
    fireEvent.pointerMove(header(2), { clientX: 202, clientY: 10 });
    expect(beforeB).toHaveAttribute('data-visible', 'false');
    expect(beforeC).toHaveAttribute('data-visible', 'true');
  });

  it('does not track field boundaries over the leading selection header or a hide button', () => {
    setup({
      leadingHeader: <button>Select rows</button>,
      onAddField: vi.fn(),
      onHideField: vi.fn(),
    });
    const beforeA = screen.getByRole('button', { name: 'Insert field before a' });
    fireEvent.pointerMove(header(1), { clientX: 102, clientY: 10 });
    expect(beforeA).toHaveAttribute('data-visible', 'true');
    fireEvent.pointerMove(header(0), { clientX: 99, clientY: 10 });
    expect(beforeA).toHaveAttribute('data-visible', 'false');
    fireEvent.pointerMove(screen.getByRole('button', { name: 'Hide field a' }), {
      clientX: 102,
      clientY: 20,
    });
    expect(beforeA).toHaveAttribute('data-visible', 'false');
  });

  it('keeps a hide button pointer gesture from exposing an insertion target before release', () => {
    const onHideField = vi.fn();
    const onAddField = vi.fn();
    setup({ onAddField, onHideField });
    const toggle = screen.getByRole('button', { name: 'Hide field a' });
    fireEvent.pointerMove(toggle, { clientX: 17, clientY: 22 });
    fireEvent.pointerDown(toggle, { button: 0, clientX: 17, clientY: 22 });
    fireEvent.pointerMove(header(0), { buttons: 1, clientX: 12, clientY: 20 });
    expect(screen.getByRole('button', { name: 'Insert field before a' })).toHaveAttribute(
      'data-visible',
      'false'
    );
    fireEvent.pointerUp(toggle, { clientX: 12, clientY: 20 });
    fireEvent.click(toggle);
    expect(onHideField).toHaveBeenCalledOnce();
    expect(onAddField).not.toHaveBeenCalled();
  });

  it('marks the drag surface and excludes contextual controls from the ghost', () => {
    setup({ onAddField: vi.fn(), onHideField: vi.fn() });
    const scroller = screen.getByRole('table').parentElement;
    fireEvent.pointerDown(header(0), { button: 0, clientX: 50, clientY: 20 });
    fireEvent.pointerMove(window, { clientX: 270, clientY: 20 });
    expect(scroller).toHaveAttribute('data-column-dragging', 'true');
    expect(ghost()?.querySelector('[data-column-control]')).toBeNull();
    expect(ghost()).toHaveTextContent('a');
    fireEvent.pointerUp(window, { clientX: 270, clientY: 20 });
    expect(scroller).not.toHaveAttribute('data-column-dragging');
  });
});
