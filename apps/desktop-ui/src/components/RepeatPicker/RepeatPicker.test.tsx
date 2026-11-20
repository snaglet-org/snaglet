import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import {
  createTableRepeat,
  repeatDraftFromRepeat,
  repeatInputFromDraft,
  tableRepeatSummary,
  type TableRepeat,
} from '@snaglet/shared/utils';
import { RepeatPicker, type RepeatPickerProps } from './RepeatPicker';

// Tue Oct 13, 2026.
const ANCHOR = '2026-10-13';
// Tue Oct 13, 2026, 9:00 AM.
const TIMED = '2026-10-13T09:00:00';

function repeat(input: { date?: string; rrule: string }) {
  const created = createTableRepeat({ date: ANCHOR, tz: 'UTC', ...input });
  if (!created.ok) throw new Error(created.error);
  return created.value;
}

function setup(props: Partial<RepeatPickerProps> = {}) {
  const onSave = vi.fn();
  const onClose = vi.fn();
  render(
    <RepeatPicker anchor={ANCHOR} repeat={null} onSave={onSave} onClose={onClose} {...props} />
  );
  return { onSave, onClose, user: userEvent.setup() };
}

const choices = () => screen.getByRole('radiogroup', { name: 'How it repeats' });
const choice = (name: string | RegExp) => within(choices()).getByRole('radio', { name });
const monthly = (name: string) =>
  within(screen.getByRole('radiogroup', { name: 'Monthly on' })).getByRole('radio', { name });
const ends = (name: string) =>
  within(screen.getByRole('radiogroup', { name: 'Ends' })).getByRole('radio', { name });
const summary = () => screen.getByTestId('repeat-panel-summary');
const done = () => screen.getByRole('button', { name: 'Done' });
const number = (name: string) => screen.getByRole('spinbutton', { name });
const combo = (name: string) => screen.getByRole('combobox', { name });
const pressed = (name: string) => screen.getByRole('button', { name });
/** Interval's four boxes, in order: days, hours, minutes, seconds. */
const intervalBoxes = () =>
  ['Days', 'Hours', 'Minutes', 'Seconds'].map((name) => (number(name) as HTMLInputElement).value);
/** A list's values, and the text of the one shown. */
const values = (name: string) =>
  within(combo(name))
    .getAllByRole('option')
    .map((option) => (option as HTMLOptionElement).value);
const shown = (name: string) =>
  within(combo(name))
    .getAllByRole('option')
    .find((option) => (option as HTMLOptionElement).selected)?.textContent;

describe('RepeatPicker choices', () => {
  it('lists the six choices for the cell’s date, under its header', () => {
    setup();
    expect(
      within(choices())
        .getAllByRole('radio')
        .map((radio) => radio.textContent)
    ).toEqual([
      'Doesn’t repeat',
      'Every day',
      'Every week on Tuesday',
      'Every month on the 13th',
      'Every year on Oct 13',
      'Custom…',
    ]);
    expect(choice('Doesn’t repeat')).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByText('Repeat')).toBeInTheDocument();
    expect(screen.getByText('from Oct 13')).toBeInTheDocument();
    expect(summary()).toHaveTextContent('Doesn’t repeat');
    expect(screen.getByText('Pick how often')).toBeInTheDocument();
    // Ends shows once it repeats.
    expect(screen.queryByRole('radiogroup', { name: 'Ends' })).toBeNull();
  });

  it('a choice is a draft: the sentence and next date follow it, and Done saves it', async () => {
    const { onSave, user } = setup();
    await user.click(choice('Every month on the 13th'));
    expect(summary()).toHaveTextContent('Every month on the 13th');
    expect(screen.getByText('Next: Fri Nov 13')).toBeInTheDocument();
    expect(onSave).not.toHaveBeenCalled();
    await user.click(done());
    expect(onSave).toHaveBeenCalledWith({
      rrule: 'FREQ=MONTHLY',
      date: ANCHOR,
    });
  });

  it.each([
    ['Every day', 'FREQ=DAILY'],
    ['Every week on Tuesday', 'FREQ=WEEKLY;BYDAY=TU'],
    ['Every month on the 13th', 'FREQ=MONTHLY'],
    ['Every year on Oct 13', 'FREQ=YEARLY'],
  ])('the quick choice %s saves %s from the cell’s date', async (name, rrule) => {
    const { onSave, user } = setup();
    await user.click(choice(name));
    expect(summary()).toHaveTextContent(name);
    await user.click(done());
    expect(onSave).toHaveBeenCalledWith({ rrule, date: ANCHOR });
    // Saved, it opens on the same choice.
    const saved = repeat({ rrule });
    render(<RepeatPicker anchor={ANCHOR} repeat={saved} onSave={vi.fn()} onClose={vi.fn()} />);
    const again = within(screen.getAllByRole('radiogroup', { name: 'How it repeats' })[1]!);
    expect(again.getByRole('radio', { name })).toHaveAttribute('aria-checked', 'true');
  });

  it('Doesn’t repeat clears a saved repeat; untouched, Done only closes', async () => {
    const saved = repeat({ rrule: 'FREQ=WEEKLY;BYDAY=TU' });
    const { onSave, onClose, user } = setup({ repeat: saved });
    expect(choice('Every week on Tuesday')).toHaveAttribute('aria-checked', 'true');
    await user.click(done());
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onSave).not.toHaveBeenCalled();
    await user.click(choice('Doesn’t repeat'));
    await user.click(done());
    expect(onSave).toHaveBeenCalledWith(null);
  });

  it('a plain cell left on Doesn’t repeat writes nothing', async () => {
    const { onSave, onClose, user } = setup();
    await user.click(choice('Every day'));
    await user.click(choice('Doesn’t repeat'));
    await user.click(done());
    expect(onSave).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('Ends is one line, kept across choices: Never, On date, After N', async () => {
    const { onSave, user } = setup();
    await user.click(choice('Every day'));
    expect(ends('Never')).toHaveAttribute('aria-checked', 'true');
    await user.click(ends('After'));
    expect(number('How many')).toHaveValue(10);
    expect(summary()).toHaveTextContent('Every day, 10 times');
    await user.click(choice('Every week on Tuesday'));
    expect(summary()).toHaveTextContent('Every week on Tuesday, 10 times');
    await user.click(ends('On date'));
    expect(screen.getByLabelText('End date')).toHaveAttribute('data-value', '2027-01-11');
    expect(summary()).toHaveTextContent('Every week on Tuesday, until Jan 11, 2027');
    await user.click(ends('After'));
    await user.click(done());
    expect(onSave).toHaveBeenCalledWith(
      expect.objectContaining({ rrule: 'FREQ=WEEKLY;BYDAY=TU;COUNT=10' })
    );
  });

  it('nested in the date popover, Back saves what changed, as Done does', async () => {
    const { onSave, onClose, user } = setup({ nested: true });
    await user.click(screen.getByRole('button', { name: 'Back to the date' }));
    expect(onClose).toHaveBeenCalledTimes(1);
    await user.click(choice('Every day'));
    await user.click(screen.getByRole('button', { name: 'Back to the date' }));
    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ rrule: 'FREQ=DAILY' }));
  });

  it('shows the save error it is given', () => {
    setup({ error: 'This entry changed elsewhere.' });
    expect(screen.getByRole('alert')).toHaveTextContent('This entry changed elsewhere.');
  });
});

