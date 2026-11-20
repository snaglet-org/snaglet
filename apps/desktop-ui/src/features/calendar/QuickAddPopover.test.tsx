/**
 * Quick add's Calendar and Table field pickers: None is the default, the
 * field list holds only the chosen calendar's bound date fields, changing
 * the calendar drops a field it doesn't show, Save carries the field, and
 * Escape in a picker closes the picker, not quick add.
 */
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Calendar, CalendarBoundField } from '@snaglet/shared/types';
import { QuickAddPopover, type QuickAddSlot } from './QuickAddPopover';

// The real editor mounts TipTap; the description field needs only a text box here.
vi.mock('@desktop/features/rich-markdown/editor', async () => ({
  ChipEditableInput: (
    await import('@desktop/features/rich-markdown/editor/chipEditableInput.testMock')
  ).MockChipEditableInput,
}));

const bound = (fieldId: string, tableName: string, fieldName: string): CalendarBoundField => ({
  tableId: `table-${fieldId}`,
  tableName,
  projectId: null,
  fieldId,
  fieldName,
  fieldType: fieldId === 'f2' ? 'datetime' : 'date',
  repeats: false,
  unscheduledCount: 0,
});

function cal(id: string, title: string, boundFields: CalendarBoundField[]): Calendar {
  return {
    id,
    title,
    description: '',
    timeZone: 'UTC',
    color: id === 'cal-a' ? 'blue' : 'green',
    isDefault: id === 'cal-a',
    sortOrder: id === 'cal-a' ? 0 : 1,
    revision: 1,
    createdAt: '',
    updatedAt: '',
    boundFields,
  };
}

const calendars = [
  cal('cal-a', 'Calendar A', [
    bound('f1', 'Test table', 'Due'),
    bound('f2', 'Test table', 'Start'),
  ]),
  cal('cal-b', 'Calendar B', [
    bound('f3', 'Other table', 'Due'),
    // A managed created_at can show on a calendar, but Snaglet sets it.
    bound('field-managed-table-f3-created_at', 'Other table', 'Created'),
  ]),
];

const slot: QuickAddSlot = { kind: 'timed', day: '2026-10-12', start: 9 * 60, end: 9 * 60 + 30 };

function setup(at: QuickAddSlot = slot) {
  const anchor = document.createElement('button');
  document.body.appendChild(anchor);
  const onSave = vi.fn();
  const onCancel = vi.fn();
  render(
    <QuickAddPopover
      anchor={anchor}
      slot={at}
      calendars={calendars}
      onSave={onSave}
      onCancel={onCancel}
    />
  );
  return { onSave, onCancel };
}

async function choose(picker: 'Calendar' | 'Table field', option: string | RegExp) {
  fireEvent.click(screen.getByRole('button', { name: new RegExp(`^${picker}:`) }));
  const list = await screen.findByRole('listbox', { name: picker });
  fireEvent.click(within(list).getByRole('option', { name: option }));
}

