import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ComponentProps } from 'react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TableDetailResponse, TableField, TableFieldsResponse } from '@snaglet/shared/types';
import { emitTableEvent, subscribeTableEvents, type TableEvent } from '@desktop/features/database';
import { CustomTableFields } from './CustomTableFields';
import { TableView } from './TableView';
import type { ChipEditableInputProps } from '@desktop/features/rich-markdown/editor/ChipEditableInput';

vi.mock('@desktop/features/rich-markdown/editor', () => ({
  ChipEditableInput: ({
    value,
    onChange,
    ariaLabel,
    disabled,
    autoFocus,
    ariaInvalid,
    ariaDescribedBy,
    onSubmit,
  }: ChipEditableInputProps) => (
    <textarea
      aria-label={ariaLabel}
      aria-invalid={ariaInvalid}
      aria-describedby={ariaDescribedBy}
      autoFocus={autoFocus}
      onKeyDown={(event) => {
        if (event.key === 'Enter') {
          event.preventDefault();
          onSubmit?.();
        }
      }}
      value={value}
      disabled={disabled}
      onChange={(event) => onChange(event.target.value)}
    />
  ),
}));

vi.mock('./TableEntriesGrid', async () => {
  const { TableGrid } = await vi.importActual<typeof import('./TableGrid')>('./TableGrid');
  return {
    TableEntriesGrid: (
      props: ComponentProps<typeof TableGrid> & {
        fieldControlsDisabled?: boolean;
        onAddField?: (trigger: HTMLButtonElement, beforeFieldId?: string) => void;
      }
    ) => (
      <>
        <button
          type="button"
          disabled={props.fieldControlsDisabled}
          onClick={(event) => props.onAddField?.(event.currentTarget)}
        >
          Add field
        </button>
        <button
          type="button"
          disabled={props.fieldControlsDisabled}
          onClick={(event) => props.onAddField?.(event.currentTarget, props.fields?.[0]?.id)}
        >
          Insert first field
        </button>
        <TableGrid {...props} emptyTitle="No entries yet" />
      </>
    ),
  };
});

const api = vi.hoisted(() => ({
  get: vi.fn(),
  fields: vi.fn(),
  createField: vi.fn(),
  updateField: vi.fn(),
  archiveField: vi.fn(),
  purgeField: vi.fn(),
  list: vi.fn(),
}));

vi.mock('@desktop/utils/api', async () => {
  const core =
    await vi.importActual<typeof import('@desktop/utils/api/core')>('@desktop/utils/api/core');
  return { tablesApi: api, FetchError: core.FetchError };
});

