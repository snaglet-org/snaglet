import { useState } from 'react';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TableEntry, TableField } from '@snaglet/shared/types';
import type { TableRepeat } from '@snaglet/shared/utils';
import { DateInput } from '@desktop/components';
import { DateRepeatInput, type DateRepeatInputProps } from './DateRepeatPopover';

const api = vi.hoisted(() => ({
  entry: vi.fn(),
  get: vi.fn(),
  set: vi.fn(),
  clear: vi.fn(),
  complete: vi.fn(),
  skip: vi.fn(),
  move: vi.fn(),
  shift: vi.fn(),
}));
const toast = vi.hoisted(() => vi.fn());

vi.mock('@desktop/utils/api', () => ({ tablesApi: { entry: api.entry } }));
vi.mock('@desktop/utils/api/tableRepeats', async () => {
  const actual = await vi.importActual<typeof import('@desktop/utils/api/tableRepeats')>(
    '@desktop/utils/api/tableRepeats'
  );
  return {
    ...actual,
    tableRepeatsApi: {
      get: api.get,
      set: api.set,
      clear: api.clear,
      complete: api.complete,
      skip: api.skip,
      move: api.move,
      shift: api.shift,
    },
  };
});
vi.mock('@desktop/utils/toast', () => ({ showToast: toast }));
vi.mock('@desktop/features/database', () => ({
  emitTableEvent: vi.fn(),
  subscribeTableEvents: () => () => {},
}));
vi.mock('@desktop/features/database/tableHistory', () => ({
  stepTableHistory: vi.fn(),
  newestTableStep: vi.fn().mockResolvedValue(null),
}));

const TABLE = 'table-1111111111111-aaaaaaaaa';
const ENTRY = '11111111-2222-3333-4444-555555555555';
const REV = 'a'.repeat(64);
const SCHEMA = 'b'.repeat(64);

const field = {
  id: 'field-due',
  tableId: TABLE,
  columnName: 'due',
  name: 'Due',
  type: 'date',
  range: false,
  recurrence: { statusFieldId: null, doneOptionIds: [], resetOptionId: null },
} as unknown as TableField;

// Mon Oct 12, 2026; today is Tue Oct 13.
const weekly: TableRepeat = {
  rrule: 'FREQ=WEEKLY;BYDAY=MO',
  dtstart: '2026-10-12',
  current: '2026-10-12',
  tz: 'UTC',
};
const entry = (due: string): TableEntry => ({
  id: ENTRY,
  createdAt: '2026-01-01T00:00:00.000Z',
  revision: REV,
  values: { [field.id]: due },
});
const revision = { expectedRevision: REV, schemaVersion: SCHEMA, expectedCurrent: '2026-10-12' };

function view(repeat: TableRepeat | null, log: unknown[] = []) {
  return {
    entryId: ENTRY,
    revision: REV,
    repeats: repeat ? { [field.id]: repeat } : {},
    log,
  };
}
/** What a write answers: the row moved to `due`, its repeat now `repeat`. */
function result(due: string, repeat: TableRepeat | null) {
  return {
    entry: { ...entry(due), revision: 'c'.repeat(64) },
    schemaVersion: SCHEMA,
    relatedEntries: {},
    relatedItems: {},
    fieldId: field.id,
    repeat,
    logged: [],
    removed: [],
    changed: true,
  };
}

const writes = () =>
  [api.set, api.clear, api.complete, api.skip, api.move, api.shift].map((fn) => fn.mock.calls);

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-13T12:00:00Z'));
  vi.clearAllMocks();
  api.entry.mockResolvedValue({ entry: entry('2026-10-12'), schemaVersion: SCHEMA });
  api.get.mockResolvedValue(view(weekly));
});
afterEach(() => vi.useRealTimers());

