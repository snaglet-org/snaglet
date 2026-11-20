import { useState } from 'react';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { DateInput } from '@desktop/components';
import { RepeatSurface } from './RepeatSurface';

function Harness({ onDismiss }: { onDismiss: () => void }) {
  const [anchor, setAnchor] = useState<HTMLButtonElement | null>(null);
  const [date, setDate] = useState('2026-10-20');
  return (
    <>
      <button type="button" ref={setAnchor}>
        Repeat
      </button>
      {anchor && (
        <RepeatSurface anchor={anchor} label="Repeat Due" onDismiss={onDismiss}>
          <DateInput aria-label="End date" value={date} onChange={setDate} />
        </RepeatSurface>
      )}
    </>
  );
}

describe('RepeatSurface with a date picker inside', () => {
  it('lets the picker take Escape and presses, then closes on the next Escape', () => {
    const onDismiss = vi.fn();
    render(<Harness onDismiss={onDismiss} />);
    const field = screen.getByRole('combobox', { name: 'End date' });
    field.focus();
    fireEvent.keyDown(field, { key: 'ArrowDown' });
    const picker = screen.getByRole('dialog', { name: 'Choose date' });

    // A press inside the picker (portaled outside the surface) is not "outside".
    const day = within(picker).getByRole('gridcell', { name: /October 22/ });
    fireEvent.pointerDown(day);
    fireEvent.click(day);
    expect(onDismiss).not.toHaveBeenCalled();
    expect(field).toHaveAttribute('data-value', '2026-10-22');

    fireEvent.keyDown(field, { key: 'ArrowDown' });
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
    expect(screen.queryByRole('dialog', { name: 'Choose date' })).not.toBeInTheDocument();
    expect(onDismiss).not.toHaveBeenCalled();
    expect(field).toHaveFocus();

    fireEvent.keyDown(field, { key: 'Escape' });
    expect(onDismiss).toHaveBeenCalledOnce();
  });
});
