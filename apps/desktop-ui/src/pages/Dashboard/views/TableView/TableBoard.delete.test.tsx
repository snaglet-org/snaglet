import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  DeleteTableEntriesRequest,
  TableEntriesResponse,
  TableEntry,
  TableField,
  TableHistoryResponse,
  TableHistoryStep,
  TableHistoryStepRequest,
  TableHistoryStepResponse,
} from '@snaglet/shared/types';
import { emitTableEvent } from '@desktop/features/database';
import { __resetTableHistoryForTests } from '@desktop/features/database/tableHistory';
import { PaneFindProvider } from '@desktop/features/pane-find/PaneFindContext';
import { FetchError } from '@desktop/utils/api';
import { useState } from 'react';
import { TableBoard } from './TableBoard';
import { TableEntryModal } from './TableEntryModal';
import { TableUndoProvider, useTableUndoController } from './tableUndo';

const api = vi.hoisted(() => ({
  entry: vi.fn(),
  entries: vi.fn<() => Promise<TableEntriesResponse>>(),
  deleteEntries: vi.fn<(id: string, input: DeleteTableEntriesRequest) => Promise<unknown>>(),
  history: vi.fn<(limit?: number) => Promise<TableHistoryResponse>>(),
  stepHistory:
    vi.fn<
      (
        direction: 'undo' | 'redo',
        input?: TableHistoryStepRequest
      ) => Promise<TableHistoryStepResponse>
    >(),
}));
vi.mock('@desktop/utils/api', async () => {
  const actual = await vi.importActual<typeof import('@desktop/utils/api')>('@desktop/utils/api');
  return { ...actual, tablesApi: { ...actual.tablesApi, ...api } };
});

const tableId = 'table-1111111111111-aaaaaaaaa';
const schemaVersion = 'a'.repeat(64);
const name: TableField = {
  range: false,
  id: 'field-1111111111111-name',
  tableId,
  columnName: 'name',
  name: 'Name',
  description: null,
  type: 'text',
  nullable: false,
  defaultValue: '',
  referenceTableId: null,
  referenceKind: null,
  options: null,
  multiple: false,
  position: 0,
  managed: false,
  collapsed: false,
  isTitle: true,
  revision: 1,
};
const status: TableField = {
  ...name,
  id: 'field-1111111111111-status',
  columnName: 'status',
  name: 'Status',
  type: 'select',
  nullable: true,
  defaultValue: null,
  isTitle: false,
  position: 1,
  options: [
    { id: 'opt-todo', label: 'To do', color: 'gray' },
    { id: 'opt-done', label: 'Done', color: 'green' },
  ],
};
const fields = [name, status];
const id = (n: number) => `00000000-0000-4000-8000-00000000000${n}`;
const row = (n: number, state: string | null): TableEntry => ({
  id: id(n),
  createdAt: '2026-01-01T00:00:00.000000Z',
  revision: `rev-${n}`,
  values: { [name.id]: `Entry ${n}`, [status.id]: state },
});
const all = [row(1, 'To do'), row(2, 'To do'), row(3, 'Done')];
const actor = { kind: 'user' as const, id: 'user-test', name: 'Test User' };
const step = (n: number, label: string, kind: TableHistoryStep['kind']): TableHistoryStep => ({
  id: `step-${n}`,
  actor,
  kind,
  label,
  tableIds: [tableId],
  state: 'done',
  seq: n,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
});
const earlier = step(1, 'Add entry to test_items', 'entry.create');
const removal = step(2, 'Delete 1 entry from test_items', 'entry.delete');

let rows: TableEntry[];

/** The table pane: the Board, its undo controller, and the entry preview it opens. */
function Pane() {
  const control = useTableUndoController(tableId, true);
  const [preview, setPreview] = useState<string | null>(null);
  return (
    <TableUndoProvider value={control}>
      <TableBoard
        tableId={tableId}
        field={status}
        fields={fields}
        onOpenEntry={(entryId) => {
          onOpenEntry(entryId);
          setPreview(entryId);
        }}
      />
      {preview && (
        <TableEntryModal
          tableId={tableId}
          entryId={preview}
          fields={fields}
          onClose={() => setPreview(null)}
        />
      )}
    </TableUndoProvider>
  );
}
const onOpenEntry = vi.fn();

