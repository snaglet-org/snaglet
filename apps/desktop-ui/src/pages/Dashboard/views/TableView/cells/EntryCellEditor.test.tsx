import { EditorView } from '@tiptap/pm/view';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TableEntryValue, TableField } from '@snaglet/shared/types';
import { tableDateTimeToUtc, userTimeZone } from '@snaglet/shared/utils';
import { tablesApi } from '@desktop/utils/api';
import { tableRepeatsApi } from '@desktop/utils/api/tableRepeats';
import { NODE_CHIP_MIME, setActiveDragChip, type NodeChipData } from '@desktop/utils/nodeChip';
import { EntryCellEditor } from './EntryCellEditor';
import { EntryCell } from './EntryCell';
import styles from './EntryCellEditor.module.scss';
import pickerStyles from '@desktop/components/controls/DateInput/DatePicker.module.scss';
import { toDateTimeInput } from '../dateTimeInput';

vi.mock('@desktop/utils/api', async () => {
  const actual = await vi.importActual<typeof import('@desktop/utils/api')>('@desktop/utils/api');
  return { ...actual, agentsApi: { ...actual.agentsApi, list: vi.fn(async () => []) } };
});

const docChip: NodeChipData = {
  id: 'doc-1111111111111-aaaaaaaaa',
  kind: 'doc',
  title: 'Field guide',
};

// jsdom has no layout. Stub geometry only; drops run through real ProseMirror handlers.
beforeAll(() => {
  if (!document.elementFromPoint) document.elementFromPoint = () => null;
  if (!Range.prototype.getClientRects)
    Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
  if (!Range.prototype.getBoundingClientRect)
    Range.prototype.getBoundingClientRect = () => new DOMRect();
});
beforeEach(() => {
  vi.spyOn(EditorView.prototype, 'posAtCoords').mockImplementation(function (this: EditorView) {
    return { pos: this.state.selection.from, inside: -1 };
  });
});
afterEach(() => {
  setActiveDragChip(null);
  vi.restoreAllMocks();
});

/**
 * DateInput is Snaglet's own picker field: it keeps the native wire value on
 * `data-value` and shows it for the viewer's locale ("Tue, Oct 13").
 */
function expectDateField(input: HTMLElement, wire: string, shown: RegExp) {
  expect(input).toHaveAttribute('data-value', wire);
  expect((input as HTMLInputElement).value).toMatch(shown);
}

function field(overrides: Partial<TableField>): TableField {
  return {
    range: false,
    id: 'field-1111111111111-aaaaaaaaa',
    tableId: 'table-1111111111111-aaaaaaaaa',
    columnName: 'f_aaaaaaaaaaaaaaaaaaaaaaaa',
    name: 'Value',
    description: null,
    type: 'text',
    nullable: true,
    defaultValue: null,
    referenceTableId: null,
    referenceKind: null,
    position: 2,
    managed: false,
    collapsed: false,
    isTitle: false,
    multiple: false,
    options: null,
    revision: 1,
    ...overrides,
  };
}

function chipTransfer(value: NodeChipData = docChip) {
  return {
    types: [NODE_CHIP_MIME],
    getData: (type: string) => (type === NODE_CHIP_MIME ? JSON.stringify(value) : ''),
    dropEffect: 'copy',
    files: [],
  };
}

function renderCell(
  cellField: TableField,
  value: TableEntryValue,
  extra: Partial<Parameters<typeof EntryCellEditor>[0]> = {}
) {
  const props = {
    onChange: vi.fn(),
    onCommit: vi.fn(),
    onCancel: vi.fn(),
    busy: false,
    ...extra,
  };
  // A parent drop handler stands in for the pane's split overlay: a drop the
  // cell owns must never reach it.
  const paneDrop = vi.fn();
  const view = render(
    <div data-table-entries-grid onDrop={paneDrop}>
      <table>
        <tbody>
          <tr>
            <EntryCell field={cellField} active>
              <EntryCellEditor field={cellField} value={value} {...props} />
            </EntryCell>
          </tr>
        </tbody>
      </table>
    </div>
  );
  return { ...props, paneDrop, view };
}

