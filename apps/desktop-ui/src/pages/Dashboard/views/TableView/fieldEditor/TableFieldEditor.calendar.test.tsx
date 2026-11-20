import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Calendar, TableField } from '@snaglet/shared/types';
import type { ChipEditableInputProps } from '@desktop/features/rich-markdown/editor/ChipEditableInput';
import { __resetCalendarStoreForTests } from '@desktop/features/calendar/calendarStore';
import {
  __resetCalendarUndoForTests,
  undoCalendarStep,
} from '@desktop/features/calendar/calendarUndo';
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
  setFieldCalendar: vi.fn(),
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
    columnName: 'due',
    name: 'due',
    description: null,
    type: 'datetime',
    nullable: true,
    defaultValue: null,
    referenceTableId: null,
    referenceKind: null,
    multiple: false,
    options: null,
    position: 0,
    managed: false,
    revision: 3,
    collapsed: false,
    isTitle: false,
    ...extra,
  } as TableField;
}
const due = f({});
const ends = f({ id: 'field-2222222222222-bbbbbbbbb', name: 'ends', columnName: 'ends' });
const day = f({ id: 'field-3333333333333-ccccccccc', name: 'day', type: 'date' });
const status = f({
  id: 'field-4444444444444-ddddddddd',
  name: 'status',
  type: 'select',
  options: [
    { id: 'opt-todo', label: 'To do', color: 'gray' },
    { id: 'opt-doing', label: 'Doing', color: 'blue' },
    { id: 'opt-done', label: 'Done', color: 'green' },
  ],
});
function cal(id: string, title: string, extra: Partial<Calendar> = {}): Calendar {
  return {
    id,
    title,
    description: '',
    timeZone: 'UTC',
    color: 'blue',
    isDefault: false,
    sortOrder: 0,
    revision: 1,
    createdAt: '',
    updatedAt: '',
    boundFields: [],
    ...extra,
  };
}
const work = cal('cal-work', 'Work');
const home = cal('cal-home', 'Home', { color: 'green', sortOrder: 1 });

beforeEach(() => {
  vi.resetAllMocks();
  __resetCalendarStoreForTests();
  __resetCalendarUndoForTests();
  calApi.listCalendars.mockResolvedValue({ calendars: [work, home] });
  api.fields.mockResolvedValue({ fields: [due, ends, day, status] });
  api.list.mockResolvedValue({ tables: [] });
});
afterEach(async () => {
  await act(async () => cleanup());
  vi.useRealTimers();
});

function submit() {
  fireEvent.submit(screen.getByRole('region').querySelector('form')!);
}
function select(label: string, value: string) {
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
}
async function calendarsLoaded() {
  await screen.findByRole('option', { name: 'Work' });
}