function column(label: string) {
  return screen.getByRole('region', { name: new RegExp(`^${label} \\(`) });
}

function titles(label: string) {
  return within(column(label))
    .queryAllByRole('button', { name: /^Open / })
    .map((button) => button.textContent);
}

/** The server's echo of a write: every open surface rereads the table. */
function serverChanged(ids: string[]) {
  emitTableEvent({ type: 'table.entries.changed', tableId, entryId: ids[0], entryIds: ids });
  emitTableEvent({ type: 'table.history.changed', stack: { kind: 'user', id: 'user-test' } });
}

beforeEach(() => {
  vi.resetAllMocks();
  __resetTableHistoryForTests();
  localStorage.clear();
  rows = [...all];
  api.entries.mockImplementation(async () => ({
    entries: rows,
    fields,
    totalCount: rows.length,
    page: 1,
    pageSize: 25,
    schemaVersion,
    relatedEntries: {},
    relatedItems: {},
  }));
  api.history.mockResolvedValue({ actor, steps: [earlier], undo: earlier, redo: null, depth: 100 });
  api.deleteEntries.mockImplementation(async (_id, input) => {
    rows = rows.filter((entry) => !input.entryIds.includes(entry.id));
    api.history.mockResolvedValue({
      actor,
      steps: [removal],
      undo: removal,
      redo: null,
      depth: 100,
    });
    setTimeout(() => serverChanged(input.entryIds));
    return { deletedIds: input.entryIds, alreadyDeleted: [] };
  });
  api.stepHistory.mockImplementation(async (direction) => {
    // Undo puts Entry 1 back as it was; redo deletes it again.
    rows = direction === 'undo' ? [...all] : rows.filter((entry) => entry.id !== id(1));
    const after =
      direction === 'undo' ? { undo: earlier, redo: removal } : { undo: removal, redo: null };
    api.history.mockResolvedValue({ actor, steps: [removal], ...after, depth: 100 });
    setTimeout(() => serverChanged([id(1)]));
    return { step: removal, ...after };
  });
  api.entry.mockImplementation(async (_table: string, entryId: string) => {
    const entry = rows.find((item) => item.id === entryId);
    if (!entry) throw new FetchError('Entry not found', 404);
    return { entry, schemaVersion, relatedEntries: {}, relatedItems: {} };
  });
  document.elementFromPoint = () => null;
});
afterEach(() => __resetTableHistoryForTests());

function setup() {
  render(
    <PaneFindProvider isActive>
      <Pane />
    </PaneFindProvider>
  );
}