/** The field as an editor holds it: a controlled value that takes a write's entry. */
function Harness({
  onValue,
  onWritten,
  initial = '2026-10-12',
  ...props
}: Partial<DateRepeatInputProps> & {
  initial?: string;
  onValue?: (next: string) => void;
  onWritten?: (entry: TableEntry) => void;
}) {
  const [value, setValue] = useState(initial);
  return (
    <DateRepeatInput
      tableId={TABLE}
      entryId={ENTRY}
      field={field}
      aria-label="Due"
      value={value}
      onChange={(next) => {
        setValue(next);
        onValue?.(next);
      }}
      onEntryWritten={(written) => {
        setValue(String(written.values[field.id] ?? ''));
        onWritten?.(written);
      }}
      {...props}
    />
  );
}

function setup(props: Parameters<typeof Harness>[0] = {}) {
  const onValue = vi.fn();
  const onWritten = vi.fn();
  render(<Harness onValue={onValue} onWritten={onWritten} {...props} />);
  return {
    onValue,
    onWritten,
    input: screen.getByRole('combobox', { name: 'Due' }),
    user: userEvent.setup(),
  };
}

const cards = () => screen.queryAllByRole('dialog', { name: 'Choose date' });
const card = () => {
  const [first] = cards();
  if (!first) throw new Error('No date popover');
  return first;
};
const repeatRow = (name: string) =>
  within(card()).findByRole('button', { name: `Repeat, ${name}` });
const day = (name: RegExp) => within(card()).getByRole('gridcell', { name });
const choices = () => within(card()).getByRole('radiogroup', { name: 'How it repeats' });
const flush = () => act(async () => {});