describe('EntryCellEditor — Text cells take real chips', () => {
  it('stores a dropped doc chip as its canonical reference and opts out of pane splits', async () => {
    const { onChange } = renderCell(field({ type: 'text' }), 'See ');
    const editor = screen.getByRole('textbox', { name: 'Value' });

    // PaneChrome skips any drop inside this marker (usePaneDropZone), so the
    // pane never splits; the editor itself consumes the drop.
    expect(editor.closest('[data-pane-drop-target="node-chip"]')).not.toBeNull();
    const notConsumed = fireEvent.drop(editor, {
      dataTransfer: chipTransfer(),
      clientX: 0,
      clientY: 0,
    });

    expect(notConsumed).toBe(false);
    await waitFor(() =>
      expect(onChange).toHaveBeenLastCalledWith(
        expect.stringContaining('[Field guide](doc-1111111111111-aaaaaaaaa)')
      )
    );
  });

  it('commits the current text on Enter and cancels on Escape', async () => {
    const { onCommit, onCancel } = renderCell(field({ type: 'text' }), 'Draft note');
    const editor = screen.getByRole('textbox', { name: 'Value' });

    fireEvent.keyDown(editor, { key: 'Enter' });
    expect(onCommit).toHaveBeenCalledWith('Draft note');

    fireEvent.keyDown(editor, { key: 'Escape' });
    expect(onCancel).toHaveBeenCalledTimes(1);
  });
});