describe('TableBoard delete', () => {
  it('deletes a card from its trash icon without a dialog; Undo restores it in place, Redo removes it', async () => {
    setup();
    const user = userEvent.setup();
    const trash = await screen.findByRole('button', { name: 'Delete Entry 1' });
    await user.click(trash);
    await waitFor(() => expect(api.deleteEntries).toHaveBeenCalledOnce());
    expect(api.deleteEntries).toHaveBeenCalledWith(tableId, {
      entryIds: [id(1)],
      expectedRevisions: { [id(1)]: 'rev-1' },
    });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(onOpenEntry).not.toHaveBeenCalled();
    await waitFor(() => expect(titles('To do')).toEqual(['Entry 2']));

    const undo = await screen.findByRole('button', { name: 'Undo delete 1 entry from test_items' });
    await waitFor(() => expect(undo).toBeEnabled());
    await user.click(undo);
    await waitFor(() =>
      expect(api.stepHistory).toHaveBeenCalledWith('undo', { stepId: removal.id })
    );
    await waitFor(() => expect(titles('To do')).toEqual(['Entry 1', 'Entry 2']));

    fireEvent.keyDown(document.body, { key: 'z', metaKey: true, shiftKey: true });
    await waitFor(() =>
      expect(api.stepHistory).toHaveBeenCalledWith('redo', { stepId: removal.id })
    );
    await waitFor(() => expect(titles('To do')).toEqual(['Entry 2']));
  });

  it('undoes a card delete with Cmd+Z', async () => {
    setup();
    await userEvent.click(await screen.findByRole('button', { name: 'Delete Entry 1' }));
    await waitFor(() => expect(titles('To do')).toEqual(['Entry 2']));
    await screen.findByRole('button', { name: 'Undo delete 1 entry from test_items' });
    fireEvent.keyDown(document.body, { key: 'z', metaKey: true });
    await waitFor(() =>
      expect(api.stepHistory).toHaveBeenCalledWith('undo', { stepId: removal.id })
    );
    await waitFor(() => expect(titles('To do')).toEqual(['Entry 1', 'Entry 2']));
  });

  it('does not start a drag from the trash icon', async () => {
    setup();
    const trash = await screen.findByRole('button', { name: 'Delete Entry 3' });
    fireEvent.pointerDown(trash, { button: 0, clientX: 10, clientY: 10, pointerId: 1 });
    fireEvent.pointerMove(window, { clientX: 400, clientY: 20, pointerId: 1 });
    fireEvent.pointerUp(window, { clientX: 400, clientY: 20, pointerId: 1 });
    expect(document.querySelector('[data-board-dragging]')).toBeNull();
    expect(onOpenEntry).not.toHaveBeenCalled();
  });

  it('shows the grid’s review dialog when the card changed since it was shown', async () => {
    api.deleteEntries.mockRejectedValue(
      new FetchError('Entry 1 changed since you loaded it.', 409, { conflicts: [id(1)] })
    );
    setup();
    await userEvent.click(await screen.findByRole('button', { name: 'Delete Entry 1' }));
    const dialog = await screen.findByRole('dialog', { name: 'Review changed entries' });
    expect(dialog).toHaveTextContent('Nothing was deleted');
    expect(titles('To do')).toEqual(['Entry 1', 'Entry 2']);
  });

  it('asks before clearing links other entries hold to the card', async () => {
    api.deleteEntries.mockRejectedValueOnce(
      new FetchError('Other entries link to these.', 409, {
        references: [
          { tableId: 'table-2', tableName: 'orders', fieldId: 'f', fieldName: 'Item', count: 2 },
        ],
      })
    );
    setup();
    await userEvent.click(await screen.findByRole('button', { name: 'Delete Entry 1' }));
    const dialog = await screen.findByRole('dialog', { name: 'Delete linked entries?' });
    expect(dialog).toHaveTextContent('orders · Item: 2 links');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Clear links and delete' }));
    await waitFor(() =>
      expect(api.deleteEntries).toHaveBeenLastCalledWith(tableId, {
        entryIds: [id(1)],
        expectedRevisions: { [id(1)]: 'rev-1' },
        clearReferences: true,
      })
    );
    await waitFor(() => expect(titles('To do')).toEqual(['Entry 2']));
  });

  it('deletes from the entry preview, closes it, and Undo brings the card back', async () => {
    setup();
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Open Entry 1' }));
    const dialog = await screen.findByRole('dialog', { name: 'Entry 1' });
    await user.click(within(dialog).getByRole('button', { name: 'Delete entry' }));
    await waitFor(() =>
      expect(api.deleteEntries).toHaveBeenCalledWith(tableId, {
        entryIds: [id(1)],
        expectedRevisions: { [id(1)]: 'rev-1' },
      })
    );
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    await waitFor(() => expect(titles('To do')).toEqual(['Entry 2']));

    await user.click(
      await screen.findByRole('button', { name: 'Undo delete 1 entry from test_items' })
    );
    await waitFor(() =>
      expect(api.stepHistory).toHaveBeenCalledWith('undo', { stepId: removal.id })
    );
    await waitFor(() => expect(titles('To do')).toEqual(['Entry 1', 'Entry 2']));
  });
});
