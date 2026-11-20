import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import type { AutomationRecord } from '@snaglet/shared/types';

const calendars = vi.hoisted(() => ({
  listCalendars: vi.fn(),
  createCalendar: vi.fn(),
}));
vi.mock('@desktop/features/calendar/calendarApi', () => ({
  calendarApi: calendars,
  occurrencesSearch: () => '',
}));
const automations = vi.hoisted(() => ({ list: vi.fn(), update: vi.fn() }));
vi.mock('@desktop/utils/api/automations', () => ({ automationsApi: automations }));
const toast = vi.hoisted(() => ({ showToast: vi.fn(), dismissToast: vi.fn() }));
vi.mock('@desktop/utils/toast', () => toast);

import { FetchError } from '@desktop/utils/api/core';
import { WebSocketContext, type WsContextValue } from '@desktop/ws/WebSocketContext';
import {
  __resetAutomationsStoreForTests,
  upsertAutomation,
  useAutomationsFeed,
} from '@desktop/features/automations/automationsStore';
import {
  automationRecord,
  calendarRecord,
  DEFAULT_CALENDAR_ID,
  testCalendars,
  WORK_CALENDAR_ID,
} from '@desktop/features/automations/testFixtures';
import { __resetCalendarStoreForTests } from '@desktop/features/calendar/calendarStore';
import { __resetCalendarViewForTests } from '@desktop/features/calendar/calendarViewStore';
import { __resetCalendarUndoForTests } from '@desktop/features/calendar/calendarUndo';
import { CalendarSidebar } from './CalendarSidebar';

const AUTOMATION_B = 'automation-2222222222222-bbbbbbbbb';
const AUTOMATION_C = 'automation-3333333333333-ccccccccc';

function seed(list: AutomationRecord[]) {
  act(() => list.forEach(upsertAutomation));
}

const onDefault = (over: Partial<AutomationRecord> = {}) =>
  automationRecord({
    calendarId: DEFAULT_CALENDAR_ID,
    calendarTitle: 'Default calendar',
    ...over,
  });

/** The toast's Undo for `message`. */
function undoOf(message: string): () => void {
  const call = toast.showToast.mock.calls.find(([m]) => m === message);
  if (!call) throw new Error(`No toast "${message}"`);
  return (call[1] as { action: { run: () => void } }).action.run;
}

