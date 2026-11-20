import { EditorView } from '@tiptap/pm/view';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  TABLE_RELATION_MAX_LINKS,
  type CreateTableEntryRequest,
  type TableEntriesQuery,
  type TableEntriesResponse,
  type TableEntry,
  type TableEntryResponse,
  type TableField,
  type UpdateTableEntryRequest,
} from '@snaglet/shared/types';
import {
  NODE_CHIP_MIME,
  nodeToChipMarkdown,
  setActiveDragChip,
  type NodeChipData,
} from '@desktop/utils/nodeChip';
import { setActiveDragChipList, writeChipDragList } from '@desktop/utils/nodeChip/payload';
import { TableEntriesGrid } from './TableEntriesGrid';
import { FetchError } from '@desktop/utils/api';

const api = vi.hoisted(() => ({
  entries: vi.fn<(id: string, query: TableEntriesQuery) => Promise<TableEntriesResponse>>(),
  entry: vi.fn(),
  fields: vi.fn(),
  createEntry: vi.fn<(id: string, input: CreateTableEntryRequest) => Promise<TableEntryResponse>>(),
  updateEntry:
    vi.fn<
      (id: string, entryId: string, input: UpdateTableEntryRequest) => Promise<TableEntryResponse>
    >(),
  agents: vi.fn(),
  searchEntries: vi.fn(),
  resolveEntries: vi.fn(),
}));
vi.mock('@desktop/utils/api', async () => {
  const core =
    await vi.importActual<typeof import('@desktop/utils/api/core')>('@desktop/utils/api/core');
  return { tablesApi: api, agentsApi: { list: api.agents }, FetchError: core.FetchError };
});
vi.mock('@desktop/features/rich-markdown/renderer', () => ({
  MarkdownRenderer: ({ content }: { content: string }) => <span>{content}</span>,
}));

const tableId = 'table-1111111111111-aaaaaaaaa';
const entryId = '00000000-0000-4000-8000-000000000001';
const otherEntryId = '00000000-0000-4000-8000-000000000002';
const schemaVersion = 'a'.repeat(64);
const chip: NodeChipData = {
  id: 'doc-1111111111111-aaaaaaaaa',
  kind: 'doc',
  title: 'Field guide',
};
const chipSource = nodeToChipMarkdown(chip);
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
  position: 2,
  managed: false,
  collapsed: false,
  isTitle: false,
  multiple: false,
  options: null,
  revision: 1,
};
let saved: TableEntry;
let rows: TableEntry[];
let fields: TableField[];

function pressEscape(editor: HTMLElement) {
  fireEvent.keyDown(editor, { key: 'Escape', code: 'Escape', keyCode: 27, which: 27 });
}

function cellContaining(element: HTMLElement): HTMLTableCellElement {
  const cell = element.closest('td');
  if (!cell) throw new Error('Expected a table cell');
  return cell;
}

function entryCell(entryId: string, fieldName = 'Title') {
  const row = document.querySelector<HTMLElement>(`[data-entry-id="${entryId}"]`);
  if (!row) throw new Error(`Missing row ${entryId}`);
  return within(row).getByRole('button', { name: new RegExp(`^Edit ${fieldName} in entry `) });
}

function findEntryCell(entryId: string, fieldName = 'Title') {
  return waitFor(() => entryCell(entryId, fieldName));
}

function drop(element: HTMLElement, value: NodeChipData = chip) {
  const dataTransfer = {
    types: [NODE_CHIP_MIME],
    getData: (type: string) => (type === NODE_CHIP_MIME ? JSON.stringify(value) : ''),
    dropEffect: 'copy',
    files: [],
  };
  fireEvent.dragOver(element, { dataTransfer });
  return fireEvent.drop(element, { dataTransfer, clientX: 0, clientY: 0 });
}

function renderGrid() {
  // The real pane leaves marked chip targets alone even when a native editor
  // consumes the browser default without stopping the event's propagation.
  const paneDrop = vi.fn();
  const view = render(
    <div
      onDrop={(event) => {
        if (
          event.target instanceof Element &&
          event.target.closest('[data-pane-drop-target="node-chip"]')
        )
          return;
        paneDrop();
      }}
    >
      <TableEntriesGrid tableId={tableId} columns={[]} fields={fields} />
    </div>
  );
  return { paneDrop, view };
}

function saveUpdate(id: string, input: UpdateTableEntryRequest): TableEntryResponse {
  const original = rows.find((row) => row.id === id);
  if (!original) throw new Error('Missing entry fixture');
  const entry = {
    ...original,
    revision: original.revision === 'b'.repeat(64) ? 'c'.repeat(64) : 'd'.repeat(64),
    values: { ...original.values, ...input.values },
  };
  rows = rows.map((row) => (row.id === id ? entry : row));
  return { entry, schemaVersion, relatedEntries: {}, relatedItems: {} };
}

