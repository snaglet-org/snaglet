import { useState, type ComponentProps } from 'react';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { addDays, localeWeekStart, startOfWeek } from '@desktop/features/calendar/calendarDates';
import { __setCalendarWeekStartForTests } from '@desktop/features/calendar/weekStart';
import { DateInput } from './DateInput';
import { rangeSpan } from './DatePicker';
import styles from './DatePicker.module.scss';

const TODAY = '2026-10-13';

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-13T12:00:00Z'));
});
afterEach(() => {
  vi.useRealTimers();
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1024 });
});

type Props = Partial<ComponentProps<typeof DateInput>>;

/** A controlled field, the way every caller holds one. */
function Field({ initial = '', onChange, ...props }: Props & { initial?: string }) {
  const [value, setValue] = useState(initial);
  return (
    <DateInput
      aria-label="When"
      {...props}
      value={value}
      onChange={(next) => {
        setValue(next);
        onChange?.(next);
      }}
    />
  );
}

function renderField(props: Props & { initial?: string } = {}) {
  const onChange = vi.fn();
  const view = render(<Field onChange={onChange} {...props} />);
  return { ...view, onChange, input: screen.getByRole('combobox', { name: 'When' }) };
}

const dialog = () => screen.getByRole('dialog');
const day = (name: RegExp | string) => within(dialog()).getByRole('gridcell', { name });
const flush = () => act(async () => {});

