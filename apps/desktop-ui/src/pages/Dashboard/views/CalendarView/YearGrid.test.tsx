import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CalendarOccurrence } from '@snaglet/shared/types';
import { YearGrid } from './YearGrid';
import styles from './YearGrid.module.scss';

let seq = 0;
function event(
  over: Partial<CalendarOccurrence> & { eventId?: string; day?: string } = {}
): CalendarOccurrence {
  const { day = '2026-10-21', eventId = `event-${++seq}`, ...rest } = over;
  return {
    key: `${eventId}:${day}`,
    source: 'event',
    eventId,
    revision: 1,
    calendarId: 'cal-1',
    title: 'Test event',
    status: 'upcoming',
    canMove: true,
    canResize: true,
    time: { kind: 'all_day', startDate: day, endDate: addOne(day) },
    ...rest,
  } as CalendarOccurrence;
}
const addOne = (day: string) => {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
};

describe('YearGrid', () => {
  const base = { anchor: '2026-10-21', weekStart: 0, today: '2026-10-21', zone: 'UTC' };
  const DAY_21 = 'Wednesday, October 21, 2 items';

  afterEach(() => {
    vi.useRealTimers();
  });

  it('draws the twelve months of the year with every day in each', () => {
    render(<YearGrid {...base} occurrences={[]} onOpenMonth={vi.fn()} onOpenDay={vi.fn()} />);
    expect(screen.getAllByRole('button', { name: /^Open \w+ 2026$/ })).toHaveLength(12);
    expect(
      screen.getAllByRole('button', { name: /^(Sun|Mon|Tues|Wednes|Thurs|Fri|Satur)day, / })
    ).toHaveLength(365);
  });

  it('circles a day with something on it and says how many', () => {
    render(
      <YearGrid
        {...base}
        occurrences={[event({ title: 'Dinner' }), event({ title: 'Flight' })]}
        onOpenMonth={vi.fn()}
        onOpenDay={vi.fn()}
      />
    );
    const day = screen.getByRole('button', { name: DAY_21 });
    expect(day.className).toMatch(/noted/);
    expect(screen.getByRole('button', { name: 'Thursday, October 22' }).className).not.toMatch(
      /noted/
    );
  });

  it('circles each day in the color of its first item’s calendar', () => {
    const colorOf = (id: string) => (id === 'cal-2' ? 'green' : '#3a7bd5');
    render(
      <YearGrid
        {...base}
        occurrences={[
          event({ title: 'Dinner', calendarId: 'cal-2' }),
          event({ title: 'Flight', day: '2026-10-23' }),
        ]}
        colorOf={colorOf}
        onOpenMonth={vi.fn()}
        onOpenDay={vi.fn()}
      />
    );
    expect(screen.getByRole('button', { name: /^Wednesday, October 21, 1 item$/ })).toHaveAttribute(
      'data-cal-color',
      'green'
    );
    // A custom color paints the ring inline.
    const custom = screen.getByRole('button', { name: /^Friday, October 23, 1 item$/ });
    expect(custom.style.getPropertyValue('--cal-accent')).toBe('#3a7bd5');
    // An empty day wears no color.
    expect(screen.getByRole('button', { name: 'Thursday, October 22' })).not.toHaveAttribute(
      'data-cal-color'
    );
  });

  it('shows the day’s list on hover or focus, with a repeat’s summary', async () => {
    render(
      <YearGrid
        {...base}
        occurrences={[
          event({ title: 'Dinner', repeatSummary: 'Every year' }),
          event({
            title: 'Call',
            time: {
              kind: 'timed',
              start: '2026-10-21T16:00:00.000Z',
              end: '2026-10-21T17:00:00.000Z',
            },
          }),
        ]}
        onOpenMonth={vi.fn()}
        onOpenDay={vi.fn()}
      />
    );
    fireEvent.mouseEnter(screen.getByRole('button', { name: DAY_21 }));
    const list = await screen.findByRole('dialog');
    expect(within(list).getByText('Dinner')).toBeInTheDocument();
    expect(within(list).getByText('↻ Every year')).toBeInTheDocument();
    expect(within(list).getByText('Call')).toBeInTheDocument();
    expect(within(list).getByText('4 PM')).toBeInTheDocument();
  });

  it('is a dialog popover, not a tooltip', async () => {
    render(
      <YearGrid
        {...base}
        occurrences={[event({ title: 'Dinner' })]}
        onOpenMonth={vi.fn()}
        onOpenDay={vi.fn()}
      />
    );
    fireEvent.mouseEnter(screen.getByRole('button', { name: 'Wednesday, October 21, 1 item' }));
    expect(await screen.findByRole('dialog')).toBeInTheDocument();
    expect(screen.queryByRole('tooltip')).toBeNull();
  });

  it('keeps a long repeat line inside the box: it wraps on its own row', async () => {
    const again = 'Every week on Saturday, open until the next one';
    render(
      <YearGrid
        {...base}
        occurrences={[event({ title: 'Groceries', repeatSummary: again })]}
        onOpenMonth={vi.fn()}
        onOpenDay={vi.fn()}
      />
    );
    fireEvent.mouseEnter(screen.getByRole('button', { name: 'Wednesday, October 21, 1 item' }));
    const list = await screen.findByRole('dialog');
    const line = within(list).getByText(`↻ ${again}`);
    // jsdom cannot measure layout; the class carries the wrapping rules
    // (flex: 1 1 100%, white-space: normal, overflow-wrap: anywhere).
    expect(line).toHaveClass(styles.listRepeat);
    expect(line.closest('li')).not.toBeNull();
    expect(list.querySelector(`.${styles.list}`)).not.toBeNull();
  });

  it('stays open while the pointer travels from the day onto the list', async () => {
    vi.useFakeTimers();
    try {
      render(
        <YearGrid
          {...base}
          occurrences={[event({ title: 'Dinner' })]}
          onOpenMonth={vi.fn()}
          onOpenDay={vi.fn()}
        />
      );
      const day = screen.getByRole('button', { name: 'Wednesday, October 21, 1 item' });
      fireEvent.mouseEnter(day);
      const list = screen.getByRole('dialog');

      // Leave the day (toward the list): the close is only scheduled, not done.
      fireEvent.mouseLeave(day);
      // The pointer reaches the list before the delay elapses, canceling it.
      fireEvent.mouseEnter(within(list).getByText('Dinner').closest(`.${styles.list}`)!);
      act(() => vi.advanceTimersByTime(200));

      expect(screen.getByRole('dialog')).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it('closes after the delay when the pointer leaves both the day and the list', async () => {
    vi.useFakeTimers();
    try {
      render(
        <YearGrid
          {...base}
          occurrences={[event({ title: 'Dinner' })]}
          onOpenMonth={vi.fn()}
          onOpenDay={vi.fn()}
        />
      );
      const day = screen.getByRole('button', { name: 'Wednesday, October 21, 1 item' });
      fireEvent.mouseEnter(day);
      const listEl = screen.getByRole('dialog').querySelector(`.${styles.list}`)!;

      fireEvent.mouseEnter(listEl);
      fireEvent.mouseLeave(listEl);
      // Before the delay it is still open.
      act(() => vi.advanceTimersByTime(100));
      expect(screen.queryByRole('dialog')).toBeInTheDocument();
      // Past the delay it closes.
      act(() => vi.advanceTimersByTime(100));
      expect(screen.queryByRole('dialog')).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('Escape closes the list and returns focus to the day', async () => {
    render(
      <YearGrid
        {...base}
        occurrences={[event({ title: 'Dinner' })]}
        onOpenMonth={vi.fn()}
        onOpenDay={vi.fn()}
      />
    );
    const day = screen.getByRole('button', { name: 'Wednesday, October 21, 1 item' });
    day.focus();
    // Enter opens the list and moves focus into it.
    fireEvent.keyDown(day, { key: 'Enter' });
    const list = await screen.findByRole('dialog');
    expect(list).toBeInTheDocument();

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(day);
  });

  it('swaps the list to another day as soon as it is hovered', async () => {
    render(
      <YearGrid
        {...base}
        occurrences={[
          event({ title: 'Dinner', day: '2026-10-21' }),
          event({ title: 'Flight', day: '2026-10-22' }),
        ]}
        onOpenMonth={vi.fn()}
        onOpenDay={vi.fn()}
      />
    );
    fireEvent.mouseEnter(screen.getByRole('button', { name: 'Wednesday, October 21, 1 item' }));
    let list = await screen.findByRole('dialog');
    expect(within(list).getByText('Dinner')).toBeInTheDocument();

    // Hovering another day replaces the list at once (no delay).
    fireEvent.mouseEnter(screen.getByRole('button', { name: 'Thursday, October 22, 1 item' }));
    list = screen.getByRole('dialog');
    expect(within(list).getByText('Flight')).toBeInTheDocument();
    expect(within(list).queryByText('Dinner')).toBeNull();
  });

  it('opens the entry the way a Month-view item does when a list item is clicked', async () => {
    const onOpenItem = vi.fn();
    const dinner = event({ title: 'Dinner' });
    render(
      <YearGrid
        {...base}
        occurrences={[dinner]}
        onOpenMonth={vi.fn()}
        onOpenDay={vi.fn()}
        onOpenItem={onOpenItem}
      />
    );
    fireEvent.mouseEnter(screen.getByRole('button', { name: 'Wednesday, October 21, 1 item' }));
    const list = await screen.findByRole('dialog');
    fireEvent.click(within(list).getByRole('button', { name: 'Dinner' }));
    expect(onOpenItem).toHaveBeenCalledTimes(1);
    expect(onOpenItem.mock.calls[0][0]).toMatchObject({ key: dinner.key });
    expect(onOpenItem.mock.calls[0][1]).toBeInstanceOf(HTMLElement);
  });

  it('“+N more” expands the list to show the rest of the day', async () => {
    const many = Array.from({ length: 9 }, (_, i) => event({ title: `Item ${i + 1}` }));
    render(<YearGrid {...base} occurrences={many} onOpenMonth={vi.fn()} onOpenDay={vi.fn()} />);
    fireEvent.mouseEnter(screen.getByRole('button', { name: 'Wednesday, October 21, 9 items' }));
    const list = await screen.findByRole('dialog');
    // Six shown, then "+3 more"; the last three are hidden until it expands.
    expect(within(list).queryByText('Item 9')).toBeNull();
    fireEvent.click(within(list).getByRole('button', { name: '+3 more' }));
    expect(within(list).getByText('Item 9')).toBeInTheDocument();
    expect(within(list).queryByRole('button', { name: /more/ })).toBeNull();
  });

  it('opens the month from its name and the day from its number', () => {
    const onOpenMonth = vi.fn();
    const onOpenDay = vi.fn();
    render(<YearGrid {...base} occurrences={[]} onOpenMonth={onOpenMonth} onOpenDay={onOpenDay} />);
    fireEvent.click(screen.getByRole('button', { name: 'Open March 2026' }));
    expect(onOpenMonth).toHaveBeenCalledWith('2026-03-01');
    const october = screen.getByRole('button', { name: 'Open October 2026' }).closest('section')!;
    fireEvent.click(within(october).getByRole('button', { name: /^Thursday, October 22/ }));
    expect(onOpenDay).toHaveBeenCalledWith('2026-10-22');
  });

  it('opens the day when a circled day is clicked', () => {
    const onOpenDay = vi.fn();
    render(
      <YearGrid {...base} occurrences={[event()]} onOpenMonth={vi.fn()} onOpenDay={onOpenDay} />
    );
    fireEvent.click(screen.getByRole('button', { name: 'Wednesday, October 21, 1 item' }));
    expect(onOpenDay).toHaveBeenCalledWith('2026-10-21');
  });
});
