import { render, screen } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { AutomationCalendarPicker } from './AutomationCalendarPicker';

vi.mock('@desktop/features/calendar/SearchSelect', () => ({
  SearchSelect: ({ options }: { options: { value: string; label: string }[] }) => (
    <select>
      {options.map((option) => (
        <option key={option.value}>{option.label}</option>
      ))}
    </select>
  ),
}));

it('offers a new default only after an empty calendar list has loaded', () => {
  const change = vi.fn();
  const view = render(
    <AutomationCalendarPicker calendars={[]} loaded={false} value={undefined} onChange={change} />
  );
  expect(screen.queryByText('Default calendar (new)')).not.toBeInTheDocument();
  view.rerender(
    <AutomationCalendarPicker calendars={[]} loaded value={undefined} onChange={change} />
  );
  expect(screen.getByText('Default calendar (new)')).toBeInTheDocument();
});
