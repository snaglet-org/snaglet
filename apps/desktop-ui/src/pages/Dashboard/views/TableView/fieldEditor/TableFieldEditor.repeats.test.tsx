import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TableField, TableFieldRecurrence } from '@snaglet/shared/types';
import type { ChipEditableInputProps } from '@desktop/features/rich-markdown/editor/ChipEditableInput';
import { __resetCalendarStoreForTests } from '@desktop/features/calendar/calendarStore';
import { __resetCalendarUndoForTests } from '@desktop/features/calendar/calendarUndo';
import { emitTableEvent } from '@desktop/features/database';
import { TableFieldEditor } from '../TableFieldEditor';

// The date field's Repeat options (every date field can repeat; no switch),
// laid out as the approved field-settings prototype has them: Done is [the Done button | <field> set to…], <field> is
// [option] (+ another), Then reset to [option | None].

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
const status = f({
  id: 'field-4444444444444-ddddddddd',
  name: 'status',
  type: 'select',
  options: [
    { id: 'opt-todo', label: 'To do', color: 'gray' },
    { id: 'opt-doing', label: 'Doing', color: 'blue' },
    { id: 'opt-done', label: 'Done', color: 'green' },
    { id: 'opt-wont', label: 'Won’t do', color: 'red' },
  ],
});
const stage = f({
  id: 'field-5555555555555-eeeeeeeee',
  name: 'stage',
  type: 'select',
  options: [{ id: 'opt-shipped', label: 'Shipped', color: 'green' }],
});
const flag = f({
  id: 'field-6666666666666-fffffffff',
  name: 'flag',
  type: 'select',
  options: [
    { id: 'opt-no', label: 'No', color: 'gray' },
    { id: 'opt-yes', label: 'Yes', color: 'green' },
  ],
});
function repeating(recurrence: Partial<TableFieldRecurrence>): TableField {
  return f({
    recurrence: {
      statusFieldId: status.id,
      doneOptionIds: ['opt-done'],
      resetOptionId: 'opt-todo',
      ...recurrence,
    },
  });
}

beforeEach(() => {
  vi.resetAllMocks();
  __resetCalendarStoreForTests();
  __resetCalendarUndoForTests();
  calApi.listCalendars.mockResolvedValue({ calendars: [] });
  api.fields.mockResolvedValue({ fields: [due, status, stage, flag] });
  api.list.mockResolvedValue({ tables: [] });
  api.updateField.mockResolvedValue({ field: f({ revision: 4 }) });
});
afterEach(async () => {
  await act(async () => cleanup());
});

function submit() {
  fireEvent.submit(screen.getByRole('region').querySelector('form')!);
}
function select(label: string, value: string) {
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
}
function value(label: string): string {
  return (screen.getByLabelText(label) as HTMLSelectElement).value;
}
/** The status choices load with the table's fields. */
async function fieldsLoaded() {
  await within(screen.getByLabelText('Done is')).findByRole('option', {
    name: 'status set to…',
  });
}
async function sent(): Promise<Record<string, unknown>> {
  await waitFor(() => expect(api.updateField).toHaveBeenCalledTimes(1));
  return api.updateField.mock.calls[0]![2] as Record<string, unknown>;
}
/** The options are closed until asked for. */
async function openOptions() {
  fireEvent.click(screen.getByRole('button', { name: /Repeat options/ }));
  await fieldsLoaded();
}

