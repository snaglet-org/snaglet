/**
 * The Calendar pane's back / forward arrows. The pane's history entry holds
 * the view (zoom and day): the view reports each change, and follows the
 * entry when history is stepped.
 */
import { render, screen, waitFor } from '@testing-library/react';
import { fireEvent } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Calendar } from '@snaglet/shared/types';
import { __setCalendarWeekStartForTests } from '@desktop/features/calendar/weekStart';

const api = vi.hoisted(() => ({ listCalendars: vi.fn(), occurrences: vi.fn() }));
vi.mock('@desktop/features/calendar/calendarApi', () => ({
  calendarApi: api,
  occurrencesSearch: (q: { from: string; to: string }) => `from=${q.from}&to=${q.to}`,
}));
vi.mock('@desktop/utils/toast', () => ({ showToast: vi.fn(), dismissToast: vi.fn() }));
vi.mock('@desktop/features/pane-find/PaneFindContext', () => ({ usePaneIsActive: () => true }));

import { CalendarView } from './CalendarView';
import { __resetCalendarStoreForTests } from '@desktop/features/calendar/calendarStore';
import { __resetCalendarViewForTests } from '@desktop/features/calendar/calendarViewStore';
import { __resetCalendarUndoForTests } from '@desktop/features/calendar/calendarUndo';
import type { CalendarPaneView } from '@desktop/pages/Dashboard/selection/types';

function cal(): Calendar {
  return {
    id: 'cal-default',
    title: 'Default calendar',
    description: '',
    timeZone: 'UTC',
    color: 'blue',
    isDefault: true,
    sortOrder: 0,
    revision: 1,
    createdAt: '',
    updatedAt: '',
    boundFields: [],
  } as Calendar;
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-14T12:00:00Z'));
  __setCalendarWeekStartForTests(1);
  window.localStorage.clear();
  api.listCalendars.mockReset().mockResolvedValue({ calendars: [cal()] });
  api.occurrences
    .mockReset()
    .mockResolvedValue({ from: '', to: '', occurrences: [], intervals: [], unavailable: [] });
  __resetCalendarUndoForTests();
  __resetCalendarStoreForTests({ calendars: [cal()] });
  __resetCalendarViewForTests({ anchor: '2026-10-14', zoom: 'month' });
});
afterEach(() => {
  vi.useRealTimers();
  __setCalendarWeekStartForTests(null);
});

const heading = (name: string) => screen.getByRole('heading', { name });

describe('CalendarView in the pane history', () => {
  it('reports the view it opens on, so the first entry holds it', async () => {
    const onPaneViewChange = vi.fn();
    render(<CalendarView onPaneViewChange={onPaneViewChange} />);
    await waitFor(() =>
      expect(onPaneViewChange).toHaveBeenCalledWith({ zoom: 'month', anchor: '2026-10-14' })
    );
  });

  it('reports a change of view, and a change of day within it', async () => {
    const onPaneViewChange = vi.fn();
    render(<CalendarView onPaneViewChange={onPaneViewChange} />);
    onPaneViewChange.mockClear();

    fireEvent.click(screen.getByRole('radio', { name: 'Year' }));
    await waitFor(() =>
      expect(onPaneViewChange).toHaveBeenLastCalledWith({ zoom: 'year', anchor: '2026-10-14' })
    );
    fireEvent.click(screen.getByRole('button', { name: 'Next year' }));
    await waitFor(() =>
      expect(onPaneViewChange).toHaveBeenLastCalledWith({ zoom: 'year', anchor: '2027-10-14' })
    );
  });

  it('follows the pane when history is stepped, without reporting it back', async () => {
    const onPaneViewChange = vi.fn();
    const first: CalendarPaneView = { zoom: 'month', anchor: '2026-10-14' };
    const { rerender } = render(
      <CalendarView paneView={first} onPaneViewChange={onPaneViewChange} />
    );
    expect(heading('October 2026')).toBeInTheDocument();
    onPaneViewChange.mockClear();

    rerender(
      <CalendarView
        paneView={{ zoom: 'year', anchor: '2027-03-05' }}
        onPaneViewChange={onPaneViewChange}
      />
    );
    await waitFor(() => expect(heading('2027')).toBeInTheDocument());
    expect(onPaneViewChange).not.toHaveBeenCalled();

    rerender(<CalendarView paneView={first} onPaneViewChange={onPaneViewChange} />);
    await waitFor(() => expect(heading('October 2026')).toBeInTheDocument());
    expect(onPaneViewChange).not.toHaveBeenCalled();
  });

  it('opens on the view its history entry holds, not the remembered one', async () => {
    const onPaneViewChange = vi.fn();
    render(
      <CalendarView
        paneView={{ zoom: 'year', anchor: '2025-06-01' }}
        onPaneViewChange={onPaneViewChange}
      />
    );
    await waitFor(() => expect(heading('2025')).toBeInTheDocument());
    expect(onPaneViewChange).not.toHaveBeenCalled();
  });

  it('still reports changes after following the pane', async () => {
    const onPaneViewChange = vi.fn();
    const { rerender } = render(
      <CalendarView
        paneView={{ zoom: 'month', anchor: '2026-10-14' }}
        onPaneViewChange={onPaneViewChange}
      />
    );
    rerender(
      <CalendarView
        paneView={{ zoom: 'year', anchor: '2026-10-14' }}
        onPaneViewChange={onPaneViewChange}
      />
    );
    await waitFor(() => expect(heading('2026')).toBeInTheDocument());
    onPaneViewChange.mockClear();
    fireEvent.click(screen.getByRole('radio', { name: 'Month' }));
    await waitFor(() =>
      expect(onPaneViewChange).toHaveBeenLastCalledWith({ zoom: 'month', anchor: '2026-10-14' })
    );
  });
});
