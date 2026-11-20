import { EditorView } from '@tiptap/pm/view';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AutomationRecord, AutomationWhen } from '@snaglet/shared/types';
import { calendarApi } from '@desktop/features/calendar/calendarApi';
import { __resetCalendarStoreForTests } from '@desktop/features/calendar/calendarStore';
import { NODE_CHIP_MIME, setActiveDragChip } from '@desktop/utils/nodeChip';

const api = vi.hoisted(() => ({ update: vi.fn() }));
vi.mock('@desktop/utils/api/automations', () => ({ automationsApi: api }));
vi.mock('@desktop/utils/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@desktop/utils/api')>();
  return { ...actual, agentsApi: { ...actual.agentsApi, list: async () => [] } };
});

import { AutomationEditForm } from './AutomationEditForm';
import {
  calendarRecord,
  DEFAULT_CALENDAR_ID,
  testCalendars,
  WORK_CALENDAR_ID,
  stubEditorLayout,
} from './testFixtures';

const DOC_ID = 'doc-1111111111111-aaaaaaaaa';

beforeAll(stubEditorLayout);

afterEach(async () => {
  await act(async () => cleanup());
  setActiveDragChip(null);
  vi.restoreAllMocks();
});

const ID = 'automation-1111111111111-aaaaaaaaa';

/** As the server makes it: on the Default calendar, whatever the timing. */
function automation(when: AutomationWhen, whenText = 'when'): AutomationRecord {
  return {
    id: ID,
    name: 'Check',
    prompt: 'Look at the build.',
    status: 'active',
    when,
    whenText,
    calendarId: DEFAULT_CALENDAR_ID,
    threadId: 'thread-1',
    agentId: 'test-agent-a',
    scheduleId: 'schedule-1',
    createdByAgentId: null,
    createdByMemberId: null,
    consecutiveFailures: 0,
    pausedReason: null,
    createdAt: '',
    updatedAt: '',
    nextRunAt: null,
    lastRun: null,
    agentName: 'Test Agent A',
    threadTitle: 'Test thread',
    calendarTitle: 'Default calendar',
    running: false,
    runningSince: null,
    unattendedPolicy: 'skip',
  };
}

function renderForm(a: AutomationRecord, onClose = vi.fn()) {
  const onSaved = vi.fn();
  render(<AutomationEditForm automation={a} onSaved={onSaved} onClose={onClose} />);
  return onSaved;
}

const save = () => fireEvent.click(screen.getByRole('button', { name: 'Save' }));

const ONCE: AutomationWhen = { kind: 'once', at: '2030-01-02T09:30:00.000Z', tz: 'UTC' };

async function openCalendarList(current: string) {
  fireEvent.click(screen.getByRole('button', { name: `Calendar: ${current}` }));
  return screen.findByRole('listbox', { name: 'Calendar' });
}

/** A real press: pointerdown, then the click it ends in. */
function press(element: Element) {
  fireEvent.pointerDown(element);
  fireEvent.click(element);
}