describe('DateRepeatInput: the date view', () => {
  it('adds a Repeat row naming the rule, under the days; a plain date field has none', async () => {
    const { user, input } = setup();
    await user.click(input);
    const row = await repeatRow('Every week on Monday');
    expect(api.get).toHaveBeenCalledWith(TABLE, ENTRY);
    expect(within(card()).getByRole('grid')).toBeInTheDocument();
    // Under the days, above the footer's Today · Clear · Done.
    const today = within(card()).getByRole('button', { name: 'Today' });
    expect(row.compareDocumentPosition(today) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(within(card()).getByRole('button', { name: 'Done' })).toBeInTheDocument();

    render(<DateInput aria-label="Plain" value="2026-10-12" onChange={vi.fn()} />);
    await user.keyboard('{Escape}');
    fireEvent.click(screen.getByRole('combobox', { name: 'Plain' }));
    expect(within(card()).queryByRole('button', { name: /^Repeat/ })).toBeNull();
  });

  it('says Never on a row that doesn’t repeat, with no This one', async () => {
    api.get.mockResolvedValue(view(null));
    const { user, input } = setup();
    await user.click(input);
    await repeatRow('Never');
    expect(within(card()).queryByText('This one')).toBeNull();
  });

  it('This one: Done and Skip move the row on, and the date follows', async () => {
    const next = { ...weekly, current: '2026-10-19' };
    api.complete.mockResolvedValue(result('2026-10-19', next));
    const { user, input, onWritten, onValue } = setup();
    await user.click(input);
    await repeatRow('Every week on Monday');
    expect(within(card()).getByText('This one')).toBeInTheDocument();
    // Its day has passed: overdue, as in the Repeat section.
    expect(within(card()).getByText('Mon, Oct 12 · Overdue')).toBeInTheDocument();
    await user.click(within(card()).getByRole('button', { name: 'Mark this one done' }));
    await waitFor(() =>
      expect(api.complete).toHaveBeenCalledWith(TABLE, ENTRY, field.id, revision)
    );
    await waitFor(() => expect(onWritten).toHaveBeenCalled());
    expect(await within(card()).findByText('Mon, Oct 19')).toBeInTheDocument();
    expect(input).toHaveAttribute('data-value', '2026-10-19');
    // The date came from the repeat write, not a PATCH of the cell.
    expect(onValue).not.toHaveBeenCalled();
    await waitFor(() =>
      expect(toast).toHaveBeenCalledWith(
        "Marked done. To undo it, use the table's history.",
        expect.anything()
      )
    );

    api.skip.mockResolvedValue(result('2026-10-26', { ...weekly, current: '2026-10-26' }));
    await user.click(within(card()).getByRole('button', { name: 'Skip this one' }));
    await waitFor(() =>
      expect(api.skip).toHaveBeenCalledWith(TABLE, ENTRY, field.id, {
        ...revision,
        expectedRevision: 'c'.repeat(64),
        expectedCurrent: '2026-10-19',
      })
    );
    expect(await within(card()).findByText('Mon, Oct 26')).toBeInTheDocument();
  });

  it('dots the month’s next occurrences, not the picked day; a plain date field has none', async () => {
    const { user, input } = setup();
    await user.click(input);
    await repeatRow('Every week on Monday');
    const marked = () =>
      within(card())
        .getAllByRole('gridcell')
        .map((cell) => cell.getAttribute('aria-label') ?? '')
        .filter((label) => label.endsWith(', repeats'));
    expect(marked()).toEqual([
      'Monday, October 19, 2026, repeats',
      'Monday, October 26, 2026, repeats',
    ]);
    expect(day(/October 12/)).toHaveAttribute('aria-label', 'Monday, October 12, 2026');
    // The next month's are asked for when it shows; the grid's other months' days stay plain.
    await user.click(within(card()).getByRole('button', { name: 'Next month' }));
    expect(marked()).toEqual([
      'Monday, November 2, 2026, repeats',
      'Monday, November 9, 2026, repeats',
      'Monday, November 16, 2026, repeats',
      'Monday, November 23, 2026, repeats',
      'Monday, November 30, 2026, repeats',
    ]);

    render(<DateInput aria-label="Plain" value="2026-10-12" onChange={vi.fn()} />);
    await user.keyboard('{Escape}');
    fireEvent.click(screen.getByRole('combobox', { name: 'Plain' }));
    expect(marked()).toEqual([]);
  });

  it('shows a refused write the way the Repeat section does', async () => {
    api.complete.mockRejectedValue(new Error('The series has ended'));
    const { user, input } = setup();
    await user.click(input);
    await repeatRow('Every week on Monday');
    await user.click(within(card()).getByRole('button', { name: 'Mark this one done' }));
    expect(await within(card()).findByRole('alert')).toHaveTextContent('The series has ended');
  });
});

describe('DateRepeatInput: moving a repeating date', () => {
  it('asks "Move to …?": Just this one moves it', async () => {
    api.move.mockResolvedValue(result('2026-10-14', weekly));
    const { user, input, onValue } = setup();
    await user.click(input);
    await repeatRow('Every week on Monday');
    fireEvent.click(day(/October 14/));
    const prompt = within(card()).getByRole('group', { name: 'Move this one' });
    expect(prompt).toHaveTextContent('Move to Wed, Oct 14?');
    // The card stays open on the prompt; This one waits.
    expect(within(card()).queryByText('This one')).toBeNull();
    expect(onValue).not.toHaveBeenCalled();
    await user.click(within(prompt).getByRole('button', { name: 'Just this one' }));
    await waitFor(() =>
      expect(api.move).toHaveBeenCalledWith(TABLE, ENTRY, field.id, {
        ...revision,
        to: '2026-10-14',
      })
    );
    expect(api.shift).not.toHaveBeenCalled();
    await waitFor(() =>
      expect(within(card()).queryByRole('group', { name: 'Move this one' })).toBeNull()
    );
    expect(input).toHaveAttribute('data-value', '2026-10-14');
  });

  it('All upcoming shifts the series', async () => {
    api.shift.mockResolvedValue(result('2026-10-14', { ...weekly, rrule: 'FREQ=WEEKLY;BYDAY=WE' }));
    const { user, input } = setup();
    await user.click(input);
    await repeatRow('Every week on Monday');
    fireEvent.click(day(/October 14/));
    await user.click(within(card()).getByRole('button', { name: 'All upcoming' }));
    await waitFor(() =>
      expect(api.shift).toHaveBeenCalledWith(TABLE, ENTRY, field.id, {
        ...revision,
        to: '2026-10-14',
      })
    );
    expect(api.move).not.toHaveBeenCalled();
  });

  it('picking its own day again, or Escape, drops the prompt', async () => {
    const { user, input } = setup();
    await user.click(input);
    await repeatRow('Every week on Monday');
    fireEvent.click(day(/October 14/));
    fireEvent.click(day(/October 12/));
    expect(within(card()).queryByRole('group', { name: 'Move this one' })).toBeNull();
    fireEvent.click(day(/October 15/));
    await user.keyboard('{Escape}');
    expect(within(card()).queryByRole('group', { name: 'Move this one' })).toBeNull();
    expect(cards()).toHaveLength(1);
    expect(writes().flat()).toHaveLength(0);
  });

  it('All upcoming is off for a repeat pinned to a numbered weekday', async () => {
    api.get.mockResolvedValue(
      view({ ...weekly, rrule: 'FREQ=MONTHLY;BYDAY=2MO', dtstart: '2026-10-12' })
    );
    const { user, input } = setup();
    await user.click(input);
    await repeatRow('Every month on the 2nd Monday');
    fireEvent.click(day(/October 14/));
    expect(within(card()).getByRole('button', { name: 'All upcoming' })).toBeDisabled();
    expect(within(card()).getByText(/pinned to a numbered weekday/)).toBeInTheDocument();
  });

  it('without a repeat, a pick sets the date as on any field', async () => {
    api.get.mockResolvedValue(view(null));
    const { user, input, onValue } = setup();
    await user.click(input);
    await repeatRow('Never');
    fireEvent.click(day(/October 14/));
    expect(onValue).toHaveBeenCalledWith('2026-10-14');
    expect(writes().flat()).toHaveLength(0);
  });
});

describe('DateRepeatInput: the Repeat view', () => {
  it('Repeat opens it in the same card; Back returns to the date', async () => {
    const { user, input } = setup();
    await user.click(input);
    const surface = card();
    await user.click(await repeatRow('Every week on Monday'));
    expect(cards()).toEqual([surface]);
    expect(within(surface).queryByRole('grid')).toBeNull();
    expect(within(choices()).getByRole('radio', { name: 'Every week on Monday' })).toHaveFocus();
    await user.click(within(surface).getByRole('button', { name: 'Back to the date' }));
    expect(within(surface).getByRole('grid')).toBeInTheDocument();
    expect(await repeatRow('Every week on Monday')).toHaveFocus();
    expect(writes().flat()).toHaveLength(0);
  });

  it('Done saves a change and returns to the date view', async () => {
    api.get.mockResolvedValue(view(null));
    const daily = { ...weekly, rrule: 'FREQ=DAILY' };
    api.set.mockResolvedValue(result('2026-10-12', daily));
    const { user, input } = setup();
    await user.click(input);
    await user.click(await repeatRow('Never'));
    await user.click(within(choices()).getByRole('radio', { name: 'Every day' }));
    await user.click(within(card()).getByRole('button', { name: 'Done' }));
    await waitFor(() =>
      expect(api.set).toHaveBeenCalledWith(TABLE, ENTRY, field.id, {
        ...revision,
        expectedCurrent: null,
        rrule: 'FREQ=DAILY',
        date: '2026-10-12',
      })
    );
    expect(await repeatRow('Every day')).toHaveFocus();
    expect(within(card()).getByText('This one')).toBeInTheDocument();
  });

  it('Doesn’t repeat clears it', async () => {
    api.clear.mockResolvedValue(result('2026-10-12', null));
    const { user, input } = setup();
    await user.click(input);
    await user.click(await repeatRow('Every week on Monday'));
    await user.click(within(choices()).getByRole('radio', { name: 'Doesn’t repeat' }));
    await user.click(within(card()).getByRole('button', { name: 'Done' }));
    await waitFor(() => expect(api.clear).toHaveBeenCalledWith(TABLE, ENTRY, field.id, revision));
    await repeatRow('Never');
  });

  it('a refused save stays on the Repeat view with the reason', async () => {
    api.set.mockRejectedValue(new Error('Repeat refused'));
    const { user, input } = setup();
    await user.click(input);
    await user.click(await repeatRow('Every week on Monday'));
    await user.click(within(choices()).getByRole('radio', { name: 'Every day' }));
    await user.click(within(card()).getByRole('button', { name: 'Done' }));
    expect(await within(card()).findByRole('alert')).toHaveTextContent('Repeat refused');
    expect(choices()).toBeInTheDocument();
  });
});

describe('DateRepeatInput: a repeating row whose date is empty', () => {
  // Cleared (Clear keeps the repeat), or written empty by an agent or a tool.
  beforeEach(() => {
    api.entry.mockResolvedValue({
      entry: { ...entry('2026-10-12'), values: { [field.id]: null } },
      schemaVersion: SCHEMA,
    });
  });

  it('keeps the Repeat row and This one, from the row’s current occurrence', async () => {
    const { user, input } = setup({ initial: '' });
    await user.click(input);
    await repeatRow('Every week on Monday');
    expect(within(card()).getByText('This one')).toBeInTheDocument();
    expect(within(card()).getByText('Mon, Oct 12 · Overdue')).toBeInTheDocument();
    // No day is picked, so the next ones are all dotted.
    expect(day(/October 19/)).toHaveAttribute('aria-label', 'Monday, October 19, 2026, repeats');
  });

  it('an empty date shows the Repeat row waiting for a date (a repeat starts from a date)', async () => {
    api.get.mockResolvedValue(view(null));
    const { user, input } = setup({ initial: '' });
    await user.click(input);
    await waitFor(() => expect(api.get).toHaveBeenCalled());
    await flush();
    expect(
      within(card()).getByRole('button', { name: 'Repeat, Pick a date first' })
    ).toBeDisabled();
  });

  it('the Repeat view edits or stops it; stopped, focus stays in the card', async () => {
    api.clear.mockResolvedValue({
      ...result('2026-10-12', null),
      entry: { ...entry('2026-10-12'), values: { [field.id]: null }, revision: 'c'.repeat(64) },
    });
    const { user, input } = setup({ initial: '' });
    await user.click(input);
    await user.click(await repeatRow('Every week on Monday'));
    expect(within(choices()).getByRole('radio', { name: 'Every week on Monday' })).toHaveAttribute(
      'aria-checked',
      'true'
    );
    await user.click(within(choices()).getByRole('radio', { name: 'Doesn’t repeat' }));
    await user.click(within(card()).getByRole('button', { name: 'Done' }));
    await waitFor(() => expect(api.clear).toHaveBeenCalledWith(TABLE, ENTRY, field.id, revision));
    await waitFor(() => expect(within(card()).getByRole('grid')).toBeInTheDocument());
    // Nothing repeats and there's no date: the Repeat row waits for one, and focus is on the grid's day.
    expect(
      within(card()).getByRole('button', { name: 'Repeat, Pick a date first' })
    ).toBeDisabled();
    expect(document.activeElement).toHaveAttribute('role', 'gridcell');
    expect(card().contains(document.activeElement)).toBe(true);
  });

  it('picking its current one’s day puts the date back; another day asks to move this one', async () => {
    api.move.mockResolvedValue(result('2026-10-14', weekly));
    const { user, input, onValue } = setup({ initial: '' });
    await user.click(input);
    await repeatRow('Every week on Monday');
    fireEvent.click(day(/October 14/));
    const prompt = within(card()).getByRole('group', { name: 'Move this one' });
    expect(prompt).toHaveTextContent('Move to Wed, Oct 14?');
    expect(onValue).not.toHaveBeenCalled();
    fireEvent.click(day(/October 12/));
    expect(onValue).toHaveBeenCalledWith('2026-10-12');
    expect(writes().flat()).toHaveLength(0);
  });
});

describe('DateRepeatInput: layers and keys', () => {
  it('Escape steps back: the Repeat view (unsaved), then the card', async () => {
    const { user, input } = setup();
    await user.click(input);
    await user.click(await repeatRow('Every week on Monday'));
    await user.click(within(choices()).getByRole('radio', { name: 'Every day' }));
    await user.keyboard('{Escape}');
    expect(cards()).toHaveLength(1);
    expect(await repeatRow('Every week on Monday')).toHaveFocus();
    await user.keyboard('{Escape}');
    expect(cards()).toHaveLength(0);
    expect(input).toHaveFocus();
    expect(writes().flat()).toHaveLength(0);
  });

  it('opening and closing it without edits writes nothing: no set, clear or cell PATCH', async () => {
    const { user, input, onValue } = setup();
    // The date view, closed by Escape.
    await user.click(input);
    await repeatRow('Every week on Monday');
    await user.keyboard('{Escape}');
    // The Repeat view, closed by its Done untouched, then the card's Done.
    await user.click(input);
    await user.click(await repeatRow('Every week on Monday'));
    await user.click(within(card()).getByRole('button', { name: 'Done' }));
    await repeatRow('Every week on Monday');
    await user.click(within(card()).getByRole('button', { name: 'Done' }));
    expect(cards()).toHaveLength(0);
    // The Repeat view again, closed by an outside press.
    await user.click(input);
    await user.click(await repeatRow('Every week on Monday'));
    fireEvent.pointerDown(document.body);
    expect(cards()).toHaveLength(0);
    await flush();
    expect(writes().flat()).toHaveLength(0);
    expect(onValue).not.toHaveBeenCalled();
  });

  it('one outside press closes the end date’s picker and the card together, unsaved', async () => {
    const { user, input } = setup();
    await user.click(input);
    await user.click(await repeatRow('Every week on Monday'));
    await user.click(
      within(within(card()).getByRole('radiogroup', { name: 'Ends' })).getByRole('radio', {
        name: 'On date',
      })
    );
    const end = within(card()).getByRole('combobox', { name: 'End date' });
    end.focus();
    fireEvent.keyDown(end, { key: 'ArrowDown' });
    expect(cards()).toHaveLength(2);
    fireEvent.pointerDown(document.body);
    expect(cards()).toHaveLength(0);
    expect(writes().flat()).toHaveLength(0);
  });

  it('Escape closes the end date’s picker first, then the Repeat view, then the card', async () => {
    const { user, input } = setup();
    await user.click(input);
    await user.click(await repeatRow('Every week on Monday'));
    await user.click(
      within(within(card()).getByRole('radiogroup', { name: 'Ends' })).getByRole('radio', {
        name: 'On date',
      })
    );
    const end = within(card()).getByRole('combobox', { name: 'End date' });
    end.focus();
    fireEvent.keyDown(end, { key: 'ArrowDown' });
    expect(cards()).toHaveLength(2);
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
    expect(cards()).toHaveLength(1);
    expect(choices()).toBeInTheDocument();
    expect(end).toHaveFocus();
    fireEvent.keyDown(end, { key: 'Escape' });
    expect(within(card()).getByRole('grid')).toBeInTheDocument();
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
    expect(cards()).toHaveLength(0);
  });

  it('Tab runs through the date view: the day, Repeat, This one, the footer, the header', async () => {
    const { input } = setup();
    input.focus();
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    await repeatRow('Every week on Monday');
    const order: string[] = [];
    for (let i = 0; i < 10; i++) {
      const active = document.activeElement as HTMLElement;
      order.push(active.getAttribute('aria-label') ?? active.textContent ?? '');
      fireEvent.keyDown(active, { key: 'Tab' });
    }
    expect(order).toEqual([
      'Monday, October 12, 2026',
      'Repeat, Every week on Monday',
      'Mark this one done',
      'Skip this one',
      'Today',
      'Clear',
      'Done',
      'Previous month',
      'Choose month and year, October 2026',
      'Next month',
    ]);
  });
});
