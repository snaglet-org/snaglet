import { render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RepeatCellText } from './RepeatCellText';

describe('RepeatCellText', () => {
  afterEach(() => vi.useRealTimers());

  const at = (rrule: string) => ({
    repeat: {
      rrule,
      dtstart: '2026-10-15T09:00:00',
      current: '2026-10-15T09:00:00',
      tz: 'UTC',
    },
    log: [],
  });

  it('marks an interval overdue once its time has passed, the same day; a daily one waits', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-15T09:30:00Z'));
    const { rerender } = render(<RepeatCellText cellRepeat={at('FREQ=HOURLY')} />);
    expect(screen.getByTitle('Overdue')).toHaveAttribute('data-overdue', 'true');
    rerender(<RepeatCellText cellRepeat={at('FREQ=DAILY')} />);
    expect(screen.queryByTitle('Overdue')).not.toBeInTheDocument();
    vi.setSystemTime(new Date('2026-10-15T08:59:00Z'));
    rerender(<RepeatCellText cellRepeat={at('FREQ=MINUTELY;INTERVAL=15')} />);
    expect(screen.queryByTitle('Overdue')).not.toBeInTheDocument();
  });
});