describe('CalendarSidebar automations', () => {
  beforeEach(() => {
    window.localStorage.clear();
    Object.values(calendars).forEach((fn) => fn.mockReset());
    Object.values(automations).forEach((fn) => fn.mockReset());
    toast.showToast.mockReset();
    calendars.listCalendars.mockResolvedValue({ calendars: [] });
    automations.list.mockResolvedValue({ automations: [] });
    __resetCalendarStoreForTests({ calendars: testCalendars() });
    __resetCalendarViewForTests({ anchor: '2026-10-14' });
    __resetCalendarUndoForTests();
    __resetAutomationsStoreForTests();
  });

  it('lists active and paused automations under their calendar, and the ones on none at the bottom', () => {
    render(<CalendarSidebar />);
    seed([
      onDefault({ name: 'Morning check' }),
      onDefault({ id: AUTOMATION_B, name: 'Backlog sweep', status: 'paused' }),
      onDefault({ id: AUTOMATION_C, name: 'Done once', status: 'finished' }),
      automationRecord({
        id: 'automation-4444444444444-ddddddddd',
        name: 'Gone',
        status: 'cancelled',
      }),
    ]);
    const list = screen.getByRole('list', { name: 'Automations on Default calendar' });
    // By name; finished and deleted ones stay in the Automations view.
    expect(
      within(list)
        .getAllByRole('button', { name: /automation/ })
        .map((b) => b.textContent)
    ).toEqual(['Backlog sweeppaused', 'Morning check']);
    expect(
      within(list).getByRole('button', { name: 'Backlog sweep, automation, paused' })
    ).toBeInTheDocument();
    expect(screen.queryByRole('list', { name: 'Automations on Work' })).toBeNull();
    // Nothing on no calendar: no group.
    expect(screen.queryByText('No calendar')).toBeNull();

    seed([automationRecord({ id: AUTOMATION_C, name: 'Loose end', status: 'active' })]);
    const unplaced = screen.getByRole('list', { name: 'Automations with no calendar' });
    expect(
      within(unplaced).getByRole('button', { name: 'Loose end, automation' })
    ).toBeInTheDocument();
    expect(screen.getByText('No calendar')).toBeInTheDocument();
  });

  it('a row opens the automation; the leaf folds automations away with the fields', () => {
    const onOpenAutomation = vi.fn();
    render(<CalendarSidebar onOpenAutomation={onOpenAutomation} />);
    const record = onDefault();
    seed([record]);
    fireEvent.click(screen.getByRole('button', { name: 'Morning check, automation' }));
    expect(onOpenAutomation).toHaveBeenCalledWith(record);

    fireEvent.click(
      screen.getByRole('button', {
        name: 'Hide the date fields and automations of Default calendar',
      })
    );
    expect(screen.queryByRole('button', { name: 'Morning check, automation' })).toBeNull();
  });

  it('Move to calendar… lists the other calendars and No calendar; a pick saves with Undo on the calendar stack', async () => {
    render(<CalendarSidebar onOpenAutomation={vi.fn()} />);
    const record = onDefault();
    seed([record]);
    const moved = automationRecord({ calendarId: WORK_CALENDAR_ID, calendarTitle: 'Work' });
    automations.update.mockResolvedValueOnce({ automation: moved });
    automations.update.mockResolvedValueOnce({ automation: record });
    automations.list.mockResolvedValue({ automations: [record] });

    fireEvent.click(screen.getByRole('button', { name: 'More for Morning check' }));
    const menu = screen.getByRole('menu', { name: 'Morning check actions' });
    expect(
      within(menu)
        .getAllByRole('menuitem')
        .map((m) => m.textContent)
    ).toEqual(['Open', 'Move to calendar…']);
    fireEvent.click(within(menu).getByRole('menuitem', { name: 'Move to calendar…' }));
    const picker = await screen.findByRole('dialog', { name: 'Move Morning check to' });
    const choices = within(picker).getAllByRole('menuitem');
    expect(choices.map((c) => c.textContent)).toEqual(['Work', 'No calendar']);
    // ↓ / ↑ move between the choices.
    choices[0]!.focus();
    fireEvent.keyDown(choices[0]!, { key: 'ArrowDown' });
    expect(choices[1]).toHaveFocus();
    fireEvent.keyDown(choices[1]!, { key: 'ArrowDown' });
    expect(choices[0]).toHaveFocus();

    fireEvent.click(choices[0]!);
    await waitFor(() =>
      expect(automations.update).toHaveBeenCalledWith(record.id, { calendarId: WORK_CALENDAR_ID })
    );
    // The row moves at once, before the realtime re-read.
    expect(
      await within(screen.getByRole('list', { name: 'Automations on Work' })).findByRole('button', {
        name: 'Morning check, automation',
      })
    ).toBeInTheDocument();
    expect(screen.queryByRole('list', { name: 'Automations on Default calendar' })).toBeNull();
    expect(screen.queryByRole('dialog', { name: 'Move Morning check to' })).toBeNull();

    act(() => undoOf('Moved Morning check to Work')());
    await waitFor(() =>
      expect(automations.update).toHaveBeenLastCalledWith(record.id, {
        calendarId: DEFAULT_CALENDAR_ID,
      })
    );
    await waitFor(() =>
      expect(
        within(screen.getByRole('list', { name: 'Automations on Default calendar' })).getByRole(
          'button',
          { name: 'Morning check, automation' }
        )
      ).toBeInTheDocument()
    );
  });

  it('a right-click opens the same menu; No calendar takes it off and it lands in the No calendar group', async () => {
    render(<CalendarSidebar />);
    const record = onDefault();
    seed([record]);
    automations.update.mockResolvedValueOnce({
      automation: automationRecord({ calendarId: null, calendarTitle: null }),
    });
    fireEvent.contextMenu(screen.getByRole('button', { name: 'Morning check, automation' }), {
      clientX: 20,
      clientY: 20,
    });
    const menu = screen.getByRole('menu', { name: 'Morning check actions' });
    // No Open without somewhere to open it.
    expect(
      within(menu)
        .getAllByRole('menuitem')
        .map((m) => m.textContent)
    ).toEqual(['Move to calendar…']);
    fireEvent.click(within(menu).getByRole('menuitem', { name: 'Move to calendar…' }));
    const picker = await screen.findByRole('dialog', { name: 'Move Morning check to' });
    fireEvent.click(within(picker).getByRole('menuitem', { name: 'No calendar' }));
    await waitFor(() =>
      expect(automations.update).toHaveBeenCalledWith(record.id, { calendarId: null })
    );
    expect(
      await within(screen.getByRole('list', { name: 'Automations with no calendar' })).findByRole(
        'button',
        { name: 'Morning check, automation' }
      )
    ).toBeInTheDocument();
    expect(toast.showToast).toHaveBeenCalledWith(
      'Removed Morning check from the calendar',
      expect.objectContaining({ action: expect.objectContaining({ label: 'Undo' }) })
    );
  });

  it('from No calendar, every calendar is a choice; with none left, the Default calendar (new) is made first', async () => {
    __resetCalendarStoreForTests({ calendars: [] });
    render(<CalendarSidebar />);
    const loose = automationRecord();
    seed([loose]);
    expect(
      screen.getByText('No calendars yet. Add a calendar to get started.')
    ).toBeInTheDocument();
    const made = calendarRecord({
      id: DEFAULT_CALENDAR_ID,
      title: 'Default calendar',
      isDefault: true,
      sortOrder: 0,
    });
    calendars.createCalendar.mockResolvedValue({ calendar: made });
    automations.update.mockResolvedValue({
      automation: onDefault(),
    });

    fireEvent.click(screen.getByRole('button', { name: 'More for Morning check' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Move to calendar…' }));
    const picker = await screen.findByRole('dialog', { name: 'Move Morning check to' });
    expect(
      within(picker)
        .getAllByRole('menuitem')
        .map((m) => m.textContent)
    ).toEqual(['Default calendar (new)']);
    fireEvent.click(within(picker).getByRole('menuitem', { name: 'Default calendar (new)' }));
    await waitFor(() =>
      expect(automations.update).toHaveBeenCalledWith(loose.id, { calendarId: DEFAULT_CALENDAR_ID })
    );
    expect(calendars.createCalendar).toHaveBeenCalledWith({ title: 'Default calendar' });
    expect(
      await within(
        screen.getByRole('list', { name: 'Automations on Default calendar' })
      ).findByRole('button', { name: 'Morning check, automation' })
    ).toBeInTheDocument();
    expect(screen.queryByRole('list', { name: 'Automations with no calendar' })).toBeNull();
  });

  it('a refused move says why and leaves the row where it was', async () => {
    render(<CalendarSidebar />);
    seed([onDefault()]);
    automations.update.mockRejectedValue(new Error('That calendar no longer exists'));
    fireEvent.click(screen.getByRole('button', { name: 'More for Morning check' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Move to calendar…' }));
    fireEvent.click(
      within(await screen.findByRole('dialog', { name: 'Move Morning check to' })).getByRole(
        'menuitem',
        { name: 'Work' }
      )
    );
    await waitFor(() =>
      expect(toast.showToast).toHaveBeenCalledWith('That calendar no longer exists')
    );
    expect(
      within(screen.getByRole('list', { name: 'Automations on Default calendar' })).getByRole(
        'button',
        { name: 'Morning check, automation' }
      )
    ).toBeInTheDocument();
  });

  it('stays live: an automations:changed event re-reads the list (created, moved, paused, deleted)', async () => {
    let listener:
      | ((message: { channel?: string; type?: string; payload?: unknown }) => void)
      | null = null;
    const ws: WsContextValue = {
      connectionState: 'open',
      serverRestarting: false,
      send: vi.fn(),
      subscribe: vi.fn(),
      unsubscribe: vi.fn(),
      addMessageListener: (fn) => {
        listener = fn as typeof listener;
        return () => {
          listener = null;
        };
      },
    };
    function Feed() {
      useAutomationsFeed();
      return null;
    }
    const wrapper = ({ children }: { children: ReactNode }) => (
      <WebSocketContext.Provider value={ws}>{children}</WebSocketContext.Provider>
    );
    automations.list.mockResolvedValue({ automations: [] });
    render(
      <>
        <Feed />
        <CalendarSidebar />
      </>,
      { wrapper }
    );
    await waitFor(() => expect(automations.list).toHaveBeenCalledTimes(1));
    const changed = async (list: AutomationRecord[]) => {
      automations.list.mockResolvedValue({ automations: list });
      await act(async () => {
        listener?.({ channel: 'workspace', type: 'automations:changed', payload: {} });
      });
    };

    await changed([onDefault()]);
    expect(
      await within(
        screen.getByRole('list', { name: 'Automations on Default calendar' })
      ).findByRole('button', { name: 'Morning check, automation' })
    ).toBeInTheDocument();

    await changed([automationRecord({ calendarId: WORK_CALENDAR_ID, status: 'paused' })]);
    expect(
      await within(screen.getByRole('list', { name: 'Automations on Work' })).findByRole('button', {
        name: 'Morning check, automation, paused',
      })
    ).toBeInTheDocument();
    expect(screen.queryByRole('list', { name: 'Automations on Default calendar' })).toBeNull();

    // Deleted elsewhere while its menu is open: the menu goes with the row.
    fireEvent.click(screen.getByRole('button', { name: 'More for Morning check' }));
    expect(screen.getByRole('menu', { name: 'Morning check actions' })).toBeInTheDocument();
    await changed([automationRecord({ calendarId: WORK_CALENDAR_ID, status: 'cancelled' })]);
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: /Morning check, automation/ })).toBeNull()
    );
    expect(screen.queryByRole('menu', { name: 'Morning check actions' })).toBeNull();

    // Purged while Move to calendar… is open: the picker closes.
    await changed([onDefault()]);
    fireEvent.click(await screen.findByRole('button', { name: 'More for Morning check' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Move to calendar…' }));
    expect(
      await screen.findByRole('dialog', { name: 'Move Morning check to' })
    ).toBeInTheDocument();
    await changed([]);
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: 'Move Morning check to' })).toBeNull()
    );
  });

  it('sorts by name with numbers in order ("Task 2" before "Task 10")', () => {
    render(<CalendarSidebar />);
    seed([
      onDefault({ name: 'Task 10' }),
      onDefault({ id: AUTOMATION_B, name: 'Task 2' }),
      onDefault({ id: AUTOMATION_C, name: 'task 1' }),
    ]);
    const list = screen.getByRole('list', { name: 'Automations on Default calendar' });
    expect(
      within(list)
        .getAllByRole('button', { name: /automation/ })
        .map((b) => b.getAttribute('data-inspect-name'))
    ).toEqual(['task 1', 'Task 2', 'Task 10']);
  });

  it("the keyboard's menu key opens the menu under the row; ⋯ says whether it is open", () => {
    render(<CalendarSidebar />);
    seed([onDefault()]);
    const row = screen.getByRole('button', { name: 'Morning check, automation' });
    row.getBoundingClientRect = () =>
      ({ left: 40, right: 200, top: 100, bottom: 120, width: 160, height: 20 }) as DOMRect;
    const more = screen.getByRole('button', { name: 'More for Morning check' });
    expect(more).toHaveAttribute('aria-expanded', 'false');
    // The menu key fires contextmenu at (0, 0).
    fireEvent.contextMenu(row, { clientX: 0, clientY: 0 });
    const menu = screen.getByRole('menu', { name: 'Morning check actions' });
    expect(menu.style.left).toBe('40px');
    expect(menu.style.top).toBe('120px');
    expect(more).toHaveAttribute('aria-expanded', 'true');
    fireEvent.keyDown(menu, { key: 'Escape' });
    expect(screen.queryByRole('menu', { name: 'Morning check actions' })).toBeNull();
    expect(more).toHaveAttribute('aria-expanded', 'false');
  });

  it('after a move, focus goes to the moved row in its new list', async () => {
    render(<CalendarSidebar />);
    seed([onDefault()]);
    automations.update.mockResolvedValue({
      automation: automationRecord({ calendarId: WORK_CALENDAR_ID, calendarTitle: 'Work' }),
    });
    fireEvent.click(screen.getByRole('button', { name: 'More for Morning check' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Move to calendar…' }));
    const picker = await screen.findByRole('dialog', { name: 'Move Morning check to' });
    fireEvent.click(within(picker).getByRole('menuitem', { name: 'Work' }));
    const list = await screen.findByRole('list', { name: 'Automations on Work' });
    const moved = within(list).getByRole('button', { name: 'Morning check, automation' });
    await waitFor(() => expect(moved).toHaveFocus());
  });

  it('the picker is one Tab stop: only the current choice is tabbable, arrows move it', async () => {
    render(<CalendarSidebar />);
    seed([onDefault()]);
    fireEvent.click(screen.getByRole('button', { name: 'More for Morning check' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Move to calendar…' }));
    const picker = await screen.findByRole('dialog', { name: 'Move Morning check to' });
    const choices = within(picker).getAllByRole('menuitem');
    const tabbable = () => choices.map((c) => c.tabIndex);
    expect(tabbable()).toEqual([0, -1]);
    choices[0]!.focus();
    fireEvent.keyDown(choices[0]!, { key: 'End' });
    expect(choices[1]).toHaveFocus();
    expect(tabbable()).toEqual([-1, 0]);
    fireEvent.keyDown(choices[1]!, { key: 'Home' });
    expect(choices[0]).toHaveFocus();
    expect(tabbable()).toEqual([0, -1]);
  });

  it('an open picker closes when an agent moves the automation, or it is deleted, meanwhile', async () => {
    render(<CalendarSidebar />);
    const record = onDefault();
    seed([record]);
    const openPicker = async () => {
      fireEvent.click(screen.getByRole('button', { name: 'More for Morning check' }));
      fireEvent.click(screen.getByRole('menuitem', { name: 'Move to calendar…' }));
      return screen.findByRole('dialog', { name: 'Move Morning check to' });
    };

    await openPicker();
    // Moved to Work elsewhere: its choices are stale.
    seed([{ ...record, calendarId: WORK_CALENDAR_ID, calendarTitle: 'Work' }]);
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: 'Move Morning check to' })).toBeNull()
    );

    await openPicker();
    seed([{ ...record, calendarId: WORK_CALENDAR_ID, status: 'cancelled' }]);
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: 'Move Morning check to' })).toBeNull()
    );
    expect(automations.update).not.toHaveBeenCalled();
  });

  it('offers Default calendar (new) only once the list is in: not while loading, not after a failed read', async () => {
    let finish!: (value: { calendars: [] }) => void;
    calendars.listCalendars.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        })
    );
    __resetCalendarStoreForTests();
    render(<CalendarSidebar />);
    seed([automationRecord()]);
    fireEvent.click(screen.getByRole('button', { name: 'More for Morning check' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Move to calendar…' }));
    let picker = await screen.findByRole('dialog', { name: 'Move Morning check to' });
    expect(within(picker).getByText('Loading calendars…')).toBeInTheDocument();
    expect(within(picker).queryAllByRole('menuitem')).toEqual([]);
    fireEvent.keyDown(picker, { key: 'Escape' });
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: 'Move Morning check to' })).toBeNull()
    );
    await act(async () => finish({ calendars: [] }));

    // A failed read: still nothing to make.
    calendars.listCalendars.mockRejectedValue(new Error('offline'));
    __resetCalendarStoreForTests({ calendars: null, error: 'offline' });
    fireEvent.click(screen.getByRole('button', { name: 'More for Morning check' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Move to calendar…' }));
    picker = await screen.findByRole('dialog', { name: 'Move Morning check to' });
    expect(within(picker).getByText("Couldn't load the calendars")).toBeInTheDocument();
    expect(within(picker).queryAllByRole('menuitem')).toEqual([]);
    expect(calendars.createCalendar).not.toHaveBeenCalled();
  });

  it('two quick moves to Default calendar (new) make one calendar', async () => {
    __resetCalendarStoreForTests({ calendars: [] });
    render(<CalendarSidebar />);
    const first = automationRecord();
    const second = automationRecord({ id: AUTOMATION_B, name: 'Evening check' });
    seed([first, second]);
    let finish!: (value: { calendar: ReturnType<typeof calendarRecord> }) => void;
    calendars.createCalendar.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        })
    );
    automations.update.mockImplementation(async (id: string) => ({
      automation: (id === first.id ? first : second) && {
        ...(id === first.id ? first : second),
        calendarId: DEFAULT_CALENDAR_ID,
        calendarTitle: 'Default calendar',
      },
    }));
    const moveToNewDefault = async (name: string) => {
      fireEvent.click(screen.getByRole('button', { name: `More for ${name}` }));
      fireEvent.click(screen.getByRole('menuitem', { name: 'Move to calendar…' }));
      const picker = await screen.findByRole('dialog', { name: `Move ${name} to` });
      fireEvent.click(within(picker).getByRole('menuitem', { name: 'Default calendar (new)' }));
    };
    await moveToNewDefault('Morning check');
    // The first create is still out: the list is empty, so the choice is offered again.
    await moveToNewDefault('Evening check');
    await act(async () =>
      finish({
        calendar: calendarRecord({
          id: DEFAULT_CALENDAR_ID,
          title: 'Default calendar',
          isDefault: true,
          sortOrder: 0,
        }),
      })
    );
    await waitFor(() => expect(automations.update).toHaveBeenCalledTimes(2));
    expect(calendars.createCalendar).toHaveBeenCalledTimes(1);
    expect(automations.update).toHaveBeenCalledWith(first.id, { calendarId: DEFAULT_CALENDAR_ID });
    expect(automations.update).toHaveBeenCalledWith(second.id, {
      calendarId: DEFAULT_CALENDAR_ID,
    });
  });

  it('an Undo that can no longer apply says why in words, not ids', async () => {
    render(<CalendarSidebar />);
    const record = onDefault();
    seed([record]);
    const moveToWork = async () => {
      fireEvent.click(screen.getByRole('button', { name: 'More for Morning check' }));
      fireEvent.click(screen.getByRole('menuitem', { name: 'Move to calendar…' }));
      const picker = await screen.findByRole('dialog', { name: 'Move Morning check to' });
      fireEvent.click(within(picker).getByRole('menuitem', { name: 'Work' }));
      await waitFor(() =>
        expect(toast.showToast).toHaveBeenCalledWith(
          'Moved Morning check to Work',
          expect.anything()
        )
      );
    };

    automations.update
      .mockResolvedValueOnce({
        automation: automationRecord({ calendarId: WORK_CALENDAR_ID, calendarTitle: 'Work' }),
      })
      .mockRejectedValueOnce(new FetchError(`Calendar ${DEFAULT_CALENDAR_ID} not found.`, 404));
    await moveToWork();
    act(() => undoOf('Moved Morning check to Work')());
    await waitFor(() =>
      expect(toast.showToast).toHaveBeenCalledWith('That calendar no longer exists')
    );

    toast.showToast.mockClear();
    seed([record]);
    automations.update
      .mockResolvedValueOnce({
        automation: automationRecord({ calendarId: WORK_CALENDAR_ID, calendarTitle: 'Work' }),
      })
      .mockRejectedValueOnce(new FetchError(`Automation ${record.id} is canceled.`, 409));
    await moveToWork();
    act(() => undoOf('Moved Morning check to Work')());
    await waitFor(() =>
      expect(toast.showToast).toHaveBeenCalledWith('That automation was deleted')
    );
  });
});
