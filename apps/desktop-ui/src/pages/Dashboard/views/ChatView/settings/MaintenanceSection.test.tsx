import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { MaintenanceSection } from './MaintenanceSection';

describe('MaintenanceSection', () => {
  it('shows current trim state and keeps destructive clearing separate', async () => {
    const user = userEvent.setup();
    const onOpenTrim = vi.fn();
    const onClear = vi.fn();
    render(
      <MaintenanceSection
        trimSummary="42 messages · 128 KB"
        trimDetail="Stored: messages 96 KB · embeddings 32 KB."
        trimResult="Trimmed 8 messages; 34 remain."
        onOpenTrim={onOpenTrim}
        onClear={onClear}
      />
    );

    expect(screen.getByText('42 messages · 128 KB')).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('Trimmed 8 messages; 34 remain.');

    const help = screen.getByRole('button', { name: 'About trimming message history' });
    help.focus();
    await waitFor(() =>
      expect(screen.getByRole('tooltip')).toHaveTextContent(
        /Nothing is deleted until you review and confirm the trim\. Stored: messages 96 KB/
      )
    );

    await user.click(screen.getByRole('button', { name: 'Trim now' }));
    await user.click(screen.getByRole('button', { name: 'Clear thread…' }));
    expect(onOpenTrim).toHaveBeenCalledTimes(1);
    expect(onClear).toHaveBeenCalledTimes(1);
  });

  it('says when the current size is loading or unavailable', () => {
    const { rerender } = render(
      <MaintenanceSection trimSummary={null} onOpenTrim={vi.fn()} onClear={vi.fn()} />
    );
    expect(screen.getByText('Reading current thread size…')).toBeInTheDocument();

    rerender(
      <MaintenanceSection
        trimSummary={null}
        trimError="totals unavailable"
        onOpenTrim={vi.fn()}
        onClear={vi.fn()}
      />
    );
    expect(screen.getByText('Current size unavailable.')).toBeInTheDocument();
  });
});
