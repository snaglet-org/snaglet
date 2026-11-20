import { EditorView } from '@tiptap/pm/view';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  CreateTableFieldRequest,
  TableField,
  UpdateTableFieldRequest,
} from '@snaglet/shared/types';
import { formatTableName } from '@snaglet/shared/utils';
import {
  NODE_CHIP_MIME,
  nodeToChipMarkdown,
  setActiveDragChip,
  type NodeChipData,
} from '@desktop/utils/nodeChip';
import { TableFieldEditor } from './TableFieldEditor';
import { FieldEditorPopover } from './FieldEditorPopover';
import { TableDraftView } from './TableDraftView';
import { TableView } from './TableView';
import { FetchError } from '@desktop/utils/api';

const api = vi.hoisted(() => ({
  createField: vi.fn(),
  updateField: vi.fn(),
  fields: vi.fn(),
  entries: vi.fn(),
  list: vi.fn(),
  agents: vi.fn(),
  create: vi.fn(),
  get: vi.fn(),
  rename: vi.fn(),
}));
vi.mock('@desktop/utils/api', async () => {
  const core =
    await vi.importActual<typeof import('@desktop/utils/api/core')>('@desktop/utils/api/core');
  return { tablesApi: api, agentsApi: { list: api.agents }, FetchError: core.FetchError };
});

