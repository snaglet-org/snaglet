import { render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { RepeatPicker } from '@desktop/components/RepeatPicker/RepeatPicker';
import { RepeatPanel } from './RepeatPanel';

describe('TableView RepeatPanel compatibility', () => {
  it('uses the shared picker unchanged and preserves the table quick choices', () => {
    expect(RepeatPanel).toBe(RepeatPicker);
    render(<RepeatPanel anchor="2026-10-13" repeat={null} onSave={vi.fn()} onClose={vi.fn()} />);
    const choices = within(screen.getByRole('radiogroup', { name: 'How it repeats' }));
    expect(choices.getAllByRole('radio').map((radio) => radio.textContent)).toEqual([
      'Doesn’t repeat',
      'Every day',
      'Every week on Tuesday',
      'Every month on the 13th',
      'Every year on Oct 13',
      'Custom…',
    ]);
    expect(choices.getByRole('radio', { name: 'Doesn’t repeat' })).toHaveAttribute(
      'aria-checked',
      'true'
    );
    expect(screen.getByTestId('repeat-panel-summary')).toHaveTextContent('Doesn’t repeat');
  });
});
