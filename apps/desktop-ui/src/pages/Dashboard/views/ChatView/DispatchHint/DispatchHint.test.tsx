import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { DispatchHint } from './DispatchHint';

describe('DispatchHint', () => {
  it('announces the hint and dismisses it from a named button', () => {
    const onDismiss = vi.fn();
    render(<DispatchHint message="Mention an agent to get a reply" onDismiss={onDismiss} />);

    expect(screen.getByRole('status')).toHaveTextContent('Mention an agent to get a reply');
    const dismiss = screen.getByRole('button', { name: 'Dismiss hint' });
    expect(dismiss).toHaveAttribute('type', 'button');

    fireEvent.click(dismiss);
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });
});