describe('QuickAddPopover pickers', () => {
  beforeEach(() => window.localStorage.clear());

  it('starts on the default calendar and None (plain event)', () => {
    setup();
    expect(screen.getByRole('button', { name: /^Calendar:/ })).toHaveAccessibleName(
      'Calendar: Calendar A'
    );
    expect(screen.getByRole('button', { name: /^Table field:/ })).toHaveAccessibleName(
      'Table field: None (plain event)'
    );
  });

  it('lists only the chosen calendar’s bound date fields you can write, after None', async () => {
    setup();
    fireEvent.click(screen.getByRole('button', { name: /^Table field:/ }));
    const list = await screen.findByRole('listbox', { name: 'Table field' });
    expect(
      within(list)
        .getAllByRole('option')
        .map((o) => o.textContent)
    ).toEqual(['None (plain event)', '▦Test table · DueDate', '▦Test table · StartDate & time']);
    fireEvent.keyDown(screen.getByRole('combobox'), { key: 'Escape' });
    await choose('Calendar', /Calendar B/);
    fireEvent.click(screen.getByRole('button', { name: /^Table field:/ }));
    const other = await screen.findByRole('listbox', { name: 'Table field' });
    // Not the managed Created: a row can't be made in it.
    expect(
      within(other)
        .getAllByRole('option')
        .map((o) => o.textContent)
    ).toEqual(['None (plain event)', '▦Other table · DueDate']);
  });

  it('changing the calendar drops a field it doesn’t show', async () => {
    setup();
    await choose('Table field', /Test table · Due/);
    expect(screen.getByRole('button', { name: /^Table field:/ })).toHaveAccessibleName(
      'Table field: Test table · Due'
    );
    await choose('Calendar', /Calendar B/);
    expect(screen.getByRole('button', { name: /^Table field:/ })).toHaveAccessibleName(
      'Table field: None (plain event)'
    );
  });

  it('Save carries the chosen field; with None it is a plain event', async () => {
    const { onSave } = setup();
    await choose('Table field', /Test table · Start/);
    expect(screen.getByRole('dialog', { name: 'New row' })).toBeInTheDocument();
    const title = screen.getByRole('textbox', { name: 'Row title' });
    fireEvent.change(title, { target: { value: 'Test row' } });
    fireEvent.submit(title.closest('form')!);
    expect(onSave).toHaveBeenCalledWith({
      title: 'Test row',
      calendarId: 'cal-a',
      slot,
      target: {
        tableId: 'table-f2',
        tableName: 'Test table',
        fieldId: 'f2',
        fieldName: 'Start',
        fieldType: 'datetime',
      },
      description: '',
      repeat: null,
    });
  });

  it('a plain event offers a Repeat row (Never) that opens the options; a row doesn’t', async () => {
    const { onSave } = setup();
    fireEvent.click(screen.getByRole('button', { name: 'Repeat, Never' }));
    expect(screen.getByRole('radiogroup', { name: 'How it repeats' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Back to the event' }));
    expect(screen.getByRole('button', { name: 'Repeat, Never' })).toBeInTheDocument();
    const title = screen.getByRole('textbox', { name: 'Event title' });
    fireEvent.change(title, { target: { value: 'Test event' } });
    fireEvent.change(screen.getByRole('textbox', { name: 'Description' }), {
      target: { value: 'Test notes' },
    });
    fireEvent.submit(title.closest('form')!);
    expect(onSave).toHaveBeenCalledWith(
      expect.objectContaining({ description: 'Test notes', repeat: null, target: null })
    );
    await choose('Table field', /Test table · Start/);
    expect(screen.queryByRole('textbox', { name: 'Description' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Repeat, / })).not.toBeInTheDocument();
  });

  it('says where an all-day slot lands in a field with a time', async () => {
    setup({ kind: 'all_day', startDate: '2026-10-12', endDate: '2026-10-13' });
    await choose('Table field', /Test table · Start/);
    expect(screen.getByText(/starts at 12:00 AM on its first day/)).toBeInTheDocument();
  });

  it('Escape in a picker closes the picker, not quick add; Enter there doesn’t save', async () => {
    const { onCancel, onSave } = setup();
    fireEvent.change(screen.getByRole('textbox', { name: 'Event title' }), {
      target: { value: 'Test event' },
    });
    fireEvent.click(screen.getByRole('button', { name: /^Table field:/ }));
    const search = await screen.findByRole('combobox', { name: 'Search table field' });
    await waitFor(() => expect(search).toHaveFocus());
    fireEvent.keyDown(search, { key: 'Enter' });
    expect(onSave).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: /^Table field:/ }));
    const again = await screen.findByRole('combobox', { name: 'Search table field' });
    fireEvent.keyDown(again, { key: 'Escape' });
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(onCancel).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog', { name: 'New event' })).toBeInTheDocument();
  });
});

describe('QuickAddPopover dismiss', () => {
  it('a press outside cancels it (no title)', () => {
    const { onCancel, onSave } = setup();
    fireEvent.pointerDown(document.body);
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onSave).not.toHaveBeenCalled();
  });

  it('a press outside whose own handler stops it still closes it', () => {
    const { onCancel } = setup();
    const header = document.createElement('div');
    header.addEventListener('pointerdown', (event) => event.stopPropagation());
    document.body.appendChild(header);
    fireEvent.pointerDown(header);
    expect(onCancel).toHaveBeenCalledTimes(1);
    header.remove();
  });

  it('Escape cancels it', () => {
    const { onCancel } = setup();
    fireEvent.keyDown(screen.getByRole('textbox', { name: 'Event title' }), { key: 'Escape' });
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('with a picker open, one press outside closes the picker and quick add', async () => {
    const { onCancel } = setup();
    fireEvent.click(screen.getByRole('button', { name: /^Calendar:/ }));
    await screen.findByRole('listbox', { name: 'Calendar' });
    fireEvent.pointerDown(document.body);
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('a pick in the portaled list keeps quick add open', async () => {
    const { onCancel, onSave } = setup();
    fireEvent.click(screen.getByRole('button', { name: /^Calendar:/ }));
    const list = await screen.findByRole('listbox', { name: 'Calendar' });
    const option = within(list).getByRole('option', { name: /Calendar B/ });
    fireEvent.pointerDown(option);
    fireEvent.click(option);
    expect(onCancel).not.toHaveBeenCalled();
    expect(onSave).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: /^Calendar: Calendar B/ })).toBeInTheDocument();
  });
});
