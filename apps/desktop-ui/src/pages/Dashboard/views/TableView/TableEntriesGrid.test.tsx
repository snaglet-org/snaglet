import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  TableEntry,
  TableEntryValues,
  TableEntriesQuery,
  TableEntriesResponse,
  TableField,
  CreateTableEntryRequest,
  TableEntryResponse,
} from '@snaglet/shared/types';
import { emitTableEvent } from '@desktop/features/database';
import type { ChipEditableInputProps } from '@desktop/features/rich-markdown/editor/ChipEditableInput';
import { FetchError } from '@desktop/utils/api';
import { NODE_CHIP_MIME } from '@desktop/utils/nodeChip';
import { DashboardNavigationProvider } from '@desktop/pages/Dashboard/selection/DashboardNavigationContext';
import { __resetEntryNameCacheForTests } from '@desktop/features/table-entries/entryNameCache';
import { TableEntriesGrid } from './TableEntriesGrid';

vi.mock('@desktop/features/rich-markdown/editor', () => ({
  ChipEditableInput: ({
    value,
    onChange,
    ariaLabel,
    disabled,
    autoFocus,
    onSubmit,
  }: ChipEditableInputProps) => (
    <textarea
      aria-label={ariaLabel}
      value={value}
      disabled={disabled}
      autoFocus={autoFocus}
      onChange={(event) => onChange(event.target.value)}
      onKeyDown={(event) => {
        if (event.key === 'Enter') {
          event.preventDefault();
          onSubmit?.();
        }
      }}
    />
  ),
}));
vi.mock('@desktop/features/rich-markdown/renderer', () => ({
  MarkdownRenderer: ({ content }: { content: string }) => <span>{content}</span>,
}));

const api = vi.hoisted(() => ({
  entries: vi.fn(),
  entry: vi.fn(),
  fields: vi.fn(),
  createEntry: vi.fn(),
  updateEntry: vi.fn(),
  reorderFields: vi.fn(),
  setFieldView: vi.fn(),
  deleteEntries: vi.fn(),
  searchEntries: vi.fn(),
  resolveEntries: vi.fn(),
}));
vi.mock('@desktop/utils/api', async () => {
  const core =
    await vi.importActual<typeof import('@desktop/utils/api/core')>('@desktop/utils/api/core');
  return { tablesApi: api, FetchError: core.FetchError };
});

const repeatsApi = vi.hoisted(() => ({ list: vi.fn(), get: vi.fn(), move: vi.fn() }));
vi.mock('@desktop/utils/api/tableRepeats', async () => {
  const actual = await vi.importActual<typeof import('@desktop/utils/api/tableRepeats')>(
    '@desktop/utils/api/tableRepeats'
  );
  return { ...actual, tableRepeatsApi: repeatsApi };
});

const tableId = 'table-1111111111111-aaaaaaaaa';
const schemaVersion = 'a'.repeat(64);
const title: TableField = {
  range: false,
  id: 'field-1111111111111-aaaaaaaaa',
  tableId,
  name: 'Title',
  columnName: 'f_aaaaaaaaaaaaaaaaaaaaaaaa',
  description: null,
  type: 'text',
  nullable: false,
  defaultValue: null,
  referenceTableId: null,
  referenceKind: null,
  revision: 1,
  managed: false,
  position: 2,
  collapsed: false,
  isTitle: false,
  multiple: false,
  options: null,
};
const amount: TableField = {
  ...title,
  id: 'field-1111111111111-bbbbbbbbb',
  name: 'Amount',
  columnName: 'f_bbbbbbbbbbbbbbbbbbbbbbbb',
  type: 'number',
  defaultValue: '0',
  position: 3,
};
const managed: TableField = {
  ...title,
  id: 'field-managed-id',
  name: 'id',
  columnName: 'id',
  type: 'uuid',
  managed: true,
  position: 0,
};
const fields = [managed, title, amount];
/** The schema the mocked server reports; tests may swap in optional fields. */
let schema: TableField[];
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
function entry(n: number, values: TableEntryValues = {}): TableEntry {
  return {
    id: id(n),
    createdAt: '2026-01-01T00:00:00.000000Z',
    revision: 'b'.repeat(64),
    values: { [managed.id]: id(n), [title.id]: `Entry ${n}`, [amount.id]: '10.00', ...values },
  };
}
let rows: TableEntry[];
function response(query: TableEntriesQuery = {}): TableEntriesResponse {
  const pageSize = query.pageSize ?? 25;
  const page = query.focusEntryId
    ? Math.floor(rows.findIndex((row) => row.id === query.focusEntryId) / pageSize) + 1
    : (query.page ?? 1);
  return {
    entries: rows.slice((page - 1) * pageSize, page * pageSize),
    fields: schema,
    totalCount: rows.length,
    page,
    pageSize,
    schemaVersion,
    relatedEntries: {},
    relatedItems: {},
  };
}
function setup(props: Partial<React.ComponentProps<typeof TableEntriesGrid>> = {}) {
  return render(<TableEntriesGrid tableId={tableId} columns={[]} fields={schema} {...props} />);
}
async function ready() {
  await waitFor(() => expect(screen.getByRole('button', { name: 'Refresh' })).toBeEnabled());
}
function toolbarButton(name: string) {
  return within(screen.getByRole('toolbar', { name: 'Table actions' })).getByRole('button', {
    name,
  });
}

beforeEach(() => {
  vi.resetAllMocks();
  __resetEntryNameCacheForTests();
  localStorage.clear();
  rows = [entry(1), entry(2)];
  schema = fields;
  api.entries.mockImplementation((_id: string, query: TableEntriesQuery) =>
    Promise.resolve(response(query))
  );
  api.entry.mockImplementation((_id: string, entryId: string) =>
    Promise.resolve({ entry: rows.find((row) => row.id === entryId), schemaVersion })
  );
  api.fields.mockImplementation(() => Promise.resolve({ fields: schema }));
  api.setFieldView.mockImplementation(
    (_id: string, fieldId: string, input: { collapsed: boolean }) => {
      schema = schema.map((field) => (field.id === fieldId ? { ...field, ...input } : field));
      return Promise.resolve({ field: schema.find((field) => field.id === fieldId) });
    }
  );
  api.deleteEntries.mockImplementation((_id: string, input: { entryIds: string[] }) => {
    rows = rows.filter((row) => !input.entryIds.includes(row.id));
    return Promise.resolve({
      deletedIds: input.entryIds,
      alreadyDeleted: [],
      clearedReferences: [],
    });
  });
  api.reorderFields.mockImplementation((_id: string, input: { fieldIds: string[] }) => {
    schema = input.fieldIds.map((fieldId, position) => {
      const field = schema.find((item) => item.id === fieldId);
      if (!field) throw new Error('Missing fixture');
      return { ...field, position };
    });
    return Promise.resolve({ fields: schema });
  });
  api.createEntry.mockImplementation(
    (_id: string, input: { id: string; values: TableEntryValues; beforeEntryId?: string }) => {
      const saved = { ...entry(3, { ...input.values, [managed.id]: input.id }), id: input.id };
      const before = rows.findIndex((row) => row.id === input.beforeEntryId);
      rows.splice(before >= 0 ? before : rows.length, 0, saved);
      return Promise.resolve({ entry: saved, schemaVersion });
    }
  );
  api.updateEntry.mockImplementation(
    (_id: string, entryId: string, input: { values: TableEntryValues }) => {
      const original = rows.find((row) => row.id === entryId);
      if (!original) throw new Error('Missing fixture');
      const saved = {
        ...original,
        values: { ...original.values, ...input.values },
        revision: 'c'.repeat(64),
      };
      rows = rows.map((row) => (row.id === entryId ? saved : row));
      return Promise.resolve({ entry: saved, schemaVersion });
    }
  );
});

