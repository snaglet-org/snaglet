import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  TableEntriesResponse,
  TableEntry,
  TableField,
  TableHistoryResponse,
  TableHistoryStep,
  TableHistoryStepRequest,
  TableHistoryStepResponse,
  UpdateTableEntryRequest,
} from '@snaglet/shared/types';
import type { ChipEditableInputProps } from '@desktop/features/rich-markdown/editor/ChipEditableInput';
import { PaneFindProvider } from '@desktop/features/pane-find/PaneFindContext';
import { __resetTableHistoryForTests } from '@desktop/features/database/tableHistory';
import { __resetEntryNameCacheForTests } from '@desktop/features/table-entries/entryNameCache';
import { TableEntriesGrid } from './TableEntriesGrid';
import { TableUndoProvider, useTableUndoController } from './tableUndo';
import { emitTableEvent } from '@desktop/features/database';

/** What the server's event stream says after any write that adds a step. */
function historyChanged() {
  setTimeout(() =>
    emitTableEvent({ type: 'table.history.changed', stack: { kind: 'user', id: 'user-test' } })
  );
}

vi.mock('@desktop/features/rich-markdown/editor', () => ({
  ChipEditableInput: ({ value, onChange, ariaLabel, autoFocus }: ChipEditableInputProps) => (
    <textarea
      aria-label={ariaLabel}
      value={value}
      autoFocus={autoFocus}
      onChange={(event) => onChange(event.target.value)}
    />
  ),
}));
vi.mock('@desktop/features/rich-markdown/renderer', () => ({
  MarkdownRenderer: ({ content }: { content: string }) => <span>{content}</span>,
}));