const tableId = 'table-1111111111111-aaaaaaaaa';
const otherId = 'table-2222222222222-bbbbbbbbb';
const field: TableField = {
  range: false,
  id: 'field-1111111111111-aaaaaaaaa',
  tableId,
  columnName: 'f_aaaaaaaaaaaaaaaaaaaaaaaa',
  name: 'Summary',
  description: 'Explain the purpose of this entry.',
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
const managed: TableField = {
  ...field,
  id: 'field-managed-id',
  columnName: 'id',
  name: 'id',
  description: null,
  type: 'uuid',
  position: 0,
  managed: true,
};
const detail: TableDetailResponse = {
  table: {
    id: tableId,
    name: 'Notes',
    origin: 'custom',
    projectId: null,
    sortOrder: 0,
    createdAt: '2026-01-01T00:00:00.000Z',
  },
  columns: [
    { name: 'id', dataType: 'uuid', nullable: false, managed: true },
    { name: field.columnName, dataType: 'text', nullable: false, managed: false },
    { name: 'unregistered', dataType: 'text', nullable: true, managed: false },
  ],
  rowCount: 0,
};
const otherDetail: TableDetailResponse = {
  table: { ...detail.table, id: otherId, name: 'Projects' },
  columns: [],
  rowCount: 0,
};

beforeEach(() => {
  vi.resetAllMocks();
  api.get.mockResolvedValue(detail);
  api.fields.mockResolvedValue({ fields: [managed, field] });
  api.list.mockResolvedValue({ tables: [detail.table] });
});

function deferred<T>() {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

describe('CustomTableFields column removal', () => {
  let tableEvents: TableEvent[] = [];
  let stop: () => void = () => undefined;

  beforeEach(() => {
    tableEvents = [];
    stop = subscribeTableEvents((event) => tableEvents.push(event));
  });

  afterEach(() => stop());

  it('offers the trash on the custom column only and opens the archive-or-delete dialog', async () => {
    render(<CustomTableFields detail={detail} />);
    const remove = await screen.findByRole('button', { name: 'Remove field Summary' });
    expect(screen.queryByRole('button', { name: 'Remove field id' })).not.toBeInTheDocument();
    await userEvent.click(remove);
    const dialog = screen.getByRole('dialog', { name: 'Remove column “Summary”?' });
    expect(dialog).toHaveTextContent('all of its values');
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(api.archiveField).not.toHaveBeenCalled();
    expect(api.purgeField).not.toHaveBeenCalled();
  });

  it('Archive archives the field, tells the table panes and closes', async () => {
    api.archiveField.mockResolvedValue({ field: { ...field, state: 'archived' }, changed: true });
    render(<CustomTableFields detail={detail} />);
    await userEvent.click(await screen.findByRole('button', { name: 'Remove field Summary' }));
    await userEvent.click(screen.getByRole('button', { name: 'Archive' }));
    await waitFor(() => expect(api.archiveField).toHaveBeenCalledWith(tableId, field.id));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(api.purgeField).not.toHaveBeenCalled();
    expect(tableEvents).toEqual([{ type: 'table.fields.changed', tableId }]);
    // The event reloads the schema.
    await waitFor(() => expect(api.fields).toHaveBeenCalledTimes(2));
  });

  it('Delete forever purges the field and closes', async () => {
    api.purgeField.mockResolvedValue({ field, changed: true });
    // The count comes from the fetched detail, not the pane's initial prop.
    api.get.mockResolvedValue({ ...detail, rowCount: 2 });
    render(<CustomTableFields detail={detail} />);
    await userEvent.click(await screen.findByRole('button', { name: 'Remove field Summary' }));
    expect(screen.getByRole('dialog')).toHaveTextContent('its values in 2 entries');
    await userEvent.click(screen.getByRole('button', { name: 'Delete forever' }));
    await waitFor(() => expect(api.purgeField).toHaveBeenCalledWith(tableId, field.id));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(api.archiveField).not.toHaveBeenCalled();
    expect(tableEvents).toEqual([{ type: 'table.fields.changed', tableId }]);
  });

  it('keeps the dialog open with the reason when the request fails', async () => {
    api.archiveField.mockRejectedValue(new Error('archive unavailable'));
    render(<CustomTableFields detail={detail} />);
    await userEvent.click(await screen.findByRole('button', { name: 'Remove field Summary' }));
    await userEvent.click(screen.getByRole('button', { name: 'Archive' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('archive unavailable');
    expect(screen.getByRole('dialog', { name: 'Remove column “Summary”?' })).toBeInTheDocument();
    expect(tableEvents).toEqual([]);
  });
});

describe('CustomTableFields', () => {
  it('shows logical names and descriptions while keeping managed and unregistered columns read-only', async () => {
    render(<CustomTableFields detail={detail} />);
    const edit = await screen.findByRole('button', { name: 'Edit field Summary' });
    act(() => edit.focus());
    expect(screen.getByRole('tooltip')).toHaveTextContent(field.description ?? '');
    expect(edit).toHaveAccessibleDescription(expect.stringContaining(field.description ?? ''));
    expect(screen.getByRole('columnheader', { name: /Summary/ })).toHaveAccessibleDescription(
      expect.stringContaining('Text')
    );
    expect(screen.getByRole('columnheader', { name: /id/ })).toHaveAttribute(
      'aria-description',
      'UUID · Managed by Snaglet'
    );
    expect(screen.queryByRole('button', { name: 'Edit field id' })).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Edit field unregistered' })
    ).not.toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: /unregistered/ })).toBeInTheDocument();
    await userEvent.click(edit);
    expect(screen.getByRole('region', { name: 'Field settings' })).toBeInTheDocument();
    expect(screen.getByLabelText('Field name')).toHaveValue('Summary');
    expect(screen.getByLabelText('Description')).toHaveValue(field.description);
    expect(screen.getByRole('button', { name: 'Add field' })).toBeDisabled();
    const dialog = screen.getByRole('dialog', { name: 'Field settings: Summary' });
    expect(edit).toHaveAttribute('aria-haspopup', 'dialog');
    expect(edit).toHaveAttribute('aria-expanded', 'true');
    expect(edit).toHaveAttribute('aria-controls', dialog.id);
    expect(edit).toBeEnabled();
    await userEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(
      screen.queryByRole('region', { name: /^(New field|Field settings)$/ })
    ).not.toBeInTheDocument();
    expect(edit).toBeEnabled();
    expect(edit).toHaveAttribute('aria-expanded', 'false');
    expect(edit).toHaveFocus();
    expect(api.updateField).not.toHaveBeenCalled();
  });

  it('closes the active field from its header without replacing the editor draft', async () => {
    render(<CustomTableFields detail={detail} />);
    const edit = await screen.findByRole('button', { name: 'Edit field Summary' });
    await userEvent.click(edit);
    expect(screen.getByRole('dialog', { name: 'Field settings: Summary' })).toBeInTheDocument();
    await userEvent.click(edit);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(edit).toHaveFocus();
    expect(api.updateField).not.toHaveBeenCalled();
  });

  it('wraps Tab from Close and handles Escape even after focus moves to the document', async () => {
    render(<CustomTableFields detail={detail} />);
    const edit = await screen.findByRole('button', { name: 'Edit field Summary' });
    await userEvent.click(edit);
    act(() => screen.getByRole('button', { name: 'Close' }).focus());
    await userEvent.tab();
    expect(screen.getByLabelText('Field name')).toHaveFocus();
    act(() => screen.getByLabelText('Field name').blur());
    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(edit).toHaveFocus();
  });

  it('opens a blank creation form and disables edits while schema loads', async () => {
    const pending = deferred<TableFieldsResponse>();
    api.fields.mockReturnValueOnce(pending.promise);
    render(<CustomTableFields detail={detail} />);
    expect(screen.getByRole('button', { name: 'Add field' })).toBeDisabled();
    expect(screen.queryByRole('button', { name: /Edit field/ })).not.toBeInTheDocument();
    await act(async () => pending.resolve({ fields: [managed, field] }));
    await userEvent.click(screen.getByRole('button', { name: 'Add field' }));
    expect(screen.getByRole('region', { name: 'New field' })).toBeInTheDocument();
    expect(screen.getByLabelText('Field name')).toHaveValue('');
    expect(api.createField).not.toHaveBeenCalled();
  });

  it('creates at the selected field boundary through the atomic placement request', async () => {
    api.createField.mockResolvedValue({ field: { ...field, name: 'first_field' } });
    render(<CustomTableFields detail={detail} />);
    await screen.findByRole('button', { name: 'Edit field Summary' });
    await userEvent.click(screen.getByRole('button', { name: 'Insert first field' }));
    fireEvent.change(screen.getByLabelText('Field name'), { target: { value: 'first_field' } });
    fireEvent.keyDown(screen.getByLabelText('Field name'), { key: 'Enter' });
    await waitFor(() =>
      expect(api.createField).toHaveBeenCalledWith(
        tableId,
        expect.objectContaining({ name: 'first_field', beforeFieldId: managed.id })
      )
    );
  });

  it('closes an untouched new-field dialog by clicking its active add trigger again', async () => {
    render(<CustomTableFields detail={detail} />);
    await screen.findByRole('button', { name: 'Edit field Summary' });
    const trigger = screen.getByRole('button', { name: 'Add field at end' });
    await userEvent.click(trigger);
    const dialog = screen.getByRole('dialog', { name: 'New field' });
    expect(trigger).toHaveAttribute('aria-expanded', 'true');
    expect(trigger).toHaveAttribute('aria-controls', dialog.id);
    expect(trigger).toBeEnabled();
    await userEvent.click(trigger);
    await waitFor(() => expect(dialog).not.toBeInTheDocument());
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
    expect(trigger).toHaveFocus();
    expect(api.createField).not.toHaveBeenCalled();
  });

  it('returns keyboard focus to the header on Escape but leaves outside clicks focused outside', async () => {
    render(
      <>
        <CustomTableFields detail={detail} />
        <button type="button">Outside the table</button>
      </>
    );
    const edit = await screen.findByRole('button', { name: 'Edit field Summary' });
    await userEvent.click(edit);
    fireEvent.keyDown(screen.getByLabelText('Field name'), { key: 'Escape' });
    expect(screen.queryByRole('region', { name: 'Field settings' })).not.toBeInTheDocument();
    expect(edit).toHaveFocus();
    await userEvent.click(edit);
    const outside = screen.getByRole('button', { name: 'Outside the table' });
    await userEvent.click(outside);
    expect(screen.queryByRole('region', { name: 'Field settings' })).not.toBeInTheDocument();
    expect(outside).toHaveFocus();
  });

  it('does not dismiss when the dropdown scroll surface receives a pointer down', async () => {
    render(<CustomTableFields detail={detail} />);
    await userEvent.click(await screen.findByRole('button', { name: 'Edit field Summary' }));
    const editor = screen.getByRole('region', { name: 'Field settings' });
    const surface = editor.closest('[data-field-editor-popover]');
    if (!surface) throw new Error('Missing anchored dropdown');
    fireEvent.pointerDown(surface);
    expect(editor).toBeInTheDocument();
  });

  it('keeps a renamed field anchored and returns focus to its current header after refresh', async () => {
    const renamed = {
      ...field,
      name: 'renamed_summary',
      columnName: 'renamed_summary',
      revision: 2,
    };
    const geometry = vi
      .spyOn(HTMLElement.prototype, 'getBoundingClientRect')
      .mockImplementation(function (this: HTMLElement) {
        return this.tagName === 'BUTTON' ? new DOMRect(420, 100, 160, 30) : new DOMRect();
      });
    try {
      api.updateField.mockImplementationOnce(() => {
        api.fields.mockResolvedValue({ fields: [managed, renamed] });
        api.get.mockResolvedValue({
          ...detail,
          columns: detail.columns.map((column) =>
            column.name === field.columnName ? { ...column, name: renamed.columnName } : column
          ),
        });
        return Promise.resolve({ field: renamed });
      });
      render(<CustomTableFields detail={detail} />);
      await userEvent.click(await screen.findByRole('button', { name: 'Edit field Summary' }));
      const input = screen.getByLabelText('Field name');
      fireEvent.change(input, { target: { value: renamed.name } });
      fireEvent.keyDown(input, { key: 'Enter' });
      const currentHeader = await screen.findByRole('button', {
        name: 'Edit field renamed_summary',
      });
      fireEvent.scroll(window);
      fireEvent.resize(window);
      expect(screen.getByRole('region').closest('[data-field-editor-popover]')).toHaveStyle({
        left: '420px',
        top: '134px',
      });
      expect(input).toHaveFocus();
      fireEvent.keyDown(input, { key: 'Escape' });
      expect(currentHeader).toHaveFocus();
    } finally {
      geometry.mockRestore();
    }
  });

  it('moves an append editor to the created field when the original end control is replaced', async () => {
    const created = {
      ...field,
      id: 'field-2222222222222-bbbbbbbbb',
      name: 'new_summary',
      columnName: 'new_summary',
      position: 4,
    };
    const geometry = vi
      .spyOn(HTMLElement.prototype, 'getBoundingClientRect')
      .mockImplementation(function (this: HTMLElement) {
        return this.tagName === 'BUTTON' ? new DOMRect(520, 100, 160, 30) : new DOMRect();
      });
    try {
      api.createField.mockImplementationOnce(() => {
        api.fields.mockResolvedValue({ fields: [managed, field, created] });
        api.get.mockResolvedValue({
          ...detail,
          columns: [
            ...detail.columns,
            { name: created.columnName, dataType: 'text', nullable: false, managed: false },
          ],
        });
        return Promise.resolve({ field: created });
      });
      render(<CustomTableFields detail={detail} />);
      await screen.findByRole('button', { name: 'Edit field Summary' });
      const append = screen.getByRole('button', { name: 'Add field at end' });
      await userEvent.click(append);
      const input = screen.getByLabelText('Field name');
      fireEvent.change(input, { target: { value: created.name } });
      fireEvent.keyDown(input, { key: 'Enter' });
      const currentHeader = await screen.findByRole('button', { name: 'Edit field new_summary' });
      expect(append.isConnected).toBe(false);
      fireEvent.scroll(window);
      fireEvent.resize(window);
      expect(screen.getByRole('region').closest('[data-field-editor-popover]')).toHaveStyle({
        left: '520px',
        top: '134px',
      });
      expect(input).toHaveFocus();
      fireEvent.keyDown(input, { key: 'Escape' });
      expect(currentHeader).toHaveFocus();
    } finally {
      geometry.mockRestore();
    }
  });

  it.each(['no interaction', 'pointer', 'keyboard'] as const)(
    'returns focus after close precedes the schema refresh, respecting %s',
    async (interaction) => {
      const created = {
        ...field,
        id: 'field-2222222222222-bbbbbbbbb',
        name: 'new_summary',
        columnName: 'new_summary',
        position: 4,
      };
      const refresh = deferred<TableFieldsResponse>();
      api.createField.mockImplementationOnce(() => {
        api.fields.mockReturnValueOnce(refresh.promise);
        api.get.mockResolvedValue({
          ...detail,
          columns: [
            ...detail.columns,
            { name: created.columnName, dataType: 'text', nullable: false, managed: false },
          ],
        });
        return Promise.resolve({ field: created });
      });
      render(
        <>
          <CustomTableFields detail={detail} />
          <button type="button">Outside the table</button>
        </>
      );
      await screen.findByRole('button', { name: 'Edit field Summary' });
      await userEvent.click(screen.getByRole('button', { name: 'Add field at end' }));
      fireEvent.change(screen.getByLabelText('Field name'), { target: { value: created.name } });
      await userEvent.click(screen.getByRole('button', { name: 'Close' }));
      await waitFor(() => expect(screen.queryByRole('region')).not.toBeInTheDocument());
      const outside = screen.getByRole('button', { name: 'Outside the table' });
      if (interaction === 'pointer') await userEvent.click(outside);
      if (interaction === 'keyboard') fireEvent.keyDown(document, { key: 'Tab' });
      await act(async () => refresh.resolve({ fields: [managed, field, created] }));
      const createdHeader = await screen.findByRole('button', { name: 'Edit field new_summary' });
      if (interaction === 'no interaction') expect(createdHeader).toHaveFocus();
      else expect(createdHeader).not.toHaveFocus();
      if (interaction === 'pointer') expect(outside).toHaveFocus();
    }
  );

  it('refreshes its schema for matching changes and reconnects, ignoring other tables', async () => {
    render(<CustomTableFields detail={detail} />);
    await screen.findByRole('button', { name: 'Edit field Summary' });
    act(() => emitTableEvent({ type: 'table.fields.changed', tableId: otherId }));
    expect(api.fields).toHaveBeenCalledTimes(1);
    api.fields.mockResolvedValueOnce({
      fields: [managed, { ...field, name: 'Remote summary', revision: 2 }],
    });
    act(() => emitTableEvent({ type: 'table.fields.changed', tableId }));
    expect(
      await screen.findByRole('button', { name: 'Edit field Remote summary' })
    ).toBeInTheDocument();
    expect(api.get).toHaveBeenCalledTimes(2);
    api.fields.mockResolvedValueOnce({
      fields: [managed, { ...field, name: 'Reconnected summary', revision: 3 }],
    });
    act(() => emitTableEvent({ type: 'tables.invalidated' }));
    expect(
      await screen.findByRole('button', { name: 'Edit field Reconnected summary' })
    ).toBeInTheDocument();
    expect(api.fields).toHaveBeenCalledTimes(3);
  });

  it('ignores an older response that finishes after a newer schema refresh', async () => {
    const first = deferred<TableFieldsResponse>();
    api.fields.mockReturnValueOnce(first.promise);
    render(<CustomTableFields detail={detail} />);
    api.fields.mockResolvedValueOnce({
      fields: [managed, { ...field, name: 'Latest summary', revision: 2 }],
    });
    act(() => emitTableEvent({ type: 'table.fields.changed', tableId }));
    expect(
      await screen.findByRole('button', { name: 'Edit field Latest summary' })
    ).toBeInTheDocument();
    await act(async () => first.resolve({ fields: [managed, field] }));
    expect(screen.getByRole('button', { name: 'Edit field Latest summary' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Edit field Summary' })).not.toBeInTheDocument();
  });

  it('keeps the open editor draft when a remote schema refresh updates the header', async () => {
    render(<CustomTableFields detail={detail} />);
    await userEvent.click(await screen.findByRole('button', { name: 'Edit field Summary' }));
    fireEvent.change(screen.getByLabelText('Field name'), { target: { value: 'My draft' } });
    api.fields.mockResolvedValueOnce({
      fields: [managed, { ...field, name: 'Remote summary', revision: 2 }],
    });
    act(() => emitTableEvent({ type: 'table.fields.changed', tableId }));
    expect(
      await screen.findByRole('button', { name: 'Edit field Remote summary' })
    ).toBeInTheDocument();
    expect(screen.getByLabelText('Field name')).toHaveValue('My draft');
    expect(api.updateField).not.toHaveBeenCalled();
  });

  it('offers retry after load failures without allowing edits against unknown metadata', async () => {
    api.fields.mockRejectedValueOnce(new Error('Schema unavailable'));
    render(<CustomTableFields detail={detail} />);
    expect(await screen.findByText('Schema unavailable')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Add field' })).toBeDisabled();
    expect(screen.queryByRole('button', { name: /Edit field/ })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Retry fields' }));
    expect(await screen.findByRole('button', { name: 'Edit field Summary' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Add field' })).toBeEnabled();
  });

  it('closes the editor when the pane switches tables and unsubscribes the previous table', async () => {
    api.updateField.mockResolvedValue({ field: { ...field, name: 'unsaved_draft', revision: 2 } });
    api.get.mockImplementation((id: string) =>
      Promise.resolve(id === tableId ? detail : otherDetail)
    );
    api.fields.mockImplementation((id: string) =>
      Promise.resolve({ fields: id === tableId ? [managed, field] : [] })
    );
    const view = render(<TableView tableId={tableId} />);
    await userEvent.click(await screen.findByRole('button', { name: 'Edit field Summary' }));
    fireEvent.change(screen.getByLabelText('Field name'), { target: { value: 'unsaved_draft' } });
    view.rerender(<TableView tableId={otherId} />);
    await waitFor(() =>
      expect(screen.queryByRole('region', { name: /^(Add|Edit) field$/ })).not.toBeInTheDocument()
    );
    expect(await screen.findByRole('button', { name: 'Projects' })).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Add field' })).toBeEnabled());
    const calls = api.fields.mock.calls.length;
    act(() => emitTableEvent({ type: 'table.fields.changed', tableId }));
    expect(api.fields).toHaveBeenCalledTimes(calls);
    expect(api.updateField).toHaveBeenCalledWith(
      tableId,
      field.id,
      expect.objectContaining({ name: 'unsaved_draft', expectedRevision: field.revision })
    );
    await userEvent.click(screen.getByRole('button', { name: 'Add field' }));
    expect(screen.getByLabelText('Field name')).toHaveValue('');
    view.unmount();
    act(() => emitTableEvent({ type: 'tables.invalidated' }));
    expect(api.fields).toHaveBeenCalledTimes(calls);
  });
});
