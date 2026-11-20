import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TableField, UpdateTableFieldRequest } from '@snaglet/shared/types';
import type { ChipEditableInputProps } from '@desktop/features/rich-markdown/editor/ChipEditableInput';
import { __resetCalendarStoreForTests } from '@desktop/features/calendar/calendarStore';
import { __resetCalendarUndoForTests } from '@desktop/features/calendar/calendarUndo';
import { TableFieldEditor } from '../TableFieldEditor';

vi.mock('@desktop/features/rich-markdown/editor', () => ({
  ChipEditableInput: ({ value, onChange, ariaLabel, disabled }: ChipEditableInputProps) => (
    <textarea
      aria-label={ariaLabel}
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
}));
vi.mock('@desktop/utils/api', async () => {
  const core =
    await vi.importActual<typeof import('@desktop/utils/api/core')>('@desktop/utils/api/core');
  return { tablesApi: api, FetchError: core.FetchError };
});
const calApi = vi.hoisted(() => ({ listCalendars: vi.fn() }));
vi.mock('@desktop/features/calendar/calendarApi', () => ({ calendarApi: calApi }));
vi.mock('@desktop/utils/toast', () => ({ showToast: vi.fn(), dismissToast: vi.fn() }));

const tableId = 'table-1111111111111-aaaaaaaaa';
function f(extra: Partial<TableField>): TableField {
  return {
    id: 'field-1111111111111-aaaaaaaaa',
    tableId,
    columnName: 'dates',
    name: 'dates',
    description: null,
    type: 'date',
    nullable: true,
    defaultValue: null,
    referenceTableId: null,
    referenceKind: null,
    multiple: false,
    range: false,
    options: null,
    position: 0,
    managed: false,
    revision: 3,
    collapsed: false,
    isTitle: false,
    ...extra,
  };
}
const day = f({});
const trip = f({ range: true });
const meeting = f({ type: 'datetime', range: true });
const status = f({
  id: 'field-4444444444444-ddddddddd',
  name: 'status',
  type: 'select',
  options: [{ id: 'opt-done', label: 'Done', color: 'green' }],
});

beforeEach(() => {
  vi.resetAllMocks();
  __resetCalendarStoreForTests();
  __resetCalendarUndoForTests();
  calApi.listCalendars.mockResolvedValue({ calendars: [] });
  api.fields.mockResolvedValue({ fields: [day, status] });
  api.list.mockResolvedValue({ tables: [] });
  // The server echoes what it saved.
  api.updateField.mockImplementation(
    async (_table: string, _field: string, request: UpdateTableFieldRequest) => ({
      field: { ...day, ...request, range: request.range ?? false, revision: 4 },
    })
  );
  api.createField.mockImplementation(async (_table: string, request: TableField) => ({
    field: { ...day, ...request, revision: 1 },
  }));
});
afterEach(async () => {
  await act(async () => cleanup());
});

function submit() {
  fireEvent.submit(screen.getByRole('region').querySelector('form')!);
}
const sent = () => api.updateField.mock.calls[0]?.[2] as UpdateTableFieldRequest;

describe('TableFieldEditor — End date', () => {
  it('sits right after Include time, for date fields only, and the type stays Date', () => {
    render(<TableFieldEditor tableId={tableId} field={trip} onClose={vi.fn()} />);
    const pills = within(screen.getByRole('group', { name: 'Field options' }))
      .getAllByRole('button')
      .map((item) => item.textContent);
    expect(pills.slice(0, 2)).toEqual(['Include time', 'End date']);
    expect(screen.getByRole('button', { name: 'End date' })).toBePressed();
    const type = screen.getByRole('combobox', { name: 'Field type' });
    expect(type).toHaveValue('date');
    expect(within(type).getByRole('option', { name: 'Date' })).toBeInTheDocument();
    fireEvent.change(type, { target: { value: 'text' } });
    expect(screen.queryByRole('button', { name: 'End date' })).not.toBeInTheDocument();
  });

  it('turning it on sends range: true and hides the default value, with a note', async () => {
    render(
      <TableFieldEditor
        tableId={tableId}
        field={{ ...day, defaultValue: '2026-10-01' }}
        onClose={vi.fn()}
      />
    );
    expect(screen.getByRole('button', { name: 'Default' })).toBePressed();
    fireEvent.click(screen.getByRole('button', { name: 'End date' }));
    expect(screen.getByRole('button', { name: 'End date' })).toBePressed();
    expect(screen.queryByRole('button', { name: 'Default' })).toBeNull();
    expect(screen.queryByLabelText('Default value')).toBeNull();
    expect(screen.getByText('Fields with an end date have no default value.')).toBeVisible();
    submit();
    await waitFor(() => expect(api.updateField).toHaveBeenCalledTimes(1));
    expect(sent()).toMatchObject({ type: 'date', range: true, defaultValue: null });
    await screen.findByText('Saved');
  });

  it('sends range for date fields only, and false for a new date field', async () => {
    render(<TableFieldEditor tableId={tableId} onClose={vi.fn()} />);
    fireEvent.change(screen.getByLabelText('Field name'), { target: { value: 'notes' } });
    submit();
    await waitFor(() => expect(api.createField).toHaveBeenCalledTimes(1));
    expect(api.createField.mock.calls[0]?.[1]).not.toHaveProperty('range');
    expect(api.createField.mock.calls[0]?.[1]).toMatchObject({ type: 'text', multiple: false });
    await act(async () => cleanup());

    render(<TableFieldEditor tableId={tableId} onClose={vi.fn()} />);
    fireEvent.change(screen.getByLabelText('Field name'), { target: { value: 'due' } });
    fireEvent.change(screen.getByLabelText('Field type'), { target: { value: 'date' } });
    submit();
    await waitFor(() => expect(api.createField).toHaveBeenCalledTimes(2));
    expect(api.createField.mock.calls[1]?.[1]).toMatchObject({ type: 'date', range: false });
  });

  it('turning it off on a saved range warns in place, saves at once and keeps the warning', async () => {
    render(<TableFieldEditor tableId={tableId} field={trip} onClose={vi.fn()} />);
    const endDate = screen.getByRole('button', { name: 'End date' });
    endDate.focus();
    await userEvent.keyboard(' ');
    expect(endDate).not.toBePressed();
    // Focus stays on the pill: there is nothing to confirm.
    expect(endDate).toHaveFocus();
    const warning = screen.getByText(
      'Removing end dates keeps each row’s start. Undo brings them back.'
    );
    expect(endDate).toHaveAttribute('aria-describedby', warning.id);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.queryByRole('button', { name: /Remove|Keep/ })).toBeNull();
    await waitFor(() => expect(api.updateField).toHaveBeenCalledTimes(1));
    expect(sent()).toMatchObject({ type: 'date', range: false });
    await screen.findByText('Saved');
    expect(screen.getByText(/Removing end dates keeps each row’s start/)).toBeInTheDocument();
    // On again: nothing is dropped.
    fireEvent.click(endDate);
    expect(screen.queryByText(/Removing end dates/)).toBeNull();
  });

  it('does not warn for a field that had no end dates', () => {
    render(<TableFieldEditor tableId={tableId} field={day} onClose={vi.fn()} />);
    const endDate = screen.getByRole('button', { name: 'End date' });
    fireEvent.click(endDate);
    fireEvent.click(endDate);
    expect(endDate).not.toBePressed();
    expect(screen.queryByText(/Removing end dates/)).toBeNull();
  });

  it('turning time off on a datetime range warns that rows keep their dates', async () => {
    render(<TableFieldEditor tableId={tableId} field={meeting} onClose={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Include time' }));
    expect(
      screen.getByText('Removing times keeps each row’s dates. Undo brings them back.')
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'End date' })).toBePressed();
    await waitFor(() => expect(api.updateField).toHaveBeenCalledTimes(1));
    expect(sent()).toMatchObject({ type: 'date', range: true });
  });

  it('keeps Repeat options while End date is on (a range repeats on its start)', () => {
    render(<TableFieldEditor tableId={tableId} field={day} onClose={vi.fn()} />);
    expect(screen.getByRole('button', { name: /Repeat options/ })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'End date' }));
    expect(screen.getByRole('button', { name: /Repeat options/ })).toBeInTheDocument();
    expect(screen.queryByText(/support end dates/)).toBeNull();
  });

  it('a repeating field turns End date on and keeps its repeat', async () => {
    const repeating = f({
      recurrence: {
        statusFieldId: status.id,
        doneOptionIds: ['opt-done'],
        resetOptionId: null,
      },
    });
    render(<TableFieldEditor tableId={tableId} field={repeating} onClose={vi.fn()} />);
    const endDate = screen.getByRole('button', { name: 'End date' });
    expect(endDate).toBeEnabled();
    fireEvent.click(endDate);
    expect(endDate).toBePressed();
    submit();
    await waitFor(() => expect(api.updateField).toHaveBeenCalledTimes(1));
    // The untouched repeat is not re-sent; the server keeps it.
    expect(sent()).toMatchObject({ range: true });
    expect(sent()).not.toHaveProperty('recurrence');
  });
});