/**
 * Every kind of saved repeat opens as itself, and
 * saves back unchanged. Untouched, Done writes nothing at all (a re-save
 * would restart the series at the current one); the draft it reads as is
 * the same spec, so a change elsewhere in the panel keeps the rest exactly.
 */
describe('RepeatPicker opens every saved repeat as itself and leaves it unchanged', () => {
  const custom = () => expect(choice('Custom')).toHaveAttribute('aria-checked', 'true');

  const cases: {
    name: string;
    input: { date?: string; rrule: string };
    props?: Partial<RepeatPickerProps>;
    sentence: string;
    shows: () => void;
  }[] = [
    {
      name: 'daily',
      input: { rrule: 'FREQ=DAILY' },
      sentence: 'Every day',
      shows: () => {
        expect(choice('Every day')).toHaveAttribute('aria-checked', 'true');
        expect(screen.queryByRole('group', { name: 'Custom repeat' })).toBeNull();
      },
    },
    {
      name: 'weekdays',
      input: { rrule: 'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR' },
      sentence: 'Every weekday',
      shows: () => {
        custom();
        expect(number('Every how many')).toHaveValue(1);
        expect(combo('Period')).toHaveValue('week');
        expect(shown('Period')).toBe('week');
        for (const day of ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'])
          expect(pressed(day)).toHaveAttribute('aria-pressed', 'true');
        for (const day of ['Saturday', 'Sunday'])
          expect(pressed(day)).toHaveAttribute('aria-pressed', 'false');
      },
    },
    {
      name: 'weekly on several days',
      input: { rrule: 'FREQ=WEEKLY;BYDAY=TU,TH' },
      sentence: 'Every week on Tue and Thu',
      shows: () => {
        custom();
        expect(pressed('Tuesday')).toHaveAttribute('aria-pressed', 'true');
        expect(pressed('Thursday')).toHaveAttribute('aria-pressed', 'true');
        expect(pressed('Monday')).toHaveAttribute('aria-pressed', 'false');
      },
    },
    {
      name: 'monthly on the 13th',
      input: { rrule: 'FREQ=MONTHLY' },
      sentence: 'Every month on the 13th',
      shows: () =>
        expect(choice('Every month on the 13th')).toHaveAttribute('aria-checked', 'true'),
    },
    {
      name: 'monthly on the last day',
      input: { date: '2026-10-31', rrule: 'FREQ=MONTHLY;BYMONTHDAY=-1' },
      props: { anchor: '2026-10-31' },
      sentence: 'Every month on the last day',
      shows: () => {
        custom();
        expect(monthly('on day')).toBeChecked();
        expect(combo('Day of the month')).toHaveValue('-1');
      },
    },
    {
      // A saved repeat: the form makes one day a month; several stay one entry.
      name: 'monthly on several days and the last day',
      input: { date: '2026-10-15', rrule: 'FREQ=MONTHLY;BYMONTHDAY=1,15,-1' },
      props: { anchor: '2026-10-15' },
      sentence: 'Every month on the 1st, 15th and last day',
      shows: () => {
        custom();
        expect(monthly('on day')).toBeChecked();
        expect(shown('Day of the month')).toBe('1st, 15th and last day');
        expect(screen.queryByRole('group', { name: 'Dates' })).toBeNull();
      },
    },
    {
      name: 'monthly on the 2nd Tuesday',
      input: { rrule: 'FREQ=MONTHLY;BYDAY=2TU' },
      sentence: 'Every month on the 2nd Tuesday',
      shows: () => {
        custom();
        expect(monthly('on the')).toBeChecked();
        expect(combo('Which week')).toHaveValue('2');
        expect(combo('Weekday')).toHaveValue('TU');
      },
    },
    {
      name: 'monthly on the last Tuesday',
      input: { date: '2026-10-27', rrule: 'FREQ=MONTHLY;BYDAY=-1TU' },
      props: { anchor: '2026-10-27' },
      sentence: 'Every month on the last Tuesday',
      shows: () => expect(combo('Which week')).toHaveValue('-1'),
    },
    {
      name: 'yearly',
      input: { rrule: 'FREQ=YEARLY' },
      sentence: 'Every year on Oct 13',
      shows: () => expect(choice('Every year on Oct 13')).toHaveAttribute('aria-checked', 'true'),
    },
    {
      // A saved yearly repeat: Custom doesn't offer years, but keeps Year for this one.
      name: 'every 2 years',
      input: { rrule: 'FREQ=YEARLY;INTERVAL=2' },
      sentence: 'Every 2 years on Oct 13',
      shows: () => {
        custom();
        expect(number('Every how many')).toHaveValue(2);
        expect(combo('Period')).toHaveValue('year');
        expect(screen.getByText('on Oct 13')).toBeInTheDocument();
      },
    },
    {
      name: 'every 2 weeks',
      input: { rrule: 'FREQ=WEEKLY;INTERVAL=2;BYDAY=TU' },
      sentence: 'Every 2 weeks on Tuesday',
      shows: () => {
        custom();
        expect(number('Every how many')).toHaveValue(2);
        expect(combo('Period')).toHaveValue('week');
        expect(shown('Period')).toBe('weeks');
      },
    },
    {
      name: 'every 3 weeks on two days',
      input: { rrule: 'FREQ=WEEKLY;INTERVAL=3;BYDAY=TU,TH' },
      sentence: 'Every 3 weeks on Tue and Thu',
      shows: () => {
        custom();
        expect(number('Every how many')).toHaveValue(3);
        expect(combo('Period')).toHaveValue('week');
        expect(shown('Period')).toBe('weeks');
        expect(screen.getByText('on')).toBeInTheDocument();
        expect(pressed('Tuesday')).toHaveAttribute('aria-pressed', 'true');
        expect(pressed('Thursday')).toHaveAttribute('aria-pressed', 'true');
      },
    },
    {
      name: 'every 3 months',
      input: { rrule: 'FREQ=MONTHLY;INTERVAL=3' },
      sentence: 'Every 3 months on the 13th',
      shows: () => {
        custom();
        expect(number('Every how many')).toHaveValue(3);
        expect(combo('Period')).toHaveValue('month');
        expect(combo('Day of the month')).toHaveValue('13');
      },
    },
    {
      name: 'every 90 minutes',
      input: { date: TIMED, rrule: 'FREQ=MINUTELY;INTERVAL=90' },
      props: { anchor: TIMED },
      sentence: 'Every 1 h 30 min',
      shows: () => {
        custom();
        expect(combo('Period')).toHaveValue('interval');
        expect(shown('Period')).toBe('Interval');
        expect(screen.queryByRole('spinbutton', { name: 'Every how many' })).toBeNull();
        expect(intervalBoxes()).toEqual(['0', '1', '30', '0']);
      },
    },
    {
      name: 'every 2 hours',
      input: { date: TIMED, rrule: 'FREQ=HOURLY;INTERVAL=2' },
      props: { anchor: TIMED },
      sentence: 'Every 2 h',
      shows: () => {
        expect(combo('Period')).toHaveValue('interval');
        expect(intervalBoxes()).toEqual(['0', '2', '0', '0']);
      },
    },
    {
      name: 'an interval of days and seconds',
      input: { date: TIMED, rrule: 'FREQ=SECONDLY;INTERVAL=194415;COUNT=5' },
      props: { anchor: TIMED },
      sentence: 'Every 2 days 6 h 15 s, 5 times',
      shows: () => {
        custom();
        expect(combo('Period')).toHaveValue('interval');
        expect(intervalBoxes()).toEqual(['2', '6', '0', '15']);
        expect(ends('After')).toHaveAttribute('aria-checked', 'true');
        expect(number('How many')).toHaveValue(5);
      },
    },
    {
      name: 'ending on a date',
      input: { rrule: 'FREQ=WEEKLY;BYDAY=TU;UNTIL=20261231' },
      sentence: 'Every week on Tuesday, until Dec 31',
      shows: () => {
        expect(choice('Every week on Tuesday')).toHaveAttribute('aria-checked', 'true');
        expect(ends('On date')).toHaveAttribute('aria-checked', 'true');
        expect(screen.getByLabelText('End date')).toHaveAttribute('data-value', '2026-12-31');
      },
    },
    {
      name: 'ending after N times',
      input: { rrule: 'FREQ=DAILY;COUNT=10' },
      sentence: 'Every day, 10 times',
      shows: () => {
        expect(choice('Every day')).toHaveAttribute('aria-checked', 'true');
        expect(ends('After')).toHaveAttribute('aria-checked', 'true');
        expect(number('How many')).toHaveValue(10);
      },
    },
  ];

  it.each(cases)('$name', async ({ input, props, sentence, shows }) => {
    const saved = repeat(input);
    const anchor = props?.anchor ?? ANCHOR;
    const { onSave, onClose, user } = setup({ repeat: saved, ...props });
    expect(summary()).toHaveTextContent(sentence);
    shows();
    await user.click(done());
    expect(onSave).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledTimes(1);
    // The draft it reads as saves back the very same spec.
    const read = repeatDraftFromRepeat(saved, { anchor });
    expect(read.exact).toBe(true);
    const again = repeatInputFromDraft(read.draft);
    if (!again.ok) throw new Error(again.error);
    expect({ ...again.value, date: again.value.date }).toEqual({
      rrule: saved.rrule,
      date: saved.current,
    });
  });

  it('a field with an End date reads its set days the same', async () => {
    const saved = repeat({ rrule: 'FREQ=WEEKLY;BYDAY=TU,TH' });
    const { onSave, user } = setup({ repeat: saved, hasEnd: true });
    expect(summary()).toHaveTextContent('Every week on Tue and Thu');
    await user.click(done());
    expect(onSave).not.toHaveBeenCalled();
  });

  it('a saved rule it can’t show opens in Custom with a note, and stays as it is', async () => {
    const odd: TableRepeat = repeat({
      date: '2026-10-30',
      rrule: 'FREQ=MONTHLY;BYDAY=FR;BYSETPOS=-1',
    });
    const { onSave, onClose, user } = setup({ repeat: odd, anchor: '2026-10-30' });
    expect(choice('Custom')).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByText(/parts this editor can’t show/)).toBeInTheDocument();
    await user.click(done());
    expect(onSave).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalled();
  });

  it('an older every-2-weeks rule from a Sunday week start reads as itself and writes nothing', async () => {
    // Sun Oct 4: with weeks from Sunday the next one is Tue Oct 6; the form,
    // whose weeks start on Monday, would make it Tue Oct 13.
    const saved = repeat({
      date: '2026-10-04',
      rrule: 'FREQ=WEEKLY;INTERVAL=2;BYDAY=SU,TU;WKST=SU',
    });
    const { onSave, onClose, user } = setup({ repeat: saved, anchor: '2026-10-04' });
    expect(choice('Custom')).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByText(/parts this editor can’t show/)).toBeInTheDocument();
    expect(summary()).toHaveTextContent(tableRepeatSummary(saved));
    expect(screen.getByText('Next: Tue Oct 6')).toBeInTheDocument();
    await user.click(done());
    expect(onSave).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('once it changes, the sentence and the next date are what Done would save', async () => {
    const saved = repeat({
      date: '2026-10-04',
      rrule: 'FREQ=WEEKLY;INTERVAL=2;BYDAY=SU,TU;WKST=SU',
    });
    const { onSave, user } = setup({ repeat: saved, anchor: '2026-10-04' });
    await user.click(ends('After'));
    expect(summary()).toHaveTextContent('Every 2 weeks on Tue and Sun, 10 times');
    expect(screen.getByText('Next: Tue Oct 13')).toBeInTheDocument();
    await user.click(done());
    expect(onSave).toHaveBeenCalledWith({
      rrule: 'FREQ=WEEKLY;INTERVAL=2;BYDAY=TU,SU;COUNT=10',
      date: '2026-10-04',
    });
  });

  it('a change saves the rest exactly as it was', async () => {
    const saved = repeat({ date: '2026-11-01', rrule: 'FREQ=MONTHLY;COUNT=6' });
    const { onSave, user } = setup({ repeat: saved, anchor: '2026-11-01' });
    fireEvent.change(number('How many'), { target: { value: '8' } });
    await user.click(done());
    expect(onSave).toHaveBeenCalledWith({
      rrule: 'FREQ=MONTHLY;COUNT=8',
      date: '2026-11-01',
    });
  });

  it('an agent’s count above 99 stays: opening and leaving its box write nothing', async () => {
    const saved = repeat({ rrule: 'FREQ=DAILY;INTERVAL=180' });
    const { onSave, onClose, user } = setup({ repeat: saved });
    expect(summary()).toHaveTextContent('Every 180 days');
    expect(number('Every how many')).toHaveValue(180);
    await user.click(number('Every how many'));
    await user.tab();
    expect(number('Every how many')).toHaveValue(180);
    expect(summary()).toHaveTextContent('Every 180 days');
    await user.click(done());
    expect(onSave).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('an agent’s count above 99 is kept when something else changes', async () => {
    const saved = repeat({ rrule: 'FREQ=DAILY;INTERVAL=180' });
    const { onSave, user } = setup({ repeat: saved });
    await user.click(ends('After'));
    fireEvent.keyDown(number('How many'), { key: 'Enter' });
    expect(onSave).toHaveBeenCalledWith({
      rrule: 'FREQ=DAILY;INTERVAL=180;COUNT=10',
      date: ANCHOR,
    });
  });

  it('an agent’s count above 99 changes only when the person edits it', async () => {
    const saved = repeat({ rrule: 'FREQ=DAILY;INTERVAL=180' });
    const { onSave, user } = setup({ repeat: saved });
    const every = number('Every how many');
    await user.clear(every);
    await user.type(every, '5');
    await user.click(done());
    expect(onSave).toHaveBeenCalledWith({ rrule: 'FREQ=DAILY;INTERVAL=5', date: ANCHOR });
  });

  it('a change made and undone writes nothing', async () => {
    const saved = repeat({ rrule: 'FREQ=WEEKLY;INTERVAL=2;BYDAY=TU' });
    const { onSave, onClose, user } = setup({ repeat: saved });
    await user.selectOptions(combo('Period'), 'day');
    await user.selectOptions(combo('Period'), 'week');
    expect(number('Every how many')).toHaveValue(2);
    await user.click(done());
    expect(onSave).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('every 3 weeks keeps its count through other units, and writes nothing undone', async () => {
    const saved = repeat({ rrule: 'FREQ=WEEKLY;INTERVAL=3;BYDAY=TU' });
    const { onSave, onClose, user } = setup({ repeat: saved });
    await user.selectOptions(combo('Period'), 'day');
    expect(number('Every how many')).toHaveValue(3);
    expect(summary()).toHaveTextContent('Every 3 days');
    await user.selectOptions(combo('Period'), 'month');
    expect(summary()).toHaveTextContent('Every 3 months on the 13th');
    await user.selectOptions(combo('Period'), 'week');
    expect(number('Every how many')).toHaveValue(3);
    expect(summary()).toHaveTextContent('Every 3 weeks on Tuesday');
    await user.click(done());
    expect(onSave).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('an interval to days and back writes nothing: each keeps its own numbers', async () => {
    const saved = repeat({ date: TIMED, rrule: 'FREQ=MINUTELY;INTERVAL=90' });
    const { onSave, onClose, user } = setup({ repeat: saved, anchor: TIMED });
    await user.selectOptions(combo('Period'), 'day');
    expect(number('Every how many')).toHaveValue(1);
    expect(screen.queryByRole('group', { name: 'Interval' })).toBeNull();
    expect(summary()).toHaveTextContent('Every day');
    await user.selectOptions(combo('Period'), 'interval');
    expect(intervalBoxes()).toEqual(['0', '1', '30', '0']);
    expect(summary()).toHaveTextContent('Every 1 h 30 min');
    await user.click(done());
    expect(onSave).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('several days of a month: picking one day replaces them', async () => {
    const saved = repeat({ date: '2026-10-15', rrule: 'FREQ=MONTHLY;BYMONTHDAY=1,15,-1' });
    const { onSave, user } = setup({ repeat: saved, anchor: '2026-10-15' });
    await user.selectOptions(combo('Day of the month'), '20');
    expect(summary()).toHaveTextContent('Every month on the 20th');
    // The kept several-days entry is gone once another day is picked.
    expect(values('Day of the month')).not.toContain('kept');
    await user.click(done());
    // From the 20th, "every month on the 20th" is plain FREQ=MONTHLY.
    expect(onSave).toHaveBeenCalledWith({ rrule: 'FREQ=MONTHLY', date: '2026-10-20' });
  });
});

describe('RepeatPicker Custom…', () => {
  it('is one line, "Repeat every [N] [week] on" the days: no tabs, no More options', async () => {
    const { user } = setup();
    await user.click(choice('Custom…'));
    expect(choice('Custom')).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByText('Repeat every')).toBeInTheDocument();
    expect(number('Every how many')).toHaveValue(1);
    expect(combo('Period')).toHaveValue('week');
    expect(shown('Period')).toBe('week');
    expect(screen.getByText('on')).toBeInTheDocument();
    expect(screen.getByRole('group', { name: 'On these days' })).toBeInTheDocument();
    expect(screen.queryByRole('checkbox')).toBeNull();
    expect(screen.queryByText(/other week/i)).toBeNull();
    expect(screen.queryByRole('radiogroup', { name: 'Kind of custom repeat' })).toBeNull();
    expect(screen.queryByRole('button', { name: /options$/ })).toBeNull();
    expect(summary()).toHaveTextContent('Every week on Tuesday');
  });

  it.each([2, 3, 4])(
    'every %i weeks on several weekdays: the unit reads "weeks", and the days are kept',
    async (n) => {
      const { onSave, user } = setup();
      await user.click(choice('Custom…'));
      await user.click(pressed('Wednesday'));
      await user.click(pressed('Thursday'));
      await user.click(pressed('Saturday'));
      await user.click(pressed('Tuesday'));
      expect(summary()).toHaveTextContent('Every week on Wed, Thu and Sat');
      const every = number('Every how many');
      await user.clear(every);
      await user.type(every, String(n));
      expect(shown('Period')).toBe('weeks');
      expect(summary()).toHaveTextContent(`Every ${n} weeks on Wed, Thu and Sat`);
      await user.click(done());
      expect(onSave).toHaveBeenCalledWith({
        rrule: `FREQ=WEEKLY;INTERVAL=${n};BYDAY=WE,TH,SA`,
        date: '2026-10-14',
      });
    }
  );

  it('the last weekday stays on', async () => {
    const { user } = setup();
    await user.click(choice('Custom…'));
    await user.click(pressed('Tuesday'));
    expect(pressed('Tuesday')).toHaveAttribute('aria-pressed', 'true');
    expect(summary()).toHaveTextContent('Every week on Tuesday');
  });

  it('weeks to days: the N stays and the chips go; back to weeks keeps the days', async () => {
    const { onSave, user } = setup();
    await user.click(choice('Custom…'));
    await user.click(pressed('Friday'));
    await user.click(pressed('Monday'));
    await user.selectOptions(combo('Period'), 'day');
    expect(number('Every how many')).toHaveValue(1);
    expect(screen.queryByRole('group', { name: 'On these days' })).toBeNull();
    expect(screen.queryByText('on')).toBeNull();
    const every = number('Every how many');
    await user.clear(every);
    await user.type(every, '2');
    expect(summary()).toHaveTextContent('Every 2 days');
    expect(shown('Period')).toBe('days');
    await user.selectOptions(combo('Period'), 'month');
    expect(number('Every how many')).toHaveValue(2);
    expect(summary()).toHaveTextContent('Every 2 months on the 13th');
    await user.selectOptions(combo('Period'), 'week');
    expect(summary()).toHaveTextContent('Every 2 weeks on Mon, Tue and Fri');
    await user.click(done());
    expect(onSave).toHaveBeenCalledWith(
      expect.objectContaining({ rrule: 'FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,TU,FR' })
    );
  });

  it('clicking Custom again keeps what was set', async () => {
    const { user } = setup();
    await user.click(choice('Custom…'));
    await user.selectOptions(combo('Period'), 'month');
    const every = number('Every how many');
    await user.clear(every);
    await user.type(every, '3');
    await user.click(choice('Custom'));
    expect(combo('Period')).toHaveValue('month');
    expect(number('Every how many')).toHaveValue(3);
    expect(summary()).toHaveTextContent('Every 3 months on the 13th');
  });

  it('while saving, Custom’s controls are disabled like the choices', async () => {
    const saved = repeat({ rrule: 'FREQ=WEEKLY;INTERVAL=3;BYDAY=TU' });
    setup({ repeat: saved, busy: true });
    expect(choice('Custom')).toBeDisabled();
    expect(number('Every how many')).toBeDisabled();
    expect(combo('Period')).toBeDisabled();
    expect(pressed('Tuesday')).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Saving…' })).toBeDisabled();
  });

  it('month on a day: the cell’s day, any other day, or the last day', async () => {
    const { onSave, user } = setup();
    await user.click(choice('Custom…'));
    await user.selectOptions(combo('Period'), 'month');
    expect(monthly('on day')).toBeChecked();
    expect(combo('Day of the month')).toHaveValue('13');
    // One day a month: 1–31 and the last day, no grid of dates.
    expect(values('Day of the month')).toHaveLength(32);
    expect(screen.queryByRole('group', { name: 'Dates' })).toBeNull();
    await user.selectOptions(combo('Day of the month'), '20');
    expect(summary()).toHaveTextContent('Every month on the 20th');
    await user.selectOptions(combo('Day of the month'), '-1');
    expect(summary()).toHaveTextContent('Every month on the last day');
    await user.click(done());
    expect(onSave).toHaveBeenCalledWith({
      rrule: 'FREQ=MONTHLY;BYMONTHDAY=-1',
      date: '2026-10-31',
    });
  });

  it('month on the nth weekday: "on the [2nd] [Tuesday]"', async () => {
    const { onSave, user } = setup();
    await user.click(choice('Custom…'));
    await user.selectOptions(combo('Period'), 'month');
    await user.click(monthly('on the'));
    expect(summary()).toHaveTextContent('Every month on the 2nd Tuesday');
    await user.click(monthly('on day'));
    expect(summary()).toHaveTextContent('Every month on the 13th');
    // Choosing the week or the weekday picks its row too.
    await user.selectOptions(combo('Which week'), '-1');
    expect(monthly('on the')).toBeChecked();
    await user.selectOptions(combo('Weekday'), 'FR');
    expect(summary()).toHaveTextContent('Every month on the last Friday');
    await user.click(done());
    expect(onSave).toHaveBeenCalledWith(
      expect.objectContaining({ rrule: 'FREQ=MONTHLY;BYDAY=-1FR' })
    );
  });
});

describe('RepeatPicker yearly and the week', () => {
  it('Every year on the date is a quick choice, saved as a yearly rule', async () => {
    const { onSave, user } = setup();
    await user.click(choice('Every year on Oct 13'));
    expect(choice('Every year on Oct 13')).toHaveAttribute('aria-checked', 'true');
    expect(summary()).toHaveTextContent('Every year on Oct 13');
    expect(screen.getByText('Next: Wed Oct 13, 2027')).toBeInTheDocument();
    await user.click(done());
    expect(onSave).toHaveBeenCalledWith({ rrule: 'FREQ=YEARLY', date: ANCHOR });
  });

  it('Custom offers day, week and month for a new repeat: no Year', async () => {
    const { user } = setup();
    await user.click(choice('Custom…'));
    expect(values('Period')).toEqual(['day', 'week', 'month']);
  });

  it('Custom after the yearly quick choice starts on every week, without Year', async () => {
    const { onSave, user } = setup();
    await user.click(choice('Every year on Oct 13'));
    await user.click(ends('After'));
    await user.click(choice('Custom…'));
    expect(values('Period')).toEqual(['day', 'week', 'month']);
    expect(combo('Period')).toHaveValue('week');
    expect(number('Every how many')).toHaveValue(1);
    expect(pressed('Tuesday')).toHaveAttribute('aria-pressed', 'true');
    expect(summary()).toHaveTextContent('Every week on Tuesday, 10 times');
    await user.click(done());
    expect(onSave).toHaveBeenCalledWith({ rrule: 'FREQ=WEEKLY;BYDAY=TU;COUNT=10', date: ANCHOR });
  });

  it('a date without a time says how to repeat every few minutes or hours', async () => {
    const { user } = setup();
    await user.click(choice('Custom…'));
    expect(
      screen.getByText('Add a time to repeat every few seconds, minutes or hours.')
    ).toBeInTheDocument();
  });

  it('an all-day event has no such hint: events repeat by day or longer', async () => {
    const { user } = setup({ noInterval: true });
    await user.click(choice('Custom…'));
    expect(screen.queryByText(/Add a time/)).toBeNull();
  });

  it('a saved repeat every few years keeps Year, and reads as today', async () => {
    const saved = repeat({ rrule: 'FREQ=YEARLY;INTERVAL=2' });
    const { onSave, user } = setup({ repeat: saved });
    expect(values('Period')).toEqual(['day', 'week', 'month', 'year']);
    // Year stays on offer while the panel is open.
    await user.selectOptions(combo('Period'), 'month');
    expect(values('Period')).toEqual(['day', 'week', 'month', 'year']);
    await user.selectOptions(combo('Period'), 'year');
    await user.click(done());
    expect(onSave).not.toHaveBeenCalled();
  });

  it('weekday chips start on Monday', async () => {
    const { user } = setup();
    await user.click(choice('Custom…'));
    const chips = within(screen.getByRole('group', { name: 'On these days' })).getAllByRole(
      'button'
    );
    expect(chips.map((chip) => chip.getAttribute('aria-label'))).toEqual([
      'Monday',
      'Tuesday',
      'Wednesday',
      'Thursday',
      'Friday',
      'Saturday',
      'Sunday',
    ]);
  });
});

describe('RepeatPicker Custom… Interval', () => {
  const openTimed = async (props: Partial<RepeatPickerProps> = {}) => {
    const ctx = setup({ anchor: TIMED, ...props });
    await ctx.user.click(choice('Custom…'));
    return ctx;
  };
  const setBox = async (user: ReturnType<typeof userEvent.setup>, name: string, value: string) => {
    await user.clear(number(name));
    await user.type(number(name), value);
  };

  it('only for a date with a time, as the list’s last entry', async () => {
    const { user } = setup();
    await user.click(choice('Custom…'));
    expect(values('Period')).toEqual(['day', 'week', 'month']);
    cleanup();
    await openTimed();
    expect(values('Period')).toEqual(['day', 'week', 'month', 'interval']);
    expect(
      within(combo('Period'))
        .getAllByRole('option')
        .map((option) => option.textContent)
    ).toEqual(['day', 'week', 'month', 'Interval']);
  });

  it('never for an event, which repeats by day or longer', async () => {
    const { user } = await openTimed({ noInterval: true });
    expect(values('Period')).toEqual(['day', 'week', 'month']);
    expect(screen.queryByText(/Add a time/)).toBeNull();
    await user.selectOptions(combo('Period'), 'day');
    expect(summary()).toHaveTextContent('Every day');
  });

  it('four boxes, "[0] days [1] hour [0] minutes [0] seconds", saved as the interval rule', async () => {
    const { onSave, user } = await openTimed();
    await user.selectOptions(combo('Period'), 'interval');
    expect(shown('Period')).toBe('Interval');
    expect(screen.queryByRole('spinbutton', { name: 'Every how many' })).toBeNull();
    expect(screen.queryByRole('group', { name: 'On these days' })).toBeNull();
    expect(intervalBoxes()).toEqual(['0', '1', '0', '0']);
    const parts = screen.getByRole('group', { name: 'Interval' });
    expect(parts).toHaveTextContent('days');
    expect(parts).toHaveTextContent('hour');
    expect(parts).not.toHaveTextContent('hours');
    expect(parts).toHaveTextContent('minutes');
    expect(parts).toHaveTextContent('seconds');
    expect(summary()).toHaveTextContent('Every 1 h');
    await setBox(user, 'Minutes', '30');
    expect(summary()).toHaveTextContent('Every 1 h 30 min');
    expect(screen.getByText(/^Starts Tue Oct 13, 9:00 AM/)).toBeInTheDocument();
    expect(screen.getByText('Next: Tue Oct 13, 10:30 AM')).toBeInTheDocument();
    await user.click(done());
    expect(onSave).toHaveBeenCalledWith({ rrule: 'FREQ=MINUTELY;INTERVAL=90', date: TIMED });
  });

  it('days and seconds too; ending after N times; Enter saves', async () => {
    const { onSave, user } = await openTimed();
    await user.selectOptions(combo('Period'), 'interval');
    await setBox(user, 'Days', '2');
    await setBox(user, 'Hours', '6');
    await setBox(user, 'Seconds', '15');
    expect(summary()).toHaveTextContent('Every 2 days 6 h 15 s');
    await user.click(ends('After'));
    expect(summary()).toHaveTextContent('Every 2 days 6 h 15 s, 10 times');
    fireEvent.keyDown(number('Seconds'), { key: 'Enter' });
    expect(onSave).toHaveBeenCalledWith({
      rrule: 'FREQ=SECONDLY;INTERVAL=194415;COUNT=10',
      date: TIMED,
    });
  });

  it('leaving a box carries over: 90 minutes reads 1 hour 30 minutes', async () => {
    const { user } = await openTimed();
    await user.selectOptions(combo('Period'), 'interval');
    await setBox(user, 'Hours', '0');
    await setBox(user, 'Minutes', '90');
    expect(intervalBoxes()).toEqual(['0', '0', '90', '0']);
    await user.tab();
    expect(intervalBoxes()).toEqual(['0', '1', '30', '0']);
    expect(summary()).toHaveTextContent('Every 1 h 30 min');
  });

  it('holds the 1-second floor: all zeros says so and won’t save', async () => {
    const { onSave, user } = await openTimed();
    await user.selectOptions(combo('Period'), 'interval');
    await setBox(user, 'Hours', '0');
    expect(screen.getByRole('alert')).toHaveTextContent('The shortest interval is 1 s.');
    expect(number('Seconds')).toHaveAttribute('aria-invalid', 'true');
    expect(done()).toBeDisabled();
    fireEvent.keyDown(number('Seconds'), { key: 'Enter' });
    expect(onSave).not.toHaveBeenCalled();
    await setBox(user, 'Seconds', '1');
    expect(screen.queryByRole('alert')).toBeNull();
    expect(summary()).toHaveTextContent('Every 1 s');
    expect(screen.getByText(/^Next: Tue Oct 13, 9:00/)).toBeInTheDocument();
    await user.click(done());
    expect(onSave).toHaveBeenCalledWith({ rrule: 'FREQ=SECONDLY', date: TIMED });
  });

  it('under a minute says it is too frequent to show on the calendar; a minute is not', async () => {
    const { user } = await openTimed();
    await user.selectOptions(combo('Period'), 'interval');
    await setBox(user, 'Hours', '0');
    await setBox(user, 'Seconds', '30');
    expect(screen.getByText(/Too frequent to show on the calendar\./)).toBeInTheDocument();
    expect(summary()).toHaveTextContent('Every 30 s');
    await setBox(user, 'Seconds', '0');
    await setBox(user, 'Minutes', '1');
    expect(screen.queryByText(/Too frequent/)).toBeNull();
    expect(summary()).toHaveTextContent('Every 1 min');
  });

  it('Interval to days and back: each keeps its own numbers', async () => {
    const { onSave, user } = await openTimed();
    await user.selectOptions(combo('Period'), 'day');
    await user.clear(number('Every how many'));
    await user.type(number('Every how many'), '3');
    await user.selectOptions(combo('Period'), 'interval');
    await setBox(user, 'Minutes', '15');
    expect(summary()).toHaveTextContent('Every 1 h 15 min');
    await user.selectOptions(combo('Period'), 'day');
    expect(number('Every how many')).toHaveValue(3);
    expect(summary()).toHaveTextContent('Every 3 days');
    await user.selectOptions(combo('Period'), 'interval');
    expect(intervalBoxes()).toEqual(['0', '1', '15', '0']);
    await user.selectOptions(combo('Period'), 'day');
    await user.click(done());
    expect(onSave).toHaveBeenCalledWith(
      expect.objectContaining({ rrule: 'FREQ=DAILY;INTERVAL=3' })
    );
  });

  it('while saving, the boxes are disabled', () => {
    const saved = repeat({ date: TIMED, rrule: 'FREQ=MINUTELY;INTERVAL=90' });
    setup({ repeat: saved, anchor: TIMED, busy: true });
    for (const name of ['Days', 'Hours', 'Minutes', 'Seconds']) expect(number(name)).toBeDisabled();
  });
});

describe('RepeatPicker keyboard', () => {
  it('focuses the checked choice; the choices are one Tab stop, arrows move the choice', async () => {
    const { user } = setup({ repeat: repeat({ rrule: 'FREQ=DAILY' }), nested: true });
    expect(choice('Every day')).toHaveFocus();
    await user.keyboard('{ArrowDown}');
    expect(choice('Every week on Tuesday')).toHaveFocus();
    expect(choice('Every week on Tuesday')).toHaveAttribute('aria-checked', 'true');
    await user.tab();
    expect(ends('Never')).toHaveFocus();
    await user.tab();
    expect(done()).toHaveFocus();
    await user.tab({ shift: true });
    await user.tab({ shift: true });
    expect(choice('Every week on Tuesday')).toHaveFocus();
    await user.tab({ shift: true });
    expect(screen.getByRole('button', { name: 'Back to the date' })).toHaveFocus();
  });
});