describe('Calendar section — create mode', () => {
  it('defaults to None and sends no binding when untouched', async () => {
    api.createField.mockResolvedValue({ field: f({ id: 'field-new', revision: 1 }) });
    render(<TableFieldEditor tableId={tableId} onClose={vi.fn()} />);
    fireEvent.change(screen.getByLabelText('Field name'), { target: { value: 'due_on' } });
    select('Field type', 'date');
    await calendarsLoaded();
    expect((screen.getByLabelText('Show on calendar') as HTMLSelectElement).value).toBe('');
    expect(screen.queryByLabelText('End time from')).toBeNull();
    submit();
    await waitFor(() => expect(api.createField).toHaveBeenCalledTimes(1));
    const body = api.createField.mock.calls[0][1];
    expect(body).not.toHaveProperty('calendarId');
    expect(body).not.toHaveProperty('recurrence');
  });

  it('puts the chosen calendar in the create request, with no calendar undo step', async () => {
    api.createField.mockResolvedValue({ field: f({ id: 'field-new', calendarId: 'cal-home' }) });
    render(<TableFieldEditor tableId={tableId} onClose={vi.fn()} />);
    fireEvent.change(screen.getByLabelText('Field name'), { target: { value: 'start' } });
    select('Field type', 'date');
    fireEvent.click(screen.getByRole('button', { name: 'Include time' }));
    await calendarsLoaded();
    select('Show on calendar', 'cal-home');
    expect(screen.queryByText(/shows on/)).toBeNull();
    // No "End time from": a range's end comes from the field itself.
    expect(screen.queryByLabelText('End time from')).toBeNull();
    submit();
    await waitFor(() => expect(api.createField).toHaveBeenCalledTimes(1));
    const body = api.createField.mock.calls[0][1];
    expect(body).toMatchObject({ type: 'datetime', calendarId: 'cal-home' });
    expect(body).not.toHaveProperty('calendarEndFieldId');
    // Create: undo is the table history's create step, not a reverse PATCH.
    await expect(undoCalendarStep()).resolves.toBeUndefined();
    expect(api.updateField).not.toHaveBeenCalled();
  });

  it('offers "Default calendar (new)" when no calendar is active', async () => {
    calApi.listCalendars.mockResolvedValue({
      calendars: [],
    });
    api.createField.mockResolvedValue({ field: f({ id: 'field-new', type: 'date' }) });
    render(<TableFieldEditor tableId={tableId} onClose={vi.fn()} />);
    fireEvent.change(screen.getByLabelText('Field name'), { target: { value: 'due_on' } });
    select('Field type', 'date');
    await screen.findByRole('option', { name: 'Default calendar (new)' });
    expect(screen.queryByRole('option', { name: 'Old' })).toBeNull();
    select('Show on calendar', 'default');
    submit();
    await waitFor(() => expect(api.createField).toHaveBeenCalledTimes(1));
    expect(api.createField.mock.calls[0][1]).toMatchObject({ calendarId: 'default' });
  });
});

describe('Calendar section — edit mode', () => {
  it('shows the saved calendar and sends no binding keys for an unrelated edit', async () => {
    const bound = f({ calendarId: 'cal-work' });
    api.updateField.mockResolvedValue({ field: { ...bound, name: 'due_date', revision: 4 } });
    render(<TableFieldEditor tableId={tableId} field={bound} onClose={vi.fn()} />);
    await calendarsLoaded();
    expect((screen.getByLabelText('Show on calendar') as HTMLSelectElement).value).toBe('cal-work');
    expect(screen.queryByLabelText('End time from')).toBeNull();
    fireEvent.change(screen.getByLabelText('Field name'), { target: { value: 'due_date' } });
    submit();
    await waitFor(() => expect(api.updateField).toHaveBeenCalledTimes(1));
    const body = api.updateField.mock.calls[0][2];
    expect(body).not.toHaveProperty('calendarId');
    expect(body).not.toHaveProperty('calendarEndFieldId');
  });

  it('bind saves in the field PATCH; undo is the reverse binding write with the returned revision', async () => {
    api.updateField.mockResolvedValueOnce({ field: f({ calendarId: 'cal-home', revision: 4 }) });
    api.setFieldCalendar.mockResolvedValueOnce({ field: f({ calendarId: null, revision: 5 }) });
    render(<TableFieldEditor tableId={tableId} field={due} onClose={vi.fn()} />);
    await calendarsLoaded();
    select('Show on calendar', 'cal-home');
    submit();
    await waitFor(() => expect(api.updateField).toHaveBeenCalledTimes(1));
    expect(api.updateField.mock.calls[0][2]).toMatchObject({
      calendarId: 'cal-home',
      expectedRevision: 3,
    });
    expect(api.updateField.mock.calls[0][2]).not.toHaveProperty('calendarEndFieldId');
    await act(async () => undoCalendarStep());
    expect(api.updateField).toHaveBeenCalledTimes(1);
    expect(api.setFieldCalendar).toHaveBeenCalledWith(tableId, due.id, {
      calendarId: null,
      expectedRevision: 4,
    });
  });

  it('unbind: undo re-binds to the previous calendar', async () => {
    const bound = f({ calendarId: 'cal-work' });
    api.updateField.mockResolvedValueOnce({ field: f({ calendarId: null, revision: 4 }) });
    api.setFieldCalendar.mockResolvedValueOnce({ field: { ...bound, revision: 5 } });
    render(<TableFieldEditor tableId={tableId} field={bound} onClose={vi.fn()} />);
    await calendarsLoaded();
    select('Show on calendar', '');
    submit();
    await waitFor(() => expect(api.updateField).toHaveBeenCalledTimes(1));
    expect(api.updateField.mock.calls[0][2]).toMatchObject({ calendarId: null });
    expect(api.updateField.mock.calls[0][2]).not.toHaveProperty('calendarEndFieldId');
    await act(async () => undoCalendarStep());
    expect(api.setFieldCalendar).toHaveBeenCalledWith(tableId, bound.id, {
      calendarId: 'cal-work',
      expectedRevision: 4,
    });
  });
});