const tableId = 'table-1111111111111-aaaaaaaaa';
const chip: NodeChipData = { id: 'doc-1111111111111-aaaaaaaaa', kind: 'doc', title: 'Field guide' };
const source = nodeToChipMarkdown(chip);
const table = {
  id: tableId,
  name: 'Notes',
  origin: 'custom' as const,
  createdAt: '2026-01-01T00:00:00.000Z',
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
  vi.resetAllMocks();
  vi.spyOn(EditorView.prototype, 'posAtCoords').mockImplementation(function (this: EditorView) {
    return { pos: this.state.selection.from, inside: -1 };
  });
  api.agents.mockResolvedValue([]);
  api.list.mockResolvedValue({ tables: [table] });
  api.get.mockResolvedValue({ table, columns: [], rowCount: 0 });
  api.fields.mockResolvedValue({ fields: [] });
  api.entries.mockResolvedValue({
    entries: [],
    fields: [],
    totalCount: 0,
    page: 1,
    pageSize: 25,
    schemaVersion: 'a'.repeat(64),
    relatedEntries: {},
    relatedItems: {},
  });
  api.createField.mockImplementation((_tableId: string, input: CreateTableFieldRequest) =>
    Promise.resolve({ field: savedField(input) })
  );
  api.updateField.mockImplementation(
    (_tableId: string, _fieldId: string, input: UpdateTableFieldRequest) =>
      Promise.resolve({
        field: {
          ...input,
          id: _fieldId,
          tableId,
          columnName: 'f_aaaaaaaaaaaaaaaaaaaaaaaa',
          position: 2,
          managed: false,
          collapsed: false,
          isTitle: false,
          multiple: false,
          revision: 2,
        },
      })
  );
});
afterEach(async () => {
  await act(async () => cleanup());
  setActiveDragChip(null);
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function drop(element: HTMLElement, value: NodeChipData = chip) {
  const dataTransfer = {
    types: [NODE_CHIP_MIME],
    getData: (type: string) => (type === NODE_CHIP_MIME ? JSON.stringify(value) : ''),
    dropEffect: 'copy',
    files: [],
  };
  fireEvent.drop(element, { dataTransfer, clientX: 0, clientY: 0 });
}

function savedField(input: CreateTableFieldRequest): TableField {
  return {
    range: false,
    ...input,
    referenceKind: input.referenceKind ?? null,
    tableId,
    columnName: 'f_aaaaaaaaaaaaaaaaaaaaaaaa',
    position: 2,
    managed: false,
    collapsed: false,
    isTitle: false,
    multiple: false,
    options: null,
    revision: 1,
  };
}

function submitFieldEditor() {
  const form = screen.getByRole('region').querySelector('form');
  if (!form) throw new Error('Missing field form');
  fireEvent.submit(form);
}

describe('TableFieldEditor with real chip inputs', () => {
  it('loads authoritative settings after a 409 without saving discarded real-input text', async () => {
    const original = savedField({
      id: 'field-1111111111111-aaaaaaaaa',
      name: 'summary',
      description: 'Original context',
      type: 'text',
      nullable: true,
      defaultValue: 'Original default',
      referenceTableId: null,
    });
    const latest: TableField = {
      ...original,
      name: 'remote_summary',
      description: 'Remote context',
      defaultValue: 'Remote default',
      revision: 4,
    };
    api.updateField.mockRejectedValueOnce(
      new FetchError('Field changed elsewhere', 409, { field: latest })
    );
    api.fields.mockResolvedValue({ fields: [latest] });
    render(<TableFieldEditor tableId={tableId} field={original} onClose={vi.fn()} />);
    const user = userEvent.setup();
    const name = await screen.findByRole('textbox', { name: 'Field name' });
    await user.clear(name);
    await user.type(name, 'local_summary');
    const description = screen.getByRole('textbox', { name: 'Description' });
    await user.clear(description);
    await user.type(description, 'Discarded context');
    const defaultValue = screen.getByRole('textbox', { name: 'Default value' });
    await user.clear(defaultValue);
    await user.type(defaultValue, 'Discarded default');
    vi.useFakeTimers();
    await act(async () => submitFieldEditor());
    expect(api.updateField).toHaveBeenCalledOnce();
    expect(name).toHaveAttribute('contenteditable', 'false');
    expect(screen.getByText('Field changed elsewhere')).toBeInTheDocument();

    await act(async () =>
      fireEvent.click(screen.getByRole('button', { name: 'Load latest field' }))
    );
    expect(name).toHaveAttribute('contenteditable', 'true');
    expect(name).toHaveTextContent('remote_summary');
    expect(description).toHaveTextContent('Remote context');
    expect(defaultValue).toHaveTextContent('Remote default');
    await act(async () => vi.advanceTimersByTimeAsync(2000));
    expect(api.updateField).toHaveBeenCalledOnce();
    expect(api.createField).not.toHaveBeenCalled();
    expect(name).not.toHaveTextContent('local_summary');
    expect(description).not.toHaveTextContent('Discarded context');
  });

  it('autofocuses the real name editor inside its positioned popover and handles native Escape', async () => {
    render(<button type="button">Edit field</button>);
    const trigger = screen.getByRole('button', { name: 'Edit field' });
    const close = vi.fn();
    render(
      <FieldEditorPopover
        id="field-test-dialog"
        label="New field"
        anchor={trigger}
        onRequestClose={close}
      >
        <TableFieldEditor tableId={tableId} returnFocusTo={trigger} onClose={close} />
      </FieldEditorPopover>
    );
    const input = await screen.findByRole('textbox', { name: 'Field name' });
    await waitFor(() => expect(input).toHaveFocus());
    fireEvent.keyDown(input, { key: 'Escape', code: 'Escape', keyCode: 27 });
    expect(close).toHaveBeenCalledOnce();
    expect(api.createField).not.toHaveBeenCalled();
  });

  it('handles native Escape from the description editor without relying on React bubbling', async () => {
    const close = vi.fn();
    render(<TableFieldEditor tableId={tableId} onClose={close} />);
    const input = await screen.findByRole('textbox', { name: 'Description' });
    await userEvent.click(input);
    fireEvent.keyDown(input, { key: 'Escape', code: 'Escape', keyCode: 27 });
    expect(close).toHaveBeenCalledOnce();
  });

  it('leaves an already-handled Escape to the inner editor UI', async () => {
    const close = vi.fn();
    render(<TableFieldEditor tableId={tableId} onClose={close} />);
    const input = await screen.findByRole('textbox', { name: 'Field name' });
    const escape = new KeyboardEvent('keydown', {
      key: 'Escape',
      code: 'Escape',
      keyCode: 27,
      bubbles: true,
      cancelable: true,
    });
    escape.preventDefault();
    fireEvent(input, escape);
    expect(close).not.toHaveBeenCalled();
  });

  it('drops a node into Description, saves its canonical reference and renders it again on reopen', async () => {
    const view = render(<TableFieldEditor tableId={tableId} onClose={vi.fn()} />);
    await userEvent.type(await screen.findByLabelText('Field name'), 'summary');
    const input = await screen.findByRole('textbox', { name: 'Description' });
    expect(input).toHaveAttribute('data-pane-drop-target', 'node-chip');
    drop(input);
    await waitFor(() =>
      expect(input.querySelector(`[data-node-url="${chip.id}"]`)).toBeInTheDocument()
    );
    expect(screen.queryByRole('button', { name: 'Transclude a doc' })).not.toBeInTheDocument();
    submitFieldEditor();
    await waitFor(() =>
      expect(api.createField).toHaveBeenCalledWith(
        tableId,
        expect.objectContaining({ description: source })
      )
    );
    const request: CreateTableFieldRequest = api.createField.mock.calls[0][1];
    view.unmount();
    render(<TableFieldEditor tableId={tableId} field={savedField(request)} onClose={vi.fn()} />);
    const reopened = await screen.findByRole('textbox', { name: 'Description' });
    await waitFor(() =>
      expect(reopened.querySelector(`[data-node-url="${chip.id}"]`)).toBeInTheDocument()
    );
    expect(api.updateField).not.toHaveBeenCalled();
  });

  it('accepts node chips as a Text default and keeps other defaults chip-editable with type validation', async () => {
    render(<TableFieldEditor tableId={tableId} onClose={vi.fn()} />);
    await userEvent.type(await screen.findByLabelText('Field name'), 'brief');
    await userEvent.click(screen.getByRole('button', { name: 'Default' }));
    const input = await screen.findByRole('textbox', { name: 'Default value' });
    expect(input).toHaveAttribute('data-pane-drop-target', 'node-chip');
    drop(input);
    await waitFor(() =>
      expect(input.querySelector(`[data-node-url="${chip.id}"]`)).toBeInTheDocument()
    );
    submitFieldEditor();
    await waitFor(() =>
      expect(api.createField).toHaveBeenCalledWith(
        tableId,
        expect.objectContaining({ type: 'text', defaultValue: source })
      )
    );
    fireEvent.change(screen.getByLabelText('Field type'), { target: { value: 'number' } });
    await userEvent.click(screen.getByRole('button', { name: 'Default' }));
    const numberInput = await screen.findByLabelText('Default value');
    drop(numberInput);
    submitFieldEditor();
    expect(screen.getByRole('alert')).toHaveTextContent('Enter a decimal number');
    expect(api.createField).toHaveBeenCalledTimes(1);
    fireEvent.change(screen.getByLabelText('Field type'), { target: { value: 'date' } });
    await userEvent.click(screen.getByRole('button', { name: 'Default' }));
    expect(await screen.findByLabelText('Default value')).toHaveAttribute(
      'data-pane-drop-target',
      'node-chip'
    );
  });

  it('accepts chips in names and relation inputs without treating document IDs as table IDs', async () => {
    const view = render(<TableFieldEditor tableId={tableId} onClose={vi.fn()} />);
    const name = await screen.findByLabelText('Field name');
    drop(name);
    submitFieldEditor();
    expect(name.querySelector(`[data-node-url="${chip.id}"]`)).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent('Use only lowercase letters');
    expect(api.createField).not.toHaveBeenCalled();
    view.unmount();

    render(<TableFieldEditor tableId={tableId} onClose={vi.fn()} />);
    await userEvent.type(await screen.findByLabelText('Field name'), 'parent');
    fireEvent.change(screen.getByLabelText('Field type'), { target: { value: 'relation' } });
    const target = await screen.findByLabelText('Related table');
    drop(target);
    submitFieldEditor();
    expect(target.querySelector(`[data-node-url="${chip.id}"]`)).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent('Choose a custom table');
    expect(api.createField).not.toHaveBeenCalled();
    await userEvent.click(await screen.findByRole('button', { name: 'Notes (this table)' }));
    submitFieldEditor();
    await waitFor(() =>
      expect(api.createField).toHaveBeenCalledWith(
        tableId,
        expect.objectContaining({ referenceTableId: tableId })
      )
    );
  });

  it('retains a chip in a date default and rejects incompatible values', async () => {
    render(<TableFieldEditor tableId={tableId} onClose={vi.fn()} />);
    await userEvent.type(await screen.findByLabelText('Field name'), 'value');
    fireEvent.change(screen.getByLabelText('Field type'), { target: { value: 'date' } });
    await userEvent.click(screen.getByRole('button', { name: 'Default' }));
    const input = await screen.findByLabelText('Default value');
    drop(input);
    submitFieldEditor();
    expect(input.querySelector(`[data-node-url="${chip.id}"]`)).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent('valid default date');
    expect(api.createField).not.toHaveBeenCalled();
  });

  it('uses a boolean checkbox default instead of a chip-editable string', async () => {
    render(<TableFieldEditor tableId={tableId} onClose={vi.fn()} />);
    await userEvent.type(await screen.findByLabelText('Field name'), 'completed');
    fireEvent.change(screen.getByLabelText('Field type'), { target: { value: 'checkbox' } });
    expect(screen.getByRole('button', { name: 'Checked by default' })).not.toBePressed();
    expect(screen.queryByRole('textbox', { name: 'Default value' })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Checked by default' }));
    submitFieldEditor();
    await waitFor(() =>
      expect(api.createField).toHaveBeenCalledWith(
        tableId,
        expect.objectContaining({ type: 'checkbox', nullable: false, defaultValue: true })
      )
    );
  });

  it('keeps overlong descriptions intact and refuses saving instead of truncating chip references', async () => {
    const long: TableField = savedField({
      id: 'field-1111111111111-aaaaaaaaa',
      name: 'summary',
      description: `${'x'.repeat(2000)} ${source}`,
      type: 'text',
      nullable: true,
      defaultValue: null,
      referenceTableId: null,
    });
    render(<TableFieldEditor tableId={tableId} field={long} onClose={vi.fn()} />);
    const input = await screen.findByRole('textbox', { name: 'Description' });
    await waitFor(() =>
      expect(input.querySelector(`[data-node-url="${chip.id}"]`)).toBeInTheDocument()
    );
    expect(screen.getByRole('alert')).toHaveTextContent('at most 2000 characters');
    submitFieldEditor();
    expect(api.updateField).not.toHaveBeenCalled();
    expect(input.querySelector(`[data-node-url="${chip.id}"]`)).toBeInTheDocument();
  });
});

describe('table title chip inputs', () => {
  it('allows a chip in a new table draft, marks the invalid name and blocks creation', async () => {
    render(<TableDraftView draftId={tableId} />);
    const input = await screen.findByLabelText('Table name');
    drop(input);
    await waitFor(() => expect(input).toHaveAttribute('aria-invalid', 'true'));
    expect(input.querySelector(`[data-node-url="${chip.id}"]`)).toBeInTheDocument();
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(api.create).not.toHaveBeenCalled();
  });

  it('keeps an invalid pasted reference as plain rename text until corrected or canceled', async () => {
    render(<TableView tableId={tableId} />);
    await userEvent.dblClick(await screen.findByRole('button', { name: table.name }));
    const input = await screen.findByRole('textbox', { name: 'Rename' });
    fireEvent.change(input, { target: { value: source } });
    await waitFor(() => expect(input).toHaveAttribute('aria-invalid', 'true'));
    // Only its capitals and spaces are fixed; the brackets are left for the error.
    expect(input).toHaveValue(formatTableName(source));
    await act(async () => fireEvent.keyDown(input, { key: 'Enter' }));
    expect(api.rename).not.toHaveBeenCalled();
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(await screen.findByRole('button', { name: table.name })).toBeInTheDocument();
  });
});