describe('Repeat options — When it’s done', () => {
  it('picking a status field defaults done to its last option and reset to its first', async () => {
    render(<TableFieldEditor tableId={tableId} field={due} onClose={vi.fn()} />);
    await openOptions();
    // The Done button needs no choices.
    expect(screen.queryByLabelText('status is')).toBeNull();
    select('Done is', status.id);
    expect(value('status is')).toBe('opt-wont');
    expect(value('Then reset to')).toBe('opt-todo');
    expect(screen.getByText(/^Setting status to Won’t do moves the row/)).toHaveTextContent(
      'Setting status to Won’t do moves the row to its next date and puts status back to To do.'
    );
  });

  it('a one-option field is done with no reset; switching fields starts over', async () => {
    render(<TableFieldEditor tableId={tableId} field={due} onClose={vi.fn()} />);
    await openOptions();
    select('Done is', status.id);
    select('status is', 'opt-done');
    select('Then reset to', 'opt-doing');
    select('Done is', stage.id);
    expect(screen.queryByLabelText('status is')).toBeNull();
    expect(value('stage is')).toBe('opt-shipped');
    expect(value('Then reset to')).toBe('');
    expect(screen.getByText(/clears stage\.$/)).toBeInTheDocument();
    submit();
    // Nothing of the previous status field goes out.
    expect((await sent()).recurrence).toEqual({
      statusFieldId: stage.id,
      doneOptionIds: ['opt-shipped'],
      resetOptionId: null,
    });
  });

  it('back to the Done button clears the status choices', async () => {
    render(<TableFieldEditor tableId={tableId} field={repeating({})} onClose={vi.fn()} />);
    await openOptions();
    select('Done is', '');
    expect(screen.queryByLabelText('Then reset to')).toBeNull();
    expect(
      screen.getByText(/Tap Done on the row’s date, or Mark done in the calendar/)
    ).toBeInTheDocument();
    submit();
    expect((await sent()).recurrence).toEqual({
      statusFieldId: null,
      doneOptionIds: [],
      resetOptionId: null,
    });
  });

  it('reset None clears the status', async () => {
    render(<TableFieldEditor tableId={tableId} field={repeating({})} onClose={vi.fn()} />);
    await openOptions();
    expect(value('Then reset to')).toBe('opt-todo');
    select('Then reset to', '');
    expect(
      screen.getByText('Setting status to Done moves the row to its next date and clears status.')
    ).toBeInTheDocument();
    submit();
    expect((await sent()).recurrence).toEqual({
      statusFieldId: status.id,
      doneOptionIds: ['opt-done'],
      resetOptionId: null,
    });
  });

  it('shows saved options by id under their current names', async () => {
    const renamed = {
      ...status,
      options: status.options!.map((o) => (o.id === 'opt-done' ? { ...o, label: 'Finished' } : o)),
    };
    api.fields.mockResolvedValue({ fields: [due, renamed] });
    render(<TableFieldEditor tableId={tableId} field={repeating({})} onClose={vi.fn()} />);
    await openOptions();
    expect(value('Done is')).toBe(status.id);
    const done = screen.getByLabelText('status is') as HTMLSelectElement;
    expect(done.value).toBe('opt-done');
    expect(within(done).getByRole('option', { name: 'Finished', selected: true })).toBeVisible();
    expect(
      within(screen.getByLabelText('Then reset to')).queryByRole('option', { name: 'Finished' })
    ).toBeNull();
    expect(screen.queryByText(/Choose/)).toBeNull();
  });

  it('offers a single select added while the editor is open', async () => {
    api.fields.mockResolvedValue({ fields: [due, status] });
    render(<TableFieldEditor tableId={tableId} field={due} onClose={vi.fn()} />);
    await openOptions();
    const picker = screen.getByLabelText('Done is');
    expect(within(picker).queryByRole('option', { name: 'stage set to…' })).toBeNull();
    const tags = f({
      id: 'field-7777777777777-ggggggggg',
      name: 'tags',
      type: 'select',
      multiple: true,
    });
    api.fields.mockResolvedValue({ fields: [due, status, stage, tags] });
    act(() => emitTableEvent({ type: 'table.fields.changed', tableId }));
    await within(picker).findByRole('option', { name: 'stage set to…' });
    expect(within(picker).queryByRole('option', { name: 'tags set to…' })).toBeNull();
    expect(within(picker).queryByRole('option', { name: 'due set to…' })).toBeNull();
  });
});