describe('repeating dates', () => {
  it('a repeating row reads as its repeat, marked overdue; others keep their date', async () => {
    const due: TableField = {
      ...title,
      id: 'field-1111111111111-ccccccccc',
      name: 'Due',
      columnName: 'f_cccccccccccccccccccccccc',
      type: 'date',
      position: 4,
      recurrence: { statusFieldId: null, doneOptionIds: [], resetOptionId: null },
    };
    schema = [...fields, due];
    rows = [entry(1, { [due.id]: '2020-01-06' }), entry(2, { [due.id]: '2020-01-08' })];
    repeatsApi.list.mockResolvedValue({
      tableId,
      rows: [
        {
          fieldId: due.id,
          entryId: id(1),
          repeat: {
            rrule: 'FREQ=WEEKLY;BYDAY=MO',
            dtstart: '2020-01-06',
            current: '2020-01-06',
            tz: 'UTC',
          },
          log: [],
        },
      ],
    });
    setup();
    await ready();
    const text = await screen.findByText('Mon Jan 6');
    expect(text).toHaveAttribute('data-overdue', 'true');
    expect(repeatsApi.list).toHaveBeenCalledWith(tableId);
    // Just the date: a repeating cell has no repeat button of its own.
    expect(screen.queryByRole('button', { name: 'Repeat Due' })).toBeNull();
  });
});

describe('the date + repeat popover in a cell', () => {
  const due: TableField = {
    ...title,
    id: 'field-1111111111111-ccccccccc',
    name: 'Due',
    columnName: 'f_cccccccccccccccccccccccc',
    type: 'date',
    position: 4,
    recurrence: { statusFieldId: null, doneOptionIds: [], resetOptionId: null },
  };
  const weekly = {
    rrule: 'FREQ=WEEKLY;BYDAY=MO',
    dtstart: '2026-10-12',
    current: '2026-10-12',
    tz: 'UTC',
  };

  beforeEach(() => {
    schema = [...fields, due];
    rows = [entry(1, { [due.id]: '2026-10-12' })];
    repeatsApi.list.mockResolvedValue({ tableId, rows: [] });
    repeatsApi.get.mockResolvedValue({
      entryId: id(1),
      revision: 'b'.repeat(64),
      repeats: { [due.id]: weekly },
      log: [],
    });
  });

  it('has no ↻ in the cell: the date popover’s Repeat row opens the Repeat view, one card', async () => {
    const user = userEvent.setup();
    setup();
    await ready();
    expect(screen.queryByRole('button', { name: 'Repeat Due' })).toBeNull();
    await user.click(screen.getByRole('button', { name: /^Edit Due in entry/ }));
    await user.click(await screen.findByRole('combobox', { name: 'Due' }));
    const card = screen.getByRole('dialog', { name: 'Choose date' });
    await user.click(
      await within(card).findByRole('button', { name: 'Repeat, Every week on Monday' })
    );
    const choices = await screen.findByRole('radiogroup', { name: 'How it repeats' });
    expect(within(choices).getByRole('radio', { name: 'Every week on Monday' })).toHaveAttribute(
      'aria-checked',
      'true'
    );
    expect(screen.getAllByRole('dialog', { name: 'Choose date' })).toHaveLength(1);
    expect(card).toContainElement(choices);
    await user.click(within(card).getByRole('button', { name: 'Back to the date' }));
    expect(within(card).getByRole('grid')).toBeInTheDocument();
    expect(
      within(card).getByRole('button', { name: 'Repeat, Every week on Monday' })
    ).toBeInTheDocument();
    expect(api.updateEntry).not.toHaveBeenCalled();
  });

  it('a repeating row whose date is empty edits or stops its repeat from the date popover', async () => {
    // Cleared (Clear keeps the repeat), or written empty by an agent or a tool.
    rows = [entry(1, { [due.id]: null }), entry(2, { [due.id]: null })];
    repeatsApi.list.mockResolvedValue({
      tableId,
      rows: [{ fieldId: due.id, entryId: id(1), repeat: weekly, log: [] }],
    });
    const user = userEvent.setup();
    setup();
    await ready();
    await waitFor(() => expect(repeatsApi.list).toHaveBeenCalledWith(tableId));
    expect(screen.queryByRole('button', { name: 'Repeat Due' })).toBeNull();
    const [firstDue] = screen.getAllByRole('button', { name: /^Edit Due in entry/ });
    await user.click(firstDue!);
    await user.click(await screen.findByRole('combobox', { name: 'Due' }));
    await user.click(
      await within(screen.getByRole('dialog', { name: 'Choose date' })).findByRole('button', {
        name: 'Repeat, Every week on Monday',
      })
    );
    const choices = await screen.findByRole('radiogroup', { name: 'How it repeats' });
    expect(within(choices).getByRole('radio', { name: 'Every week on Monday' })).toHaveAttribute(
      'aria-checked',
      'true'
    );
    await user.click(screen.getByRole('button', { name: 'Back to the date' }));
    const card = screen.getByRole('dialog', { name: 'Choose date' });
    expect(
      within(card).getByRole('button', { name: 'Repeat, Every week on Monday' })
    ).toBeInTheDocument();
    expect(api.updateEntry).not.toHaveBeenCalled();
  });

  it('moving a repeating date asks; Just this one moves it and the row writes no PATCH', async () => {
    const moved = {
      ...rows[0]!,
      revision: 'c'.repeat(64),
      values: { ...rows[0]!.values, [due.id]: '2026-10-14' },
    };
    repeatsApi.move.mockResolvedValue({
      entry: moved,
      schemaVersion,
      relatedEntries: {},
      relatedItems: {},
      fieldId: due.id,
      repeat: weekly,
      logged: [],
      removed: [],
      changed: true,
    });
    const user = userEvent.setup();
    setup();
    await ready();
    await user.click(screen.getByRole('button', { name: /^Edit Due in entry/ }));
    const input = await screen.findByRole('combobox', { name: 'Due' });
    await user.click(input);
    const card = screen.getByRole('dialog', { name: 'Choose date' });
    await within(card).findByRole('button', { name: 'Repeat, Every week on Monday' });
    fireEvent.click(within(card).getByRole('gridcell', { name: /October 14/ }));
    await user.click(within(card).getByRole('button', { name: 'Just this one' }));
    await waitFor(() =>
      expect(repeatsApi.move).toHaveBeenCalledWith(tableId, id(1), due.id, {
        expectedRevision: 'b'.repeat(64),
        schemaVersion,
        expectedCurrent: '2026-10-12',
        to: '2026-10-14',
      })
    );
    // The editor took the moved row as its base and shows the new day.
    await waitFor(() => expect(input).toHaveAttribute('data-value', '2026-10-14'));
    await user.keyboard('{Escape}');
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('combobox', { name: 'Due' })).toBeNull());
    expect(api.updateEntry).not.toHaveBeenCalled();
  });
});

