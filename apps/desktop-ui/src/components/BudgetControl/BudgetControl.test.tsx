import { useState } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { BudgetControl, type BudgetValues } from './BudgetControl';

function Harness({
  initial,
  onImmediateChange,
  onCommit,
}: {
  initial: BudgetValues;
  onImmediateChange?: (value: BudgetValues) => void;
  onCommit?: (value: BudgetValues) => void;
}) {
  const [value, setValue] = useState<BudgetValues>(initial);
  return (
    <BudgetControl
      value={value}
      onChange={setValue}
      onImmediateChange={onImmediateChange}
      onCommit={onCommit}
    />
  );
}

describe('BudgetControl — immediate saves carry the new value', () => {
  it('hands the 15-minute default to onImmediateChange when Limited is picked', async () => {
    const user = userEvent.setup();
    const onImmediateChange = vi.fn();
    render(
      <Harness
        initial={{ maxToolCallsPerTurn: 5, maxDurationSeconds: null }}
        onImmediateChange={onImmediateChange}
      />
    );

    await user.click(screen.getByRole('radio', { name: 'Limited' }));

    expect(onImmediateChange).toHaveBeenCalledTimes(1);
    expect(onImmediateChange).toHaveBeenCalledWith({
      maxToolCallsPerTurn: 5,
      maxDurationSeconds: 900,
    });
  });

  it('hands null to onImmediateChange when Unlimited is picked', async () => {
    const user = userEvent.setup();
    const onImmediateChange = vi.fn();
    render(<Harness initial={{ maxDurationSeconds: 900 }} onImmediateChange={onImmediateChange} />);

    await user.click(screen.getByRole('radio', { name: 'Unlimited' }));

    expect(onImmediateChange).toHaveBeenCalledWith({ maxDurationSeconds: null });
  });

  it('hands the converted seconds to onImmediateChange when the unit changes', async () => {
    const user = userEvent.setup();
    const onImmediateChange = vi.fn();
    // 900s displays as 15 minutes; switching the unit to hours means 15 hours.
    render(<Harness initial={{ maxDurationSeconds: 900 }} onImmediateChange={onImmediateChange} />);

    await user.selectOptions(screen.getByRole('combobox'), 'hours');

    expect(onImmediateChange).toHaveBeenCalledWith({ maxDurationSeconds: 15 * 3600 });
  });

  it('commits the typed value on blur', () => {
    const onCommit = vi.fn();
    render(<Harness initial={{}} onCommit={onCommit} />);
    const input = screen.getByPlaceholderText('1000');

    fireEvent.change(input, { target: { value: '12' } });
    fireEvent.blur(input);

    expect(onCommit).toHaveBeenCalledWith({ maxToolCallsPerTurn: 12 });
  });
});