describe('DateInput — the field', () => {
  it('shows the value for the locale and keeps the wire value', () => {
    const { input } = renderField({ initial: '2026-10-13' });
    expect(input).toHaveValue('Tue, Oct 13');
    expect(input).toHaveAttribute('data-value', '2026-10-13');
    expect(input).toHaveAttribute('aria-haspopup', 'dialog');
    expect(input).toHaveAttribute('aria-expanded', 'false');
  });

  it('shows the year only when it is not this one, and date-times and times on the locale clock', () => {
    render(
      <>
        <DateInput aria-label="Next year" value="2027-01-02" onChange={vi.fn()} />
        <DateInput
          aria-label="At"
          type="datetime-local"
          value="2026-10-13T09:00"
          onChange={vi.fn()}
        />
        <DateInput aria-label="Clock" type="time" value="21:30" onChange={vi.fn()} />
      </>
    );
    expect(screen.getByLabelText('Next year')).toHaveValue('Sat, Jan 2, 2027');
    expect(screen.getByLabelText('At')).toHaveValue('Oct 13, 9:00 AM');
    expect(screen.getByLabelText('Clock')).toHaveValue('9:30 PM');
  });

  it('takes a typed ISO value at once and keeps the text as typed', () => {
    const { input, onChange } = renderField({ initial: '2026-10-13' });
    fireEvent.change(input, { target: { value: '2026-10-18' } });
    expect(onChange).toHaveBeenLastCalledWith('2026-10-18');
    expect(input).toHaveValue('2026-10-18');
    fireEvent.blur(input);
    expect(input).toHaveValue('Sun, Oct 18');
  });

  it.each([
    ['10/20', '2026-10-20'],
    ['oct 20', '2026-10-20'],
    ['20 oct', '2026-10-20'],
    ['tomorrow', '2026-10-14'],
    ['yesterday', '2026-10-12'],
  ])('reads %j on Enter', (text, value) => {
    const { input, onChange } = renderField({ initial: '2026-10-13' });
    fireEvent.change(input, { target: { value: text } });
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onChange).toHaveBeenLastCalledWith(value);
    expect(input).toHaveAttribute('data-value', value);
  });

  it('reads typed times and date-times on blur', () => {
    const time = renderField({ type: 'time', initial: '09:00' });
    fireEvent.change(time.input, { target: { value: '930p' } });
    fireEvent.blur(time.input);
    expect(time.onChange).toHaveBeenLastCalledWith('21:30');
    expect(time.input).toHaveValue('9:30 PM');
    time.unmount();

    const at = renderField({ type: 'datetime-local', initial: '2026-10-13T09:00' });
    fireEvent.change(at.input, { target: { value: 'tomorrow noon' } });
    fireEvent.blur(at.input);
    expect(at.onChange).toHaveBeenLastCalledWith('2026-10-14T12:00');
    expect(at.input).toHaveValue('Oct 14, 12:00 PM');
  });

  it('marks unreadable text invalid, keeps the last good value and blocks the host Enter', () => {
    const hostEnter = vi.fn();
    render(
      <div onKeyDown={(event) => event.key === 'Enter' && hostEnter()}>
        <Field initial="2026-10-13" />
      </div>
    );
    const input = screen.getByRole('combobox', { name: 'When' });
    fireEvent.change(input, { target: { value: 'someday' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(input).toHaveAttribute('aria-invalid', 'true');
    expect(input).toHaveValue('someday');
    expect(input).toHaveAttribute('data-value', '2026-10-13');
    expect(hostEnter).not.toHaveBeenCalled();
    // Escape reverts the typing first, without reaching the host.
    const hostEscape = vi.fn();
    window.addEventListener('keydown', hostEscape);
    fireEvent.keyDown(input, { key: 'Escape' });
    window.removeEventListener('keydown', hostEscape);
    expect(hostEscape.mock.calls[0]?.[0].defaultPrevented).toBe(true);
    expect(input).toHaveValue('Tue, Oct 13');
    expect(input).toHaveAttribute('aria-invalid', 'false');
  });

  it('lets a good Enter reach the host after the value is in', () => {
    const seen: string[] = [];
    let latest = '';
    render(
      <div onKeyDown={(event) => event.key === 'Enter' && seen.push(latest)}>
        <DateInput aria-label="When" value="2026-10-13" onChange={(next) => (latest = next)} />
      </div>
    );
    const input = screen.getByRole('combobox', { name: 'When' });
    fireEvent.change(input, { target: { value: 'oct 30' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(seen).toEqual(['2026-10-30']);
  });

  it('refuses typed days outside min and max', () => {
    const { input, onChange } = renderField({
      initial: '2026-10-13',
      min: '2026-10-10',
      max: '2026-10-20',
    });
    fireEvent.change(input, { target: { value: '2026-10-21' } });
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(input).toHaveAttribute('aria-invalid', 'true');
    fireEvent.change(input, { target: { value: 'oct 9' } });
    fireEvent.blur(input);
    expect(input).toHaveAttribute('aria-invalid', 'true');
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.change(input, { target: { value: 'oct 20' } });
    fireEvent.blur(input);
    expect(onChange).toHaveBeenLastCalledWith('2026-10-20');
  });

  it('says in the open picker why typed text was refused', () => {
    const { input } = renderField({ initial: '2026-10-13', min: '2026-10-10' });
    fireEvent.click(input);
    fireEvent.change(input, { target: { value: 'someday' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(within(dialog()).getByRole('status')).toHaveTextContent(
      'Couldn’t read “someday”. Try 10/13, Oct 13 or tomorrow.'
    );
    fireEvent.change(input, { target: { value: 'oct 9' } });
    expect(within(dialog()).getByRole('status')).toBeEmptyDOMElement();
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(within(dialog()).getByRole('status')).toHaveTextContent('Pick Sat, Oct 10 or later.');
  });

  it('clears an optional field with × and offers no × when required', () => {
    const { input, onChange, unmount } = renderField({ initial: '2026-10-13' });
    fireEvent.click(screen.getByRole('button', { name: 'Clear When' }));
    expect(onChange).toHaveBeenLastCalledWith('');
    expect(input).toHaveValue('');
    expect(input).toHaveAttribute('placeholder', 'Pick a date');
    expect(screen.queryByRole('button', { name: 'Clear When' })).not.toBeInTheDocument();
    unmount();

    renderField({ initial: '2026-10-13', required: true });
    expect(screen.queryByRole('button', { name: /^Clear/ })).not.toBeInTheDocument();
  });

  it('carries name on a hidden input for forms', () => {
    const { container } = renderField({ initial: '2026-10-13', name: 'due' });
    expect(container.querySelector('input[type="hidden"][name="due"]')).toHaveValue('2026-10-13');
  });

  it('opens nothing and changes nothing when read-only or disabled', () => {
    const readOnly = renderField({ initial: '2026-10-13', readOnly: true });
    fireEvent.click(readOnly.input);
    fireEvent.keyDown(readOnly.input, { key: 'ArrowDown' });
    fireEvent.change(readOnly.input, { target: { value: '2026-10-20' } });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(readOnly.onChange).not.toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: /^Clear/ })).not.toBeInTheDocument();
    readOnly.unmount();

    const disabled = renderField({ initial: '2026-10-13', disabled: true });
    expect(disabled.input).toBeDisabled();
    fireEvent.click(disabled.input);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('keeps month and week native', () => {
    render(<DateInput aria-label="Month" type="month" value="2026-10" onChange={vi.fn()} />);
    expect(screen.getByLabelText('Month')).toHaveAttribute('type', 'month');
    expect(screen.getByLabelText('Month')).toHaveValue('2026-10');
  });
});

describe('DateInput — opening the picker', () => {
  it('opens on click with focus left in the field, portaled and keeping table cells open', () => {
    const { input } = renderField({ initial: '2026-10-13' });
    input.focus();
    fireEvent.click(input);
    const picker = dialog();
    expect(picker).toHaveAccessibleName('Choose date');
    expect(picker.parentElement).toBe(document.body);
    expect(picker).toHaveAttribute('data-keeps-cell');
    expect(input).toHaveAttribute('aria-expanded', 'true');
    expect(input).toHaveAttribute('aria-controls', picker.id);
    expect(input).toHaveFocus();
    expect(within(picker).getByRole('grid', { name: 'October 2026' })).toBeInTheDocument();
  });

  it('opens on ↓ and Alt+↓ with focus on the selected day', () => {
    const { input } = renderField({ initial: '2026-10-20' });
    input.focus();
    fireEvent.keyDown(input, { key: 'ArrowDown', altKey: true });
    expect(day('Tuesday, October 20, 2026')).toHaveFocus();
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(input).toHaveFocus();
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    expect(day('Tuesday, October 20, 2026')).toHaveFocus();
  });

  it('opens on Space when nothing is typed, and Space types once typing has begun', () => {
    const { input } = renderField({ initial: '2026-10-13' });
    input.focus();
    fireEvent.keyDown(input, { key: ' ' });
    expect(dialog()).toBeInTheDocument();
    expect(day('Tuesday, October 13, 2026')).toHaveFocus();
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' });

    fireEvent.change(input, { target: { value: 'oct' } });
    expect(fireEvent.keyDown(input, { key: ' ' })).toBe(true);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('opens on Enter unless a host takes the Enter', async () => {
    const free = renderField({ initial: '2026-10-13' });
    free.input.focus();
    fireEvent.keyDown(free.input, { key: 'Enter' });
    await flush();
    expect(dialog()).toBeInTheDocument();
    free.unmount();

    render(
      <div onKeyDown={(event) => event.key === 'Enter' && event.preventDefault()}>
        <Field initial="2026-10-13" />
      </div>
    );
    const hosted = screen.getByRole('combobox', { name: 'When' });
    hosted.focus();
    fireEvent.keyDown(hosted, { key: 'Enter' });
    await flush();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('starts on today when empty, with today ringed and marked current', () => {
    const { input } = renderField();
    fireEvent.click(input);
    const today = day('Tuesday, October 13, 2026');
    expect(today).toHaveAttribute('aria-current', 'date');
    expect(today).toHaveAttribute('tabindex', '0');
    expect(today).not.toHaveAttribute('aria-selected');
  });

  it('follows typing: the grid moves to the day the text reads as', () => {
    const { input } = renderField({ initial: '2026-10-13' });
    fireEvent.click(input);
    fireEvent.change(input, { target: { value: 'dec 25' } });
    expect(within(dialog()).getByRole('grid', { name: 'December 2026' })).toBeInTheDocument();
    expect(day('Friday, December 25, 2026')).toHaveClass(styles.dayPreview);
  });

  it('closes on a press outside, without moving focus', () => {
    render(
      <>
        <Field initial="2026-10-13" />
        <button type="button">Elsewhere</button>
      </>
    );
    fireEvent.click(screen.getByRole('combobox', { name: 'When' }));
    expect(dialog()).toBeInTheDocument();
    fireEvent.pointerDown(screen.getByRole('button', { name: 'Elsewhere' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
});

describe('DateInput — picking a day', () => {
  it('picks with the mouse and closes', () => {
    const { input, onChange } = renderField({ initial: '2026-10-13' });
    input.focus();
    fireEvent.click(input);
    expect(day('Tuesday, October 13, 2026')).toHaveAttribute('aria-selected', 'true');
    fireEvent.click(day('Thursday, October 22, 2026'));
    expect(onChange).toHaveBeenLastCalledWith('2026-10-22');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(input).toHaveValue('Thu, Oct 22');
    expect(input).toHaveFocus();
  });

  it('moves by day, week, month and year from the keyboard and picks with Enter', () => {
    const { input, onChange } = renderField({ initial: '2026-10-13' });
    input.focus();
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    const key = (k: string, extra: Partial<KeyboardEventInit> = {}) =>
      fireEvent.keyDown(document.activeElement!, { key: k, ...extra });
    const focused = () => document.activeElement?.getAttribute('data-day');

    key('ArrowRight');
    expect(focused()).toBe('2026-10-14');
    key('ArrowLeft');
    key('ArrowLeft');
    expect(focused()).toBe('2026-10-12');
    key('ArrowDown');
    expect(focused()).toBe('2026-10-19');
    key('ArrowUp');
    expect(focused()).toBe('2026-10-12');
    key('PageDown');
    expect(focused()).toBe('2026-11-12');
    expect(within(dialog()).getByRole('grid', { name: 'November 2026' })).toBeInTheDocument();
    key('PageUp');
    key('PageUp');
    expect(focused()).toBe('2026-09-12');
    key('PageDown', { shiftKey: true });
    expect(focused()).toBe('2027-09-12');
    key('PageUp', { shiftKey: true });
    expect(focused()).toBe('2026-09-12');
    const weekStart = startOfWeek('2026-09-12', localeWeekStart());
    key('Home');
    expect(focused()).toBe(weekStart);
    key('End');
    expect(focused()).toBe(addDays(weekStart, 6));
    key('Enter');
    expect(onChange).toHaveBeenLastCalledWith(addDays(weekStart, 6));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(input).toHaveFocus();
  });

  it('starts its weeks where the Calendar does, and follows a change', () => {
    const headers = () =>
      within(dialog())
        .getAllByRole('columnheader')
        .map((h) => h.getAttribute('aria-label'));
    try {
      __setCalendarWeekStartForTests(1);
      const { input } = renderField({ initial: '2026-10-13' });
      fireEvent.click(input);
      expect(headers()[0]).toBe('Monday');
      expect(headers()[6]).toBe('Sunday');
      // Oct 2026 starts on a Thursday: the grid opens on Monday Sep 28.
      expect(within(dialog()).getAllByRole('gridcell')[0]).toHaveAttribute(
        'data-day',
        '2026-09-28'
      );
      act(() => __setCalendarWeekStartForTests(0));
      expect(headers()[0]).toBe('Sunday');
      expect(within(dialog()).getAllByRole('gridcell')[0]).toHaveAttribute(
        'data-day',
        '2026-09-27'
      );
    } finally {
      __setCalendarWeekStartForTests(null);
    }
  });

  it('fades days outside the month and disables days outside min and max', () => {
    const { input, onChange } = renderField({
      initial: '2026-10-13',
      min: '2026-10-05',
      max: '2026-10-25',
    });
    fireEvent.click(input);
    expect(day('Sunday, October 4, 2026')).toHaveAttribute('aria-disabled', 'true');
    expect(day('Monday, October 26, 2026')).toHaveAttribute('aria-disabled', 'true');
    expect(day('Monday, October 5, 2026')).not.toHaveAttribute('aria-disabled');
    fireEvent.click(day('Monday, October 26, 2026'));
    expect(onChange).not.toHaveBeenCalled();
    expect(dialog()).toBeInTheDocument();
    const outside = within(dialog())
      .getAllByRole('gridcell')
      .find((cell) => !cell.getAttribute('data-day')?.startsWith('2026-10'));
    expect(outside).toHaveClass(styles.dayOther);
  });

  it('jumps by month and year from the header', () => {
    const { input, onChange } = renderField({ initial: '2026-10-13' });
    fireEvent.click(input);
    fireEvent.click(within(dialog()).getByRole('button', { name: 'Next month' }));
    expect(within(dialog()).getByRole('grid', { name: 'November 2026' })).toBeInTheDocument();
    fireEvent.click(within(dialog()).getByRole('button', { name: /Choose month and year/ }));
    fireEvent.click(within(dialog()).getByRole('button', { name: /Choose year/ }));
    expect(within(dialog()).getByRole('group', { name: '2016 – 2027' })).toBeInTheDocument();
    fireEvent.click(within(dialog()).getByRole('button', { name: 'Next years' }));
    fireEvent.click(within(dialog()).getByRole('button', { name: '2029' }));
    fireEvent.click(within(dialog()).getByRole('button', { name: 'March 2029' }));
    expect(within(dialog()).getByRole('grid', { name: 'March 2029' })).toBeInTheDocument();
    fireEvent.click(day('Wednesday, March 14, 2029'));
    expect(onChange).toHaveBeenLastCalledWith('2029-03-14');
  });

  it('keeps keyboard focus through the month and year views', () => {
    const { input, onChange } = renderField({ initial: '2026-10-13' });
    input.focus();
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    const title = within(dialog()).getByRole('button', { name: /Choose month and year/ });
    title.focus();
    fireEvent.click(title);
    expect(document.activeElement).toHaveAccessibleName('October 2026');
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowDown' });
    expect(document.activeElement).toHaveAccessibleName('January 2027');
    fireEvent.click(document.activeElement!);
    expect(document.activeElement).toHaveAttribute('data-day', '2027-01-13');
    fireEvent.keyDown(document.activeElement!, { key: 'Enter' });
    expect(onChange).toHaveBeenLastCalledWith('2027-01-13');
  });

  it('steps back from the month view on Escape before closing', () => {
    const { input } = renderField({ initial: '2026-10-13' });
    fireEvent.click(input);
    fireEvent.click(within(dialog()).getByRole('button', { name: /Choose month and year/ }));
    expect(within(dialog()).queryByRole('grid')).not.toBeInTheDocument();
    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(within(dialog()).getByRole('grid', { name: 'October 2026' })).toBeInTheDocument();
    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('has Today and Clear in the footer', () => {
    const { input, onChange } = renderField({ initial: '2026-11-02' });
    fireEvent.click(input);
    fireEvent.click(within(dialog()).getByRole('button', { name: 'Today' }));
    expect(onChange).toHaveBeenLastCalledWith(TODAY);
    fireEvent.click(input);
    fireEvent.click(within(dialog()).getByRole('button', { name: 'Clear' }));
    expect(onChange).toHaveBeenLastCalledWith('');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('cycles Tab inside the picker: header, grid, footer', () => {
    const { input } = renderField({ initial: '2026-10-13' });
    input.focus();
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    const order: string[] = [];
    for (let i = 0; i < 7; i++) {
      const active = document.activeElement as HTMLElement;
      order.push(active.getAttribute('aria-label') ?? active.textContent ?? '');
      fireEvent.keyDown(active, { key: 'Tab' });
    }
    expect(order).toEqual([
      'Tuesday, October 13, 2026',
      'Today',
      'Clear',
      'Previous month',
      'Choose month and year, October 2026',
      'Next month',
      'Tuesday, October 13, 2026',
    ]);
  });
});

describe('DateInput — one end of a range', () => {
  const byDay = (iso: string) =>
    within(dialog())
      .getAllByRole('gridcell')
      .find((c) => c.getAttribute('data-day') === iso)!;
  const banded = () =>
    within(dialog())
      .getAllByRole('gridcell')
      .filter((c) => c.classList.contains(styles.dayInRange))
      .map((c) => c.getAttribute('data-day'));

  it('bands the days between Start and End and shows both ends as picked', () => {
    const { input } = renderField({
      initial: '2026-10-15',
      range: { part: 'end', other: '2026-10-12' },
    });
    fireEvent.click(input);
    expect(banded()).toEqual(['2026-10-13', '2026-10-14']);
    const start = byDay('2026-10-12');
    expect(start).toHaveClass(styles.daySelected, styles.dayRangeStart);
    // Only the field's own value is selected for assistive tech.
    expect(start).not.toHaveAttribute('aria-selected');
    const end = byDay('2026-10-15');
    expect(end).toHaveClass(styles.daySelected, styles.dayRangeEnd);
    expect(end).toHaveAttribute('aria-selected', 'true');
  });

  it('previews the range under the pointer while picking the End', () => {
    const { input } = renderField({
      initial: '2026-10-14',
      range: { part: 'end', other: '2026-10-12' },
    });
    fireEvent.click(input);
    fireEvent.mouseEnter(byDay('2026-10-17'));
    expect(banded()).toEqual(['2026-10-13', '2026-10-14', '2026-10-15', '2026-10-16']);
    expect(byDay('2026-10-17')).toHaveClass(styles.dayPreview, styles.dayRangeEnd);
    // A day before the Start can't end the range: the saved one shows.
    fireEvent.mouseEnter(byDay('2026-10-09'));
    expect(banded()).toEqual(['2026-10-13']);
    fireEvent.mouseEnter(byDay('2026-10-16'));
    fireEvent.mouseLeave(within(dialog()).getByRole('grid'));
    expect(banded()).toEqual(['2026-10-13']);
  });

  it('an empty End bands nothing until a day is hovered; the Start never previews', () => {
    const end = renderField({ initial: '', range: { part: 'end', other: '2026-10-12' } });
    fireEvent.click(end.input);
    expect(banded()).toEqual([]);
    fireEvent.mouseEnter(byDay('2026-10-14'));
    expect(banded()).toEqual(['2026-10-13']);
    end.unmount();

    const start = renderField({
      initial: '2026-10-12',
      range: { part: 'start', other: '2026-10-14' },
    });
    fireEvent.click(start.input);
    expect(banded()).toEqual(['2026-10-13']);
    fireEvent.mouseEnter(byDay('2026-10-08'));
    expect(banded()).toEqual(['2026-10-13']);
  });

  it('rangeSpan: Start to End, the End standing in for a hovered later day', () => {
    expect(rangeSpan(undefined, '2026-10-12', null)).toBeNull();
    expect(rangeSpan({ part: 'end', otherDay: '' }, '2026-10-12', null)).toBeNull();
    expect(rangeSpan({ part: 'start', otherDay: '2026-10-14' }, '2026-10-12', null)).toEqual({
      from: '2026-10-12',
      to: '2026-10-14',
    });
    // A Start after the End is no range.
    expect(rangeSpan({ part: 'start', otherDay: '2026-10-10' }, '2026-10-12', null)).toBeNull();
    expect(rangeSpan({ part: 'end', otherDay: '2026-10-12' }, '2026-10-14', '2026-10-20')).toEqual({
      from: '2026-10-12',
      to: '2026-10-20',
    });
    expect(rangeSpan({ part: 'end', otherDay: '2026-10-12' }, '', '2026-10-11')).toBeNull();
  });
});

describe('DateInput — Escape belongs to the picker', () => {
  it('closes only the picker, never a parent popover, cell or modal, and returns focus', () => {
    const escapes = (event: { key: string }) => event.key === 'Escape';
    const parentKeyDown = vi.fn();
    const windowBubble = vi.fn();
    const documentListener = vi.fn();
    const calls = (spy: typeof parentKeyDown) =>
      spy.mock.calls.filter(([event]) => escapes(event as { key: string })).length;
    window.addEventListener('keydown', windowBubble);
    document.addEventListener('keydown', documentListener);
    render(
      <div role="dialog" aria-modal="true" aria-label="Parent" onKeyDown={parentKeyDown}>
        <Field initial="2026-10-13" />
      </div>
    );
    const input = screen.getByRole('combobox', { name: 'When' });
    input.focus();
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    const picker = screen.getByRole('dialog', { name: 'Choose date' });
    fireEvent.keyDown(within(picker).getByRole('gridcell', { name: /October 13/ }), {
      key: 'Escape',
    });
    // Picker open with focus still in the field: the same.
    fireEvent.click(input);
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(screen.queryByRole('dialog', { name: 'Choose date' })).not.toBeInTheDocument();
    expect(calls(parentKeyDown)).toBe(0);
    expect(calls(windowBubble)).toBe(0);
    expect(calls(documentListener)).toBe(0);
    expect(input).toHaveFocus();

    // Closed: the next Escape is the parent's.
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(calls(parentKeyDown)).toBe(1);
    window.removeEventListener('keydown', windowBubble);
    document.removeEventListener('keydown', documentListener);
  });

  it('keeps picker keys from reaching the host (no cell commit from a picked day)', () => {
    const hostKeyDown = vi.fn();
    render(
      <div onKeyDown={hostKeyDown}>
        <Field initial="2026-10-13" />
      </div>
    );
    const input = screen.getByRole('combobox', { name: 'When' });
    input.focus();
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    hostKeyDown.mockClear();
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowRight' });
    fireEvent.keyDown(document.activeElement!, { key: 'Enter' });
    expect(hostKeyDown).not.toHaveBeenCalled();
  });
});

describe('DateInput — date and time', () => {
  it('puts the day grid and the time list side by side, and keeps the time for a picked day', () => {
    const { input, onChange } = renderField({
      type: 'datetime-local',
      initial: '2026-10-13T14:30',
    });
    fireEvent.click(input);
    const picker = dialog();
    expect(picker).toHaveAccessibleName('Choose date and time');
    expect(picker).toHaveAttribute('data-layout', 'wide');
    expect(picker).toHaveClass(styles.kindDateTime);
    expect(picker).not.toHaveClass(styles.stacked);
    const times = within(picker).getByRole('listbox', { name: 'Times' });
    expect(within(times).getAllByRole('option')).toHaveLength(96);
    expect(within(times).getByRole('option', { name: '2:30 PM' })).toHaveAttribute(
      'aria-selected',
      'true'
    );

    fireEvent.click(day('Friday, October 16, 2026'));
    expect(onChange).toHaveBeenLastCalledWith('2026-10-16T14:30');
    expect(dialog()).toBeInTheDocument();
    fireEvent.click(within(times).getByRole('option', { name: '9:15 AM' }));
    expect(onChange).toHaveBeenLastCalledWith('2026-10-16T09:15');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(input).toHaveValue('Oct 16, 9:15 AM');
  });

  it('keeps the card open on a time pick when the host has more under the grid, until Done', () => {
    const { input, onChange } = renderField({
      type: 'datetime-local',
      initial: '2026-10-13T14:30',
      pickerAddon: { below: <p>More to set</p>, stayOpenOnTime: true },
    });
    fireEvent.click(input);
    fireEvent.click(
      within(within(dialog()).getByRole('listbox', { name: 'Times' })).getByRole('option', {
        name: '9:15 AM',
      })
    );
    expect(onChange).toHaveBeenLastCalledWith('2026-10-13T09:15');
    expect(dialog()).toBeInTheDocument();
    expect(within(dialog()).getByText('More to set')).toBeInTheDocument();
    fireEvent.click(within(dialog()).getByRole('button', { name: 'Done' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('gives a day picked on an empty field 9:00 AM, and moves a keyboard user on to the time', () => {
    const { input, onChange } = renderField({ type: 'datetime-local' });
    input.focus();
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    fireEvent.keyDown(document.activeElement!, { key: 'Enter' });
    expect(onChange).toHaveBeenLastCalledWith(`${TODAY}T09:00`);
    expect(document.activeElement).toHaveAttribute('role', 'option');
    expect(document.activeElement).toHaveTextContent('9:00 AM');
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowDown' });
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowDown' });
    fireEvent.keyDown(document.activeElement!, { key: 'Enter' });
    expect(onChange).toHaveBeenLastCalledWith(`${TODAY}T09:30`);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(input).toHaveFocus();
  });

  it('stacks the time list under the grid below about 420 px', () => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 400 });
    const { input } = renderField({ type: 'datetime-local', initial: '2026-10-13T14:30' });
    fireEvent.click(input);
    expect(dialog()).toHaveAttribute('data-layout', 'stacked');
    expect(dialog()).toHaveClass(styles.stacked);
  });

  it('becomes a full-width sheet in a pane narrower than about 360 px', () => {
    const pane = document.createElement('div');
    pane.className = 'pane-body';
    document.body.appendChild(pane);
    vi.spyOn(pane, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 320, 600));
    const onChange = vi.fn();
    render(<DateInput aria-label="When" value="2026-10-13" onChange={onChange} />, {
      container: pane,
    });
    fireEvent.click(screen.getByRole('combobox', { name: 'When' }));
    expect(dialog()).toHaveClass(styles.sheet);
    expect(dialog()).toHaveAttribute('data-layout', 'sheet');
    pane.remove();
  });
});

describe('DateInput — time', () => {
  it('lists times in steps (15 minutes, or a coarser step), selected and typed', () => {
    const { input, onChange } = renderField({ type: 'time', initial: '09:00', step: 1800 });
    fireEvent.click(input);
    const picker = dialog();
    expect(picker).toHaveAccessibleName('Choose time');
    expect(within(picker).queryByRole('grid')).not.toBeInTheDocument();
    const options = within(picker).getAllByRole('option');
    expect(options).toHaveLength(48);
    expect(within(picker).getByRole('option', { name: '9:00 AM' })).toHaveAttribute(
      'aria-selected',
      'true'
    );
    const entry = within(picker).getByRole('textbox', { name: 'Type a time' });
    fireEvent.change(entry, { target: { value: '7:45p' } });
    fireEvent.keyDown(entry, { key: 'Enter' });
    expect(onChange).toHaveBeenLastCalledWith('19:45');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('refuses a typed time it cannot read', () => {
    const { input, onChange } = renderField({ type: 'time', initial: '09:00' });
    fireEvent.click(input);
    const entry = within(dialog()).getByRole('textbox', { name: 'Type a time' });
    fireEvent.change(entry, { target: { value: 'lunch' } });
    fireEvent.keyDown(entry, { key: 'Enter' });
    expect(entry).toHaveAttribute('aria-invalid', 'true');
    expect(onChange).not.toHaveBeenCalled();
  });
});

describe('DateInput — with userEvent', () => {
  it('types a day over the selected text and picks one with a click', async () => {
    vi.useRealTimers();
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Field initial="" onChange={onChange} />);
    const input = screen.getByRole('combobox', { name: 'When' });
    await user.click(input);
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    await user.type(input, '2030-01-05');
    expect(onChange).toHaveBeenLastCalledWith('2030-01-05');
    expect(within(dialog()).getByRole('grid', { name: 'January 2030' })).toBeInTheDocument();
    await user.click(day('Monday, January 7, 2030'));
    expect(onChange).toHaveBeenLastCalledWith('2030-01-07');
    expect(input).toHaveValue('Mon, Jan 7, 2030');
  });
});