describe('entry references', () => {
  it('copies the full named entry reference from the title field, not a bare ID', async () => {
    schema = [managed, { ...title, isTitle: true }, amount];
    const user = userEvent.setup();
    setup();
    await ready();
    const write = vi.spyOn(navigator.clipboard, 'writeText');
    await user.click(screen.getByRole('button', { name: 'Copy reference to Entry 1' }));
    expect(write).toHaveBeenCalledWith(`[Entry 1](entry:${tableId}/${id(1)})`);
    expect(screen.queryByRole('textbox', { name: 'Title' })).not.toBeInTheDocument();
  });

  it('opens the referenced page and focuses its row, including a repeat seek without remounting', async () => {
    rows = Array.from({ length: 30 }, (_, index) => entry(index + 1));
    const view = setup({ focusEntryId: id(28), focusRequestId: 1 });
    await waitFor(() => expect(document.activeElement).toHaveAttribute('data-entry-id', id(28)));
    expect(screen.getByRole('status', { name: 'Page 2 of 2' })).toBeInTheDocument();
    const root = view.container.firstChild;
    view.rerender(
      <TableEntriesGrid
        tableId={tableId}
        columns={[]}
        fields={schema}
        focusEntryId={id(2)}
        focusRequestId={2}
      />
    );
    await waitFor(() => expect(document.activeElement).toHaveAttribute('data-entry-id', id(2)));
    expect(view.container.firstChild).toBe(root);
    view.rerender(
      <TableEntriesGrid
        tableId={tableId}
        columns={[]}
        fields={schema}
        focusEntryId={id(2)}
        focusRequestId={3}
      />
    );
    await waitFor(() =>
      expect(
        api.entries.mock.calls.filter(([, query]) => query.focusEntryId === id(2))
      ).toHaveLength(2)
    );
  });

  it('moves the row reference beside the checkbox while Name is hidden', async () => {
    schema = [managed, { ...optionalTitle, isTitle: true, collapsed: true }, amount];
    rows = [entry(1), entry(2, { [title.id]: '' })];
    const user = userEvent.setup();
    setup();
    await ready();
    const selectionCell = (entryId: string) => {
      const row = document.querySelector<HTMLElement>(`[data-entry-id="${entryId}"]`);
      const selection = row?.querySelector('td');
      if (!selection) throw new Error(`Missing row ${entryId}`);
      return selection;
    };
    expect(
      within(selectionCell(id(1))).getByRole('button', { name: 'Copy reference to Entry 1' })
    ).toBeInTheDocument();
    const unnamed = selectionCell(id(2));
    expect(within(unnamed).getByRole('checkbox')).toHaveAccessibleName('Select entry Untitled 2');
    const handle = within(unnamed).getByRole('button', { name: 'Copy reference to Untitled 2' });
    const write = vi.spyOn(navigator.clipboard, 'writeText');
    await user.click(handle);
    // The display label never leaks into the copied or dragged chip.
    expect(write).toHaveBeenCalledWith(`[](entry:${tableId}/${id(2)})`);
    const setData = vi.fn();
    fireEvent.dragStart(handle, { dataTransfer: { setData, setDragImage: vi.fn() } });
    expect(setData).toHaveBeenCalledWith(
      NODE_CHIP_MIME,
      JSON.stringify({ kind: 'entry', id: `${tableId}/${id(2)}`, title: '' })
    );

    await user.click(screen.getByRole('button', { name: 'Hidden fields: 1 hidden field' }));
    await user.click(screen.getByRole('button', { name: 'Show field Title' }));
    await waitFor(() =>
      expect(
        within(selectionCell(id(2))).queryByRole('button', { name: /^Copy reference/ })
      ).not.toBeInTheDocument()
    );
    expect(
      screen.getByRole('button', { name: 'Copy reference to Untitled 2' })
    ).toBeInTheDocument();
  });

  it('opens a linked entry from its relation chip without editing the cell', async () => {
    const related: TableField = {
      ...optionalTitle,
      id: 'field-1111111111111-ccccccccc',
      name: 'Related',
      columnName: 'f_cccccccccccccccccccccccc',
      type: 'relation',
      referenceTableId: tableId,
      position: 4,
    };
    schema = [managed, { ...optionalTitle, isTitle: true }, amount, related];
    rows = [entry(1, { [related.id]: id(2) }), entry(2, { [title.id]: '' })];
    api.entries.mockImplementation((_id: string, query: TableEntriesQuery) =>
      Promise.resolve({
        ...response(query),
        relatedEntries: { [tableId]: { [id(2)]: { name: '' } } },
        relatedItems: {},
      })
    );
    api.searchEntries.mockResolvedValue({ results: [], hasMore: false });
    const openTableEntry = vi.fn();
    const user = userEvent.setup();
    render(
      <DashboardNavigationProvider
        value={{
          openInPane: vi.fn(),
          openThreadAgent: vi.fn(),
          requestReveal: vi.fn(),
          openTableEntry,
        }}
      >
        <TableEntriesGrid tableId={tableId} columns={[]} fields={schema} />
      </DashboardNavigationProvider>
    );
    await ready();
    const row = document.querySelector<HTMLElement>(`[data-entry-id="${id(1)}"]`);
    if (!row) throw new Error('Missing row');
    const chip = within(row).getByRole('link');
    // The linked entry is unnamed, so its chip reads by its row number.
    await waitFor(() => expect(chip).toHaveTextContent('Untitled 2'));
    expect(api.entries.mock.calls.every(([, query]) => query.pageSize !== 1)).toBe(true);

    await user.click(chip);
    expect(openTableEntry).toHaveBeenCalledWith(tableId, id(2));
    chip.focus();
    await user.keyboard('{Enter}');
    expect(openTableEntry).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument();

    const edit = cell('Related', id(1));
    edit.focus();
    await user.keyboard('{Enter}');
    expect(await screen.findByRole('combobox', { name: 'Search Related' })).toBeInTheDocument();
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('combobox')).not.toBeInTheDocument());
    const chipList = within(row).getByRole('link').parentElement;
    if (!chipList) throw new Error('Missing chip list');
    await user.click(chipList);
    expect(await screen.findByRole('combobox', { name: 'Search Related' })).toBeInTheDocument();
    expect(openTableEntry).toHaveBeenCalledTimes(2);
  });

  it('flushes a pending edit before seeking another row in the same table', async () => {
    const view = setup();
    await ready();
    await userEvent.click(screen.getByRole('button', { name: 'Edit Title in entry Entry 1' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Title' }), {
      target: { value: 'Saved before seek' },
    });
    view.rerender(
      <TableEntriesGrid
        tableId={tableId}
        columns={[]}
        fields={schema}
        focusEntryId={id(2)}
        focusRequestId={1}
      />
    );
    await waitFor(() => expect(document.activeElement).toHaveAttribute('data-entry-id', id(2)));
    expect(api.updateEntry).toHaveBeenCalledWith(
      tableId,
      id(1),
      expect.objectContaining({ values: { [title.id]: 'Saved before seek' } })
    );
    expect(screen.queryByRole('textbox', { name: 'Title' })).not.toBeInTheDocument();
  });

  it('keeps an invalid edit in place rather than losing it during a seek', async () => {
    const view = setup();
    await ready();
    await userEvent.click(screen.getByRole('button', { name: 'Edit Amount in entry Entry 1' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Amount' }), {
      target: { value: 'not a number' },
    });
    view.rerender(
      <TableEntriesGrid
        tableId={tableId}
        columns={[]}
        fields={schema}
        focusEntryId={id(2)}
        focusRequestId={1}
      />
    );
    expect(
      await screen.findByText('Save or discard this edit before opening the linked entry.')
    ).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'Amount' })).toHaveValue('not a number');
    expect(api.entries.mock.calls.some(([, query]) => query.focusEntryId)).toBe(false);
  });

  it('keeps the old page visible but blocks new edits while an entry seek is pending', async () => {
    const view = setup();
    await ready();
    let complete: ((value: TableEntriesResponse) => void) | undefined;
    api.entries.mockImplementationOnce(
      () =>
        new Promise<TableEntriesResponse>((resolve) => {
          complete = resolve;
        })
    );
    view.rerender(
      <TableEntriesGrid
        tableId={tableId}
        columns={[]}
        fields={schema}
        focusEntryId={id(2)}
        focusRequestId={1}
      />
    );
    const editFirst = screen.getByRole('button', { name: 'Edit Title in entry Entry 1' });
    await waitFor(() => expect(editFirst).toBeDisabled());
    await userEvent.click(editFirst);
    expect(screen.queryByRole('textbox', { name: 'Title' })).not.toBeInTheDocument();
    await act(async () => complete?.(response()));
    await waitFor(() => expect(editFirst).toBeEnabled());
  });
});