describe('Repeats section', () => {
  it('saves a repeat with no status field (rows completed with Done / Skip)', async () => {
    api.updateField.mockResolvedValue({
      field: f({
        revision: 4,
        recurrence: {
          statusFieldId: null,
          doneOptionIds: [],
          resetOptionId: null,
        },
      }),
    });
    render(<TableFieldEditor tableId={tableId} field={due} onClose={vi.fn()} />);
    await calendarsLoaded();
    fireEvent.click(screen.getByRole('button', { name: /Repeat options/ }));
    const picker = screen.getByLabelText('Done is') as HTMLSelectElement;
    expect(picker.value).toBe('');
    expect(
      await screen.findByText(/Tap Done on the row’s date, or Mark done in the calendar/)
    ).toBeInTheDocument();
    expect(screen.queryByLabelText('Then reset to')).toBeNull();
    // Choosing a status field, then the Done button again, saves the default setting.
    await within(picker).findByRole('option', { name: 'status set to…' });
    select('Done is', status.id);
    select('Done is', '');
    submit();
    await waitFor(() => expect(api.updateField).toHaveBeenCalledTimes(1));
    expect(api.updateField.mock.calls[0]![2]).toMatchObject({
      recurrence: { statusFieldId: null, doneOptionIds: [], resetOptionId: null },
    });
  });

  it('picking a status field starts on its last option as done and its first as the reset', async () => {
    api.updateField.mockResolvedValue({ field: f({ revision: 4 }) });
    render(<TableFieldEditor tableId={tableId} field={due} onClose={vi.fn()} />);
    await calendarsLoaded();
    fireEvent.click(screen.getByRole('button', { name: /Repeat options/ }));
    // A status field is optional and starts on the Done button.
    const picker = screen.getByLabelText('Done is') as HTMLSelectElement;
    expect(picker.value).toBe('');
    await within(picker).findByRole('option', { name: 'status set to…' });
    select('Done is', status.id);
    expect((screen.getByLabelText('status is') as HTMLSelectElement).value).toBe('opt-done');
    const reset = screen.getByLabelText('Then reset to') as HTMLSelectElement;
    expect(reset.value).toBe('opt-todo');
    // Done options are not offered as the reset status.
    expect(within(reset).queryByRole('option', { name: 'Done' })).toBeNull();
    expect(
      screen.getByText(
        'Setting status to Done moves the row to its next date and puts status back to To do.'
      )
    ).toBeInTheDocument();
    submit();
    await waitFor(() => expect(api.updateField).toHaveBeenCalledTimes(1));
    expect(api.updateField.mock.calls[0][2]).toMatchObject({
      recurrence: {
        statusFieldId: status.id,
        doneOptionIds: ['opt-done'],
        resetOptionId: 'opt-todo',
      },
    });
    expect(api.updateField.mock.calls[0][2]).not.toHaveProperty('calendarId');
  });

  it('validates a status field with no options yet', async () => {
    const empty = f({
      id: 'field-5555555555555-eeeeeeeee',
      name: 'stage',
      type: 'select',
      options: [],
    });
    api.fields.mockResolvedValue({ fields: [due, ends, day, status, empty] });
    render(<TableFieldEditor tableId={tableId} field={due} onClose={vi.fn()} />);
    await calendarsLoaded();
    fireEvent.click(screen.getByRole('button', { name: /Repeat options/ }));
    await within(screen.getByLabelText('Done is')).findByRole('option', {
      name: 'stage set to…',
    });
    select('Done is', empty.id);
    expect(screen.getByText('stage has no options yet.')).toBeInTheDocument();
    expect(screen.queryByLabelText('Then reset to')).toBeNull();
    submit();
    expect(await screen.findByText(/at least one status of stage/)).toBeInTheDocument();
    expect(api.updateField).not.toHaveBeenCalled();
  });

  it('marking the reset status as done moves the reset to the next option', async () => {
    render(<TableFieldEditor tableId={tableId} field={due} onClose={vi.fn()} />);
    await calendarsLoaded();
    fireEvent.click(screen.getByRole('button', { name: /Repeat options/ }));
    await within(screen.getByLabelText('Done is')).findByRole('option', {
      name: 'status set to…',
    });
    select('Done is', status.id);
    expect((screen.getByLabelText('Then reset to') as HTMLSelectElement).value).toBe('opt-todo');
    select('status is', 'opt-todo');
    expect((screen.getByLabelText('Then reset to') as HTMLSelectElement).value).toBe('opt-doing');
  });

  it('a repeating field can drop its time: it warns that rows lose their repeat, then sends the type', async () => {
    const repeating = f({
      recurrence: {
        statusFieldId: status.id,
        doneOptionIds: ['opt-done'],
        resetOptionId: null,
      },
    });
    api.updateField.mockResolvedValue({ field: f({ revision: 4, type: 'date' }) });
    render(<TableFieldEditor tableId={tableId} field={repeating} onClose={vi.fn()} />);
    await calendarsLoaded();
    expect(screen.queryByText(/removes every row’s repeat/)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Include time' }));
    expect(screen.getByText(/removes every row’s repeat/)).toBeInTheDocument();
    submit();
    await waitFor(() => expect(api.updateField).toHaveBeenCalledTimes(1));
    expect(api.updateField.mock.calls[0]![2]).toMatchObject({ type: 'date' });
    expect(api.updateField.mock.calls[0]![2]).not.toHaveProperty('recurrence', null);
  });

  it('shows the server refusal inline', async () => {
    const { FetchError } = await import('@desktop/utils/api');
    api.updateField.mockRejectedValue(
      new FetchError('Done is not an option of status. Choose one of its options.', 400)
    );
    render(<TableFieldEditor tableId={tableId} field={due} onClose={vi.fn()} />);
    await calendarsLoaded();
    fireEvent.click(screen.getByRole('button', { name: /Repeat options/ }));
    await within(screen.getByLabelText('Done is')).findByRole('option', {
      name: 'status set to…',
    });
    select('Done is', status.id);
    submit();
    expect(await screen.findByText(/Done is not an option of status/)).toBeInTheDocument();
  });

  it('is not shown for non-date fields', async () => {
    render(<TableFieldEditor tableId={tableId} field={f({ type: 'text' })} onClose={vi.fn()} />);
    expect(screen.queryByRole('group', { name: 'Calendar' })).toBeNull();
    expect(screen.queryByRole('group', { name: 'Repeats' })).toBeNull();
  });

  it('reopened, shows the saved status setting by option id, under the options’ current names', async () => {
    // The status option was renamed since the setting was saved: ids still match.
    const renamed = {
      ...status,
      options: status.options!.map((o) => (o.id === 'opt-done' ? { ...o, label: 'Finished' } : o)),
    };
    api.fields.mockResolvedValue({ fields: [due, ends, day, renamed] });
    const repeating = f({
      recurrence: {
        statusFieldId: status.id,
        doneOptionIds: ['opt-done'],
        resetOptionId: 'opt-todo',
      },
    });
    render(<TableFieldEditor tableId={tableId} field={repeating} onClose={vi.fn()} />);
    await calendarsLoaded();
    fireEvent.click(screen.getByRole('button', { name: /Repeat options/ }));
    const done = (await screen.findByLabelText('status is')) as HTMLSelectElement;
    expect(done.value).toBe('opt-done');
    expect(within(done).getByRole('option', { name: 'Finished', selected: true })).toBeVisible();
    expect((screen.getByLabelText('Done is') as HTMLSelectElement).value).toBe(status.id);
    // One done value: To do and Doing are not counted as done.
    expect(screen.queryByLabelText('Or status is')).toBeNull();
    const reset = screen.getByLabelText('Then reset to') as HTMLSelectElement;
    expect(reset.value).toBe('opt-todo');
    expect(within(reset).queryByRole('option', { name: 'Finished' })).toBeNull();
    expect(screen.queryByText(/Choose/)).toBeNull();
  });

  it('offers a single select added while the editor is open, and only single selects', async () => {
    render(<TableFieldEditor tableId={tableId} field={due} onClose={vi.fn()} />);
    await calendarsLoaded();
    fireEvent.click(screen.getByRole('button', { name: /Repeat options/ }));
    const picker = screen.getByLabelText('Done is');
    await within(picker).findByRole('option', { name: 'status set to…' });
    const stage = f({
      id: 'field-5555555555555-eeeeeeeee',
      name: 'stage',
      type: 'select',
      options: [{ id: 'opt-shipped', label: 'Shipped', color: 'green' }],
    });
    const tags = f({
      id: 'field-6666666666666-fffffffff',
      name: 'tags',
      type: 'select',
      multiple: true,
    });
    api.fields.mockResolvedValue({ fields: [due, ends, day, status, stage, tags] });
    const { emitTableEvent } = await import('@desktop/features/database');
    act(() => emitTableEvent({ type: 'table.fields.changed', tableId }));
    await within(picker).findByRole('option', { name: 'stage set to…' });
    expect(within(picker).queryByRole('option', { name: 'tags set to…' })).toBeNull();
    expect(within(picker).queryByRole('option', { name: 'due set to…' })).toBeNull();
    select('Done is', stage.id);
    expect((screen.getByLabelText('stage is') as HTMLSelectElement).value).toBe('opt-shipped');
    api.updateField.mockResolvedValue({ field: f({ revision: 4 }) });
    submit();
    await waitFor(() => expect(api.updateField).toHaveBeenCalledTimes(1));
    expect(api.updateField.mock.calls[0]![2]).toMatchObject({
      recurrence: {
        statusFieldId: stage.id,
        doneOptionIds: ['opt-shipped'],
        resetOptionId: null,
      },
    });
  });

  it('switching the status field starts its done and reset choices over', async () => {
    const stage = f({
      id: 'field-5555555555555-eeeeeeeee',
      name: 'stage',
      type: 'select',
      options: [{ id: 'opt-shipped', label: 'Shipped', color: 'green' }],
    });
    api.fields.mockResolvedValue({ fields: [due, ends, day, status, stage] });
    render(<TableFieldEditor tableId={tableId} field={due} onClose={vi.fn()} />);
    await calendarsLoaded();
    fireEvent.click(screen.getByRole('button', { name: /Repeat options/ }));
    await within(screen.getByLabelText('Done is')).findByRole('option', {
      name: 'stage set to…',
    });
    select('Done is', status.id);
    select('status is', 'opt-done');
    select('Then reset to', 'opt-todo');
    select('Done is', stage.id);
    // The new field's own defaults: its one option is done, with no reset.
    expect((screen.getByLabelText('stage is') as HTMLSelectElement).value).toBe('opt-shipped');
    expect(screen.queryByLabelText('status is')).toBeNull();
    expect((screen.getByLabelText('Then reset to') as HTMLSelectElement).value).toBe('');
    // Nothing of the previous status field goes out.
    api.updateField.mockResolvedValue({ field: f({ revision: 4 }) });
    submit();
    await waitFor(() => expect(api.updateField).toHaveBeenCalledTimes(1));
    expect(api.updateField.mock.calls[0]![2]).toMatchObject({
      recurrence: { statusFieldId: stage.id, doneOptionIds: ['opt-shipped'], resetOptionId: null },
    });
  });
});
