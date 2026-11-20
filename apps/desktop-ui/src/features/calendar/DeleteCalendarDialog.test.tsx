import { FetchError } from '@desktop/utils/api/core';
import { expect, it, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { DeleteCalendarDialog, deletionConsequences } from './DeleteCalendarDialog';
import { calendarApi } from './calendarApi';
import {
  __resetCalendarStoreForTests,
  getCalendarsSnapshot,
  loadCalendars,
  HIDDEN_CALENDARS_KEY,
  COLLAPSED_CALENDARS_KEY,
} from './calendarStore';
import type { Calendar } from '@snaglet/shared/types';
vi.mock('./calendarApi', () => ({
  calendarApi: { previewDeletion: vi.fn(), deleteCalendar: vi.fn(), listCalendars: vi.fn() },
}));
const calendar: Calendar = {
  id: 'c',
  title: 'Work',
  color: null,
  timeZone: 'UTC',
  description: '',
  isDefault: true,
  sortOrder: 0,
  revision: 1,
  createdAt: '',
  updatedAt: '',
  boundFields: [],
};
const preview = { token: 'preview', events: 3, dateFields: 2, automations: 1 };
beforeEach(() => {
  vi.clearAllMocks();
  __resetCalendarStoreForTests();
  vi.mocked(calendarApi.previewDeletion).mockResolvedValue(preview);
  vi.mocked(calendarApi.listCalendars).mockResolvedValue({ calendars: [] });
});
it('omits zero consequences and plainly counts destroyed events', () => {
  expect(deletionConsequences({ ...preview, events: 0, dateFields: 0, automations: 0 })).toEqual([
    'Events in the trash and their reminders will also be permanently deleted. Inactive date fields and canceled or finished automations will be disconnected, not deleted.',
    'This cannot be undone.',
  ]);
  expect(deletionConsequences(preview)[0]).toContain('3 events will be permanently deleted');
  expect(deletionConsequences(preview)).toContain(
    'Counts include active and paused automations, but exclude items in the trash, inactive date fields, and canceled or finished automations.'
  );
  expect(deletionConsequences(preview).join(' ')).toContain('paused states will be kept');
});
it('cancel does not delete; confirmation sends the exact reviewed token', async () => {
  const close = vi.fn();
  const view = render(<DeleteCalendarDialog calendar={calendar} onClose={close} />);
  await screen.findByText(/3 events will/);
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
  expect(calendarApi.deleteCalendar).not.toHaveBeenCalled();
  view.unmount();
  render(<DeleteCalendarDialog calendar={calendar} onClose={close} />);
  await screen.findByText(/3 events will/);
  fireEvent.click(screen.getByRole('button', { name: 'Delete calendar' }));
  await waitFor(() => expect(calendarApi.deleteCalendar).toHaveBeenCalledWith('c', 'preview'));
});
it('prunes disappeared hidden/collapsed IDs and persists the cleanup', async () => {
  __resetCalendarStoreForTests({
    calendars: [calendar],
    hidden: new Set(['c']),
    collapsed: new Set(['c']),
  });
  await loadCalendars();
  expect([...getCalendarsSnapshot().hidden]).toEqual([]);
  expect([...getCalendarsSnapshot().collapsed]).toEqual([]);
  expect(localStorage.getItem(HIDDEN_CALENDARS_KEY)).toBe('[]');
  expect(localStorage.getItem(COLLAPSED_CALENDARS_KEY)).toBe('[]');
});

it('disables confirmation until the preview loads', () => {
  vi.mocked(calendarApi.previewDeletion).mockReturnValue(new Promise(() => {}));
  render(<DeleteCalendarDialog calendar={calendar} onClose={vi.fn()} />);
  expect(screen.getByRole('button', { name: 'Delete calendar' })).toBeDisabled();
});
it('refreshes a stale token and requires another explicit confirmation', async () => {
  vi.mocked(calendarApi.previewDeletion)
    .mockResolvedValueOnce(preview)
    .mockResolvedValueOnce({ ...preview, token: 'fresh', events: 4 });
  vi.mocked(calendarApi.deleteCalendar)
    .mockRejectedValueOnce(new Error('This calendar changed.'))
    .mockResolvedValueOnce({ id: 'c' });
  const close = vi.fn();
  render(<DeleteCalendarDialog calendar={calendar} onClose={close} />);
  await screen.findByText(/3 events will/);
  fireEvent.click(screen.getByRole('button', { name: 'Delete calendar' }));
  await screen.findByText(/4 events will/);
  expect(close).not.toHaveBeenCalled();
  expect(calendarApi.deleteCalendar).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole('button', { name: 'Delete calendar' }));
  await waitFor(() => expect(calendarApi.deleteCalendar).toHaveBeenLastCalledWith('c', 'fresh'));
});

it.each(['preview', 'delete', 'refresh'])(
  'closes and refreshes when %s finds the calendar gone',
  async (stage) => {
    const gone = new FetchError('Calendar not found', 404);
    if (stage === 'preview') vi.mocked(calendarApi.previewDeletion).mockRejectedValueOnce(gone);
    else if (stage === 'delete') vi.mocked(calendarApi.deleteCalendar).mockRejectedValueOnce(gone);
    else {
      vi.mocked(calendarApi.deleteCalendar).mockRejectedValueOnce(new Error('Stale preview'));
      vi.mocked(calendarApi.previewDeletion)
        .mockResolvedValueOnce(preview)
        .mockRejectedValueOnce(gone);
    }
    const close = vi.fn();
    render(<DeleteCalendarDialog calendar={calendar} onClose={close} />);
    if (stage !== 'preview') {
      await screen.findByText(/3 events will/);
      fireEvent.click(screen.getByRole('button', { name: 'Delete calendar' }));
    }
    await waitFor(() => expect(close).toHaveBeenCalledTimes(1));
    expect(calendarApi.listCalendars).toHaveBeenCalled();
  }
);

it('keeps the preview when its parent rerenders with the same close callback', async () => {
  const close = vi.fn();
  const view = render(<DeleteCalendarDialog calendar={calendar} onClose={close} />);
  await screen.findByText(/3 events will/);
  view.rerender(<DeleteCalendarDialog calendar={{ ...calendar }} onClose={close} />);
  expect(calendarApi.previewDeletion).toHaveBeenCalledTimes(1);
});
