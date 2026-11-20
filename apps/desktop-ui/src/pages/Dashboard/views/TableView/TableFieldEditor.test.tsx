import { createRef, StrictMode } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TableCatalogEntry, TableField, TableFieldResponse } from '@snaglet/shared/types';
import { tableDateTimeToUtc, userTimeZone } from '@snaglet/shared/utils';
import { subscribeTableEvents, type TableEvent } from '@desktop/features/database';
import type { ChipEditableInputProps } from '@desktop/features/rich-markdown/editor/ChipEditableInput';
import { FetchError } from '@desktop/utils/api';
import { NODE_CHIP_MIME } from '@desktop/utils/nodeChip';
import { TableFieldEditor } from './TableFieldEditor';
import { toDateTimeInput } from './dateTimeInput';

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
    placeholder,
  }: ChipEditableInputProps) => (
    <textarea
      aria-label={ariaLabel}
      aria-invalid={ariaInvalid}
      aria-describedby={ariaDescribedBy}
      autoFocus={autoFocus}
      value={value}
      disabled={disabled}
      placeholder={placeholder}
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

const api = vi.hoisted(() => ({
  createField: vi.fn(),
  updateField: vi.fn(),
  fields: vi.fn(),
  list: vi.fn(),
}));
vi.mock('@desktop/utils/api', async () => {
  const core =
    await vi.importActual<typeof import('@desktop/utils/api/core')>('@desktop/utils/api/core');
  return { tablesApi: api, FetchError: core.FetchError };
});

const tableId = 'table-1111111111111-aaaaaaaaa';
const targetId = 'table-2222222222222-bbbbbbbbb';
const field: TableField = {
  range: false,
  id: 'field-1111111111111-aaaaaaaaa',
  tableId,
  columnName: 'f_aaaaaaaaaaaaaaaaaaaaaaaa',
  name: 'summary',
  description: 'Describe the entry.',
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
};
const catalog: TableCatalogEntry[] = [
  {
    id: tableId,
    name: 'Notes',
    origin: 'custom',
    projectId: null,
    sortOrder: 0,
    createdAt: '2026-01-01T00:00:00.000Z',
  },
  {
    id: targetId,
    name: 'Projects',
    origin: 'custom',
    projectId: null,
    sortOrder: 0,
    createdAt: '2026-01-01T00:00:00.000Z',
  },
  {
    id: 'table-builtin-docs',
    name: 'Docs',
    origin: 'builtin',
    projectId: null,
    sortOrder: 0,
    createdAt: '2026-01-01T00:00:00.000Z',
  },
];
let events: TableEvent[];
let stop: () => void;

beforeEach(() => {
  vi.resetAllMocks();
  api.createField.mockResolvedValue({ field: { ...field, revision: 1 } });
  api.updateField.mockResolvedValue({ field: { ...field, revision: 2 } });
  api.fields.mockResolvedValue({ fields: [field] });
  api.list.mockResolvedValue({ tables: catalog });
  events = [];
  stop = subscribeTableEvents((event) => events.push(event));
});
afterEach(async () => {
  await act(async () => cleanup());
  stop();
  vi.useRealTimers();
});

function change(label: string, value: string) {
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
}
function submit() {
  const form = screen.getByRole('region').querySelector('form');
  if (!form) throw new Error('Missing field form');
  fireEvent.submit(form);
}
function deferred<T>() {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

describe('TableFieldEditor autosave', () => {
  it('leaves untouched settings idle through StrictMode effect replay', async () => {
    render(
      <StrictMode>
        <TableFieldEditor tableId={tableId} field={field} onClose={vi.fn()} />
      </StrictMode>
    );
    await act(async () => {});
    expect(screen.queryByText('Saved')).not.toBeInTheDocument();
    expect(api.createField).not.toHaveBeenCalled();
    expect(api.updateField).not.toHaveBeenCalled();
  });

  it('makes a single relation optional even after Required was chosen for text', async () => {
    render(<TableFieldEditor tableId={tableId} onClose={vi.fn()} />);
    change('Field name', 'project');
    fireEvent.click(screen.getByRole('button', { name: 'Required' }));
    change('Field type', 'relation');
    await screen.findByLabelText('Custom tables');
    change('Related table', targetId);
    submit();
    expect(api.createField).toHaveBeenCalledWith(
      tableId,
      expect.objectContaining({ type: 'relation', nullable: true })
    );
    await screen.findByText('Saved');
  });
  it('is an inline region with no Save or Create action', () => {
    render(<TableFieldEditor tableId={tableId} onClose={vi.fn()} />);
    expect(screen.getByRole('region', { name: 'New field' })).toBeInTheDocument();
    expect(screen.getByLabelText('Field name')).toHaveFocus();
    expect(
      screen.queryByRole('button', { name: /save field|create field/i })
    ).not.toBeInTheDocument();
  });

  it('creates a configured field on commit and keeps its stable creation id', async () => {
    render(<TableFieldEditor tableId={tableId} onClose={vi.fn()} />);
    change('Field name', '  budget_total  ');
    change('Description', '  Estimated cost.  ');
    change('Field type', 'number');
    await userEvent.click(screen.getByRole('button', { name: 'Required' }));
    submit();
    await waitFor(() => expect(api.createField).toHaveBeenCalledOnce());
    expect(api.createField).toHaveBeenCalledWith(tableId, {
      id: expect.stringMatching(/^field-\d{13}-[a-z0-9]{1,12}$/),
      name: 'budget_total',
      description: 'Estimated cost.',
      type: 'number',
      nullable: false,
      defaultValue: null,
      referenceTableId: null,
      multiple: false,
    });
    expect(await screen.findByText('Saved')).toBeInTheDocument();
    expect(events).toEqual([{ type: 'table.fields.changed', tableId }]);
  });

  it('starts a new checkbox field as required and unchecked by default', async () => {
    render(<TableFieldEditor tableId={tableId} onClose={vi.fn()} />);
    change('Field name', 'completed');
    change('Field type', 'checkbox');
    expect(screen.getByRole('button', { name: 'Required' })).toBePressed();
    expect(screen.getByRole('button', { name: 'Default' })).toBePressed();
    expect(screen.getByRole('button', { name: 'Checked by default' })).not.toBePressed();
    expect(screen.queryByLabelText('Default value')).not.toBeInTheDocument();
    submit();
    await waitFor(() =>
      expect(api.createField).toHaveBeenCalledWith(
        tableId,
        expect.objectContaining({ type: 'checkbox', nullable: false, defaultValue: false })
      )
    );
  });

  it('normalizes defaults only when an existing field is explicitly changed to checkbox', async () => {
    render(
      <TableFieldEditor
        tableId={tableId}
        field={{ ...field, defaultValue: 'old default' }}
        onClose={vi.fn()}
      />
    );
    change('Field type', 'checkbox');
    submit();
    await waitFor(() =>
      expect(api.updateField).toHaveBeenCalledWith(
        tableId,
        field.id,
        expect.objectContaining({
          type: 'checkbox',
          nullable: false,
          defaultValue: false,
          expectedRevision: field.revision,
        })
      )
    );
  });

  it('preserves an existing nullable checkbox definition on open and unrelated edits', async () => {
    render(
      <TableFieldEditor
        tableId={tableId}
        field={{ ...field, type: 'checkbox' }}
        onClose={vi.fn()}
      />
    );
    expect(screen.getByRole('button', { name: 'Required' })).not.toBePressed();
    expect(screen.getByRole('button', { name: 'Default' })).not.toBePressed();
    expect(screen.queryByRole('button', { name: 'Checked by default' })).not.toBeInTheDocument();
    expect(api.updateField).not.toHaveBeenCalled();
    change('Description', 'Optional completion state.');
    submit();
    await waitFor(() =>
      expect(api.updateField).toHaveBeenCalledWith(
        tableId,
        field.id,
        expect.objectContaining({
          type: 'checkbox',
          nullable: true,
          defaultValue: null,
          description: 'Optional completion state.',
        })
      )
    );
  });

  it('edits an existing checked default as a boolean without normalizing its nullability', async () => {
    render(
      <TableFieldEditor
        tableId={tableId}
        field={{ ...field, type: 'checkbox', defaultValue: true }}
        onClose={vi.fn()}
      />
    );
    expect(screen.getByRole('button', { name: 'Checked by default' })).toBePressed();
    expect(screen.getByRole('button', { name: 'Required' })).not.toBePressed();
    expect(api.updateField).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole('button', { name: 'Checked by default' }));
    submit();
    await waitFor(() =>
      expect(api.updateField).toHaveBeenCalledWith(
        tableId,
        field.id,
        expect.objectContaining({ type: 'checkbox', nullable: true, defaultValue: false })
      )
    );
  });

  it('still allows explicitly optional checkbox fields without a default', async () => {
    render(<TableFieldEditor tableId={tableId} onClose={vi.fn()} />);
    change('Field name', 'completed');
    change('Field type', 'checkbox');
    await userEvent.click(screen.getByRole('button', { name: 'Required' }));
    await userEvent.click(screen.getByRole('button', { name: 'Default' }));
    expect(screen.queryByRole('button', { name: 'Checked by default' })).not.toBeInTheDocument();
    submit();
    await waitFor(() =>
      expect(api.createField).toHaveBeenCalledWith(
        tableId,
        expect.objectContaining({ type: 'checkbox', nullable: true, defaultValue: null })
      )
    );
  });

  it('explains the immutable title type while allowing its other metadata to change', async () => {
    render(
      <TableFieldEditor tableId={tableId} field={{ ...field, isTitle: true }} onClose={vi.fn()} />
    );
    const typeSelect = screen.getByRole('combobox', { name: 'Field type' });
    expect(typeSelect).toBeDisabled();
    expect(typeSelect).toHaveAccessibleDescription(
      'This field names each entry and must stay Text.'
    );
    change('Field type', 'checkbox');
    expect(api.updateField).not.toHaveBeenCalled();
    change('Description', 'An entry name.');
    submit();
    await waitFor(() =>
      expect(api.updateField).toHaveBeenCalledWith(
        tableId,
        field.id,
        expect.objectContaining({ type: 'text', description: 'An entry name.' })
      )
    );
  });

  it('autosaves existing metadata with the optimistic revision and preserves focus', async () => {
    render(<TableFieldEditor tableId={tableId} field={field} onClose={vi.fn()} />);
    const name = screen.getByLabelText('Field name');
    change('Field name', 'due_date');
    change('Description', '');
    fireEvent.keyDown(name, { key: 'Enter' });
    await waitFor(() => expect(api.updateField).toHaveBeenCalledOnce());
    expect(api.updateField).toHaveBeenCalledWith(tableId, field.id, {
      name: 'due_date',
      description: null,
      type: 'text',
      nullable: true,
      defaultValue: null,
      referenceTableId: null,
      multiple: false,
      expectedRevision: 1,
    });
    expect(name).toHaveFocus();
  });

  it('waits for the newest in-flight edit before closing', async () => {
    const first = deferred<TableFieldResponse>();
    const close = vi.fn();
    api.updateField
      .mockReturnValueOnce(first.promise)
      .mockResolvedValueOnce({ field: { ...field, name: 'latest', revision: 3 } });
    render(<TableFieldEditor tableId={tableId} field={field} onClose={close} />);
    const name = screen.getByLabelText('Field name');
    change('Field name', 'first');
    fireEvent.keyDown(name, { key: 'Enter' });
    await waitFor(() => expect(api.updateField).toHaveBeenCalledOnce());
    change('Field name', 'latest');
    await userEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(close).not.toHaveBeenCalled();
    await act(async () => first.resolve({ field: { ...field, name: 'first', revision: 2 } }));
    await waitFor(() => expect(api.updateField).toHaveBeenCalledTimes(2));
    expect(api.updateField).toHaveBeenLastCalledWith(
      tableId,
      field.id,
      expect.objectContaining({
        name: 'latest',
        expectedRevision: 2,
      })
    );
    await waitFor(() => expect(close).toHaveBeenCalledOnce());
  });

  it('keeps invalid drafts local and sends no mutation', async () => {
    const close = vi.fn();
    render(<TableFieldEditor tableId={tableId} onClose={close} />);
    change('Field name', 'Total!');
    submit();
    expect(await screen.findByRole('alert')).toHaveTextContent('Use only lowercase letters');
    expect(api.createField).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(close).not.toHaveBeenCalled();
    expect(screen.getByLabelText('Field name')).toHaveValue('Total!');
    await userEvent.click(screen.getByRole('button', { name: 'Discard unsaved changes' }));
    expect(close).toHaveBeenCalledOnce();
  });

  it('keeps newer pending edits dirty and flushes them before closing', async () => {
    const first = deferred<TableFieldResponse>();
    const close = vi.fn();
    api.updateField.mockReturnValueOnce(first.promise);
    render(<TableFieldEditor tableId={tableId} field={field} onClose={close} />);
    change('Field name', 'first');
    submit();
    await waitFor(() => expect(api.updateField).toHaveBeenCalledOnce());
    change('Field name', 'latest');
    await act(async () => first.resolve({ field: { ...field, name: 'first', revision: 2 } }));
    expect(screen.getByText('Waiting to save…')).toBeInTheDocument();
    expect(api.updateField).toHaveBeenCalledOnce();
    fireEvent.keyDown(screen.getByLabelText('Field name'), { key: 'Escape' });
    expect(close).not.toHaveBeenCalled();
    await waitFor(() => expect(api.updateField).toHaveBeenCalledTimes(2));
    expect(api.updateField).toHaveBeenLastCalledWith(
      tableId,
      field.id,
      expect.objectContaining({ name: 'latest', expectedRevision: 2 })
    );
    await waitFor(() => expect(close).toHaveBeenCalledOnce());
  });

  it('keeps a stale draft locked until the latest field is loaded', async () => {
    const latest = {
      ...field,
      name: 'remote_title',
      description: 'Latest description.',
      revision: 3,
    };
    api.updateField.mockRejectedValueOnce(
      new FetchError('Field changed elsewhere', 409, { field: latest })
    );
    api.fields.mockResolvedValueOnce({ fields: [latest] });
    render(<TableFieldEditor tableId={tableId} field={field} onClose={vi.fn()} />);
    change('Field name', 'local_title');
    submit();
    expect(await screen.findByText('Field changed elsewhere')).toBeInTheDocument();
    expect(screen.getByLabelText('Field name')).toHaveValue('local_title');
    expect(screen.getByLabelText('Field name')).toBeDisabled();
    await userEvent.click(screen.getByRole('button', { name: 'Load latest field' }));
    expect(screen.getByLabelText('Field name')).toHaveValue('remote_title');
    expect(screen.getByLabelText('Field name')).toBeEnabled();
  });

  it('normalizes relation names to custom table ids before autosave', async () => {
    render(<TableFieldEditor tableId={tableId} onClose={vi.fn()} />);
    change('Field name', 'project');
    change('Field type', 'relation');
    const targets = await screen.findByLabelText('Custom tables');
    expect(within(targets).getByRole('button', { name: 'Projects' })).toBeInTheDocument();
    expect(within(targets).queryByRole('button', { name: 'Docs' })).not.toBeInTheDocument();
    change('Related table', 'Projects');
    submit();
    await waitFor(() => expect(api.createField).toHaveBeenCalledOnce());
    expect(api.createField).toHaveBeenCalledWith(
      tableId,
      expect.objectContaining({
        type: 'relation',
        nullable: true,
        defaultValue: null,
        referenceTableId: targetId,
      })
    );
  });

  it('retains the insertion boundary and id on retry, then updates the created field', async () => {
    api.createField.mockRejectedValueOnce(new Error('Temporarily unavailable'));
    render(
      <TableFieldEditor tableId={tableId} beforeFieldId="field-managed-id" onClose={vi.fn()} />
    );
    change('Field name', 'summary');
    submit();
    expect(await screen.findByText('Temporarily unavailable')).toBeInTheDocument();
    const original = api.createField.mock.calls[0][1];
    expect(original).toEqual(expect.objectContaining({ beforeFieldId: 'field-managed-id' }));
    submit();
    await waitFor(() => expect(api.createField).toHaveBeenCalledTimes(2));
    expect(api.createField.mock.calls[1][1]).toEqual(original);
    expect(await screen.findByText('Saved')).toBeInTheDocument();
    change('Description', 'Saved field context');
    submit();
    await waitFor(() => expect(api.updateField).toHaveBeenCalledOnce());
    expect(api.updateField.mock.calls[0][2]).not.toHaveProperty('beforeFieldId');
  });

  it('starts a valid pending save synchronously when the host requests dismissal', async () => {
    const close = vi.fn();
    const pending = deferred<TableFieldResponse>();
    api.updateField.mockReturnValueOnce(pending.promise);
    const requestCloseRef = createRef<(() => void) | null>();
    render(
      <TableFieldEditor
        tableId={tableId}
        field={field}
        requestCloseRef={requestCloseRef}
        onClose={close}
      />
    );
    change('Field name', 'renamed');
    act(() => requestCloseRef.current?.());
    expect(api.updateField).toHaveBeenCalledOnce();
    expect(close).not.toHaveBeenCalled();
    await act(async () => pending.resolve({ field: { ...field, name: 'renamed', revision: 2 } }));
    await waitFor(() => expect(close).toHaveBeenCalledOnce());
  });

  it('preserves and focuses invalid drafts on dismissal until explicitly discarded', async () => {
    const close = vi.fn();
    const requestCloseRef = createRef<(() => void) | null>();
    render(
      <TableFieldEditor tableId={tableId} requestCloseRef={requestCloseRef} onClose={close} />
    );
    change('Field name', 'Invalid!');
    act(() => requestCloseRef.current?.());
    expect(
      screen.getByText('Keep editing, or discard your unsaved changes.').parentElement
    ).toHaveFocus();
    fireEvent.keyDown(screen.getByLabelText('Field name'), { key: 'Escape' });
    expect(close).not.toHaveBeenCalled();
    expect(screen.getByLabelText('Field name')).toHaveValue('Invalid!');
    expect(api.createField).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole('button', { name: 'Discard unsaved changes' }));
    expect(close).toHaveBeenCalledOnce();
  });

  it('keeps a failed draft open and offers retry when dismissal is requested', async () => {
    const close = vi.fn();
    api.updateField.mockRejectedValueOnce(new Error('Connection lost'));
    render(<TableFieldEditor tableId={tableId} field={field} onClose={close} />);
    change('Field name', 'renamed');
    submit();
    expect(await screen.findByText('Connection lost')).toBeInTheDocument();
    fireEvent.keyDown(screen.getByLabelText('Field name'), { key: 'Escape' });
    expect(close).not.toHaveBeenCalled();
    expect(screen.getByLabelText('Field name')).toHaveValue('renamed');
    await userEvent.click(screen.getByRole('button', { name: 'Retry save' }));
    await waitFor(() => expect(api.updateField).toHaveBeenCalledTimes(2));
    expect(await screen.findByText('Saved')).toBeInTheDocument();
    expect(screen.queryByText('Discard unsaved changes')).not.toBeInTheDocument();
  });

  it('does not discard while a retry is already writing', async () => {
    const close = vi.fn();
    const retry = deferred<TableFieldResponse>();
    api.updateField
      .mockRejectedValueOnce(new Error('Connection lost'))
      .mockReturnValueOnce(retry.promise);
    render(<TableFieldEditor tableId={tableId} field={field} onClose={close} />);
    change('Field name', 'renamed');
    submit();
    expect(await screen.findByText('Connection lost')).toBeInTheDocument();
    fireEvent.keyDown(screen.getByLabelText('Field name'), { key: 'Escape' });
    await userEvent.click(screen.getByRole('button', { name: 'Retry save' }));
    await waitFor(() => expect(api.updateField).toHaveBeenCalledTimes(2));
    const discard = screen.getByRole('button', { name: 'Discard unsaved changes' });
    expect(discard).toBeDisabled();
    await userEvent.click(discard);
    expect(close).not.toHaveBeenCalled();
    await act(async () => retry.resolve({ field: { ...field, name: 'renamed', revision: 2 } }));
    expect(await screen.findByText('Saved')).toBeInTheDocument();
  });

  it('persists the last queued write after unmount using the accepted revision', async () => {
    vi.useFakeTimers();
    try {
      const pending = deferred<TableFieldResponse>();
      api.updateField.mockReturnValueOnce(pending.promise);
      const close = vi.fn();
      const view = render(<TableFieldEditor tableId={tableId} field={field} onClose={close} />);
      change('Field name', 'first');
      submit();
      await act(async () => vi.advanceTimersByTimeAsync(0));
      expect(api.updateField).toHaveBeenCalledOnce();
      change('Field name', 'queued');
      submit();
      await act(async () => vi.advanceTimersByTimeAsync(0));
      view.unmount();
      await act(async () => pending.resolve({ field: { ...field, name: 'first', revision: 2 } }));
      await act(async () => vi.advanceTimersByTimeAsync(1000));
      expect(api.updateField).toHaveBeenCalledTimes(2);
      expect(api.updateField).toHaveBeenLastCalledWith(
        tableId,
        field.id,
        expect.objectContaining({ name: 'queued', expectedRevision: 2 })
      );
      expect(close).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('waits through slow new-field configuration and creates once with the chosen type and default', async () => {
    vi.useFakeTimers();
    const close = vi.fn();
    render(<TableFieldEditor tableId={tableId} onClose={close} />);
    change('Field name', 'com');
    await act(async () => vi.advanceTimersByTimeAsync(1000));
    change('Field name', 'completed');
    fireEvent.blur(screen.getByLabelText('Field name'), {
      relatedTarget: screen.getByLabelText('Field type'),
    });
    change('Field type', 'checkbox');
    await act(async () => vi.advanceTimersByTimeAsync(1000));
    expect(api.createField).not.toHaveBeenCalled();
    expect(api.updateField).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(api.createField).toHaveBeenCalledOnce();
    expect(api.createField).toHaveBeenCalledWith(
      tableId,
      expect.objectContaining({
        name: 'completed',
        type: 'checkbox',
        nullable: false,
        defaultValue: false,
      })
    );
    await act(async () => vi.advanceTimersByTimeAsync(1000));
    expect(api.createField).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledOnce();
  });

  it('commits a new field when name focus leaves the settings', async () => {
    render(<TableFieldEditor tableId={tableId} onClose={vi.fn()} />);
    change('Field name', 'summary');
    fireEvent.blur(screen.getByLabelText('Field name'), { relatedTarget: document.body });
    expect(api.createField).toHaveBeenCalledOnce();
    await screen.findByText('Saved');
  });

  it.each(['text', 'number', 'date'])(
    'resets inherited checkbox Required when switching to %s',
    async (type) => {
      render(
        <TableFieldEditor
          tableId={tableId}
          field={{ ...field, type: 'checkbox', nullable: false, defaultValue: false }}
          onClose={vi.fn()}
        />
      );
      change('Field type', type);
      expect(screen.getByRole('button', { name: 'Required' })).not.toBePressed();
      submit();
      expect(api.updateField).toHaveBeenCalledWith(
        tableId,
        field.id,
        expect.objectContaining({ type, nullable: true, defaultValue: null })
      );
      await screen.findByText('Saved');
    }
  );

  it('preserves an explicit Required choice across type changes', async () => {
    render(<TableFieldEditor tableId={tableId} onClose={vi.fn()} />);
    change('Field name', 'estimate');
    fireEvent.click(screen.getByRole('button', { name: 'Required' }));
    change('Field type', 'checkbox');
    change('Field type', 'number');
    expect(screen.getByRole('button', { name: 'Required' })).toBePressed();
    submit();
    expect(api.createField).toHaveBeenCalledWith(
      tableId,
      expect.objectContaining({ type: 'number', nullable: false })
    );
    await screen.findByText('Saved');
  });

  it.each(['number', 'date'])('preserves an existing Required text field as %s', async (type) => {
    render(
      <TableFieldEditor tableId={tableId} field={{ ...field, nullable: false }} onClose={vi.fn()} />
    );
    change('Field type', type);
    expect(screen.getByRole('button', { name: 'Required' })).toBePressed();
    submit();
    expect(api.updateField).toHaveBeenCalledWith(
      tableId,
      field.id,
      expect.objectContaining({ type, nullable: false })
    );
    await screen.findByText('Saved');
  });

  it('flushes a debounced edit on unmount without requiring a close click', async () => {
    vi.useFakeTimers();
    const view = render(<TableFieldEditor tableId={tableId} field={field} onClose={vi.fn()} />);
    change('Description', 'Last accepted change');
    expect(api.updateField).not.toHaveBeenCalled();
    view.unmount();
    expect(api.updateField).toHaveBeenCalledWith(
      tableId,
      field.id,
      expect.objectContaining({ description: 'Last accepted change', expectedRevision: 1 })
    );
    await act(async () => vi.advanceTimersByTimeAsync(1000));
    expect(api.updateField).toHaveBeenCalledOnce();
  });

  it('does not lose a synchronous close save when navigation immediately unmounts the editor', async () => {
    const pending = deferred<TableFieldResponse>();
    api.updateField.mockReturnValueOnce(pending.promise);
    const close = vi.fn();
    const requestCloseRef = createRef<(() => void) | null>();
    const view = render(
      <TableFieldEditor
        tableId={tableId}
        field={field}
        requestCloseRef={requestCloseRef}
        onClose={close}
      />
    );
    change('Description', 'Navigating away');
    act(() => requestCloseRef.current?.());
    expect(api.updateField).toHaveBeenCalledOnce();
    view.unmount();
    await act(async () =>
      pending.resolve({ field: { ...field, description: 'Navigating away', revision: 2 } })
    );
    expect(api.updateField).toHaveBeenCalledOnce();
    expect(close).not.toHaveBeenCalled();
  });
});

describe('TableFieldEditor relation cardinality', () => {
  const relation: TableField = {
    ...field,
    name: 'projects',
    type: 'relation',
    referenceTableId: targetId,
  };
  const multipleRelation: TableField = {
    ...relation,
    multiple: true,
    nullable: false,
    defaultValue: [],
  };

  it('does not dirty or save a repeated selection of the current related table', async () => {
    vi.useFakeTimers();
    const close = vi.fn();
    render(<TableFieldEditor tableId={tableId} field={relation} onClose={close} />);
    await act(async () => vi.advanceTimersByTimeAsync(0));
    const target = within(screen.getByLabelText('Custom tables')).getByRole('button', {
      name: 'Projects',
    });
    expect(target).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(target);
    expect(screen.getByRole('status')).toBeEmptyDOMElement();
    await act(async () => vi.advanceTimersByTimeAsync(1000));
    expect(api.updateField).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(close).toHaveBeenCalledOnce();
    expect(api.updateField).not.toHaveBeenCalled();
  });

  it('initializes an existing multiple relation and preserves it during unrelated edits', async () => {
    render(<TableFieldEditor tableId={tableId} field={multipleRelation} onClose={vi.fn()} />);
    expect(screen.getByRole('button', { name: 'Allow multiple entries' })).toBePressed();
    expect(screen.queryByRole('button', { name: 'Required' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Default' })).not.toBeInTheDocument();
    expect(api.updateField).not.toHaveBeenCalled();
    change('Description', 'Linked work in sequence.');
    submit();
    expect(api.updateField).toHaveBeenCalledWith(
      tableId,
      field.id,
      expect.objectContaining({
        type: 'relation',
        multiple: true,
        nullable: false,
        defaultValue: [],
        referenceTableId: targetId,
        description: 'Linked work in sequence.',
      })
    );
    await screen.findByText('Saved');
  });

  it.each([
    { original: relation, multiple: true, nullable: false, defaultValue: [] },
    { original: multipleRelation, multiple: false, nullable: true, defaultValue: null },
  ])('converts a relation to multiple=$multiple with canonical emptiness', async (conversion) => {
    render(<TableFieldEditor tableId={tableId} field={conversion.original} onClose={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Allow multiple entries' }));
    submit();
    expect(api.updateField).toHaveBeenCalledWith(
      tableId,
      field.id,
      expect.objectContaining({
        type: 'relation',
        multiple: conversion.multiple,
        nullable: conversion.nullable,
        defaultValue: conversion.defaultValue,
        referenceTableId: targetId,
        expectedRevision: field.revision,
      })
    );
    await screen.findByText('Saved');
  });

  it('preserves an unsafe conversion draft and shows the server error without locking settings', async () => {
    const message = 'Some entries link to more than one entry. Remove extra links first.';
    api.updateField.mockRejectedValueOnce(new FetchError(message, 409));
    const close = vi.fn();
    render(<TableFieldEditor tableId={tableId} field={multipleRelation} onClose={close} />);
    fireEvent.click(screen.getByRole('button', { name: 'Allow multiple entries' }));
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(await screen.findByText(message)).toBeInTheDocument();
    const toggle = screen.getByRole('button', { name: 'Allow multiple entries' });
    expect(toggle).not.toBePressed();
    expect(toggle).toBeEnabled();
    expect(screen.getByLabelText('Related table')).toHaveValue(targetId);
    expect(screen.queryByRole('button', { name: 'Load latest field' })).not.toBeInTheDocument();
    expect(close).not.toHaveBeenCalled();
    expect(api.updateField).toHaveBeenCalledOnce();
    expect(events).toEqual([]);
    fireEvent.click(toggle);
    submit();
    await screen.findByText('Saved');
    expect(api.updateField).toHaveBeenLastCalledWith(
      tableId,
      field.id,
      expect.objectContaining({ multiple: true, defaultValue: [], expectedRevision: 1 })
    );
  });

  it('creates a new multiple relation only on commit with its canonical default', async () => {
    vi.useFakeTimers();
    render(<TableFieldEditor tableId={tableId} onClose={vi.fn()} />);
    change('Field name', 'projects');
    change('Field type', 'relation');
    expect(screen.getByRole('button', { name: 'Allow multiple entries' })).not.toBePressed();
    change('Related table', targetId);
    fireEvent.click(screen.getByRole('button', { name: 'Allow multiple entries' }));
    await act(async () => vi.advanceTimersByTimeAsync(1000));
    expect(api.createField).not.toHaveBeenCalled();
    submit();
    expect(api.createField).toHaveBeenCalledWith(
      tableId,
      expect.objectContaining({
        type: 'relation',
        multiple: true,
        nullable: false,
        defaultValue: [],
        referenceTableId: targetId,
      })
    );
    await act(async () => vi.advanceTimersByTimeAsync(0));
    expect(api.createField).toHaveBeenCalledOnce();
  });

  it('restores single-relation metadata when toggled back before creation', async () => {
    render(<TableFieldEditor tableId={tableId} onClose={vi.fn()} />);
    change('Field name', 'project');
    change('Field type', 'relation');
    change('Related table', targetId);
    const multiple = screen.getByRole('button', { name: 'Allow multiple entries' });
    fireEvent.click(multiple);
    fireEvent.click(multiple);
    submit();
    expect(api.createField).toHaveBeenCalledWith(
      tableId,
      expect.objectContaining({
        type: 'relation',
        multiple: false,
        nullable: true,
        defaultValue: null,
      })
    );
    await screen.findByText('Saved');
  });

  it.each(['text', 'number', 'date'])(
    'resets inherited multiple-relation Required and default when switching to %s',
    async (type) => {
      render(<TableFieldEditor tableId={tableId} field={multipleRelation} onClose={vi.fn()} />);
      change('Field type', type);
      expect(screen.getByRole('button', { name: 'Required' })).not.toBePressed();
      expect(screen.getByRole('button', { name: 'Default' })).not.toBePressed();
      submit();
      expect(api.updateField).toHaveBeenCalledWith(
        tableId,
        field.id,
        expect.objectContaining({
          type,
          multiple: false,
          nullable: true,
          defaultValue: null,
          referenceTableId: null,
        })
      );
      await screen.findByText('Saved');
    }
  );
});

describe('TableFieldEditor Date includes time', () => {
  const dateField: TableField = {
    ...field,
    name: 'due_date',
    type: 'date',
    nullable: false,
    defaultValue: '2026-10-01',
  };
  const dateTimeField: TableField = {
    ...dateField,
    type: 'datetime',
    defaultValue: '2026-10-01T02:30:00.000000Z',
  };

  afterEach(() => vi.restoreAllMocks());

  it('presents one Date option and initializes datetime as Date with Include time enabled', () => {
    render(<TableFieldEditor tableId={tableId} field={dateTimeField} onClose={vi.fn()} />);
    const type = screen.getByRole('combobox', { name: 'Field type' });
    expect(type).toHaveValue('date');
    expect(within(type).getAllByRole('option', { name: 'Date' })).toHaveLength(1);
    expect(within(type).queryByRole('option', { name: 'Date and time' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Include time' })).toBePressed();
    expect(screen.getByRole('button', { name: 'Required' })).toBePressed();
    // Snaglet's picker field: the native wire value on data-value, a date and time picker.
    expect(screen.getByLabelText('Default value')).toHaveAttribute(
      'data-value',
      toDateTimeInput(String(dateTimeField.defaultValue))
    );
    expect(screen.getByLabelText('Default value')).toHaveAttribute('data-type', 'datetime-local');
    change('Field type', 'date');
    expect(screen.getByRole('button', { name: 'Include time' })).toBePressed();
    expect(api.updateField).not.toHaveBeenCalled();
  });

  it('preserves datetime and its exact default during unrelated edits', async () => {
    render(<TableFieldEditor tableId={tableId} field={dateTimeField} onClose={vi.fn()} />);
    change('Description', 'When this work is due.');
    submit();
    expect(api.updateField).toHaveBeenCalledWith(
      tableId,
      field.id,
      expect.objectContaining({
        type: 'datetime',
        nullable: false,
        defaultValue: dateTimeField.defaultValue,
        expectedRevision: field.revision,
      })
    );
    await screen.findByText('Saved');
  });

  it('enables time without dropping an existing date default or Required setting', async () => {
    render(<TableFieldEditor tableId={tableId} field={dateField} onClose={vi.fn()} />);
    expect(screen.getByRole('button', { name: 'Include time' })).not.toBePressed();
    fireEvent.click(screen.getByRole('button', { name: 'Include time' }));
    expect(screen.getByLabelText('Default value')).toHaveAttribute(
      'data-value',
      '2026-10-01T00:00'
    );
    expect((screen.getByLabelText('Default value') as HTMLInputElement).value).toMatch(
      /^Oct 1, (2026, )?12:00 AM$/
    );
    expect(screen.getByRole('button', { name: 'Required' })).toBePressed();
    submit();
    expect(api.updateField).toHaveBeenCalledWith(
      tableId,
      field.id,
      expect.objectContaining({
        type: 'datetime',
        nullable: false,
        defaultValue: '2026-10-01',
        expectedRevision: field.revision,
      })
    );
    await screen.findByText('Saved');
  });

  it.each([
    { zone: 'America/Los_Angeles', value: '2026-10-01T02:30:00.000000Z', date: '2026-09-30' },
    { zone: 'Asia/Tokyo', value: '2026-10-01T23:30:00.000000Z', date: '2026-10-02' },
    { zone: 'America/Los_Angeles', value: '2026-10-01T23:30:00-07:00', date: '2026-10-01' },
  ])(
    'disables time using the local calendar date in $zone for $value',
    async ({ zone, value, date }) => {
      const options = Intl.DateTimeFormat().resolvedOptions();
      vi.spyOn(Intl.DateTimeFormat.prototype, 'resolvedOptions').mockReturnValue({
        ...options,
        timeZone: zone,
      });
      render(
        <TableFieldEditor
          tableId={tableId}
          field={{ ...dateTimeField, defaultValue: value }}
          onClose={vi.fn()}
        />
      );
      fireEvent.click(screen.getByRole('button', { name: 'Include time' }));
      expect(screen.getByLabelText('Default value')).toHaveValue(date);
      expect(screen.getByLabelText('Default value')).toHaveAttribute('placeholder', 'YYYY-MM-DD');
      expect(screen.getByRole('button', { name: 'Required' })).toBePressed();
      submit();
      expect(api.updateField).toHaveBeenCalledWith(
        tableId,
        field.id,
        expect.objectContaining({ type: 'date', nullable: false, defaultValue: date })
      );
      await screen.findByText('Saved');
    }
  );

  it.each(['date', 'datetime'] as const)(
    'does not invent a default or change optionality when toggling an optional %s field',
    async (type) => {
      render(
        <TableFieldEditor
          tableId={tableId}
          field={{ ...dateField, type, nullable: true, defaultValue: null }}
          onClose={vi.fn()}
        />
      );
      fireEvent.click(screen.getByRole('button', { name: 'Include time' }));
      expect(screen.queryByLabelText('Default value')).not.toBeInTheDocument();
      submit();
      expect(api.updateField).toHaveBeenCalledWith(
        tableId,
        field.id,
        expect.objectContaining({
          type: type === 'date' ? 'datetime' : 'date',
          nullable: true,
          defaultValue: null,
        })
      );
      await screen.findByText('Saved');
    }
  );

  it('keeps an invalid persisted datetime default available for validation after turning time off', async () => {
    render(
      <TableFieldEditor
        tableId={tableId}
        field={{ ...dateTimeField, defaultValue: 'not a date' }}
        onClose={vi.fn()}
      />
    );
    fireEvent.click(screen.getByRole('button', { name: 'Include time' }));
    expect(screen.getByLabelText('Default value')).toHaveValue('not a date');
    submit();
    expect(await screen.findByRole('alert')).toHaveTextContent('valid default date');
    expect(api.updateField).not.toHaveBeenCalled();
  });

  it('creates a required datetime only on commit with the chosen local-time default', async () => {
    vi.useFakeTimers();
    render(<TableFieldEditor tableId={tableId} onClose={vi.fn()} />);
    change('Field name', 'appointment');
    fireEvent.click(screen.getByRole('button', { name: 'Required' }));
    change('Field type', 'date');
    fireEvent.click(screen.getByRole('button', { name: 'Include time' }));
    fireEvent.click(screen.getByRole('button', { name: 'Default' }));
    change('Default value', '2026-10-01T15:30');
    await act(async () => vi.advanceTimersByTimeAsync(1000));
    expect(api.createField).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Required' })).toBePressed();
    submit();
    expect(api.createField).toHaveBeenCalledWith(
      tableId,
      expect.objectContaining({
        type: 'datetime',
        nullable: false,
        defaultValue: tableDateTimeToUtc('2026-10-01T15:30', userTimeZone()),
        multiple: false,
        referenceTableId: null,
      })
    );
    await act(async () => vi.advanceTimersByTimeAsync(0));
    expect(api.createField).toHaveBeenCalledOnce();
  });

  it('hides the switch for non-date fields and preserves Required when leaving datetime', async () => {
    render(<TableFieldEditor tableId={tableId} field={dateTimeField} onClose={vi.fn()} />);
    change('Field type', 'number');
    expect(screen.queryByRole('button', { name: 'Include time' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'End date' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Required' })).toBePressed();
    submit();
    expect(api.updateField).toHaveBeenCalledWith(
      tableId,
      field.id,
      expect.objectContaining({ type: 'number', nullable: false, defaultValue: null })
    );
    await screen.findByText('Saved');
  });

  it('turns time off at once and warns in place that rows keep their date', async () => {
    api.updateField.mockImplementation(async (_table, _field, request) => ({
      field: { ...dateTimeField, ...request, revision: 2 },
    }));
    render(<TableFieldEditor tableId={tableId} field={dateTimeField} onClose={vi.fn()} />);
    const includeTime = screen.getByRole('button', { name: 'Include time' });
    includeTime.focus();
    await userEvent.keyboard(' ');
    expect(includeTime).not.toBePressed();
    // Focus stays on the pill: there is nothing to confirm.
    expect(includeTime).toHaveFocus();
    const warning = screen.getByText(
      'Removing times keeps each row’s date. Undo brings them back.'
    );
    expect(includeTime).toHaveAttribute('aria-describedby', warning.id);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.queryByText(/Saving removes the time/)).not.toBeInTheDocument();
    await waitFor(() =>
      expect(api.updateField).toHaveBeenCalledWith(
        tableId,
        dateTimeField.id,
        expect.objectContaining({ type: 'date' })
      )
    );
    await screen.findByText('Saved');
    // The saved field has no times; the warning stays, since undo brings them back.
    expect(screen.getByText(/Removing times keeps each row’s date/)).toBeInTheDocument();
  });

  it('turning time back on before the save keeps the exact default and drops the warning', async () => {
    render(<TableFieldEditor tableId={tableId} field={dateTimeField} onClose={vi.fn()} />);
    const includeTime = screen.getByRole('button', { name: 'Include time' });
    fireEvent.click(includeTime);
    fireEvent.click(includeTime);
    expect(includeTime).toBePressed();
    expect(screen.queryByText(/Removing times/)).not.toBeInTheDocument();
    submit();
    expect(api.updateField).toHaveBeenCalledWith(
      tableId,
      dateTimeField.id,
      expect.objectContaining({ type: 'datetime', defaultValue: dateTimeField.defaultValue })
    );
    await screen.findByText('Saved');
  });

  it('lets a saved Date field toggle time on and off again without a destructive warning', () => {
    render(<TableFieldEditor tableId={tableId} field={dateField} onClose={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Include time' }));
    expect(screen.getByRole('button', { name: 'Include time' })).toBePressed();
    fireEvent.click(screen.getByRole('button', { name: 'Include time' }));
    expect(screen.queryByText(/Removing times/)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Include time' })).not.toBePressed();
    expect(api.updateField).not.toHaveBeenCalled();
  });

  it('allows an uncreated date field to toggle time without a destructive warning', () => {
    render(<TableFieldEditor tableId={tableId} onClose={vi.fn()} />);
    change('Field type', 'date');
    fireEvent.click(screen.getByRole('button', { name: 'Include time' }));
    fireEvent.click(screen.getByRole('button', { name: 'Include time' }));
    expect(screen.queryByText(/Removing times/)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Include time' })).not.toBePressed();
    expect(api.createField).not.toHaveBeenCalled();
  });

  it('preserves every stored fractional digit when displaying a default in local time', async () => {
    const options = Intl.DateTimeFormat().resolvedOptions();
    vi.spyOn(Intl.DateTimeFormat.prototype, 'resolvedOptions').mockReturnValue({
      ...options,
      timeZone: 'America/Los_Angeles',
    });
    const value = '2026-10-01T02:30:16.832699Z';
    render(
      <TableFieldEditor
        tableId={tableId}
        field={{ ...dateTimeField, defaultValue: value }}
        onClose={vi.fn()}
      />
    );
    // Seconds and milliseconds stay in the field's value and its text.
    expect(screen.getByLabelText('Default value')).toHaveAttribute(
      'data-value',
      '2026-09-30T19:30:16.832'
    );
    expect((screen.getByLabelText('Default value') as HTMLInputElement).value).toMatch(
      /^Sep 30, (2026, )?7:30:16 PM$/
    );
    expect(api.updateField).not.toHaveBeenCalled();
    fireEvent.blur(screen.getByLabelText('Default value'));
    change('Description', 'Changed context');
    submit();
    expect(api.updateField).toHaveBeenCalledWith(
      tableId,
      dateTimeField.id,
      expect.objectContaining({ defaultValue: value })
    );
    await screen.findByText('Saved');
  });

  it('converts an edited local default to UTC before saving', async () => {
    const options = Intl.DateTimeFormat().resolvedOptions();
    vi.spyOn(Intl.DateTimeFormat.prototype, 'resolvedOptions').mockReturnValue({
      ...options,
      timeZone: 'America/Los_Angeles',
    });
    render(<TableFieldEditor tableId={tableId} field={dateTimeField} onClose={vi.fn()} />);
    change('Default value', '2026-10-01T15:40:45.123');
    submit();
    expect(api.updateField).toHaveBeenCalledWith(
      tableId,
      dateTimeField.id,
      expect.objectContaining({ defaultValue: '2026-10-01T22:40:45.123000Z' })
    );
    await screen.findByText('Saved');
  });

  it('rejects a node chip dropped into a datetime default without splitting the pane', () => {
    const paneDrop = vi.fn();
    render(
      <div onDrop={paneDrop}>
        <TableFieldEditor tableId={tableId} field={dateTimeField} onClose={vi.fn()} />
      </div>
    );
    const input = screen.getByLabelText('Default value');
    expect(input.closest('[data-pane-drop-target="node-chip"]')).not.toBeNull();
    fireEvent.drop(input, {
      dataTransfer: {
        types: [NODE_CHIP_MIME],
        getData: (type: string) =>
          type === NODE_CHIP_MIME
            ? JSON.stringify({ id: 'doc-1111111111111-aaaaaaaaa', kind: 'doc', title: 'Test note' })
            : '',
      },
    });
    expect(screen.getByRole('alert')).toHaveTextContent('Date defaults cannot contain links.');
    expect(paneDrop).not.toHaveBeenCalled();
    expect(api.updateField).not.toHaveBeenCalled();
    expect(input).toHaveAttribute(
      'data-value',
      toDateTimeInput(String(dateTimeField.defaultValue))
    );
  });
});

describe('TableFieldEditor option pills', () => {
  const pillsIn = (group: string) =>
    within(screen.getByRole('group', { name: group }))
      .getAllByRole('button')
      .map((pill) => pill.textContent);

  it('shows each field type its own pills in one row', async () => {
    render(<TableFieldEditor tableId={tableId} onClose={vi.fn()} />);
    expect(pillsIn('Field options')).toEqual(['Required', 'Default']);
    change('Field type', 'number');
    expect(pillsIn('Field options')).toEqual(['Required', 'Default']);
    change('Field type', 'date');
    expect(pillsIn('Field options')).toEqual(['Include time', 'End date', 'Required', 'Default']);
    change('Field type', 'checkbox');
    expect(pillsIn('Field options')).toEqual(['Required', 'Default']);
    change('Field type', 'select');
    expect(screen.queryByRole('group', { name: 'Field options' })).not.toBeInTheDocument();
    expect(pillsIn('Choice options')).toEqual(['Allow multiple choices', 'Required']);
    change('Field type', 'relation');
    await screen.findByLabelText('Custom tables');
    expect(screen.queryByRole('group', { name: 'Field options' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Allow multiple entries' })).not.toBePressed();
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
  });

  it('toggles a pill by click or keyboard and reports it with aria-pressed', async () => {
    render(<TableFieldEditor tableId={tableId} onClose={vi.fn()} />);
    const required = screen.getByRole('button', { name: 'Required' });
    expect(required).toHaveAttribute('aria-pressed', 'false');
    await userEvent.click(required);
    expect(required).toHaveAttribute('aria-pressed', 'true');
    required.focus();
    await userEvent.keyboard('{Enter}');
    expect(required).toHaveAttribute('aria-pressed', 'false');
    await userEvent.keyboard(' ');
    expect(required).toHaveAttribute('aria-pressed', 'true');
  });

  it('shows the default value input right under the row only while Default is on', async () => {
    render(<TableFieldEditor tableId={tableId} onClose={vi.fn()} />);
    const pill = screen.getByRole('button', { name: 'Default' });
    expect(pill).not.toBePressed();
    expect(screen.queryByLabelText('Default value')).not.toBeInTheDocument();

    await userEvent.click(pill);
    expect(pill).toBePressed();
    const input = screen.getByLabelText('Default value');
    const row = screen.getByRole('group', { name: 'Field options' });
    expect(row.compareDocumentPosition(input) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(
      input.compareDocumentPosition(screen.getByLabelText('Description')) &
        Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();

    await userEvent.click(pill);
    expect(pill).not.toBePressed();
    expect(screen.queryByLabelText('Default value')).not.toBeInTheDocument();
  });
});