beforeAll(() => {
  if (!document.elementFromPoint) document.elementFromPoint = () => null;
  if (!Range.prototype.getClientRects)
    Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
  if (!Range.prototype.getBoundingClientRect)
    Range.prototype.getBoundingClientRect = () => new DOMRect();
});
beforeEach(() => {
  vi.resetAllMocks();
  api.searchEntries.mockResolvedValue({ results: [], hasMore: false });
  api.resolveEntries.mockResolvedValue({ entries: [] });
  localStorage.clear();
  vi.spyOn(EditorView.prototype, 'posAtCoords').mockImplementation(function (this: EditorView) {
    return { pos: this.state.selection.from, inside: -1 };
  });
  // Native dragover paints a drop cursor; jsdom has no offset-parent layout.
  vi.spyOn(HTMLElement.prototype, 'offsetParent', 'get').mockReturnValue(document.body);
  saved = {
    id: entryId,
    createdAt: '2026-01-01T00:00:00.000000Z',
    revision: 'b'.repeat(64),
    values: { [title.id]: 'Original title' },
  };
  rows = [saved];
  fields = [title];
  api.agents.mockResolvedValue([]);
  api.entries.mockImplementation((_id: string, query: TableEntriesQuery) =>
    Promise.resolve({
      entries: [...rows],
      fields,
      totalCount: rows.length,
      page: query.page ?? 1,
      pageSize: query.pageSize ?? 25,
      schemaVersion,
      relatedEntries: {},
      relatedItems: {},
    })
  );
  api.entry.mockResolvedValue({
    entry: saved,
    schemaVersion,
    relatedEntries: {},
    relatedItems: {},
  });
  api.fields.mockImplementation(() => Promise.resolve({ fields }));
  api.updateEntry.mockImplementation((_id, id, input) => Promise.resolve(saveUpdate(id, input)));
  api.createEntry.mockImplementation((_id, input) => {
    const entry: TableEntry = {
      id: input.id,
      createdAt: '2026-01-01T00:00:00.000000Z',
      revision: 'b'.repeat(64),
      values: input.values,
    };
    rows = [...rows, entry];
    return Promise.resolve({ entry, schemaVersion, relatedEntries: {}, relatedItems: {} });
  });
});
afterEach(async () => {
  // Unmount can flush accepted edits and pending React effects; keep their API
  // mocks intact until the grid has unsubscribed and that work has settled.
  await act(async () => cleanup());
  setActiveDragChip(null);
  setActiveDragChipList(null);
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('TableEntriesGrid with the real chip editor', () => {
  it('saves the latest value and closes the real editor when Tab leaves its cell', async () => {
    renderGrid();
    const user = userEvent.setup();
    await user.click(await findEntryCell(entryId));
    const editor = await screen.findByRole('textbox', { name: 'Title' });
    await user.clear(editor);
    await user.paste('Saved with Tab');
    expect(api.updateEntry).not.toHaveBeenCalled();

    await user.tab();

    expect(screen.queryByRole('textbox', { name: 'Title' })).not.toBeInTheDocument();
    expect(api.updateEntry).toHaveBeenCalledExactlyOnceWith(tableId, entryId, {
      values: { [title.id]: 'Saved with Tab' },
      schemaVersion,
      expectedRevision: saved.revision,
    });
    expect(entryCell(entryId)).toHaveTextContent('Saved with Tab');
    expect(api.createEntry).not.toHaveBeenCalled();
    vi.useFakeTimers();
    await act(async () => vi.advanceTimersByTimeAsync(1000));
    expect(api.updateEntry).toHaveBeenCalledOnce();
  });

  it('keeps the editor and its draft open while clicking outside the grid to browse chips', async () => {
    render(
      <>
        <button>Browse chips</button>
        <TableEntriesGrid tableId={tableId} columns={[]} fields={fields} />
      </>
    );
    const user = userEvent.setup();
    await user.click(await findEntryCell(entryId));
    const editor = await screen.findByRole('textbox', { name: 'Title' });
    await user.clear(editor);
    await user.paste('Keep this cell open');

    await user.click(screen.getByRole('button', { name: 'Browse chips' }));

    expect(screen.getByRole('button', { name: 'Browse chips' })).toHaveFocus();
    expect(screen.getByRole('textbox', { name: 'Title' })).toBe(editor);
    expect(editor).toHaveTextContent('Keep this cell open');
    expect(api.updateEntry).not.toHaveBeenCalled();
    await waitFor(() =>
      expect(api.updateEntry).toHaveBeenCalledExactlyOnceWith(tableId, entryId, {
        values: { [title.id]: 'Keep this cell open' },
        schemaVersion,
        expectedRevision: saved.revision,
      })
    );
    expect(screen.getByRole('textbox', { name: 'Title' })).toBe(editor);
    expect(api.createEntry).not.toHaveBeenCalled();
  });

  it('discards the unsent tail on Escape and waits for the sent write before reopening', async () => {
    let finishSave: ((value: TableEntryResponse) => void) | undefined;
    api.updateEntry.mockReturnValueOnce(
      new Promise((resolve) => {
        finishSave = resolve;
      })
    );
    const user = userEvent.setup();
    renderGrid();
    await user.click(await findEntryCell(entryId));
    const editor = await screen.findByRole('textbox', { name: 'Title' });
    await user.clear(editor);
    await user.paste('Sent value');
    await waitFor(() => expect(api.updateEntry).toHaveBeenCalledOnce());
    const sent = api.updateEntry.mock.calls[0][2];
    await user.clear(editor);
    await user.paste('Discard this tail');
    pressEscape(editor);
    expect(screen.queryByRole('textbox', { name: 'Title' })).not.toBeInTheDocument();
    await user.click(entryCell(entryId));
    expect(screen.queryByRole('textbox', { name: 'Title' })).not.toBeInTheDocument();

    const resolve = finishSave;
    if (!resolve) throw new Error('Expected pending save');
    await act(async () => resolve(saveUpdate(entryId, sent)));
    const reopened = await screen.findByRole('textbox', { name: 'Title' });
    await waitFor(() => expect(reopened).toHaveTextContent('Sent value'));
    vi.useFakeTimers();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(api.updateEntry).toHaveBeenCalledOnce();
    expect(rows[0].values[title.id]).toBe('Sent value');
  });

  it('keeps a canceled write failure from contaminating the next cell draft', async () => {
    let rejectSave: ((reason: Error) => void) | undefined;
    api.updateEntry.mockReturnValueOnce(
      new Promise((_resolve, reject) => {
        rejectSave = reject;
      })
    );
    rows.push({ ...saved, id: otherEntryId, values: { [title.id]: 'Other entry' } });
    const user = userEvent.setup();
    renderGrid();
    await user.click(await findEntryCell(entryId));
    const editor = await screen.findByRole('textbox', { name: 'Title' });
    await user.clear(editor);
    await user.paste('Sent value');
    await waitFor(() => expect(api.updateEntry).toHaveBeenCalledOnce());
    await user.clear(editor);
    await user.paste('Discard this tail');
    pressEscape(editor);
    await user.click(entryCell(otherEntryId));
    const reject = rejectSave;
    if (!reject) throw new Error('Expected pending save');
    await act(async () => reject(new Error('Save failed')));
    await waitFor(() =>
      expect(screen.getByRole('textbox', { name: 'Title' })).toHaveTextContent('Other entry')
    );
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(api.updateEntry).toHaveBeenCalledOnce();
  });

  it('cancels a focused cell draft with Escape before its debounce fires', async () => {
    const user = userEvent.setup();
    render(<TableEntriesGrid tableId={tableId} columns={[]} fields={[title]} />);
    await user.click(await findEntryCell(entryId));
    const editor = await screen.findByRole('textbox', { name: 'Title' });
    await waitFor(() => expect(editor).toHaveTextContent('Original title'));
    await user.clear(editor);
    await user.paste('Local draft');
    pressEscape(editor);
    await waitFor(() =>
      expect(screen.queryByRole('textbox', { name: 'Title' })).not.toBeInTheDocument()
    );
    expect(api.updateEntry).not.toHaveBeenCalled();
  });

  it('uses the first Escape to dismiss mention suggestions and the next to leave the cell', async () => {
    const user = userEvent.setup();
    render(<TableEntriesGrid tableId={tableId} columns={[]} fields={[title]} />);
    await user.click(await findEntryCell(entryId));
    const editor = await screen.findByRole('textbox', { name: 'Title' });
    await user.clear(editor);
    await user.paste('@');
    expect(await screen.findByText('Type to search…')).toBeInTheDocument();
    pressEscape(editor);
    await waitFor(() => expect(screen.queryByText('Type to search…')).not.toBeInTheDocument());
    expect(screen.getByRole('textbox', { name: 'Title' })).toBeInTheDocument();
    pressEscape(editor);
    await waitFor(() =>
      expect(screen.queryByRole('textbox', { name: 'Title' })).not.toBeInTheDocument()
    );
    expect(api.updateEntry).not.toHaveBeenCalled();
  });
});

describe('TableEntriesGrid native chip drops', () => {
  it.each(['unfocused cell', 'native editor'] as const)(
    'reverts an immediate chip drop on the %s when Escape arrives before autosave',
    async (dropTarget) => {
      const { paneDrop } = renderGrid();
      const user = userEvent.setup();
      const button = await findEntryCell(entryId);
      let target: HTMLElement = cellContaining(button);
      if (dropTarget === 'native editor') {
        await user.click(button);
        target = await screen.findByRole('textbox', { name: 'Title' });
      }
      vi.useFakeTimers();
      await act(async () => expect(drop(target)).toBe(false));
      const editor = screen.getByRole('textbox', { name: 'Title' });
      expect(editor.querySelector(`[data-node-url="${chip.id}"]`)).toBeInTheDocument();

      pressEscape(editor);
      await act(async () => vi.advanceTimersByTimeAsync(1000));

      expect(screen.queryByRole('textbox', { name: 'Title' })).not.toBeInTheDocument();
      expect(entryCell(entryId)).toHaveTextContent('Original title');
      expect(document.querySelector(`[data-node-url="${chip.id}"]`)).not.toBeInTheDocument();
      expect(rows[0].values[title.id]).toBe('Original title');
      expect(api.updateEntry).not.toHaveBeenCalled();
      expect(api.createEntry).not.toHaveBeenCalled();
      expect(paneDrop).not.toHaveBeenCalled();
    }
  );

  it('rejects drops on the selection cell with its Text-cell guidance and no pane split', async () => {
    const { paneDrop } = renderGrid();
    const selection = await screen.findByRole('checkbox', { name: /^Select entry / });
    vi.useFakeTimers();

    expect(drop(cellContaining(selection))).toBe(false);
    fireEvent.dragEnd(window);
    await act(async () => vi.advanceTimersByTimeAsync(1000));

    expect(screen.getByRole('alert')).toHaveTextContent(/^Drop links into a Text cell$/);
    expect(selection).not.toBeChecked();
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
    expect(api.updateEntry).not.toHaveBeenCalled();
    expect(api.createEntry).not.toHaveBeenCalled();
    expect(paneDrop).not.toHaveBeenCalled();
    expect(rows).toEqual([saved]);
  });

  it('locks the real editor while loading a conflicting row instead of accepting edits it would overwrite', async () => {
    let finishReload: ((value: TableEntryResponse) => void) | undefined;
    api.updateEntry.mockRejectedValueOnce(new FetchError('Entry changed elsewhere', 409));
    api.entry.mockReturnValueOnce(
      new Promise((resolve) => {
        finishReload = resolve;
      })
    );
    const user = userEvent.setup();
    renderGrid();
    await user.click(await findEntryCell(entryId));
    const editor = await screen.findByRole('textbox', { name: 'Title' });
    await user.clear(editor);
    await user.paste('Local conflict');
    await user.click(await screen.findByRole('button', { name: 'Load latest row' }));
    await waitFor(() => expect(api.entry).toHaveBeenCalledOnce());
    expect(editor).toHaveAttribute('contenteditable', 'false');
    expect(drop(editor)).toBe(false);
    expect(
      screen.getByText('Editing is unavailable. Try again when this table is ready.')
    ).toBeInTheDocument();
    await user.type(editor, 'Unaccepted text');
    expect(editor).toHaveTextContent('Local conflict');
    expect(editor).not.toHaveTextContent('Unaccepted text');
    const resolve = finishReload;
    if (!resolve) throw new Error('Expected pending reload');
    await act(async () =>
      resolve({
        entry: { ...saved, revision: 'd'.repeat(64), values: { [title.id]: 'Remote title' } },
        schemaVersion,
        relatedEntries: {},
        relatedItems: {},
      })
    );
    await waitFor(() =>
      expect(screen.getByRole('textbox', { name: 'Title' })).toHaveTextContent('Remote title')
    );
    expect(screen.getByRole('textbox', { name: 'Title' })).toHaveAttribute(
      'contenteditable',
      'true'
    );
    expect(api.updateEntry).toHaveBeenCalledOnce();
  });

  it.each([
    { reason: undefined, expected: 'Editing is unavailable' },
    {
      reason: 'Close field settings to edit entries.',
      expected: 'Close field settings to edit entries.',
    },
  ])(
    'rejects blocked native editor drops with the applicable reason: $expected',
    async ({ reason, expected }) => {
      const user = userEvent.setup();
      const { paneDrop, view } = renderGrid();
      await user.click(await findEntryCell(entryId));
      await screen.findByRole('textbox', { name: 'Title' });
      view.rerender(
        <div onDrop={paneDrop}>
          <TableEntriesGrid
            tableId={tableId}
            columns={[]}
            fields={fields}
            editingDisabled
            editingDisabledReason={reason}
          />
        </div>
      );
      const editor = screen.getByRole('textbox', { name: 'Title' });
      expect(editor).toHaveAttribute('contenteditable', 'false');
      await user.type(editor, 'Blocked input');
      expect(editor).toBeInTheDocument();
      vi.useFakeTimers();

      expect(drop(editor)).toBe(false);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1000);
      });

      expect(screen.getByRole('alert')).toHaveTextContent(expected);
      expect(editor).toHaveTextContent('Original title');
      expect(editor).not.toHaveTextContent('Blocked input');
      expect(editor.querySelector('[data-node-url]')).not.toBeInTheDocument();
      expect(api.updateEntry).not.toHaveBeenCalled();
      expect(api.createEntry).not.toHaveBeenCalled();
      expect(paneDrop).not.toHaveBeenCalled();
    }
  );

  it('appends a chip to an unfocused Text cell and autosaves its canonical reference', async () => {
    const { paneDrop } = renderGrid();
    const cell = cellContaining(await findEntryCell(entryId));
    expect(screen.queryByRole('textbox', { name: 'Title' })).not.toBeInTheDocument();
    expect(cell.closest('[data-pane-drop-target="node-chip"]')).not.toBeNull();

    expect(drop(cell)).toBe(false);

    await waitFor(() =>
      expect(api.updateEntry).toHaveBeenCalledWith(tableId, entryId, {
        values: { [title.id]: `Original title ${chipSource}` },
        schemaVersion,
        expectedRevision: saved.revision,
      })
    );
    const editor = screen.getByRole('textbox', { name: 'Title' });
    expect(editor).toHaveTextContent('Original title');
    expect(editor.querySelector(`[data-node-url="${chip.id}"]`)).toBeInTheDocument();
    expect(api.updateEntry).toHaveBeenCalledOnce();
    expect(api.createEntry).not.toHaveBeenCalled();
    expect(paneDrop).not.toHaveBeenCalled();
  });

  it('appends every chip of a multi-row drop to an unfocused Text cell, in order, in one save', async () => {
    const thread: NodeChipData = {
      id: 'thread-2222222222222-bbbbbbbbb',
      kind: 'thread',
      title: 'Planning',
    };
    const other: NodeChipData = {
      id: 'doc-3333333333333-ccccccccc',
      kind: 'doc',
      title: 'Glossary',
    };
    renderGrid();
    const cell = cellContaining(await findEntryCell(entryId));
    writeChipDragList({ setData: () => {} } as unknown as DataTransfer, {
      chips: [thread, chip, other],
      unlinkable: 0,
    });

    drop(cell, chip);

    await waitFor(() =>
      expect(api.updateEntry).toHaveBeenCalledWith(tableId, entryId, {
        values: {
          [title.id]: `Original title ${nodeToChipMarkdown(thread)} ${chipSource} ${nodeToChipMarkdown(other)}`,
        },
        schemaVersion,
        expectedRevision: saved.revision,
      })
    );
    expect(api.updateEntry).toHaveBeenCalledOnce();
  });

  it.each([false, true])(
    'links a matching entry chip into an unfocused relation (multiple=%s)',
    async (multiple) => {
      const relatedTable = 'table-1111111111111-bbbbbbbbb';
      const relation: TableField = {
        ...title,
        type: 'relation',
        name: 'Related',
        referenceTableId: relatedTable,
        nullable: !multiple,
        multiple,
        defaultValue: multiple ? [] : null,
      };
      fields = [relation];
      rows = [{ ...saved, values: { [relation.id]: multiple ? [entryId] : entryId } }];
      const { paneDrop } = renderGrid();
      const cell = cellContaining(await findEntryCell(entryId, 'Related'));
      drop(cell, { kind: 'entry', id: `${relatedTable}/${otherEntryId}`, title: 'Linked entry' });
      await waitFor(() =>
        expect(api.updateEntry).toHaveBeenCalledWith(
          tableId,
          entryId,
          expect.objectContaining({
            values: { [relation.id]: multiple ? [entryId, otherEntryId] : otherEntryId },
          })
        )
      );
      expect(api.updateEntry).toHaveBeenCalledOnce();
      expect(paneDrop).not.toHaveBeenCalled();
      if (multiple) {
        drop(cell, {
          kind: 'entry',
          id: `${relatedTable}/${otherEntryId.toUpperCase()}`,
          title: 'Linked entry',
        });
        await act(async () => {});
        expect(api.updateEntry).toHaveBeenCalledOnce();
      }
    }
  );

  it('refuses entry chips from another table without changing a relation', async () => {
    fields = [
      {
        ...title,
        type: 'relation',
        name: 'Related',
        nullable: true,
        referenceTableId: 'table-1111111111111-bbbbbbbbb',
      },
    ];
    rows = [{ ...saved, values: { [title.id]: null } }];
    const { paneDrop } = renderGrid();
    drop(cellContaining(await findEntryCell(entryId, 'Related')), {
      kind: 'entry',
      id: `${tableId}/${otherEntryId}`,
      title: 'Wrong table',
    });
    expect(screen.getByRole('alert')).toHaveTextContent('This entry belongs to another table.');
    expect(api.updateEntry).not.toHaveBeenCalled();
    expect(paneDrop).not.toHaveBeenCalled();
  });

  it('refuses another entry once a multiple relation is full, without failing autosave', async () => {
    const relatedTable = 'table-1111111111111-bbbbbbbbb';
    fields = [
      {
        ...title,
        type: 'relation',
        name: 'Related',
        nullable: false,
        multiple: true,
        defaultValue: [],
        referenceTableId: relatedTable,
      },
    ];
    const linked = Array.from(
      { length: TABLE_RELATION_MAX_LINKS },
      (_, index) => `00000000-0000-4000-8000-${String(index + 100).padStart(12, '0')}`
    );
    rows = [{ ...saved, values: { [title.id]: linked } }];
    const { paneDrop } = renderGrid();
    drop(cellContaining(await findEntryCell(entryId, 'Related')), {
      kind: 'entry',
      id: `${relatedTable}/${otherEntryId}`,
      title: 'One too many',
    });
    expect(await screen.findByRole('alert')).toHaveTextContent(
      `Up to ${TABLE_RELATION_MAX_LINKS} entries can be linked.`
    );
    await act(async () => {});
    expect(api.updateEntry).not.toHaveBeenCalled();
    expect(paneDrop).not.toHaveBeenCalled();
  });

  it('asks a relation without a related table to choose one before accepting entries', async () => {
    fields = [{ ...title, type: 'relation', name: 'Related', nullable: true }];
    rows = [{ ...saved, values: { [title.id]: null } }];
    const { paneDrop } = renderGrid();
    drop(cellContaining(await findEntryCell(entryId, 'Related')), {
      kind: 'entry',
      id: `${tableId}/${otherEntryId}`,
      title: 'Any entry',
    });
    expect(screen.getByRole('alert')).toHaveTextContent('Choose a table in field settings first.');
    expect(api.updateEntry).not.toHaveBeenCalled();
    expect(paneDrop).not.toHaveBeenCalled();
  });

  it('creates one row when an entry chip lands in the ghost relation', async () => {
    const relatedTable = 'table-1111111111111-bbbbbbbbb';
    fields = [
      {
        ...title,
        type: 'relation',
        name: 'Related',
        nullable: true,
        referenceTableId: relatedTable,
      },
    ];
    rows = [];
    const { paneDrop } = renderGrid();
    drop(cellContaining(await screen.findByRole('button', { name: 'New entry: Related' })), {
      kind: 'entry',
      id: `${relatedTable}/${otherEntryId}`,
      title: 'Linked entry',
    });
    await waitFor(() => expect(api.createEntry).toHaveBeenCalledOnce());
    expect(api.createEntry).toHaveBeenCalledWith(
      tableId,
      expect.objectContaining({ values: { [title.id]: otherEntryId } })
    );
    expect(paneDrop).not.toHaveBeenCalled();
  });

  it('creates one row from a ghost Text drop with the chip in its first saved value', async () => {
    fields = [{ ...title, nullable: true }];
    rows = [];
    const { paneDrop } = renderGrid();
    const ghost = cellContaining(await screen.findByRole('button', { name: 'New entry: Title' }));
    expect(ghost.closest('[data-pane-drop-target="node-chip"]')).not.toBeNull();

    expect(drop(ghost)).toBe(false);

    await waitFor(() => expect(api.createEntry).toHaveBeenCalledOnce());
    expect(api.createEntry).toHaveBeenCalledWith(tableId, {
      id: expect.stringMatching(/^[a-f\d-]{36}$/),
      schemaVersion,
      values: { [title.id]: chipSource },
    });
    expect(await screen.findByText('Saved')).toBeInTheDocument();
    expect(api.updateEntry).not.toHaveBeenCalled();
    expect(rows).toHaveLength(1);
    expect(screen.getByRole('button', { name: 'New entry: Title' })).toBeEnabled();
    expect(paneDrop).not.toHaveBeenCalled();
  });

  const incompatibleFields: TableField[] = [
    { ...title, name: 'Amount', type: 'number', nullable: true },
    { ...title, name: 'Due', type: 'date', nullable: true },
    { ...title, name: 'Appointment', type: 'datetime', nullable: true },
    { ...title, name: 'Ready', type: 'checkbox', nullable: true },
    {
      ...title,
      name: 'Related',
      type: 'relation',
      nullable: true,
      referenceTableId: 'table-1111111111111-bbbbbbbbb',
    },
    { ...title, name: 'id', type: 'uuid', columnName: 'id', managed: true },
  ];

  describe.each(['existing', 'ghost'] as const)('%s cells reject incompatible chips', (rowKind) => {
    it.each(incompatibleFields)(
      '$name consumes the drop without editing, saving, or splitting',
      async (field) => {
        fields = [field];
        rows = rowKind === 'ghost' ? [] : [{ ...saved, values: { [field.id]: null } }];
        const { paneDrop, view } = renderGrid();
        const ghostName = field.managed ? 'New entry' : `New entry: ${field.name}`;
        const ghostRole = field.type === 'checkbox' ? 'checkbox' : 'button';
        await waitFor(() => expect(screen.getByRole(ghostRole, { name: ghostName })).toBeEnabled());
        const cell =
          rowKind === 'ghost'
            ? cellContaining(
                screen.getByRole(ghostRole, {
                  name: field.managed ? 'New entry' : `New entry: ${field.name}`,
                })
              )
            : view.container.querySelector<HTMLElement>(
                'td[data-column][data-pane-drop-target="node-chip"]'
              );
        if (!cell) throw new Error('Expected a chip-aware data cell');
        expect(cell.closest('[data-pane-drop-target="node-chip"]')).not.toBeNull();
        vi.useFakeTimers();

        expect(drop(cell)).toBe(false);
        await act(async () => {
          await vi.advanceTimersByTimeAsync(1000);
        });

        expect(screen.getByRole('alert')).toHaveTextContent(/Text/i);
        if (field.type === 'datetime')
          expect(screen.getByRole('alert')).toHaveTextContent(
            "Date and time cells can't hold links"
          );
        expect(api.createEntry).not.toHaveBeenCalled();
        expect(api.updateEntry).not.toHaveBeenCalled();
        expect(paneDrop).not.toHaveBeenCalled();
        expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
        expect(rows).toEqual(
          rowKind === 'ghost' ? [] : [{ ...saved, values: { [field.id]: null } }]
        );
      }
    );
  });

  it('keeps a failed current-row draft and never inserts the chip into either wrong row', async () => {
    rows.push({ ...saved, id: otherEntryId, values: { [title.id]: 'Second title' } });
    api.updateEntry.mockRejectedValue(new Error('Table save unavailable'));
    const user = userEvent.setup();
    const { paneDrop } = renderGrid();
    await user.click(await findEntryCell(entryId));
    const editor = await screen.findByRole('textbox', { name: 'Title' });
    await user.clear(editor);
    await user.paste('Unsaved local draft');
    const destination = cellContaining(entryCell(otherEntryId));

    expect(drop(destination)).toBe(false);

    expect(await screen.findByText('Table save unavailable')).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'Title' })).toHaveTextContent('Unsaved local draft');
    expect(entryCell(otherEntryId)).toHaveTextContent('Second title');
    expect(document.querySelector(`[data-node-url="${chip.id}"]`)).not.toBeInTheDocument();
    expect(api.updateEntry).toHaveBeenCalledWith(
      tableId,
      entryId,
      expect.objectContaining({ values: { [title.id]: 'Unsaved local draft' } })
    );
    expect(api.updateEntry.mock.calls.every(([, id]) => id === entryId)).toBe(true);
    expect(api.createEntry).not.toHaveBeenCalled();
    expect(paneDrop).not.toHaveBeenCalled();
  });

  it.each(['cell surface', 'native editor'] as const)(
    'retains repeated drops on the %s while the first autosave is still in flight',
    async (dropTarget) => {
      let finishFirst: ((value: TableEntryResponse) => void) | undefined;
      api.updateEntry.mockReturnValueOnce(
        new Promise<TableEntryResponse>((resolve) => {
          finishFirst = resolve;
        })
      );
      const secondChip: NodeChipData = {
        id: 'doc-1111111111111-bbbbbbbbb',
        kind: 'doc',
        title: 'Second guide',
      };
      const thirdChip: NodeChipData = {
        id: 'doc-1111111111111-ccccccccc',
        kind: 'doc',
        title: 'Third guide',
      };
      const { paneDrop } = renderGrid();
      const target = cellContaining(await findEntryCell(entryId));
      expect(drop(target)).toBe(false);
      await waitFor(() => expect(api.updateEntry).toHaveBeenCalledOnce());
      const firstRequest = api.updateEntry.mock.calls[0][2];

      const activeTarget =
        dropTarget === 'native editor' ? screen.getByRole('textbox', { name: 'Title' }) : target;
      expect(drop(activeTarget, secondChip)).toBe(false);
      expect(drop(activeTarget, thirdChip)).toBe(false);

      const resolve = finishFirst;
      if (!resolve) throw new Error('First save has not started');
      await act(async () => resolve(saveUpdate(entryId, firstRequest)));
      const separator = dropTarget === 'native editor' ? '' : ' ';
      const expected = `Original title ${chipSource}${separator}${nodeToChipMarkdown(secondChip)}${separator}${nodeToChipMarkdown(thirdChip)}`;
      await waitFor(() =>
        expect(api.updateEntry).toHaveBeenLastCalledWith(tableId, entryId, {
          values: { [title.id]: expected },
          schemaVersion,
          expectedRevision: 'c'.repeat(64),
        })
      );
      expect(await screen.findByText('Saved')).toBeInTheDocument();
      expect(api.updateEntry).toHaveBeenCalledTimes(2);
      expect(rows[0].values[title.id]).toBe(expected);
      const editor = screen.getByRole('textbox', { name: 'Title' });
      for (const dropped of [chip, secondChip, thirdChip]) {
        expect(editor.querySelectorAll(`[data-node-url="${dropped.id}"]`)).toHaveLength(1);
      }
      expect(api.createEntry).not.toHaveBeenCalled();
      expect(paneDrop).not.toHaveBeenCalled();
    }
  );

  it('preserves each accepted drop when queued row switches revisit a previously saved row', async () => {
    const thirdEntryId = '00000000-0000-4000-8000-000000000003';
    rows.push(
      { ...saved, id: otherEntryId, values: { [title.id]: 'Second title' } },
      { ...saved, id: thirdEntryId, values: { [title.id]: 'Third title' } }
    );
    let finishFirst: ((value: TableEntryResponse) => void) | undefined;
    api.updateEntry.mockReturnValueOnce(
      new Promise<TableEntryResponse>((resolve) => {
        finishFirst = resolve;
      })
    );
    const nextChip: NodeChipData = {
      id: 'doc-1111111111111-bbbbbbbbb',
      kind: 'doc',
      title: 'Second guide',
    };
    const { paneDrop } = renderGrid();
    const first = cellContaining(await findEntryCell(entryId));
    const second = cellContaining(entryCell(otherEntryId));
    const third = cellContaining(entryCell(thirdEntryId));
    expect(drop(first)).toBe(false);
    await waitFor(() => expect(api.updateEntry).toHaveBeenCalledOnce());
    const firstRequest = api.updateEntry.mock.calls[0][2];

    expect(drop(second)).toBe(false);
    expect(drop(third)).toBe(false);
    expect(drop(second, nextChip)).toBe(false);

    const resolve = finishFirst;
    if (!resolve) throw new Error('First save has not started');
    await act(async () => resolve(saveUpdate(entryId, firstRequest)));
    await waitFor(() => expect(api.updateEntry).toHaveBeenCalledTimes(4));
    expect(await screen.findByText('Saved')).toBeInTheDocument();
    expect(api.updateEntry.mock.calls.map(([, id]) => id)).toEqual([
      entryId,
      otherEntryId,
      thirdEntryId,
      otherEntryId,
    ]);
    expect(api.updateEntry).toHaveBeenLastCalledWith(tableId, otherEntryId, {
      values: { [title.id]: `Second title ${chipSource} ${nodeToChipMarkdown(nextChip)}` },
      schemaVersion,
      expectedRevision: 'c'.repeat(64),
    });
    expect(rows.find((row) => row.id === entryId)?.values[title.id]).toBe(
      `Original title ${chipSource}`
    );
    expect(rows.find((row) => row.id === thirdEntryId)?.values[title.id]).toBe(
      `Third title ${chipSource}`
    );
    expect(api.createEntry).not.toHaveBeenCalled();
    expect(paneDrop).not.toHaveBeenCalled();
  });

  it('does not create a queued ghost row after the grid unmounts during a save', async () => {
    let finishFirst: ((value: TableEntryResponse) => void) | undefined;
    api.updateEntry.mockReturnValueOnce(
      new Promise<TableEntryResponse>((resolve) => {
        finishFirst = resolve;
      })
    );
    const { view } = renderGrid();
    const first = cellContaining(await findEntryCell(entryId));
    expect(drop(first)).toBe(false);
    await waitFor(() => expect(api.updateEntry).toHaveBeenCalledOnce());
    const firstRequest = api.updateEntry.mock.calls[0][2];
    const ghost = cellContaining(screen.getByRole('button', { name: 'New entry: Title' }));
    expect(drop(ghost)).toBe(false);
    view.unmount();

    const resolve = finishFirst;
    if (!resolve) throw new Error('First save has not started');
    vi.useFakeTimers();
    await act(async () => {
      resolve(saveUpdate(entryId, firstRequest));
      await vi.advanceTimersByTimeAsync(1000);
    });

    expect(api.updateEntry).toHaveBeenCalledOnce();
    expect(api.createEntry).not.toHaveBeenCalled();
    expect(rows).toHaveLength(1);
  });

  it('resolves a queued unsaved-row drop to its newly saved id without creating another row', async () => {
    const notes: TableField = {
      ...title,
      id: 'field-1111111111111-bbbbbbbbb',
      columnName: 'notes',
      name: 'Notes',
      nullable: true,
      position: 3,
    };
    fields = [{ ...title, nullable: true }, notes];
    let finishCreate: ((value: TableEntryResponse) => void) | undefined;
    api.createEntry.mockReturnValueOnce(
      new Promise<TableEntryResponse>((resolve) => {
        finishCreate = resolve;
      })
    );
    const { paneDrop } = renderGrid();
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'New entry: Title' }));
    await waitFor(() => expect(api.createEntry).toHaveBeenCalledOnce());
    const createRequest = api.createEntry.mock.calls[0][1];
    const savedTarget = cellContaining(entryCell(entryId));
    const draftTarget = cellContaining(entryCell(createRequest.id, 'Notes'));

    expect(drop(savedTarget)).toBe(false);
    expect(drop(draftTarget)).toBe(false);

    const resolve = finishCreate;
    if (!resolve) throw new Error('First creation has not started');
    const created: TableEntry = {
      ...saved,
      id: createRequest.id,
      values: createRequest.values,
    };
    rows = [...rows, created];
    await act(async () =>
      resolve({ entry: created, schemaVersion, relatedEntries: {}, relatedItems: {} })
    );
    await waitFor(() => expect(api.updateEntry).toHaveBeenCalledTimes(2));

    expect(api.createEntry).toHaveBeenCalledOnce();
    expect(api.updateEntry).toHaveBeenCalledWith(
      tableId,
      entryId,
      expect.objectContaining({ values: { [title.id]: `Original title ${chipSource}` } })
    );
    expect(api.updateEntry).toHaveBeenLastCalledWith(tableId, createRequest.id, {
      values: { [notes.id]: chipSource },
      schemaVersion,
      expectedRevision: created.revision,
    });
    expect(rows).toHaveLength(2);
    expect(rows.find((row) => row.id === createRequest.id)?.values[notes.id]).toBe(chipSource);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(paneDrop).not.toHaveBeenCalled();
  });
});