const optionalTitle: TableField = { ...title, nullable: true };

function cell(name: string, entryId: string) {
  const row = document.querySelector<HTMLElement>(`[data-entry-id="${entryId}"]`);
  if (!row) throw new Error(`Missing row ${entryId}`);
  return within(row).getByRole('button', { name: new RegExp(`^Edit ${name} in entry `) });
}

describe('TableEntriesGrid direct editing and autosave', () => {
  it('labels unnamed rows by their row number across selection, insertion and cell buttons', async () => {
    schema = [managed, { ...optionalTitle, isTitle: true }, amount];
    rows = [
      { ...entry(1, { [title.id]: null }), id: '11111111-0000-4000-8000-000000000001' },
      { ...entry(2, { [title.id]: '' }), id: '22222222-0000-4000-8000-000000000002' },
      entry(3),
    ];
    setup();
    await ready();

    for (const position of [1, 2]) {
      expect(
        screen.getByRole('checkbox', { name: `Select entry Untitled ${position}` })
      ).toBeEnabled();
      expect(
        screen.getByRole('button', { name: `Insert a row above Untitled ${position}` })
      ).toBeEnabled();
      expect(
        screen.getByRole('button', { name: `Edit Title in entry Untitled ${position}` })
      ).toHaveTextContent(`Untitled ${position}`);
    }
    expect(screen.getByRole('button', { name: 'Edit Title in entry Entry 3' })).toBeEnabled();
    expect(
      screen.queryByRole('checkbox', { name: 'Select entry Untitled' })
    ).not.toBeInTheDocument();
  });

  it('numbers an unnamed row by its place in the whole table, not on its page', async () => {
    schema = [managed, { ...optionalTitle, isTitle: true }, amount];
    rows = Array.from({ length: 30 }, (_, index) =>
      entry(index + 1, index === 27 ? { [title.id]: '' } : {})
    );
    setup({ focusEntryId: id(28), focusRequestId: 1 });
    expect(
      await screen.findByRole('button', { name: 'Edit Title in entry Untitled 28' })
    ).toHaveTextContent('Untitled 28');
    expect(screen.getByRole('status', { name: 'Page 2 of 2' })).toBeInTheDocument();
  });

  it('shows system fields with presentation controls and keeps their cells read-only', async () => {
    setup();
    await ready();
    expect(screen.getByRole('button', { name: 'Hide field id' }).closest('th')).toHaveAttribute(
      'aria-description',
      'UUID · Managed by Snaglet'
    );
    expect(screen.getAllByTitle(id(1)).find((node) => node.tagName === 'BUTTON')).toHaveTextContent(
      id(1).slice(0, 8)
    );
    expect(screen.queryByRole('button', { name: /system fields/i })).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Edit id in entry Entry 1' })
    ).not.toBeInTheDocument();
  });

  it('holds a new row with an empty required field until it has a value, then autosaves it', async () => {
    setup();
    await ready();
    await userEvent.click(screen.getByRole('button', { name: `Insert a row above Entry 1` }));
    const input = screen.getByRole('textbox', { name: 'Title' });
    expect(input).toHaveFocus();
    expect(api.createEntry).not.toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: /save entry/i })).not.toBeInTheDocument();
    fireEvent.change(input, { target: { value: 'Autosaved row' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(api.createEntry).toHaveBeenCalledOnce());
    // New row inserts at the top of the page.
    expect(api.createEntry).toHaveBeenCalledWith(tableId, {
      id: expect.stringMatching(/^[a-f\d-]{36}$/),
      schemaVersion,
      values: { [title.id]: 'Autosaved row', [amount.id]: '0' },
      beforeEntryId: id(1),
    });
    expect(await screen.findByText('Saved')).toBeInTheDocument();
    expect(screen.queryByRole('textbox', { name: 'Title' })).not.toBeInTheDocument();
  });

  it('keeps an invalid new row open with validation beside the cell', async () => {
    setup();
    await ready();
    await userEvent.click(screen.getByRole('button', { name: 'Insert a row at end' }));
    fireEvent.keyDown(screen.getByRole('textbox', { name: 'Title' }), { key: 'Enter' });
    expect(await screen.findByText('Title is required.')).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'Title' })).toBeInTheDocument();
    expect(api.createEntry).not.toHaveBeenCalled();
  });

  it('creates a row from the empty bottom row at once so its system fields show', async () => {
    schema = [managed, optionalTitle, amount];
    rows = [];
    setup();
    await ready();
    expect(screen.queryByText(/no rows yet/i)).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'New entry: Amount' }));
    await waitFor(() => expect(api.createEntry).toHaveBeenCalledOnce());
    const created = api.createEntry.mock.calls[0][1] as { id: string };
    expect(api.createEntry.mock.calls[0][1]).not.toHaveProperty('beforeEntryId');
    // The server-assigned id is on screen while the clicked cell is still open.
    expect(
      (await screen.findAllByTitle(created.id)).find((node) => node.tagName === 'BUTTON')
    ).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'Amount' })).toHaveFocus();
    // The empty row stays below it, ready for the next entry.
    expect(screen.getByRole('button', { name: 'New entry: Title' })).toBeEnabled();
  });

  it('inserts a row above an entry from the + on its corner', async () => {
    schema = [managed, optionalTitle, amount];
    setup();
    await ready();
    await userEvent.click(screen.getByRole('button', { name: `Insert a row above Entry 2` }));
    await waitFor(() => expect(api.createEntry).toHaveBeenCalledOnce());
    expect(api.createEntry).toHaveBeenCalledWith(
      tableId,
      expect.objectContaining({ beforeEntryId: id(2) })
    );
    const created = (api.createEntry.mock.calls[0][1] as { id: string }).id;
    // Row order read from the id column.
    await waitFor(() =>
      expect(
        [...document.querySelectorAll('[data-entry-id]')].map((node) =>
          node.getAttribute('data-entry-id')
        )
      ).toEqual([id(1), created, id(2)])
    );
  });

  it('edits a cell on one click, sends a sparse revision-safe patch, and Enter leaves the cell', async () => {
    setup();
    await ready();
    await userEvent.click(cell('Title', id(1)));
    const input = screen.getByRole('textbox', { name: 'Title' });
    fireEvent.change(input, { target: { value: 'Revised title' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(api.updateEntry).toHaveBeenCalledOnce());
    expect(api.updateEntry).toHaveBeenCalledWith(tableId, id(1), {
      values: { [title.id]: 'Revised title' },
      schemaVersion,
      expectedRevision: 'b'.repeat(64),
    });
    await waitFor(() =>
      expect(screen.queryByRole('textbox', { name: 'Title' })).not.toBeInTheDocument()
    );
    expect(cell('Title', id(1))).toHaveFocus();
    expect(cell('Title', id(1))).toHaveTextContent('Revised title');
  });

  it('keeps other rows and the field controls usable while a cell is open', async () => {
    const onAddField = vi.fn();
    const onEditField = vi.fn();
    setup({ onAddField, onEditField });
    await ready();
    await userEvent.click(cell('Title', id(1)));
    expect(screen.getByRole('button', { name: 'Insert a row at end' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Add field at end' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Edit field Amount' })).toBeEnabled();
    fireEvent.change(screen.getByRole('textbox', { name: 'Title' }), {
      target: { value: 'Moved on' },
    });
    await userEvent.click(cell('Amount', id(2)));
    await waitFor(() =>
      expect(api.updateEntry).toHaveBeenCalledWith(
        tableId,
        id(1),
        expect.objectContaining({ values: { [title.id]: 'Moved on' } })
      )
    );
    expect(await screen.findByRole('textbox', { name: 'Amount' })).toHaveFocus();
  });

  it('queues a newer edit behind an in-flight request instead of losing it', async () => {
    let finishFirst: (value: unknown) => void = () => undefined;
    api.updateEntry.mockReturnValueOnce(
      new Promise((resolve) => {
        finishFirst = resolve;
      })
    );
    setup();
    await ready();
    await userEvent.click(cell('Title', id(1)));
    const input = screen.getByRole('textbox', { name: 'Title' });
    fireEvent.change(input, { target: { value: 'First value' } });
    await waitFor(() => expect(api.updateEntry).toHaveBeenCalledOnce());
    fireEvent.change(input, { target: { value: 'Latest value' } });
    await act(async () => {
      finishFirst({
        entry: {
          ...entry(1),
          revision: 'c'.repeat(64),
          values: { ...entry(1).values, [title.id]: 'First value' },
        },
        schemaVersion,
      });
    });
    await waitFor(() => expect(api.updateEntry).toHaveBeenCalledTimes(2));
    expect(api.updateEntry).toHaveBeenLastCalledWith(
      tableId,
      id(1),
      expect.objectContaining({
        values: { [title.id]: 'Latest value' },
        expectedRevision: 'c'.repeat(64),
      })
    );
    expect(input).toHaveValue('Latest value');
  });

  it('reopens a conflicting cell with the local draft until the user loads the latest row', async () => {
    api.updateEntry.mockRejectedValueOnce(new FetchError('Entry changed elsewhere', 409));
    setup();
    await ready();
    await userEvent.click(cell('Title', id(1)));
    fireEvent.change(screen.getByRole('textbox', { name: 'Title' }), {
      target: { value: 'Local draft' },
    });
    fireEvent.keyDown(screen.getByRole('textbox', { name: 'Title' }), { key: 'Enter' });
    expect(await screen.findByText('Entry changed elsewhere')).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getByRole('textbox', { name: 'Title' })).toHaveValue('Local draft')
    );
    rows[0] = { ...entry(1, { [title.id]: 'Remote title' }), revision: 'd'.repeat(64) };
    await userEvent.click(screen.getByRole('button', { name: 'Load latest row' }));
    await waitFor(() =>
      expect(screen.getByRole('textbox', { name: 'Title' })).toHaveValue('Remote title')
    );
  });

  it('reorders fields from a header and keeps the new order', async () => {
    setup({ onEditField: vi.fn() });
    await ready();
    const headers = () =>
      screen
        .getAllByRole('columnheader')
        .map((header) => header.getAttribute('data-column'))
        .filter(Boolean);
    expect(headers()).toEqual(['id', title.columnName, amount.columnName]);
    fireEvent.keyDown(screen.getByRole('button', { name: 'Edit field Title' }), {
      key: 'ArrowLeft',
      altKey: true,
    });
    expect(headers()).toEqual([title.columnName, 'id', amount.columnName]);
    await waitFor(() =>
      expect(api.reorderFields).toHaveBeenCalledWith(tableId, {
        fieldIds: [title.id, managed.id, amount.id],
      })
    );
    await waitFor(() => expect(headers()).toEqual([title.columnName, 'id', amount.columnName]));
  });

  it('reorders the shown columns around a hidden one, which keeps its slot', async () => {
    schema = fields.map((field) => ({ ...field, collapsed: field.id === title.id }));
    setup({ onEditField: vi.fn() });
    await ready();
    fireEvent.keyDown(screen.getByRole('button', { name: 'Edit field Amount' }), {
      key: 'ArrowLeft',
      altKey: true,
    });
    // Shown: id, Amount → Amount, id. Hidden Title stays second.
    await waitFor(() =>
      expect(api.reorderFields).toHaveBeenCalledWith(tableId, {
        fieldIds: [amount.id, title.id, managed.id],
      })
    );
  });

  it('restores the saved column order when a reorder fails', async () => {
    api.reorderFields.mockRejectedValueOnce(new FetchError('Fields changed elsewhere', 409));
    setup({ onEditField: vi.fn() });
    await ready();
    fireEvent.keyDown(screen.getByRole('button', { name: 'Edit field Amount' }), {
      key: 'ArrowLeft',
      altKey: true,
    });
    expect(await screen.findByText('Fields changed elsewhere')).toBeInTheDocument();
    expect(
      screen
        .getAllByRole('columnheader')
        .map((header) => header.getAttribute('data-column'))
        .filter(Boolean)
    ).toEqual(['id', title.columnName, amount.columnName]);
  });

  it('keeps pagination and refresh controls working around the inline editor', async () => {
    rows = Array.from({ length: 26 }, (_, index) => entry(index + 1));
    const onRefreshFields = vi.fn();
    setup({ onRefreshFields });
    await ready();
    expect(screen.getByText('1–25 of 26')).toBeInTheDocument();
    // The empty add row lives on the last page only.
    expect(screen.queryByRole('button', { name: 'New entry: Title' })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Next page' }));
    expect(await screen.findByText('Entry 26')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'New entry: Title' })).toBeInTheDocument();
    const calls = api.entries.mock.calls.length;
    await userEvent.click(toolbarButton('Refresh'));
    expect(onRefreshFields).toHaveBeenCalledOnce();
    await waitFor(() => expect(api.entries.mock.calls.length).toBeGreaterThan(calls));
  });

  it('ignores realtime events for other tables', async () => {
    setup();
    await ready();
    act(() =>
      emitTableEvent({ type: 'table.entries.changed', tableId: 'table-other', entryId: id(1) })
    );
    expect(api.entries).toHaveBeenCalledOnce();
  });

  it('pins pagination in a bar at the bottom, not the toolbar, and keeps field creation on the header boundary', async () => {
    const onAddField = vi.fn();
    setup({ onAddField });
    await ready();
    const toolbar = screen.getByRole('toolbar', { name: 'Table actions' });
    // The pager is the grid's last child, a bar that stays at the bottom while rows scroll.
    expect(
      within(toolbar).queryByRole('group', { name: 'Entry pagination' })
    ).not.toBeInTheDocument();
    const grid = toolbar.closest('[data-table-entries-grid]')!;
    const bar = grid.querySelector<HTMLElement>('[data-table-pager-bar]')!;
    expect(bar).not.toBeNull();
    expect(grid.lastElementChild).toBe(bar);
    expect(within(bar).getByRole('group', { name: 'Entry pagination' })).toBeInTheDocument();
    expect(
      within(toolbar).queryByRole('combobox', { name: 'Rows per page' })
    ).not.toBeInTheDocument();
    expect(
      within(toolbar).queryByRole('button', { name: /New row|Add field/ })
    ).not.toBeInTheDocument();
    expect(screen.queryByText('+ New')).not.toBeInTheDocument();
    const insert = screen.getByRole('button', { name: 'Insert field before Title' });
    await userEvent.click(insert);
    expect(onAddField).toHaveBeenCalledWith(insert, title.id);
  });

  it('selects displayed saved rows with a mixed select-all state and clears on page changes', async () => {
    rows = Array.from({ length: 26 }, (_, index) => entry(index + 1));
    setup();
    await ready();
    const all = screen.getByRole('checkbox', { name: 'Select all displayed entries' });
    await userEvent.click(screen.getByRole('checkbox', { name: `Select entry Entry 1` }));
    expect(all).toBePartiallyChecked();
    expect(screen.getByText('1 selected')).toBeInTheDocument();
    await userEvent.click(all);
    expect(all).toBeChecked();
    expect(screen.getByText('25 selected')).toBeInTheDocument();
    expect(screen.getAllByRole('checkbox', { checked: true })).toHaveLength(26);
    expect(api.updateEntry).not.toHaveBeenCalled();

    await userEvent.click(screen.getByRole('button', { name: 'Next page' }));
    expect(await screen.findByText('Entry 26')).toBeInTheDocument();
    expect(all).not.toBeChecked();
    expect(all).not.toBePartiallyChecked();
    expect(screen.queryByText(/selected$/)).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Previous page' }));
    expect(await screen.findByText('Entry 1')).toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: `Select entry Entry 1` })).not.toBeChecked();
  });

  it('does not select an unsaved required draft and appends from the explicit end control', async () => {
    setup();
    await ready();
    await userEvent.click(screen.getByRole('button', { name: 'Insert a row at end' }));
    expect(
      within(screen.getByRole('row', { name: 'New entry' })).queryByRole('checkbox')
    ).not.toBeInTheDocument();
    fireEvent.change(screen.getByRole('textbox', { name: 'Title' }), {
      target: { value: 'Appended' },
    });
    fireEvent.keyDown(screen.getByRole('textbox', { name: 'Title' }), { key: 'Enter' });
    await waitFor(() => expect(api.createEntry).toHaveBeenCalledOnce());
    expect(api.createEntry.mock.calls[0][1]).not.toHaveProperty('beforeEntryId');
  });

  it('supports first-row and keyboard boundary insertion without a toolbar button', async () => {
    schema = [managed, optionalTitle, amount];
    rows = [];
    setup();
    await ready();
    const first = screen.getByRole('button', { name: 'Insert first row' });
    first.focus();
    await userEvent.keyboard('{Enter}');
    await waitFor(() => expect(api.createEntry).toHaveBeenCalledOnce());
    const firstId = (api.createEntry.mock.calls[0][1] as { id: string }).id;
    fireEvent.keyDown(screen.getByLabelText('Table entries'), {
      key: 'N',
      ctrlKey: true,
      shiftKey: true,
    });
    await waitFor(() => expect(api.createEntry).toHaveBeenCalledTimes(2));
    expect(api.createEntry).toHaveBeenLastCalledWith(
      tableId,
      expect.objectContaining({ beforeEntryId: firstId })
    );
  });

  it('hides a column from its header and shows it again from the toolbar, touching no entry', async () => {
    const user = userEvent.setup();
    setup();
    await ready();
    const before = rows.map((row) => row.values);
    expect(screen.queryByRole('button', { name: /^Hidden fields/ })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Hide field Amount' }));
    expect(api.setFieldView).toHaveBeenCalledWith(tableId, amount.id, { collapsed: true });
    // The column leaves the grid entirely: no header, no strip, no cells.
    await waitFor(() =>
      expect(screen.queryByRole('columnheader', { name: 'Amount' })).not.toBeInTheDocument()
    );
    expect(document.querySelector(`[data-column="${amount.columnName}"]`)).toBeNull();
    const menu = screen.getByRole('button', { name: 'Hidden fields: 1 hidden field' });
    await user.click(menu);
    const panel = screen.getByRole('dialog', { name: 'Hidden fields' });
    expect(within(panel).getByText('Amount')).toBeInTheDocument();
    await user.click(within(panel).getByRole('button', { name: 'Show field Amount' }));
    expect(api.setFieldView).toHaveBeenLastCalledWith(tableId, amount.id, { collapsed: false });
    expect(await screen.findByRole('columnheader', { name: 'Amount' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Hidden fields/ })).not.toBeInTheDocument();
    expect(rows.map((row) => row.values)).toEqual(before);
    expect(api.updateEntry).not.toHaveBeenCalled();
    expect(api.createEntry).not.toHaveBeenCalled();
  });

  it('hides a managed column and shows several again with Show all', async () => {
    const user = userEvent.setup();
    schema = fields.map((field) => ({ ...field, collapsed: field.id !== title.id }));
    setup();
    await ready();
    expect(screen.queryByText(id(1))).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Hide field Title' })).toHaveAttribute(
      'aria-disabled',
      'true'
    );
    await user.click(screen.getByRole('button', { name: 'Hidden fields: 2 hidden fields' }));
    await user.click(screen.getByRole('button', { name: 'Show all' }));
    await waitFor(() =>
      expect(api.setFieldView).toHaveBeenCalledWith(tableId, managed.id, { collapsed: false })
    );
    expect(api.setFieldView).toHaveBeenCalledWith(tableId, amount.id, { collapsed: false });
    expect(await screen.findByRole('columnheader', { name: 'Amount' })).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: 'id' })).toBeInTheDocument();
  });

  it('restores a failed hide and keeps all entry values intact', async () => {
    api.setFieldView.mockRejectedValueOnce(new Error('View unavailable'));
    setup();
    await ready();
    await userEvent.click(screen.getByRole('button', { name: 'Hide field Title' }));
    expect(await screen.findByText('View unavailable')).toBeInTheDocument();
    expect(cell('Title', id(1))).toHaveTextContent('Entry 1');
    expect(api.updateEntry).not.toHaveBeenCalled();
    expect(api.createEntry).not.toHaveBeenCalled();
  });

  it('saves and closes a valid active draft before hiding its column', async () => {
    setup();
    await ready();
    await userEvent.click(cell('Title', id(1)));
    fireEvent.change(screen.getByRole('textbox', { name: 'Title' }), {
      target: { value: 'Saved before hiding' },
    });
    // Direct activation has no pointerdown/blur side effect to close the cell.
    fireEvent.click(screen.getByRole('button', { name: 'Hide field Title' }));
    await waitFor(() =>
      expect(api.setFieldView).toHaveBeenCalledWith(tableId, title.id, { collapsed: true })
    );
    expect(screen.queryByRole('textbox', { name: 'Title' })).not.toBeInTheDocument();
    expect(rows[0].values[title.id]).toBe('Saved before hiding');
  });

  it('keeps a required invalid editor instead of hiding its recovery path', async () => {
    setup();
    await ready();
    await userEvent.click(screen.getByRole('button', { name: 'Insert a row at end' }));
    await userEvent.click(screen.getByRole('button', { name: 'Hide field Title' }));
    expect(await screen.findByText('Title is required.')).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'Title' })).toHaveValue('');
    expect(screen.getByRole('button', { name: 'Hide field Title' })).toBeInTheDocument();
    expect(api.setFieldView).not.toHaveBeenCalled();
    expect(api.updateEntry).not.toHaveBeenCalled();
  });

  it('shows an editable field before inserting when all editable fields are hidden', async () => {
    schema = fields.map((field) => ({ ...field, collapsed: !field.managed }));
    setup();
    await ready();
    await userEvent.click(screen.getByRole('button', { name: 'Insert a row at end' }));
    expect(await screen.findByRole('textbox', { name: 'Title' })).toHaveFocus();
    expect(api.setFieldView).toHaveBeenCalledWith(tableId, title.id, { collapsed: false });
    expect(api.createEntry).not.toHaveBeenCalled();
    fireEvent.change(screen.getByRole('textbox', { name: 'Title' }), {
      target: { value: 'Visible required field' },
    });
    fireEvent.keyDown(screen.getByRole('textbox', { name: 'Title' }), { key: 'Enter' });
    await waitFor(() => expect(api.createEntry).toHaveBeenCalledOnce());
  });

  it('reveals a hidden required field when another field cannot complete a new row', async () => {
    schema = fields.map((field) => ({ ...field, collapsed: field.id === title.id }));
    setup();
    await ready();
    await userEvent.click(screen.getByRole('button', { name: 'Insert a row at end' }));
    fireEvent.keyDown(await screen.findByRole('textbox', { name: 'Amount' }), { key: 'Enter' });
    expect(await screen.findByRole('textbox', { name: 'Title' })).toHaveFocus();
    expect(screen.getByText('Title is required.')).toBeInTheDocument();
    expect(api.createEntry).not.toHaveBeenCalled();
  });

  it('does not open a hidden draft when showing the required field fails', async () => {
    schema = fields.map((field) => ({ ...field, collapsed: !field.managed }));
    api.setFieldView.mockRejectedValueOnce(new Error('Could not expand'));
    setup();
    await ready();
    await userEvent.click(screen.getByRole('button', { name: 'Insert a row at end' }));
    expect(await screen.findByText('Could not expand')).toBeInTheDocument();
    expect(screen.queryByRole('row', { name: 'New entry' })).not.toBeInTheDocument();
    expect(api.createEntry).not.toHaveBeenCalled();
  });

  it('deletes only confirmed selected entries and refreshes after success', async () => {
    setup();
    await ready();
    await userEvent.click(screen.getByRole('checkbox', { name: `Select entry Entry 1` }));
    await userEvent.click(toolbarButton('Delete selected'));
    expect(await screen.findByRole('dialog', { name: 'Delete 1 entry?' })).toBeInTheDocument();
    expect(api.deleteEntries).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.getByRole('checkbox', { name: `Select entry Entry 1` })).toBeChecked();
    await userEvent.click(toolbarButton('Delete selected'));
    await userEvent.click(await screen.findByRole('button', { name: 'Delete entries' }));
    expect(api.deleteEntries).toHaveBeenCalledWith(tableId, {
      entryIds: [id(1)],
      expectedRevisions: { [id(1)]: 'b'.repeat(64) },
    });
    await waitFor(() => expect(screen.queryByText('Entry 1')).not.toBeInTheDocument());
    expect(screen.getByText('Entry 2')).toBeInTheDocument();
    expect(screen.queryByText(/selected$/)).not.toBeInTheDocument();
  });

  it('removes confirmed rows immediately and restores stable focus even when reload fails', async () => {
    setup();
    await ready();
    await userEvent.click(screen.getByRole('checkbox', { name: 'Select entry Entry 1' }));
    await userEvent.click(toolbarButton('Delete selected'));
    let rejectReload: (error: Error) => void = () => undefined;
    api.entries.mockImplementation(
      () =>
        new Promise((_resolve, reject) => {
          rejectReload = reject;
        })
    );
    await userEvent.click(await screen.findByRole('button', { name: 'Delete entries' }));
    expect(
      screen.queryByRole('button', { name: 'Edit Title in entry Entry 1' })
    ).not.toBeInTheDocument();
    expect(screen.getByText('1 row')).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getByRole('checkbox', { name: 'Select all displayed entries' })).toHaveFocus()
    );
    await act(async () => rejectReload(new Error('Refresh unavailable')));
    expect(await screen.findByText('Refresh unavailable')).toBeInTheDocument();
    expect(screen.queryByText('Entry 1')).not.toBeInTheDocument();
  });

  it('ignores insertion shortcuts inside the delete dialog and keeps an unrelated invalid draft', async () => {
    setup();
    await ready();
    await userEvent.click(screen.getByRole('checkbox', { name: 'Select entry Entry 1' }));
    await userEvent.click(screen.getByRole('button', { name: 'Insert a row at end' }));
    expect(screen.getByRole('textbox', { name: 'Title' })).toHaveValue('');
    await userEvent.click(toolbarButton('Delete selected'));
    const dialog = await screen.findByRole('dialog');
    expect(screen.getByText('The separate row draft will be kept.')).toBeInTheDocument();
    fireEvent.keyDown(within(dialog).getByRole('button', { name: 'Cancel' }), {
      key: 'N',
      ctrlKey: true,
      shiftKey: true,
    });
    expect(api.createEntry).not.toHaveBeenCalled();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Delete entries' }));
    expect(screen.getByRole('textbox', { name: 'Title' })).toHaveValue('');
    expect(screen.getAllByRole('row', { name: 'New entry' })).toHaveLength(1);
    expect(api.createEntry).not.toHaveBeenCalled();
  });

  it('only offers the blank append row on the last page and clears selection on page-size changes', async () => {
    rows = Array.from({ length: 26 }, (_, index) => entry(index + 1));
    setup();
    await ready();
    expect(screen.queryByRole('button', { name: 'New entry: Title' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Insert a row at end' })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('checkbox', { name: 'Select entry Entry 1' }));
    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Rows per page' }), '50');
    await ready();
    expect(screen.getByRole('checkbox', { name: 'Select entry Entry 1' })).not.toBeChecked();
    expect(screen.getByRole('button', { name: 'New entry: Title' })).toBeInTheDocument();
  });

  it('renders centered two-state checkboxes that autosave by click, Space and Enter without opening a cell', async () => {
    const done = {
      ...title,
      id: 'field-done',
      name: 'Done',
      columnName: 'done',
      type: 'checkbox' as const,
      nullable: true,
    };
    schema = [...fields, done];
    setup();
    await ready();
    const checkbox = screen.getByRole('checkbox', { name: 'Done in Entry 1' });
    expect(checkbox).not.toBeChecked();
    expect(checkbox).not.toBePartiallyChecked();
    await userEvent.click(checkbox);
    await waitFor(() =>
      expect(api.updateEntry).toHaveBeenCalledWith(
        tableId,
        id(1),
        expect.objectContaining({ values: { [done.id]: true } })
      )
    );
    expect(checkbox).toHaveFocus();
    expect(document.querySelector('[data-active-cell]')).toBeNull();
    await userEvent.keyboard(' ');
    await waitFor(() =>
      expect(api.updateEntry).toHaveBeenLastCalledWith(
        tableId,
        id(1),
        expect.objectContaining({ values: { [done.id]: false }, expectedRevision: 'c'.repeat(64) })
      )
    );
    await userEvent.keyboard('{Enter}');
    await waitFor(() => expect(api.updateEntry).toHaveBeenCalledTimes(3));
    expect(checkbox).toBeChecked();
    expect(screen.queryByRole('button', { name: 'Clear' })).not.toBeInTheDocument();
  });

  it('keeps rapid checkbox toggles ordered and reveals required fields for a new checkbox row', async () => {
    const done = {
      ...title,
      id: 'field-done',
      name: 'Done',
      columnName: 'done',
      type: 'checkbox' as const,
      nullable: true,
    };
    schema = [...fields, done];
    setup();
    await ready();
    const checkbox = screen.getByRole('checkbox', { name: 'Done in Entry 1' });
    await act(async () => {
      fireEvent.click(checkbox);
      fireEvent.click(checkbox);
      fireEvent.click(checkbox);
    });
    await waitFor(() => expect(api.updateEntry).toHaveBeenCalledOnce());
    expect(api.updateEntry).toHaveBeenLastCalledWith(
      tableId,
      id(1),
      expect.objectContaining({ values: { [done.id]: true } })
    );
    await userEvent.click(screen.getByRole('checkbox', { name: 'New entry: Done' }));
    expect(await screen.findByRole('textbox', { name: 'Title' })).toHaveFocus();
    expect(screen.getByRole('checkbox', { name: 'Done in New entry' })).toBeChecked();
    expect(api.createEntry).not.toHaveBeenCalled();
  });

  it('hands focus from a valid ghost checkbox to its created row so Space toggles instead of inserting again', async () => {
    const done = {
      ...title,
      id: 'field-done',
      name: 'Done',
      columnName: 'done',
      type: 'checkbox' as const,
      nullable: false,
      defaultValue: false,
    };
    schema = [managed, optionalTitle, amount, done];
    setup();
    await ready();
    await userEvent.click(screen.getByRole('checkbox', { name: 'New entry: Done' }));
    await waitFor(() => expect(api.createEntry).toHaveBeenCalledOnce());
    const newId = api.createEntry.mock.calls[0][1].id;
    const checkbox = await screen.findByRole('checkbox', { name: 'Done in Untitled 3' });
    await waitFor(() => expect(checkbox).toHaveFocus());
    expect(checkbox).toBeChecked();
    await userEvent.keyboard(' ');
    await waitFor(() =>
      expect(api.updateEntry).toHaveBeenCalledWith(
        tableId,
        newId,
        expect.objectContaining({ values: { [done.id]: false } })
      )
    );
    expect(api.createEntry).toHaveBeenCalledOnce();
    expect(checkbox).not.toBeChecked();
  });

  it('flushes a selected draft before freezing the revision for deletion', async () => {
    setup();
    await ready();
    await userEvent.click(screen.getByRole('checkbox', { name: `Select entry Entry 1` }));
    await userEvent.click(cell('Title', id(1)));
    fireEvent.change(screen.getByRole('textbox', { name: 'Title' }), {
      target: { value: 'Latest saved edit' },
    });
    await userEvent.click(toolbarButton('Delete selected'));
    await userEvent.click(await screen.findByRole('button', { name: 'Delete entries' }));
    expect(api.updateEntry).toHaveBeenCalledOnce();
    expect(api.deleteEntries).toHaveBeenCalledWith(tableId, {
      entryIds: [id(1)],
      expectedRevisions: { [id(1)]: 'c'.repeat(64) },
    });
  });

  it('preserves selection and the visible draft when pre-delete saving fails', async () => {
    api.updateEntry.mockRejectedValue(new Error('Save unavailable'));
    setup();
    await ready();
    await userEvent.click(screen.getByRole('checkbox', { name: `Select entry Entry 1` }));
    await userEvent.click(cell('Title', id(1)));
    fireEvent.change(screen.getByRole('textbox', { name: 'Title' }), {
      target: { value: 'Unsaved edit' },
    });
    await userEvent.click(toolbarButton('Delete selected'));
    expect(await screen.findByText('Save unavailable')).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'Title' })).toHaveValue('Unsaved edit');
    expect(screen.getByRole('checkbox', { name: `Select entry Entry 1` })).toBeChecked();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(api.deleteEntries).not.toHaveBeenCalled();
  });

  it('follows the last page when two queued appends cross the page boundary', async () => {
    schema = [managed, optionalTitle, amount];
    rows = Array.from({ length: 24 }, (_, index) => entry(index + 1));
    const pending: Array<{
      input: CreateTableEntryRequest;
      resolve: (result: TableEntryResponse) => void;
    }> = [];
    api.createEntry.mockImplementation(
      (_id: string, input: CreateTableEntryRequest) =>
        new Promise<TableEntryResponse>((resolve) => {
          pending.push({ input, resolve });
        })
    );
    const finish = (index: number) => {
      const { input, resolve } = pending[index];
      const saved = {
        ...entry(25 + index),
        id: input.id,
        values: { ...input.values, [managed.id]: input.id },
      };
      rows.push(saved);
      resolve({ entry: saved, schemaVersion, relatedEntries: {}, relatedItems: {} });
    };
    setup();
    await ready();
    await userEvent.click(screen.getByRole('button', { name: 'Insert a row at end' }));
    await waitFor(() => expect(api.createEntry).toHaveBeenCalledOnce());
    await userEvent.click(screen.getByRole('button', { name: 'Insert a row at end' }));
    expect(api.createEntry).toHaveBeenCalledOnce();
    await act(async () => finish(0));
    await waitFor(() => expect(api.createEntry).toHaveBeenCalledTimes(2));
    await act(async () => finish(1));
    expect(await screen.findByRole('status', { name: 'Page 2 of 2' })).toBeInTheDocument();
    fireEvent.keyDown(screen.getByRole('textbox', { name: 'Title' }), { key: 'Enter' });
    await waitFor(() =>
      expect(screen.queryByRole('textbox', { name: 'Title' })).not.toBeInTheDocument()
    );
    expect(
      (await screen.findAllByTitle(pending[1].input.id)).find((node) => node.tagName === 'BUTTON')
    ).toBeInTheDocument();
    expect(screen.getByText('26–26 of 26')).toBeInTheDocument();
  });
});

