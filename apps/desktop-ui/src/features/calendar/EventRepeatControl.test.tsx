import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { EventRepeatControl } from './EventRepeatControl';

// Fri Oct 9, 2026, 9:00 AM.
const START = '2026-10-09T09:00:00';

function setup(value: { rrule: string } | null = null) {
  const onChange = vi.fn();
  render(<EventRepeatControl anchor={START} timeZone="UTC" value={value} onChange={onChange} />);
  return { onChange, user: userEvent.setup() };
}

const choice = (name: string) =>
  within(screen.getByRole('radiogroup', { name: 'How it repeats' })).getByRole('radio', { name });

describe('EventRepeatControl', () => {
  it('names the repeat on its row and opens the picker', async () => {
    const { user } = setup({ rrule: 'FREQ=MONTHLY;BYDAY=2FR' });
    await user.click(screen.getByRole('button', { name: 'Repeat, Every month on the 2nd Friday' }));
    expect(choice('Custom')).toHaveAttribute('aria-checked', 'true');
    expect(
      within(screen.getByRole('radiogroup', { name: 'Monthly on' })).getByRole('radio', {
        name: 'on the',
      })
    ).toBeChecked();
  });

  it('a quick choice saves its rule; Back returns to the row', async () => {
    const { onChange, user } = setup();
    await user.click(screen.getByRole('button', { name: 'Repeat, Never' }));
    await user.click(choice('Every week on Friday'));
    await user.click(screen.getByRole('button', { name: 'Back to the event' }));
    expect(onChange).toHaveBeenCalledWith({ rrule: 'FREQ=WEEKLY;BYDAY=FR' });
  });

  it('Custom repeats a timed event by day or longer: no minutes or hours', async () => {
    const { onChange, user } = setup();
    await user.click(screen.getByRole('button', { name: 'Repeat, Never' }));
    await user.click(choice('Custom…'));
    const period = screen.getByRole('combobox', { name: 'Period' });
    expect(
      within(period)
        .getAllByRole('option')
        .map((option) => (option as HTMLOptionElement).value)
    ).toEqual(['day', 'week', 'month']);
    await user.click(screen.getByRole('button', { name: 'Monday' }));
    await user.click(screen.getByRole('button', { name: 'Done' }));
    expect(onChange).toHaveBeenCalledWith({ rrule: 'FREQ=WEEKLY;BYDAY=MO,FR' });
  });
});