describe('EntryCellEditor — scalar cells refuse chips and keep their value', () => {
  it.each([
    ['number', '42', 'Number'],
    ['date', '2026-09-25', 'Date'],
    ['checkbox', true, 'Checkbox'],
  ] as const)('a %s cell owns and rejects a chip drop', (type, value, label) => {
    const { onChange, paneDrop } = renderCell(field({ type }), value);
    const target = document.querySelector<HTMLElement>('[data-pane-drop-target="node-chip"]');
    if (!target) throw new Error('scalar cell is not a chip drop target');

    fireEvent.dragOver(target, { dataTransfer: chipTransfer() });
    fireEvent.drop(target, { dataTransfer: chipTransfer() });

    expect(onChange).not.toHaveBeenCalled();
    expect(paneDrop).not.toHaveBeenCalled();
    expect(screen.getByRole('alert')).toHaveTextContent(`${label} cells can't hold links`);
  });

  it('keeps an exact decimal string, clears to null, and commits the latest edit on Enter', () => {
    const { onChange, onCommit } = renderCell(field({ type: 'number' }), '42');
    const input = screen.getByRole('textbox', { name: 'Value' });
    expect(input).toHaveValue('42');

    fireEvent.change(input, { target: { value: '12.50' } });
    expect(onChange).toHaveBeenLastCalledWith('12.50');
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onCommit).toHaveBeenLastCalledWith('12.50');

    fireEvent.change(input, { target: { value: '   ' } });
    expect(onChange).toHaveBeenLastCalledWith(null);
  });

  it('clears the cell-owned rejection message on the next editing gesture', () => {
    renderCell(field({ type: 'number' }), '42');
    const target = document.querySelector<HTMLElement>('[data-pane-drop-target="node-chip"]');
    if (!target) throw new Error('missing drop target');
    fireEvent.drop(target, { dataTransfer: chipTransfer() });
    expect(screen.getByRole('alert')).toBeInTheDocument();

    fireEvent.pointerDown(screen.getByRole('textbox', { name: 'Value' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Value' }), { target: { value: '7' } });
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('commits the newest edit after a cell-owned chip rejection', () => {
    const { onChange, onCommit } = renderCell(field({ type: 'number' }), '42');
    const input = screen.getByRole('textbox', { name: 'Value' });
    fireEvent.drop(input, { dataTransfer: chipTransfer() });
    expect(screen.getByRole('alert')).toBeInTheDocument();

    fireEvent.pointerDown(input);
    fireEvent.change(input, { target: { value: '9007199254740993.01' } });
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onChange).toHaveBeenLastCalledWith('9007199254740993.01');
    expect(onCommit).toHaveBeenLastCalledWith('9007199254740993.01');
  });

  it('edits a date as YYYY-MM-DD and empties it to null', () => {
    const { onChange } = renderCell(field({ type: 'date' }), '2026-09-25');
    const input = screen.getByLabelText('Value');

    fireEvent.change(input, { target: { value: '2026-10-01' } });
    expect(onChange).toHaveBeenLastCalledWith('2026-10-01');
    fireEvent.change(input, { target: { value: '' } });
    expect(onChange).toHaveBeenLastCalledWith(null);
  });

  it('renders null as unchecked and toggles directly without a Clear control', async () => {
    const user = userEvent.setup();
    const nullable = renderCell(field({ type: 'checkbox', nullable: true }), null);
    expect(screen.getByRole('checkbox')).not.toBeChecked();
    expect(screen.getByRole('checkbox')).not.toBePartiallyChecked();
    await user.click(screen.getByRole('checkbox', { name: 'Value' }));
    expect(nullable.onChange).toHaveBeenLastCalledWith(true);
    expect(screen.queryByRole('button', { name: 'Clear' })).not.toBeInTheDocument();
    nullable.view.unmount();

    renderCell(field({ type: 'checkbox', nullable: false }), false);
    expect(screen.queryByRole('button', { name: 'Clear' })).not.toBeInTheDocument();
  });

  it('toggles checkboxes with Enter and Space without closing an editor', async () => {
    const { onChange, onCommit } = renderCell(field({ type: 'checkbox', nullable: true }), true);
    screen.getByRole('checkbox', { name: 'Value' }).focus();
    await userEvent.keyboard('{Enter}');
    expect(onChange).toHaveBeenLastCalledWith(false);
    expect(onCommit).not.toHaveBeenCalled();

    screen.getByRole('checkbox', { name: 'Value' }).focus();
    await userEvent.keyboard(' ');
    expect(onChange).toHaveBeenLastCalledWith(true);
    expect(onCommit).not.toHaveBeenCalled();
  });
});

describe('EntryCellEditor — state and focus', () => {
  it('uses a cell-owned number input without a nested bordered form shell', () => {
    renderCell(field({ type: 'number' }), '42');
    const input = screen.getByRole('textbox', { name: 'Value' });
    expect(input).toHaveClass(styles.scalarInput);
    expect(input.parentElement).toHaveClass(styles.control);
    expect(input.parentElement?.parentElement).toHaveClass(styles.cell);
  });

  it('owns scalar drops across the editor surface, including its validation area', () => {
    const { onChange, paneDrop } = renderCell(field({ type: 'date' }), '2026-01-01', {
      error: 'Choose a date.',
    });
    const alert = screen.getByRole('alert');
    expect(fireEvent.drop(alert, { dataTransfer: chipTransfer() })).toBe(false);
    expect(onChange).not.toHaveBeenCalled();
    expect(paneDrop).not.toHaveBeenCalled();
    expect(
      screen.getByText("Date cells can't hold links. Drop links into a Text field instead.")
    ).toHaveAttribute('role', 'alert');
    expect(alert).toHaveTextContent('Choose a date.');
    expectDateField(screen.getByLabelText('Value'), '2026-01-01', /^Thu, Jan 1\b/);
  });

  it('uses the current busy state and cancel callback for native text-editor Escape', async () => {
    const originalCancel = vi.fn();
    const currentCancel = vi.fn();
    const props = {
      field: field({ type: 'text' }),
      value: 'Draft note',
      onChange: vi.fn(),
      onCommit: vi.fn(),
    };
    const view = render(<EntryCellEditor {...props} busy={false} onCancel={originalCancel} />);
    const editor = await screen.findByRole('textbox', { name: 'Value' });
    await waitFor(() => expect(editor).toHaveTextContent('Draft note'));

    view.rerender(<EntryCellEditor {...props} busy onCancel={currentCancel} />);
    fireEvent.keyDown(editor, { key: 'Escape', code: 'Escape', keyCode: 27, which: 27 });
    expect(originalCancel).not.toHaveBeenCalled();
    expect(currentCancel).not.toHaveBeenCalled();

    view.rerender(<EntryCellEditor {...props} busy={false} onCancel={currentCancel} />);
    fireEvent.keyDown(editor, { key: 'Escape', code: 'Escape', keyCode: 27, which: 27 });
    expect(originalCancel).not.toHaveBeenCalled();
    expect(currentCancel).toHaveBeenCalledOnce();
  });

  it('shows the grid error, wires it to the control, and blocks commits while busy', () => {
    const { onCommit } = renderCell(field({ type: 'number' }), '42', {
      busy: true,
      error: 'Enter a number.',
    });
    const input = screen.getByRole('textbox', { name: 'Value' });
    const alert = screen.getByRole('alert');

    expect(alert).toHaveTextContent('Enter a number.');
    expect(input).toHaveAttribute('aria-describedby', alert.id);
    expect(input).toHaveAttribute('readonly');
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onCommit).not.toHaveBeenCalled();
  });

  it('focuses the first editor when asked, including checkboxes', () => {
    renderCell(field({ type: 'number' }), '1', { autoFocus: true });
    expect(screen.getByRole('textbox', { name: 'Value' })).toHaveFocus();
  });

  it('focuses a checkbox editor when asked', () => {
    renderCell(field({ type: 'checkbox' }), false, { autoFocus: true });
    expect(screen.getByRole('checkbox', { name: 'Value' })).toHaveFocus();
  });

  it('renders managed fields read-only with only the outer cell drop target', () => {
    renderCell(field({ type: 'datetime', managed: true, name: 'created_at' }), '2026-01-01');
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
    expect(document.querySelectorAll('[data-pane-drop-target]')).toHaveLength(1);
    expect(document.querySelector('[data-pane-drop-target]')?.tagName).toBe('TD');
    expect(screen.getByLabelText('created_at')).toHaveTextContent('2026-01-01');
  });
});

describe('EntryCellEditor — date and time', () => {
  it('presents a stored instant in local time without saving or truncating its precision', () => {
    const value = '2026-09-26T17:02:16.832699Z';
    const { onChange, onCommit } = renderCell(field({ type: 'datetime' }), value, {
      autoFocus: true,
    });
    const input = screen.getByLabelText('Value');
    expect(input).toHaveAttribute('data-type', 'datetime-local');
    // Seconds and milliseconds survive into the field (zones never shift seconds).
    expectDateField(input, toDateTimeInput(value), /:16 [AP]M$/);
    expect(toDateTimeInput(value)).toMatch(/:16\.832$/);
    expect(input).toHaveFocus();
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onCommit).toHaveBeenCalledWith(value);
  });

  it('saves changed local times as UTC and commits the latest value on Enter', () => {
    const { onChange, onCommit } = renderCell(
      field({ type: 'datetime' }),
      '2026-09-26T17:02:16.832699Z'
    );
    const input = screen.getByLabelText('Value');
    const next = '2026-10-01T01:23:45.123';
    fireEvent.change(input, { target: { value: next } });
    const utc = tableDateTimeToUtc(next, userTimeZone());
    expect(onChange).toHaveBeenLastCalledWith(utc);
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onCommit).toHaveBeenLastCalledWith(utc);
  });

  it('clears to null and leaves Tab to grid blur handling while Escape cancels', () => {
    const { onChange, onCommit, onCancel } = renderCell(
      field({ type: 'datetime' }),
      '2026-09-26T17:02:16.832699Z'
    );
    const input = screen.getByLabelText('Value');
    fireEvent.change(input, { target: { value: '' } });
    expect(onChange).toHaveBeenLastCalledWith(null);
    expect(fireEvent.keyDown(input, { key: 'Tab' })).toBe(true);
    expect(onCommit).not.toHaveBeenCalled();
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onCommit).toHaveBeenLastCalledWith(null);
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(onCancel).toHaveBeenCalledOnce();
  });

  it('keeps invalid persisted values for validation without throwing during display', () => {
    const { onCommit } = renderCell(field({ type: 'datetime' }), '2026-02-30T12:00', {
      error: 'Enter a date and time.',
    });
    const input = screen.getByLabelText('Value');
    expect(input).toHaveValue('');
    expect(input).toHaveAttribute('aria-invalid', 'true');
    expect(input).toHaveAttribute('aria-describedby', screen.getByRole('alert').id);
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onCommit).toHaveBeenCalledWith('2026-02-30T12:00');
  });

  it('blocks changes, commits and cancellation while busy', () => {
    const { onChange, onCommit, onCancel } = renderCell(
      field({ type: 'datetime' }),
      '2026-01-01T00:00:00Z',
      { busy: true }
    );
    const input = screen.getByLabelText('Value');
    expect(input).toHaveAttribute('readonly');
    fireEvent.change(input, { target: { value: '2026-02-01T12:30' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(onChange).not.toHaveBeenCalled();
    expect(onCommit).not.toHaveBeenCalled();
    expect(onCancel).not.toHaveBeenCalled();
  });
});

describe('EntryCellEditor — date ranges', () => {
  const dateRange = field({ type: 'date', range: true, name: 'Trip' });
  const timeRange = field({ type: 'datetime', range: true, name: 'Meeting' });

  it('edits a start and an end of the field kind under the field name', () => {
    const { onChange } = renderCell(dateRange, '2026-10-12/2026-10-15', { autoFocus: true });
    const group = screen.getByRole('group', { name: 'Trip' });
    const start = within(group).getByLabelText('Start');
    const end = within(group).getByLabelText('End');
    expect(start).toHaveAttribute('data-type', 'date');
    expect(end).toHaveAttribute('data-type', 'date');
    expectDateField(start, '2026-10-12', /^Mon, Oct 12\b/);
    expectDateField(end, '2026-10-15', /^Thu, Oct 15\b/);
    expect(start).toHaveFocus();
    expect(group).toHaveTextContent('→');
    fireEvent.change(end, { target: { value: '2026-10-18' } });
    expect(onChange).toHaveBeenLastCalledWith('2026-10-12/2026-10-18');
    fireEvent.change(start, { target: { value: '2026-10-14' } });
    expect(onChange).toHaveBeenLastCalledWith('2026-10-14/2026-10-18');
  });

  it('opens Start and End in a panel under the cell in the grid, the cell showing the value', () => {
    const { onChange } = renderCell(dateRange, '2026-10-12/2026-10-15', {
      autoFocus: true,
      rangePanel: true,
    });
    const panel = screen.getByRole('group', { name: 'Trip' });
    expect(panel.closest('[data-cell-picker-popover]')).not.toBeNull();
    expect(within(panel).getByText('Start')).toBeInTheDocument();
    const end = within(panel).getByLabelText('End');
    expectDateField(end, '2026-10-15', /^Thu, Oct 15\b/);
    expect(within(panel).getByLabelText('Start')).toHaveFocus();
    fireEvent.change(end, { target: { value: '2026-10-18' } });
    expect(onChange).toHaveBeenLastCalledWith('2026-10-12/2026-10-18');
    fireEvent.change(end, { target: { value: '2026-10-10' } });
    expect(within(panel).getByRole('alert')).toBeInTheDocument();
  });

  it('the range card closes on a press outside, keeping the edit, and reverts on Escape', () => {
    const outside = document.createElement('button');
    outside.textContent = 'Elsewhere';
    // A sidebar control that stops its own press must not keep the card open.
    outside.addEventListener('pointerdown', (event) => event.stopPropagation());
    document.body.appendChild(outside);
    const { onCommit, onCancel } = renderCell(dateRange, '2026-10-12/2026-10-15', {
      autoFocus: true,
      rangePanel: true,
    });
    const panel = screen.getByRole('group', { name: 'Trip' });
    fireEvent.change(within(panel).getByLabelText('End'), { target: { value: '2026-10-18' } });
    // A press inside the card or on its own cell keeps it open.
    fireEvent.pointerDown(within(panel).getByLabelText('Start'));
    fireEvent.pointerDown(panel.closest('td') ?? panel);
    expect(onCommit).not.toHaveBeenCalled();
    fireEvent.pointerDown(outside);
    expect(onCommit).toHaveBeenCalledWith('2026-10-12/2026-10-18');
    expect(onCancel).not.toHaveBeenCalled();
    outside.remove();
  });

  it('Escape from outside the range card cancels it', () => {
    const { onCommit, onCancel } = renderCell(dateRange, '2026-10-12/2026-10-15', {
      autoFocus: true,
      rangePanel: true,
    });
    (document.activeElement as HTMLElement | null)?.blur();
    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(onCancel).toHaveBeenCalled();
    expect(onCommit).not.toHaveBeenCalled();
  });

  it('shades the days between Start and End in either picker, date or date & time', () => {
    const banded = () =>
      Array.from(document.querySelectorAll(`.${pickerStyles.dayInRange}`)).map((c) =>
        c.getAttribute('data-day')
      );
    const { view } = renderCell(dateRange, '2026-10-12/2026-10-15');
    fireEvent.click(screen.getByLabelText('End'));
    expect(banded()).toEqual(['2026-10-13', '2026-10-14']);
    const start = screen.getByLabelText('Start');
    fireEvent.pointerDown(start);
    fireEvent.click(start);
    expect(banded()).toEqual(['2026-10-13', '2026-10-14']);
    view.unmount();
    // Whatever the machine's zone, the 14th and 15th lie strictly inside.
    renderCell(timeRange, '2026-10-12T16:00:00.000000Z/2026-10-16T16:00:00.000000Z');
    fireEvent.click(screen.getByLabelText('End'));
    expect(banded()).toEqual(expect.arrayContaining(['2026-10-14', '2026-10-15']));
  });

  it('treats an empty end as a single value and both empty as no value', () => {
    const { onChange } = renderCell(dateRange, '2026-10-12');
    const end = screen.getByLabelText('End');
    expect(end).toHaveValue('');
    fireEvent.change(end, { target: { value: '2026-10-12' } });
    expect(onChange).toHaveBeenLastCalledWith('2026-10-12');
    fireEvent.change(end, { target: { value: '2026-10-13' } });
    expect(onChange).toHaveBeenLastCalledWith('2026-10-12/2026-10-13');
    fireEvent.change(end, { target: { value: '' } });
    expect(onChange).toHaveBeenLastCalledWith('2026-10-12');
    fireEvent.change(screen.getByLabelText('Start'), { target: { value: '' } });
    expect(onChange).toHaveBeenLastCalledWith(null);
  });

  it("refuses an end before the start with the parser's sentence and does not commit it", () => {
    const { onChange, onCommit } = renderCell(dateRange, '2026-10-12/2026-10-15');
    const end = screen.getByLabelText('End');
    fireEvent.change(end, { target: { value: '2026-10-10' } });
    // The draft gets the refused pair, so its validation blocks the save too.
    expect(onChange).toHaveBeenLastCalledWith('2026-10-12/2026-10-10');
    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent('The end is before the start.');
    expect(end).toHaveAttribute('aria-invalid', 'true');
    expect(end).toHaveAttribute('aria-describedby', alert.id);
    expect(end).toHaveValue('2026-10-10');
    fireEvent.keyDown(end, { key: 'Enter' });
    expect(onCommit).not.toHaveBeenCalled();
    fireEvent.change(end, { target: { value: '2026-10-20' } });
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    fireEvent.keyDown(end, { key: 'Enter' });
    expect(onCommit).toHaveBeenLastCalledWith('2026-10-12/2026-10-20');
  });

  it('edits wall times in the viewer zone and keeps an untouched part exact', () => {
    const start = '2026-10-12T16:00:00.832699Z';
    const { onChange } = renderCell(timeRange, `${start}/2026-10-12T17:30:00.000000Z`);
    const startInput = screen.getByLabelText('Start');
    const endInput = screen.getByLabelText('End');
    expect(startInput).toHaveAttribute('data-type', 'datetime-local');
    expect(endInput).toHaveAttribute('data-type', 'datetime-local');
    expectDateField(startInput, toDateTimeInput(start), /:00 [AP]M$/);
    expect(toDateTimeInput(start)).toMatch(/:00\.832$/);
    expectDateField(endInput, toDateTimeInput('2026-10-12T17:30:00.000000Z'), /\d [AP]M$/);
    const nextEnd = toDateTimeInput('2026-10-12T19:00:00.000000Z');
    fireEvent.change(endInput, { target: { value: nextEnd } });
    expect(onChange).toHaveBeenLastCalledWith(
      `${start}/${tableDateTimeToUtc(nextEnd, userTimeZone())}`
    );
    fireEvent.change(endInput, { target: { value: toDateTimeInput(start) } });
    expect(screen.getByRole('alert')).toHaveTextContent('The end is before the start.');
  });

  it('moves Start to End with Tab, commits on Enter and cancels on Escape', async () => {
    const user = userEvent.setup();
    const { onCommit, onCancel } = renderCell(dateRange, '2026-10-12/2026-10-15', {
      autoFocus: true,
    });
    expect(screen.getByLabelText('Start')).toHaveFocus();
    await user.tab();
    const end = screen.getByLabelText('End');
    expect(end).toHaveFocus();
    fireEvent.change(end, { target: { value: '2026-10-16' } });
    fireEvent.keyDown(end, { key: 'Enter' });
    expect(onCommit).toHaveBeenLastCalledWith('2026-10-12/2026-10-16');
    fireEvent.keyDown(end, { key: 'Escape' });
    expect(onCancel).toHaveBeenCalledOnce();
  });

  it('blocks range edits while busy', () => {
    const { onChange, onCommit } = renderCell(dateRange, '2026-10-12/2026-10-15', { busy: true });
    const end = screen.getByLabelText('End');
    expect(end).toHaveAttribute('readonly');
    expect(screen.getByLabelText('Start')).toHaveAttribute('readonly');
    fireEvent.change(end, { target: { value: '2026-10-20' } });
    fireEvent.keyDown(end, { key: 'Enter' });
    expect(onChange).not.toHaveBeenCalled();
    expect(onCommit).not.toHaveBeenCalled();
  });
});

describe('EntryCellEditor — a repeating date (the date + repeat popover)', () => {
  const ENTRY = '11111111-2222-3333-4444-555555555555';
  const recurrence = {
    statusFieldId: null,
    doneOptionIds: [],
    resetOptionId: null,
  };
  const due = field({ type: 'date', name: 'Due', recurrence });
  const repeat = { tableId: due.tableId, entryId: ENTRY };

  beforeEach(() => {
    vi.spyOn(tablesApi, 'entry').mockResolvedValue({
      entry: {
        id: ENTRY,
        createdAt: '2026-01-01T00:00:00.000Z',
        revision: 'a'.repeat(64),
        values: { [due.id]: '2026-10-12' },
      },
      schemaVersion: 'b'.repeat(64),
      relatedEntries: {},
      relatedItems: {},
    });
    vi.spyOn(tableRepeatsApi, 'get').mockResolvedValue({
      entryId: ENTRY,
      revision: 'a'.repeat(64),
      repeats: {},
      log: [],
    });
  });

  const openPicker = (name: string) => {
    const input = screen.getByRole('combobox', { name });
    fireEvent.click(input);
    return screen.getByRole('dialog', { name: 'Choose date' });
  };

  it('a saved row of a repeating field gets the Repeat row', async () => {
    renderCell(due, '2026-10-12', { repeat });
    const card = openPicker('Due');
    expect(await within(card).findByRole('button', { name: 'Repeat, Never' })).toBeInTheDocument();
    expect(tableRepeatsApi.get).toHaveBeenCalledWith(due.tableId, ENTRY);
  });

  it('no Repeat row when the field doesn’t repeat, or the row isn’t saved yet', () => {
    const { view } = renderCell({ ...due, recurrence: null }, '2026-10-12', { repeat });
    let card = openPicker('Due');
    expect(within(card).queryByRole('button', { name: /^Repeat/ })).toBeNull();
    view.unmount();
    renderCell(due, '2026-10-12');
    card = openPicker('Due');
    expect(within(card).queryByRole('button', { name: /^Repeat/ })).toBeNull();
    expect(tableRepeatsApi.get).not.toHaveBeenCalled();
  });

  it('a range repeats on its start: the Start’s picker has the row, the End’s doesn’t', async () => {
    const trip = { ...due, range: true };
    renderCell(trip, '2026-10-12/2026-10-14', { repeat });
    const start = openPicker('Start');
    expect(await within(start).findByRole('button', { name: 'Repeat, Never' })).toBeInTheDocument();
    fireEvent.keyDown(start, { key: 'Escape' });
    const end = openPicker('End');
    expect(within(end).queryByRole('button', { name: /^Repeat/ })).toBeNull();
  });
});