describe('column widths', () => {
  const columnCells = (field: TableField) =>
    Array.from(document.querySelectorAll<HTMLElement>(`td[data-column="${field.columnName}"]`));

  it('draws a saved width on the header and every cell; a hidden column draws nothing', async () => {
    schema = [managed, { ...title, width: 240 }, { ...amount, collapsed: true, width: 300 }];
    setup();
    await ready();
    expect(screen.getByRole('columnheader', { name: 'Title' })).toHaveStyle({ width: '240px' });
    // Both rows and the empty row at the end.
    expect(columnCells(title)).toHaveLength(3);
    for (const cell of columnCells(title))
      expect(cell).toHaveStyle({ width: '240px', minWidth: '240px', maxWidth: '240px' });
    expect(screen.queryByRole('columnheader', { name: 'Amount' })).toBeNull();
    expect(columnCells(amount)).toHaveLength(0);
    expect(screen.queryByRole('separator', { name: 'Resize Amount column' })).toBeNull();
  });

  it('draws a dragged width at once and saves it once, touching no entry', async () => {
    const onEditField = vi.fn();
    setup({ onEditField });
    await ready();
    const header = screen.getByRole('columnheader', { name: 'Title' });
    Object.defineProperty(header, 'offsetWidth', { configurable: true, value: 200 });
    const edge = screen.getByRole('separator', { name: 'Resize Title column' });
    fireEvent.pointerDown(edge, { button: 0, clientX: 300, clientY: 10 });
    fireEvent.pointerMove(window, { clientX: 340, clientY: 10 });
    fireEvent.pointerMove(window, { clientX: 360, clientY: 10 });
    fireEvent.pointerUp(window, { clientX: 360, clientY: 10 });
    fireEvent.click(screen.getByRole('button', { name: 'Edit field Title' }));

    expect(header).toHaveStyle({ width: '260px' });
    for (const cell of columnCells(title)) expect(cell).toHaveStyle({ width: '260px' });
    expect(api.setFieldView).not.toHaveBeenCalled();
    await waitFor(() =>
      expect(api.setFieldView).toHaveBeenCalledWith(tableId, title.id, { width: 260 })
    );
    expect(api.setFieldView).toHaveBeenCalledOnce();
    expect(onEditField).not.toHaveBeenCalled();
    expect(api.updateEntry).not.toHaveBeenCalled();
    expect(api.createEntry).not.toHaveBeenCalled();
  });
});
