import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  TableField,
  TableFieldResponse,
  UpdateTableFieldRequest,
} from '@snaglet/shared/types';
import { FetchError } from '@desktop/utils/api';
import { TableFieldEditor } from './TableFieldEditor';

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
  updateField:
    vi.fn<
      (
        tableId: string,
        fieldId: string,
        input: UpdateTableFieldRequest
      ) => Promise<TableFieldResponse>
    >(),
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
function submit() {
  const form = screen.getByRole('region').querySelector('form');
  if (!form) throw new Error('Missing settings form');
  fireEvent.submit(form);
}
function deferred<T>() {
  let complete: (value: T) => void;
  let fail: (reason: Error) => void;
  const promise = new Promise<T>((resolve, reject) => {
    complete = resolve;
    fail = reject;
  });
  return { promise, resolve: (value: T) => complete(value), reject: (error: Error) => fail(error) };
}
beforeEach(() => {
  vi.resetAllMocks();
  api.list.mockResolvedValue({ tables: [] });
  api.fields.mockResolvedValue({ fields: [field] });
  api.updateField.mockResolvedValue({ field: { ...field, revision: 3 } });
});
afterEach(async () => {
  await act(async () => cleanup());
});

describe('Select settings authoritative lifecycle', () => {
  it('discards an uncommitted local option label when Load latest replaces a stale definition', async () => {
    const pending = deferred<TableFieldResponse>();
    api.updateField.mockReturnValueOnce(pending.promise);
    const remote: TableField = {
      ...field,
      defaultValue: 'Remote',
      options: [{ id: 'opt-first', label: 'Remote', color: 'blue' }],
      revision: 2,
    };
    api.fields.mockResolvedValue({ fields: [remote] });
    const close = vi.fn();
    render(<TableFieldEditor tableId={field.tableId} field={field} onClose={close} />);
    fireEvent.change(screen.getByRole('textbox', { name: 'Description' }), {
      target: { value: 'Sent change' },
    });
    submit();
    fireEvent.click(screen.getByRole('button', { name: 'Rename option First' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Option label' }), {
      target: { value: 'Discarded local label' },
    });
    await act(async () =>
      pending.reject(new FetchError('Field changed elsewhere', 409, { field: remote }))
    );
    fireEvent.click(screen.getByRole('button', { name: 'Load latest field' }));
    await waitFor(() =>
      expect(screen.getByRole('combobox', { name: 'Default choice' })).toHaveValue('Remote')
    );
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    await waitFor(() => expect(close).toHaveBeenCalledOnce());
    expect(api.updateField).toHaveBeenCalledOnce();
  });

  it('preserves inferred options when unmount flushes a pending addition behind a conversion save', async () => {
    const pending = deferred<TableFieldResponse>();
    api.updateField.mockReturnValueOnce(pending.promise);
    const text: TableField = { ...field, type: 'text', options: null, defaultValue: null };
    const view = render(
      <TableFieldEditor tableId={field.tableId} field={text} onClose={vi.fn()} />
    );
    fireEvent.change(screen.getByRole('combobox', { name: 'Field type' }), {
      target: { value: 'select' },
    });
    submit();
    expect(api.updateField).toHaveBeenCalledOnce();
    fireEvent.change(screen.getByRole('textbox', { name: 'New option' }), {
      target: { value: 'Queued option' },
    });
    view.unmount();
    await act(async () =>
      pending.resolve({ field: { ...field, defaultValue: null, revision: 2 } })
    );
    await waitFor(() => expect(api.updateField).toHaveBeenCalledTimes(2));
    expect(api.updateField.mock.calls[1][2].options).toEqual(
      expect.arrayContaining([
        { id: 'opt-first', label: 'First', color: 'blue' },
        { id: 'opt-second', label: 'Second', color: 'green' },
        expect.objectContaining({ label: 'Queued option' }),
      ])
    );
  });
});
