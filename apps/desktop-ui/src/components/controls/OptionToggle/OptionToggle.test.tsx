import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { OptionToggle, OptionToggleRow } from './OptionToggle';

describe('OptionToggle', () => {
  it('is a named toggle button that reports the next state', () => {
    const onChange = vi.fn();
    const { rerender } = render(
      <OptionToggle pressed={false} onChange={onChange}>
        Required
      </OptionToggle>
    );
    const pill = screen.getByRole('button', { name: 'Required' });
    expect(pill).toHaveAttribute('type', 'button');
    expect(pill).toHaveAttribute('aria-pressed', 'false');
    fireEvent.click(pill);
    expect(onChange).toHaveBeenLastCalledWith(true);

    rerender(
      <OptionToggle pressed onChange={onChange}>
        Required
      </OptionToggle>
    );
    expect(pill).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(pill);
    expect(onChange).toHaveBeenLastCalledWith(false);
  });

  it('toggles from the keyboard with Space and Enter', async () => {
    const onChange = vi.fn();
    render(
      <OptionToggle pressed={false} onChange={onChange}>
        Default
      </OptionToggle>
    );
    screen.getByRole('button', { name: 'Default' }).focus();
    await userEvent.keyboard(' ');
    await userEvent.keyboard('{Enter}');
    expect(onChange).toHaveBeenCalledTimes(2);
    expect(onChange).toHaveBeenCalledWith(true);
  });

  it('is described by any text it is pointed at', () => {
    render(
      <>
        <p id="warning">Undo brings them back.</p>
        <OptionToggle pressed onChange={vi.fn()} aria-describedby="warning">
          End date
        </OptionToggle>
      </>
    );
    expect(screen.getByRole('button', { name: 'End date' })).toHaveAccessibleDescription(
      'Undo brings them back.'
    );
  });

  it('does not change when disabled', async () => {
    const onChange = vi.fn();
    render(
      <OptionToggle pressed={false} disabled onChange={onChange}>
        Required
      </OptionToggle>
    );
    await userEvent.click(screen.getByRole('button', { name: 'Required' }));
    expect(onChange).not.toHaveBeenCalled();
  });
});

describe('OptionToggleRow', () => {
  it('names its pills as a group only when given a label', () => {
    const { rerender } = render(
      <OptionToggleRow aria-label="Field options">
        <OptionToggle pressed={false} onChange={vi.fn()}>
          Required
        </OptionToggle>
      </OptionToggleRow>
    );
    expect(screen.getByRole('group', { name: 'Field options' })).toContainElement(
      screen.getByRole('button', { name: 'Required' })
    );

    rerender(
      <OptionToggleRow>
        <OptionToggle pressed={false} onChange={vi.fn()}>
          Required
        </OptionToggle>
      </OptionToggleRow>
    );
    expect(screen.queryByRole('group')).toBeNull();
  });
});
