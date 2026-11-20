import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  CreateTableFieldRequest,
  TableField,
  UpdateTableFieldRequest,
} from '@snaglet/shared/types';
import { resolveSelectOptions } from '@snaglet/shared/utils';
import { TableFieldEditor } from './TableFieldEditor';
import { FetchError } from '@desktop/utils/api';

vi.mock('./TableInput', () => ({
  TableInput: ({
    label,
    value,
    onChange,
    disabled,
  }: {
    label: string;
    value: string;
    onChange: (value: string) => void;
    disabled?: boolean;
  }) => (
    <input
      aria-label={label}
      value={value}
      disabled={disabled}
      onChange={(event) => onChange(event.target.value)}
    />
  ),
}));
const api = vi.hoisted(() => ({
  createField: vi.fn(),
  updateField: vi.fn(),
  fields: vi.fn(),
  list: vi.fn(),
  selectOptionUsage: vi.fn(),
}));
vi.mock('@desktop/utils/api', async () => ({
  ...(await vi.importActual<typeof import('@desktop/utils/api/core')>('@desktop/utils/api/core')),
  tablesApi: api,
}));

const field: TableField = {
  range: false,
  id: 'field-1111111111111-aaaaaaaaa',
  tableId: 'table-1111111111111-aaaaaaaaa',
  columnName: 'status',
  name: 'status',
  description: null,
  type: 'select',
  nullable: true,
  defaultValue: 'First',
  referenceTableId: null,
  referenceKind: null,
  multiple: false,
  options: [
    { id: 'opt-first', label: 'First', color: 'blue' },
    { id: 'opt-second', label: 'Second', color: 'green' },
  ],
  position: 3,
  managed: false,
  collapsed: false,
  isTitle: false,
  revision: 1,
};
function saved(input: CreateTableFieldRequest | UpdateTableFieldRequest): TableField {
  return {
    ...field,
    ...input,
    multiple: !!input.multiple,
    options:
      input.type === 'select'
        ? resolveSelectOptions(field.options, input.options ?? [], () => 'opt-generated')
        : null,
    revision: 2,
  };
}
function change(label: string, value: string) {
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
}
function submit() {
  const form = screen.getByRole('region').querySelector('form');
  if (!form) throw new Error('Missing settings form');
  fireEvent.submit(form);
}
function rename(label = 'Renamed') {
  fireEvent.click(screen.getByRole('button', { name: 'Rename option First' }));
  change('Option label', label);
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

beforeEach(() => {
  vi.resetAllMocks();
  api.list.mockResolvedValue({ tables: [] });
  api.fields.mockResolvedValue({ fields: [field] });
  api.createField.mockImplementation((_id: string, input: CreateTableFieldRequest) =>
    Promise.resolve({ field: saved(input) })
  );
  api.updateField.mockImplementation(
    (_id: string, _field: string, input: UpdateTableFieldRequest) =>
      Promise.resolve({ field: saved(input) })
  );
  api.selectOptionUsage.mockResolvedValue({ usage: { 'opt-first': 2 } });
});
afterEach(async () => {
  await act(async () => cleanup());
  vi.useRealTimers();
});

describe('Select field settings integration', () => {
  it('creates the complete multi-select definition only on commit', async () => {
    vi.useFakeTimers();
    render(<TableFieldEditor tableId={field.tableId} onClose={vi.fn()} />);
    change('Field name', 'tags');
    change('Field type', 'select');
    change('New option', 'First');
    fireEvent.keyDown(screen.getByLabelText('New option'), { key: 'Enter' });
    fireEvent.click(screen.getByRole('button', { name: 'Allow multiple choices' }));
    fireEvent.click(screen.getByRole('button', { name: 'Default First' }));
    await act(async () => vi.advanceTimersByTime(700));
    expect(api.createField).not.toHaveBeenCalled();
    submit();
    await act(async () => {});
    expect(api.createField).toHaveBeenCalledWith(
      field.tableId,
      expect.objectContaining({
        name: 'tags',
        type: 'select',
        multiple: true,
        nullable: false,
        defaultValue: ['First'],
        options: [{ id: expect.stringMatching(/^opt-/), label: 'First', color: 'blue' }],
      })
    );
  });

  it('flushes a pending option rename and its default when Close is clicked', async () => {
    const close = vi.fn();
    render(<TableFieldEditor tableId={field.tableId} field={field} onClose={close} />);
    rename();
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    await waitFor(() => expect(close).toHaveBeenCalledOnce());
    expect(api.updateField).toHaveBeenCalledWith(
      field.tableId,
      field.id,
      expect.objectContaining({
        defaultValue: 'Renamed',
        options: [{ ...field.options![0], label: 'Renamed' }, field.options![1]],
      })
    );
  });

  it('flushes a pending option rename when navigation unmounts settings without blur', async () => {
    const view = render(
      <TableFieldEditor tableId={field.tableId} field={field} onClose={vi.fn()} />
    );
    rename();
    view.unmount();
    await waitFor(() =>
      expect(api.updateField).toHaveBeenCalledWith(
        field.tableId,
        field.id,
        expect.objectContaining({
          defaultValue: 'Renamed',
          options: expect.arrayContaining([
            expect.objectContaining({ id: 'opt-first', label: 'Renamed' }),
          ]),
        })
      )
    );
  });

  it('does not let another settings timer commit a half-typed option label', async () => {
    vi.useFakeTimers();
    render(<TableFieldEditor tableId={field.tableId} field={field} onClose={vi.fn()} />);
    change('Description', 'New context');
    rename('F');
    await act(async () => vi.advanceTimersByTime(500));
    expect(api.updateField).toHaveBeenCalledOnce();
    expect(api.updateField.mock.calls[0][2].options[0].label).toBe('First');
    expect(screen.getByLabelText('Option label')).toHaveValue('F');
    fireEvent.keyDown(screen.getByLabelText('Option label'), { key: 'Escape' });
  });

  it('keeps invalid local labels open instead of dropping them on Close', () => {
    const close = vi.fn();
    render(<TableFieldEditor tableId={field.tableId} field={field} onClose={close} />);
    rename('second');
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(close).not.toHaveBeenCalled();
    expect(api.updateField).not.toHaveBeenCalled();
    expect(screen.getByLabelText('Option label')).toHaveAttribute('aria-invalid', 'true');
  });

  it('requires usage confirmation before removing an option and its default', async () => {
    render(<TableFieldEditor tableId={field.tableId} field={field} onClose={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Remove option First' }));
    expect(await screen.findByText('Remove “First” from 2 rows?')).toBeInTheDocument();
    expect(api.updateField).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Remove option' }));
    submit();
    await waitFor(() =>
      expect(api.updateField).toHaveBeenCalledWith(
        field.tableId,
        field.id,
        expect.objectContaining({ options: [field.options![1]], defaultValue: null })
      )
    );
  });

  it('preserves queued option edits when the preceding save returns', async () => {
    const pending = deferred<{ field: TableField }>();
    api.updateField.mockReturnValueOnce(pending.promise);
    render(<TableFieldEditor tableId={field.tableId} field={field} onClose={vi.fn()} />);
    change('Description', 'New context');
    submit();
    rename();
    fireEvent.keyDown(screen.getByLabelText('Option label'), { key: 'Enter' });
    submit();
    await act(async () =>
      pending.resolve({ field: { ...field, description: 'New context', revision: 2 } })
    );
    await waitFor(() => expect(api.updateField).toHaveBeenCalledTimes(2));
    expect(api.updateField.mock.calls[1][2]).toMatchObject({
      expectedRevision: 2,
      defaultValue: 'Renamed',
      options: [{ id: 'opt-first', label: 'Renamed' }, { id: 'opt-second' }],
    });
  });

  it('adopts options discovered during a text conversion in later saves', async () => {
    const text: TableField = { ...field, type: 'text', options: null, defaultValue: null };
    api.updateField.mockResolvedValueOnce({ field: { ...field, defaultValue: null, revision: 2 } });
    render(<TableFieldEditor tableId={field.tableId} field={text} onClose={vi.fn()} />);
    change('Field type', 'select');
    submit();
    await screen.findByRole('button', { name: 'Rename option First' });
    change('Description', 'Keep inferred options');
    submit();
    expect(api.updateField.mock.calls[1][2]).toMatchObject({
      options: field.options,
      expectedRevision: 2,
    });
  });

  it('loads authoritative options after a conflict without resaving the rejected list', async () => {
    vi.useFakeTimers();
    api.updateField.mockRejectedValueOnce(new FetchError('Field changed', 409, { field }));
    render(<TableFieldEditor tableId={field.tableId} field={field} onClose={vi.fn()} />);
    rename();
    fireEvent.keyDown(screen.getByLabelText('Option label'), { key: 'Enter' });
    submit();
    await act(async () => {});
    fireEvent.click(screen.getByRole('button', { name: 'Load latest field' }));
    await act(async () => {});
    await act(async () => vi.advanceTimersByTime(1000));
    expect(screen.getByRole('button', { name: 'Rename option First' })).toBeInTheDocument();
    expect(api.updateField).toHaveBeenCalledOnce();
  });
});