const api = vi.hoisted(() => ({
  entries: vi.fn<() => Promise<TableEntriesResponse>>(),
  entry: vi.fn(),
  fields: vi.fn(),
  createEntry: vi.fn(),
  updateEntry:
    vi.fn<(tableId: string, entryId: string, input: UpdateTableEntryRequest) => Promise<unknown>>(),
  reorderFields: vi.fn(),
  setFieldView: vi.fn(),
  deleteEntries: vi.fn(),
  searchEntries: vi.fn(),
  resolveEntries: vi.fn(),
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
  const core =
    await vi.importActual<typeof import('@desktop/utils/api/core')>('@desktop/utils/api/core');
  return { tablesApi: api, FetchError: core.FetchError };
});

const tableId = 'table-1111111111111-aaaaaaaaa';
const schemaVersion = 'a'.repeat(64);
const name: TableField = {
  range: false,
  id: 'field-1111111111111-aaaaaaaaa',
  tableId,
  name: 'name',
  columnName: 'name',
  description: null,
  type: 'text',
  nullable: false,
  defaultValue: '',
  referenceTableId: null,
  referenceKind: null,
  revision: 1,
  managed: false,
  position: 0,
  collapsed: false,
  isTitle: true,
  multiple: false,
  options: null,
};
const row: TableEntry = {
  id: '00000000-0000-4000-8000-000000000001',
  createdAt: '2026-01-01T00:00:00.000000Z',
  revision: 'b'.repeat(64),
  values: { [name.id]: 'Alpha' },
};
const actor = { kind: 'user' as const, id: 'user-test', name: 'Test User' };
function step(n: number, label: string): TableHistoryStep {
  return {
    id: `step-${n}`,
    actor,
    kind: 'entry.update',
    label,
    tableIds: [tableId],
    state: 'done',
    seq: n,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}
const earlier = step(1, 'Add entry to test_items');
const edit = step(2, 'Edit name in test_items');

function Pane() {
  const control = useTableUndoController(tableId, true);
  return (
    <TableUndoProvider value={control}>
      <TableEntriesGrid tableId={tableId} columns={[]} fields={[name]} />
    </TableUndoProvider>
  );
}

beforeEach(() => {
  vi.resetAllMocks();
  __resetEntryNameCacheForTests();
  __resetTableHistoryForTests();
  localStorage.clear();
  api.entries.mockResolvedValue({
    entries: [row],
    fields: [name],
    totalCount: 1,
    page: 1,
    pageSize: 25,
    schemaVersion,
    relatedEntries: {},
    relatedItems: {},
  });
  api.fields.mockResolvedValue({ fields: [name] });
  api.history.mockResolvedValue({ actor, steps: [earlier], undo: earlier, redo: null, depth: 100 });
});
afterEach(() => __resetTableHistoryForTests());

describe('TableEntriesGrid undo', () => {
  it('saves the open cell, then undoes that newest edit instead of the step it showed', async () => {
    const order: string[] = [];
    api.updateEntry.mockImplementation((_id, _entryId, input) => {
      order.push('save');
      // The save is now the newest step on the server.
      api.history.mockResolvedValue({ actor, steps: [edit], undo: edit, redo: null, depth: 100 });
      return Promise.resolve({
        entry: { ...row, values: { ...row.values, ...input.values }, revision: 'c'.repeat(64) },
        schemaVersion,
        relatedEntries: {},
        relatedItems: {},
      });
    });
    api.stepHistory.mockImplementation((_direction, input) => {
      order.push(`undo ${input?.stepId}`);
      return Promise.resolve({ step: edit, undo: earlier, redo: edit });
    });
    const user = userEvent.setup();
    render(
      <PaneFindProvider isActive>
        <Pane />
      </PaneFindProvider>
    );
    const undo = await screen.findByRole('button', { name: 'Undo add entry to test_items' });
    await user.click(screen.getByRole('button', { name: 'Edit name in entry Alpha' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'name' }), {
      target: { value: 'Alpha two' },
    });
    await user.click(undo);
    await waitFor(() => expect(order).toEqual(['save', 'undo step-2']));
    expect(screen.queryByRole('textbox', { name: 'name' })).not.toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Redo edit name in test_items' })).toBeEnabled()
    );
  });

  it('leaves Cmd/Ctrl+Z to the open cell editor', async () => {
    const user = userEvent.setup();
    render(
      <PaneFindProvider isActive>
        <Pane />
      </PaneFindProvider>
    );
    await screen.findByRole('button', { name: 'Undo add entry to test_items' });
    await user.click(screen.getByRole('button', { name: 'Edit name in entry Alpha' }));
    const editor = screen.getByRole('textbox', { name: 'name' });
    expect(fireEvent.keyDown(editor, { key: 'z', metaKey: true })).toBe(true);
    expect(api.stepHistory).not.toHaveBeenCalled();
    expect(editor).toBeInTheDocument();
  });

  it('deletes checked rows on Backspace without a dialog; Cmd+Z restores, Cmd+Shift+Z redoes', async () => {
    const second: TableEntry = {
      ...row,
      id: '00000000-0000-4000-8000-000000000002',
      values: { [name.id]: 'Beta' },
    };
    api.entries.mockResolvedValue({
      entries: [row, second],
      fields: [name],
      totalCount: 2,
      page: 1,
      pageSize: 25,
      schemaVersion,
      relatedEntries: {},
      relatedItems: {},
    });
    const removal = {
      ...step(3, 'Delete 2 entries from test_items'),
      kind: 'entry.delete' as const,
    };
    api.deleteEntries.mockImplementation(() => {
      api.history.mockResolvedValue({
        actor,
        steps: [removal],
        undo: removal,
        redo: null,
        depth: 100,
      });
      historyChanged();
      return Promise.resolve({ deletedIds: [row.id, second.id], alreadyDeleted: [] });
    });
    api.stepHistory.mockImplementation((direction) => {
      const after =
        direction === 'undo' ? { undo: earlier, redo: removal } : { undo: removal, redo: null };
      api.history.mockResolvedValue({ actor, steps: [removal], ...after, depth: 100 });
      return Promise.resolve({ step: removal, ...after });
    });
    const user = userEvent.setup();
    render(
      <PaneFindProvider isActive>
        <Pane />
      </PaneFindProvider>
    );
    await user.click(await screen.findByRole('checkbox', { name: 'Select entry Alpha' }));
    await user.click(screen.getByRole('checkbox', { name: 'Select entry Beta' }));
    await user.keyboard('{Backspace}');
    await waitFor(() => expect(api.deleteEntries).toHaveBeenCalledOnce());
    expect(api.deleteEntries).toHaveBeenCalledWith(tableId, {
      entryIds: [row.id, second.id],
      expectedRevisions: { [row.id]: row.revision, [second.id]: second.revision },
    });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();

    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: 'Undo delete 2 entries from test_items' })
      ).toBeEnabled()
    );
    fireEvent.keyDown(document.body, { key: 'z', metaKey: true });
    await waitFor(() =>
      expect(api.stepHistory).toHaveBeenCalledWith('undo', { stepId: removal.id })
    );
    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: 'Redo delete 2 entries from test_items' })
      ).toBeEnabled()
    );
    fireEvent.keyDown(document.body, { key: 'z', metaKey: true, shiftKey: true });
    await waitFor(() =>
      expect(api.stepHistory).toHaveBeenLastCalledWith('redo', { stepId: removal.id })
    );
  });

  it('keeps the confirm dialog for "Delete selected"', async () => {
    const user = userEvent.setup();
    render(
      <PaneFindProvider isActive>
        <Pane />
      </PaneFindProvider>
    );
    await user.click(await screen.findByRole('checkbox', { name: 'Select entry Alpha' }));
    await user.click(screen.getByRole('button', { name: 'Delete selected' }));
    expect(await screen.findByRole('dialog')).toBeInTheDocument();
    expect(api.deleteEntries).not.toHaveBeenCalled();
  });

  it('shows the dialog when a keyboard delete hits rows other entries link to', async () => {
    const core =
      await vi.importActual<typeof import('@desktop/utils/api/core')>('@desktop/utils/api/core');
    api.deleteEntries.mockRejectedValueOnce(
      new core.FetchError('Other entries link to these.', 409, {
        references: [
          { tableId: 'table-2', tableName: 'other', fieldId: 'f', fieldName: 'link', count: 1 },
        ],
      })
    );
    const user = userEvent.setup();
    render(
      <PaneFindProvider isActive>
        <Pane />
      </PaneFindProvider>
    );
    await user.click(await screen.findByRole('checkbox', { name: 'Select entry Alpha' }));
    await user.keyboard('{Delete}');
    expect(
      await screen.findByRole('dialog', { name: 'Delete linked entries?' })
    ).toBeInTheDocument();
  });

  it('ignores Backspace while a cell editor has focus', async () => {
    const user = userEvent.setup();
    render(
      <PaneFindProvider isActive>
        <Pane />
      </PaneFindProvider>
    );
    await user.click(await screen.findByRole('checkbox', { name: 'Select entry Alpha' }));
    await user.click(screen.getByRole('button', { name: 'Edit name in entry Alpha' }));
    const editor = screen.getByRole('textbox', { name: 'name' });
    fireEvent.keyDown(editor, { key: 'Backspace' });
    expect(api.deleteEntries).not.toHaveBeenCalled();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('undoes a new row with Cmd+Z once it is saved', async () => {
    const added = { ...step(3, 'Add entry to test_items'), kind: 'entry.create' as const };
    api.createEntry.mockImplementation(
      (_id: string, input: { id: string; values: Record<string, unknown> }) => {
        api.history.mockResolvedValue({
          actor,
          steps: [added],
          undo: added,
          redo: null,
          depth: 100,
        });
        historyChanged();
        return Promise.resolve({
          entry: { ...row, id: input.id, values: input.values },
          schemaVersion,
          relatedEntries: {},
          relatedItems: {},
        });
      }
    );
    api.stepHistory.mockResolvedValue({ step: added, undo: earlier, redo: added });
    const user = userEvent.setup();
    render(
      <PaneFindProvider isActive>
        <Pane />
      </PaneFindProvider>
    );
    await user.click(await screen.findByRole('button', { name: 'Insert a row above Alpha' }));
    const input = screen.getByRole('textbox', { name: 'name' });
    fireEvent.change(input, { target: { value: 'Gamma' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(api.createEntry).toHaveBeenCalledOnce());
    // Enter saves and keeps the editor open; leave it, then undo from the grid.
    await user.keyboard('{Escape}');
    await waitFor(() =>
      expect(screen.queryByRole('textbox', { name: 'name' })).not.toBeInTheDocument()
    );
    fireEvent.keyDown(document.body, { key: 'z', metaKey: true });
    await waitFor(() => expect(api.stepHistory).toHaveBeenCalledWith('undo', { stepId: added.id }));
  });

  it('undoes a saved cell edit with Cmd+Z', async () => {
    api.updateEntry.mockImplementation((_id, _entryId, input) => {
      api.history.mockResolvedValue({ actor, steps: [edit], undo: edit, redo: null, depth: 100 });
      return Promise.resolve({
        entry: { ...row, values: { ...row.values, ...input.values }, revision: 'c'.repeat(64) },
        schemaVersion,
        relatedEntries: {},
        relatedItems: {},
      });
    });
    api.stepHistory.mockResolvedValue({ step: edit, undo: earlier, redo: edit });
    const user = userEvent.setup();
    render(
      <PaneFindProvider isActive>
        <Pane />
      </PaneFindProvider>
    );
    await user.click(await screen.findByRole('button', { name: 'Edit name in entry Alpha' }));
    const input = screen.getByRole('textbox', { name: 'name' });
    fireEvent.change(input, { target: { value: 'Alpha two' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(api.updateEntry).toHaveBeenCalledOnce());
    (document.activeElement as HTMLElement | null)?.blur();
    fireEvent.keyDown(document.body, { key: 'z', metaKey: true });
    await waitFor(() => expect(api.stepHistory).toHaveBeenCalledWith('undo', { stepId: edit.id }));
  });
});