describe('Repeat options — several done values', () => {
  const multi = repeating({ doneOptionIds: ['opt-done', 'opt-wont'], resetOptionId: 'opt-todo' });

  it('a saved setting with several done values shows each and round-trips unchanged', async () => {
    render(<TableFieldEditor tableId={tableId} field={multi} onClose={vi.fn()} />);
    await openOptions();
    expect(value('status is')).toBe('opt-done');
    expect(value('Or status is')).toBe('opt-wont');
    const reset = screen.getByLabelText('Then reset to');
    expect(within(reset).queryByRole('option', { name: 'Done' })).toBeNull();
    expect(within(reset).queryByRole('option', { name: 'Won’t do' })).toBeNull();
    expect(screen.getByText(/^Setting status to Done or Won’t do moves/)).toBeInTheDocument();
    // Touch the reset and put it back; the done values go back in their order.
    select('Then reset to', '');
    select('Then reset to', 'opt-todo');
    submit();
    expect((await sent()).recurrence).toEqual({
      statusFieldId: status.id,
      doneOptionIds: ['opt-done', 'opt-wont'],
      resetOptionId: 'opt-todo',
    });
  });

  it('an unrelated edit does not re-send the setting', async () => {
    render(<TableFieldEditor tableId={tableId} field={multi} onClose={vi.fn()} />);
    await openOptions();
    fireEvent.change(screen.getByLabelText('Field name'), { target: { value: 'due_on' } });
    submit();
    expect(await sent()).not.toHaveProperty('recurrence');
  });

  it('+ another adds a done value the reset does not use, and × removes it', async () => {
    render(<TableFieldEditor tableId={tableId} field={repeating({})} onClose={vi.fn()} />);
    await openOptions();
    expect(screen.queryByLabelText('Or status is')).toBeNull();
    fireEvent.click(
      screen.getByRole('button', { name: 'Add another status value that means done' })
    );
    expect(value('Or status is')).toBe('opt-doing');
    // Each done select offers only the options no other done select has.
    expect(
      within(screen.getByLabelText('Or status is')).queryByRole('option', { name: 'Done' })
    ).toBeNull();
    select('Or status is', 'opt-wont');
    // All but the reset are done: nothing left to add.
    fireEvent.click(
      screen.getByRole('button', { name: 'Add another status value that means done' })
    );
    expect(
      screen.queryByRole('button', { name: 'Add another status value that means done' })
    ).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Remove Won’t do from done' }));
    submit();
    expect((await sent()).recurrence).toMatchObject({
      doneOptionIds: ['opt-done', 'opt-doing'],
      resetOptionId: 'opt-todo',
    });
  });

  it('offers no + another for a field with two options', async () => {
    render(<TableFieldEditor tableId={tableId} field={due} onClose={vi.fn()} />);
    await openOptions();
    select('Done is', flag.id);
    expect(value('flag is')).toBe('opt-yes');
    expect(value('Then reset to')).toBe('opt-no');
    expect(screen.queryByRole('button', { name: /Add another/ })).toBeNull();
  });
});

describe('Repeat options — default setting', () => {
  it('a field with no setting shows the default, and sends one once changed', async () => {
    render(<TableFieldEditor tableId={tableId} field={due} onClose={vi.fn()} />);
    expect(screen.queryByRole('checkbox', { name: 'Rows can repeat' })).toBeNull();
    expect(screen.queryByLabelText('Done is')).toBeNull();
    await openOptions();
    expect(value('Done is')).toBe('');
    select('Done is', status.id);
    select('Done is', '');
    submit();
    const recurrence = (await sent()).recurrence as TableFieldRecurrence;
    expect(Object.keys(recurrence).sort()).toEqual([
      'doneOptionIds',
      'resetOptionId',
      'statusFieldId',
    ]);
    expect(recurrence).toMatchObject({
      statusFieldId: null,
      doneOptionIds: [],
      resetOptionId: null,
    });
  });

  it('opens and closes with Repeat options, keeping the choice made', async () => {
    render(<TableFieldEditor tableId={tableId} field={repeating({})} onClose={vi.fn()} />);
    const toggle = screen.getByRole('button', { name: /Repeat options/ });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByLabelText('Then reset to')).toBeNull();
    await openOptions();
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    select('Then reset to', '');
    fireEvent.click(toggle);
    expect(screen.queryByLabelText('Then reset to')).toBeNull();
    submit();
    expect((await sent()).recurrence).toMatchObject({ resetOptionId: null });
  });

  it('disables every choice while the field is stale', async () => {
    const saved = repeating({});
    render(<TableFieldEditor tableId={tableId} field={saved} onClose={vi.fn()} />);
    await openOptions();
    const { FetchError } = await import('@desktop/utils/api');
    api.updateField.mockRejectedValue(
      new FetchError('Field changed elsewhere', 409, { field: { ...saved, revision: 5 } })
    );
    fireEvent.change(screen.getByLabelText('Field name'), { target: { value: 'due_on' } });
    submit();
    await waitFor(() => expect(screen.getByLabelText('Done is')).toBeDisabled());
    expect(screen.getByLabelText('status is')).toBeDisabled();
    expect(screen.getByLabelText('Then reset to')).toBeDisabled();
  });
});