describe('AutomationEditForm', () => {
  beforeEach(() => {
    __resetCalendarStoreForTests({ calendars: testCalendars() });
    api.update.mockReset();
    api.update.mockImplementation(async (_id: string) => ({
      automation: automation({ kind: 'interval', everyMs: 60_000, tz: 'UTC' }),
    }));
  });

  it('saves a once as a local date and time in its zone', async () => {
    const onSaved = renderForm(
      automation({ kind: 'once', at: '2030-01-02T09:30:00.000Z', tz: 'UTC' })
    );
    fireEvent.change(screen.getByLabelText('Date'), { target: { value: '2030-01-03' } });
    fireEvent.change(screen.getByLabelText('Time'), { target: { value: '10:15' } });
    save();
    await waitFor(() =>
      expect(api.update).toHaveBeenCalledWith(ID, { when: { at: '2030-01-03T10:15', tz: 'UTC' } })
    );
    expect(onSaved).toHaveBeenCalled();
  });

  it('saves a repeat quick choice with its time', async () => {
    renderForm(
      automation({
        kind: 'repeat',
        rrule: 'FREQ=DAILY',
        timeOfDay: '09:00',
        startsOn: '2026-10-13',
        tz: 'America/Los_Angeles',
      })
    );
    fireEvent.change(screen.getByLabelText('Repeats'), { target: { value: 'weekly' } });
    fireEvent.change(screen.getByLabelText('Day'), { target: { value: 'TH' } });
    fireEvent.change(screen.getByLabelText('Time'), { target: { value: '07:45' } });
    save();
    await waitFor(() =>
      expect(api.update).toHaveBeenCalledWith(ID, {
        when: { repeat: 'FREQ=WEEKLY;BYDAY=TH', at: '07:45', tz: 'America/Los_Angeles' },
      })
    );
  });

  it('saves When Snaglet first opens that day with its earliest time', async () => {
    renderForm(
      automation({
        kind: 'repeat',
        rrule: 'FREQ=WEEKLY;BYDAY=MO',
        timeOfDay: '09:00',
        startsOn: '2026-10-13',
        tz: 'America/Los_Angeles',
      })
    );
    fireEvent.change(screen.getByLabelText('Repeats'), { target: { value: 'first_open' } });
    // No day, no "at" time: an earliest time instead, 05:00 to start.
    expect(screen.queryByLabelText('Day')).toBeNull();
    expect(screen.queryByLabelText('Time')).toBeNull();
    expect((screen.getByLabelText('Earliest time') as HTMLInputElement).value).toBe('5:00 AM');
    expect(screen.getByText(/the first time Snaglet is open and the computer awake/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Earliest time'), { target: { value: '06:30' } });
    save();
    await waitFor(() =>
      expect(api.update).toHaveBeenCalledWith(ID, {
        when: { first_open: true, after: '06:30', tz: 'America/Los_Angeles' },
      })
    );
  });

  it('leaves out Notify while the timing is When Snaglet first opens that day, saved or not', () => {
    renderForm(
      automation({
        kind: 'repeat',
        rrule: 'FREQ=DAILY',
        timeOfDay: '09:00',
        startsOn: '2026-10-13',
        tz: 'UTC',
      })
    );
    const notify = () => document.querySelector('[data-reminder-settings]');
    expect(notify()).not.toBeNull();
    fireEvent.change(screen.getByLabelText('Repeats'), { target: { value: 'first_open' } });
    expect(notify()).toBeNull();
    fireEvent.change(screen.getByLabelText('Repeats'), { target: { value: 'daily' } });
    expect(notify()).not.toBeNull();
  });

  it('opens a stored first-open timing on its choice, and leaves it out of a save that did not touch it', async () => {
    renderForm(
      automation(
        { kind: 'first_open', after: '07:15', tz: 'UTC' },
        'when Snaglet first opens, after 7:15 AM'
      )
    );
    expect((screen.getByLabelText('Repeats') as HTMLSelectElement).value).toBe('first_open');
    expect((screen.getByLabelText('Earliest time') as HTMLInputElement).value).toBe('7:15 AM');
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Morning show' } });
    save();
    await waitFor(() => expect(api.update).toHaveBeenCalledWith(ID, { name: 'Morning show' }));
  });

  it('turns a first-open timing back into a daily repeat', async () => {
    renderForm(automation({ kind: 'first_open', after: '07:15', tz: 'UTC' }));
    fireEvent.change(screen.getByLabelText('Repeats'), { target: { value: 'daily' } });
    expect(screen.queryByLabelText('Earliest time')).toBeNull();
    fireEvent.change(screen.getByLabelText('Time'), { target: { value: '08:00' } });
    save();
    await waitFor(() =>
      expect(api.update).toHaveBeenCalledWith(ID, {
        when: { repeat: 'FREQ=DAILY', at: '08:00', tz: 'UTC' },
      })
    );
  });

  it('saves an interval in minutes or hours (people may use 1 minute)', async () => {
    renderForm(automation({ kind: 'interval', everyMs: 3_600_000, tz: 'UTC' }));
    expect((screen.getByLabelText('How many') as HTMLInputElement).value).toBe('1');
    fireEvent.change(screen.getByLabelText('How many'), { target: { value: '1' } });
    fireEvent.change(screen.getByLabelText('Unit'), { target: { value: 'm' } });
    save();
    await waitFor(() =>
      expect(api.update).toHaveBeenCalledWith(ID, { when: { every: '1m', tz: 'UTC' } })
    );
  });

  it('sends an optional first run with an interval (the stagger anchor)', async () => {
    renderForm(automation({ kind: 'interval', everyMs: 900_000, tz: 'UTC' }));
    fireEvent.change(screen.getByLabelText('First run date'), { target: { value: '2026-10-16' } });
    fireEvent.change(screen.getByLabelText('First run time'), { target: { value: '19:07' } });
    save();
    await waitFor(() =>
      expect(api.update).toHaveBeenCalledWith(ID, {
        when: { every: '15m', at: '2026-10-16T19:07', tz: 'UTC' },
      })
    );
  });

  const ANCHORED: AutomationWhen = {
    kind: 'interval',
    everyMs: 900_000,
    tz: 'America/Los_Angeles',
    anchor: '2026-10-17T02:07:09.000Z',
  };

  it('prefills the first run from the stored anchor in the automation’s zone', () => {
    renderForm(automation(ANCHORED));
    expect((screen.getByLabelText('First run date') as HTMLInputElement).value).toBe('Fri, Oct 16');
    expect((screen.getByLabelText('First run time') as HTMLInputElement).value).toBe('7:07 PM');
  });

  it('a name-only edit sends no `when`, so the anchor is kept', async () => {
    renderForm(automation(ANCHORED));
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Renamed' } });
    save();
    await waitFor(() => expect(api.update).toHaveBeenCalledWith(ID, { name: 'Renamed' }));
  });

  it('a length change alone sends the stored anchor as `at`, so the phase stays', async () => {
    renderForm(automation(ANCHORED));
    fireEvent.change(screen.getByLabelText('How many'), { target: { value: '30' } });
    save();
    await waitFor(() =>
      expect(api.update).toHaveBeenCalledWith(ID, {
        when: { every: '30m', at: '2026-10-16T19:07:09', tz: 'America/Los_Angeles' },
      })
    );
  });

  it('clearing the first run on a same-length edit sends now, resetting the phase', async () => {
    renderForm(automation(ANCHORED));
    fireEvent.change(screen.getByLabelText('First run date'), { target: { value: '' } });
    fireEvent.change(screen.getByLabelText('First run time'), { target: { value: '' } });
    save();
    await waitFor(() =>
      expect(api.update).toHaveBeenCalledWith(ID, {
        when: {
          every: '15m',
          at: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/),
          tz: 'America/Los_Angeles',
        },
      })
    );
  });

  describe('a daily window on an interval', () => {
    const WINDOWED: AutomationWhen = {
      kind: 'interval',
      everyMs: 300_000,
      tz: 'UTC',
      anchor: '2026-10-17T02:07:09.000Z',
      windowStart: '05:05',
      windowEnd: '06:00',
    };

    it('sends the window in place of a first run, which it hides', async () => {
      renderForm(automation({ kind: 'interval', everyMs: 900_000, tz: 'UTC' }));
      expect(screen.getByLabelText('First run date')).toBeTruthy();
      fireEvent.change(screen.getByLabelText('How many'), { target: { value: '5' } });
      fireEvent.change(screen.getByLabelText('Window start'), { target: { value: '05:05' } });
      fireEvent.change(screen.getByLabelText('Window end'), { target: { value: '06:00' } });
      expect(screen.queryByLabelText('First run date')).toBeNull();
      expect(screen.queryByLabelText('First run time')).toBeNull();
      expect(
        screen.getByText('Runs at 5:05 AM, then each interval up to 6:00 AM, every day, in UTC.')
      ).toBeTruthy();
      save();
      await waitFor(() =>
        expect(api.update).toHaveBeenCalledWith(ID, {
          when: { every: '5m', window_start: '05:05', window_end: '06:00', tz: 'UTC' },
        })
      );
    });

    it('prefills a stored window and keeps it on a length change', async () => {
      renderForm(automation(WINDOWED));
      expect((screen.getByLabelText('Window start') as HTMLInputElement).value).toBe('5:05 AM');
      expect((screen.getByLabelText('Window end') as HTMLInputElement).value).toBe('6:00 AM');
      expect(screen.queryByLabelText('First run date')).toBeNull();
      fireEvent.change(screen.getByLabelText('How many'), { target: { value: '10' } });
      save();
      await waitFor(() =>
        expect(api.update).toHaveBeenCalledWith(ID, {
          when: { every: '10m', window_start: '05:05', window_end: '06:00', tz: 'UTC' },
        })
      );
    });

    it('clearing the window brings the first run back and sends none', async () => {
      renderForm(automation(WINDOWED));
      fireEvent.change(screen.getByLabelText('Window start'), { target: { value: '' } });
      fireEvent.change(screen.getByLabelText('Window end'), { target: { value: '' } });
      expect(screen.getByLabelText('First run date')).toBeTruthy();
      save();
      await waitFor(() =>
        expect(api.update).toHaveBeenCalledWith(ID, { when: { every: '5m', tz: 'UTC' } })
      );
    });

    it('will not save half a window or an empty one, and says why', () => {
      renderForm(automation({ kind: 'interval', everyMs: 900_000, tz: 'UTC' }));
      fireEvent.change(screen.getByLabelText('Window start'), { target: { value: '05:05' } });
      expect(screen.getByRole('alert').textContent).toBe('Set both window times, or clear both.');
      expect((screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement).disabled).toBe(
        true
      );
      fireEvent.change(screen.getByLabelText('Window end'), { target: { value: '05:05' } });
      expect(screen.getByRole('alert').textContent).toBe(
        'The window must end at another time than it starts.'
      );
      expect((screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement).disabled).toBe(
        true
      );
      fireEvent.change(screen.getByLabelText('Window end'), { target: { value: '01:00' } });
      expect(screen.queryByRole('alert')).toBeNull();
      expect((screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement).disabled).toBe(
        false
      );
    });

    it('shows no window fields for a once or a repeat', () => {
      renderForm(automation(ONCE));
      expect(screen.queryByLabelText('Window start')).toBeNull();
      fireEvent.click(screen.getByRole('radio', { name: 'Repeat' }));
      expect(screen.queryByLabelText('Window start')).toBeNull();
      fireEvent.click(screen.getByRole('radio', { name: 'Every' }));
      expect(screen.getByLabelText('Window start')).toBeTruthy();
    });
  });

  it('shows a rule that is no quick choice in words, read-only, until Change to…', async () => {
    renderForm(
      automation(
        {
          kind: 'repeat',
          rrule: 'FREQ=MONTHLY;BYDAY=2TU',
          timeOfDay: '09:00',
          startsOn: '2026-10-13',
          tz: 'UTC',
        },
        'every month on the 2nd Tuesday at 9:00 AM'
      )
    );
    expect(screen.getByText('every month on the 2nd Tuesday at 9:00 AM')).toBeTruthy();
    expect(screen.queryByLabelText('Repeats')).toBeNull();
    // Saving untouched keeps the rule (no `when` sent).
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Renamed' } });
    save();
    await waitFor(() => expect(api.update).toHaveBeenCalledWith(ID, { name: 'Renamed' }));

    fireEvent.click(screen.getByRole('button', { name: 'Change to…' }));
    expect(screen.getByLabelText('Repeats')).toBeTruthy();
  });

  it('edits the prompt in the chip editor and saves its chip markup', async () => {
    vi.spyOn(EditorView.prototype, 'posAtCoords').mockImplementation(function (this: EditorView) {
      return { pos: this.state.doc.content.size - 1, inside: -1 };
    });
    renderForm(automation({ kind: 'interval', everyMs: 60_000, tz: 'UTC' }));
    const prompt = screen.getByRole('textbox', { name: 'Prompt' });
    await waitFor(() => expect(prompt).toHaveTextContent('Look at the build.'));
    const dataTransfer = {
      types: [NODE_CHIP_MIME],
      getData: (type: string) =>
        type === NODE_CHIP_MIME ? JSON.stringify({ id: DOC_ID, kind: 'doc', title: 'Plan' }) : '',
      dropEffect: 'copy',
      files: [],
    };
    fireEvent.drop(prompt, { dataTransfer, clientX: 0, clientY: 0 });
    await waitFor(() => expect(prompt.querySelector('[data-node-kind="doc"]')).toBeTruthy());
    save();
    await waitFor(() =>
      expect(api.update).toHaveBeenCalledWith(ID, {
        prompt: `Look at the build.[Plan](${DOC_ID})`,
      })
    );
  });

  it('sends what an unattended run does only when a person changes it', async () => {
    renderForm(automation(ONCE));
    const policy = screen.getByLabelText('Tool calls that ask for a person') as HTMLSelectElement;
    expect(policy.value).toBe('skip');
    expect(
      within(policy)
        .getAllByRole('option')
        .map((o) => o.textContent)
    ).toEqual(['Skip calls that ask', 'Run calls tool access allows']);
    fireEvent.change(policy, { target: { value: 'auto-approve-allowed' } });
    save();
    await waitFor(() =>
      expect(api.update).toHaveBeenCalledWith(ID, { unattendedPolicy: 'auto-approve-allowed' })
    );
  });

  it('counts the prompt against the 4000 limit and will not save one over it', async () => {
    renderForm({
      ...automation({ kind: 'interval', everyMs: 60_000, tz: 'UTC' }),
      prompt: 'x'.repeat(4001),
    });
    expect(screen.getByText('4001 / 4000')).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent('Too long: 4001 of 4000 characters.');
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
  });

  describe('Calendar', () => {
    it('moves a once to another calendar, each with its color', async () => {
      renderForm(automation(ONCE));
      const list = await openCalendarList('Default calendar');
      expect(
        within(list)
          .getAllByRole('option')
          .map((o) => o.textContent)
      ).toEqual(['No calendar', 'Default calendar', 'Work']);
      const work = within(list).getByRole('option', { name: 'Work' });
      expect(work.querySelector('[data-cal-color="blue"]')).toBeTruthy();
      fireEvent.click(work);
      save();
      await waitFor(() =>
        expect(api.update).toHaveBeenCalledWith(ID, { calendarId: WORK_CALENDAR_ID })
      );
    });

    it('sends no calendar when it stays put', async () => {
      renderForm(automation(ONCE));
      fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Renamed' } });
      save();
      await waitFor(() => expect(api.update).toHaveBeenCalledWith(ID, { name: 'Renamed' }));
    });

    it('switching to Every keeps the picker and the pick', async () => {
      renderForm(automation(ONCE));
      fireEvent.click(await openCalendarList('Default calendar'));
      fireEvent.click(screen.getByRole('option', { name: 'Work' }));
      fireEvent.click(screen.getByRole('radio', { name: 'Every' }));
      expect(screen.getByRole('button', { name: 'Calendar: Work' })).toBeTruthy();
      expect(screen.queryByText(/don't show on a calendar/)).toBeNull();
      save();
      await waitFor(() =>
        expect(api.update).toHaveBeenCalledWith(ID, {
          when: { every: '1h', tz: 'UTC' },
          calendarId: WORK_CALENDAR_ID,
        })
      );
    });

    it('an Every shows its calendar and keeps it when made a once', async () => {
      renderForm(automation({ kind: 'interval', everyMs: 3_600_000, tz: 'UTC' }));
      expect(screen.getByRole('button', { name: 'Calendar: Default calendar' })).toBeTruthy();
      fireEvent.click(screen.getByRole('radio', { name: 'Once' }));
      expect(screen.getByRole('button', { name: 'Calendar: Default calendar' })).toBeTruthy();
      save();
      await waitFor(() =>
        expect(api.update).toHaveBeenCalledWith(ID, { when: { at: expect.any(String), tz: 'UTC' } })
      );
    });

    it('an Every with no calendar says No calendar and can be put on one', async () => {
      renderForm({
        ...automation({ kind: 'interval', everyMs: 900_000, tz: 'UTC' }),
        calendarId: null,
        calendarTitle: null,
      });
      const list = await openCalendarList('No calendar');
      fireEvent.click(within(list).getByRole('option', { name: 'Work' }));
      save();
      await waitFor(() =>
        expect(api.update).toHaveBeenCalledWith(ID, { calendarId: WORK_CALENDAR_ID })
      );
    });

    it('with no calendar left, Default calendar (new) is made on Save and the automation goes on it', async () => {
      __resetCalendarStoreForTests({ calendars: [] });
      const made = calendarRecord({
        id: DEFAULT_CALENDAR_ID,
        title: 'Default calendar',
        color: null,
        isDefault: true,
        sortOrder: 0,
      });
      const create = vi.spyOn(calendarApi, 'createCalendar').mockResolvedValue({ calendar: made });
      renderForm({ ...automation(ONCE), calendarId: null, calendarTitle: null });
      const list = await openCalendarList('No calendar');
      fireEvent.click(within(list).getByRole('option', { name: 'Default calendar (new)' }));
      expect(screen.getByRole('button', { name: 'Calendar: Default calendar (new)' })).toBeTruthy();
      // Nothing is made until Save.
      expect(create).not.toHaveBeenCalled();
      save();
      await waitFor(() =>
        expect(api.update).toHaveBeenCalledWith(ID, { calendarId: DEFAULT_CALENDAR_ID })
      );
      expect(create).toHaveBeenCalledExactlyOnceWith({ title: 'Default calendar' });
    });

    it('takes a once off the calendar with No calendar', async () => {
      renderForm(automation(ONCE));
      const list = await openCalendarList('Default calendar');
      fireEvent.click(within(list).getByRole('option', { name: 'No calendar' }));
      expect(screen.getByRole('button', { name: 'Calendar: No calendar' })).toBeTruthy();
      save();
      await waitFor(() => expect(api.update).toHaveBeenCalledWith(ID, { calendarId: null }));
    });

    it('one with no calendar shows No calendar, keeps it, and can go back on one', async () => {
      renderForm({ ...automation(ONCE), calendarId: null, calendarTitle: null });
      fireEvent.change(screen.getByLabelText('Date'), { target: { value: '2030-01-03' } });
      expect(screen.getByRole('button', { name: 'Calendar: No calendar' })).toBeTruthy();
      save();
      await waitFor(() =>
        expect(api.update).toHaveBeenCalledWith(ID, { when: { at: '2030-01-03T09:30', tz: 'UTC' } })
      );

      api.update.mockClear();
      const list = await openCalendarList('No calendar');
      fireEvent.click(within(list).getByRole('option', { name: 'Work' }));
      save();
      await waitFor(() =>
        expect(api.update).toHaveBeenCalledWith(ID, {
          when: { at: '2030-01-03T09:30', tz: 'UTC' },
          calendarId: WORK_CALENDAR_ID,
        })
      );
    });

    it('an Every made a once can be put on No calendar', async () => {
      renderForm(automation({ kind: 'interval', everyMs: 3_600_000, tz: 'UTC' }));
      fireEvent.click(screen.getByRole('radio', { name: 'Once' }));
      const list = await openCalendarList('Default calendar');
      fireEvent.click(within(list).getByRole('option', { name: 'No calendar' }));
      save();
      await waitFor(() =>
        expect(api.update).toHaveBeenCalledWith(ID, {
          when: { at: expect.any(String), tz: 'UTC' },
          calendarId: null,
        })
      );
    });

    it('keeps a revived calendar listed until it is moved', async () => {
      const archived = calendarRecord({
        id: 'calendar-3333333333333-ccccccccc',
        title: 'Old plans',
        sortOrder: 2,
      });
      __resetCalendarStoreForTests({ calendars: [...testCalendars(), archived] });
      renderForm({
        ...automation(ONCE),
        calendarId: archived.id,
        calendarTitle: 'Old plans',
      });
      const list = await openCalendarList('Old plans');
      expect(within(list).getByRole('option', { name: /Old plans/ })).toHaveTextContent(
        'Old plans'
      );
      fireEvent.click(within(list).getByRole('option', { name: 'Work' }));
      save();
      await waitFor(() =>
        expect(api.update).toHaveBeenCalledWith(ID, { calendarId: WORK_CALENDAR_ID })
      );
    });

    // One outside press closes one layer, unsaved.
    it('a press outside the open list closes only the list, then the next closes the form', async () => {
      const onClose = vi.fn();
      renderForm(automation(ONCE), onClose);
      const dialog = screen.getByRole('dialog', { name: 'Edit Check' });
      const backdrop = dialog.parentElement!;

      await openCalendarList('Default calendar');
      press(screen.getByLabelText('Name'));
      expect(screen.queryByRole('listbox', { name: 'Calendar' })).toBeNull();
      expect(onClose).not.toHaveBeenCalled();

      await openCalendarList('Default calendar');
      press(backdrop);
      expect(screen.queryByRole('listbox', { name: 'Calendar' })).toBeNull();
      expect(onClose).not.toHaveBeenCalled();

      press(backdrop);
      expect(onClose).toHaveBeenCalledTimes(1);
      expect(api.update).not.toHaveBeenCalled();
    });
  });

  it('holds the name while it saves, so nothing typed then is lost', async () => {
    let release!: () => void;
    api.update.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = () => resolve({ automation: automation(ONCE) });
        })
    );
    renderForm(automation(ONCE));
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Renamed' } });
    save();
    expect(await screen.findByRole('button', { name: 'Saving…' })).toBeDisabled();
    expect(screen.getByLabelText('Name')).toBeDisabled();
    await act(async () => release());
    expect(screen.getByLabelText('Name')).not.toBeDisabled();
  });

  it('shows the server error inline', async () => {
    api.update.mockRejectedValue(new Error('That time is in the past.'));
    renderForm(automation({ kind: 'once', at: '2030-01-02T09:30:00.000Z', tz: 'UTC' }));
    fireEvent.change(screen.getByLabelText('Date'), { target: { value: '2001-01-01' } });
    save();
    expect(await screen.findByRole('alert')).toHaveTextContent('That time is in the past.');
  });
});
