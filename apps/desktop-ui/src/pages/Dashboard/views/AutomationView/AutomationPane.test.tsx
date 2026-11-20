import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactElement } from 'react';
import type { AutomationRecord, AutomationRunRecord } from '@snaglet/shared/types';

const api = vi.hoisted(() => ({
  list: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  pause: vi.fn(),
  resume: vi.fn(),
  remove: vi.fn(),
  restore: vi.fn(),
  runNow: vi.fn(),
  runs: vi.fn(),
}));
vi.mock('@desktop/utils/api/automations', () => ({ automationsApi: api }));

const people = vi.hoisted(() => ({
  agents: vi.fn(),
  threads: vi.fn(),
  thread: vi.fn(),
  participants: vi.fn(),
}));
vi.mock('@desktop/utils/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@desktop/utils/api')>();
  return {
    ...actual,
    agentsApi: { ...actual.agentsApi, list: () => people.agents() },
    threadsApi: {
      ...actual.threadsApi,
      list: (agentId?: string) => people.threads(agentId),
      get: (id: string) => people.thread(id),
      listParticipants: (id: string) => people.participants(id),
    },
  };
});

vi.mock('@desktop/hooks/useTieredSearch', () => ({
  useTieredSearch: () => ({
    instant: null,
    enriched: null,
    instantLoading: false,
    enrichmentLoading: false,
  }),
  stableMergeById: <T,>(instant: readonly T[], enriched: readonly T[]) => [...instant, ...enriched],
}));

type ToastAction = { label: string; run: () => void };
const toast = vi.hoisted(() => ({ show: vi.fn() }));
vi.mock('@desktop/utils/toast', () => ({
  showToast: (...args: unknown[]) => toast.show(...args),
  dismissToast: vi.fn(),
}));

import {
  __resetAutomationsStoreForTests,
  upsertAutomation,
} from '@desktop/features/automations/automationsStore';
import {
  automationRecord,
  calendarRecord,
  DEFAULT_CALENDAR_ID,
  TEST_THREAD_ID,
  testCalendars,
  WORK_CALENDAR_ID,
  stubEditorLayout,
} from '@desktop/features/automations/testFixtures';
import { calendarApi } from '@desktop/features/calendar/calendarApi';
import { __resetCalendarStoreForTests } from '@desktop/features/calendar/calendarStore';
import {
  DashboardNavigationProvider,
  type DashboardNavigationValue,
} from '@desktop/pages/Dashboard/selection/DashboardNavigationContext';
import { useSelectionDescriptor } from '@desktop/pages/Dashboard/selection/selectionDescriptor';
import { AutomationPane } from './AutomationPane';

const ID = 'automation-1111111111111-aaaaaaaaa';
const base = automationRecord({
  id: ID,
  lastRun: {
    status: 'failed',
    scheduledFor: '2026-10-13T09:00:00.000Z',
    finishedAt: '2026-10-13T09:01:00.000Z',
    error: 'Provider exploded',
  },
  consecutiveFailures: 1,
  calendarId: DEFAULT_CALENDAR_ID,
  calendarTitle: 'Default calendar',
});

function nav(): DashboardNavigationValue {
  return {
    openInPane: vi.fn(),
    openThreadAgent: vi.fn(),
    requestReveal: vi.fn(),
    openThread: vi.fn(),
    openAutomation: vi.fn(),
  };
}

function renderWithNav(ui: ReactElement, value = nav()) {
  render(<DashboardNavigationProvider value={value}>{ui}</DashboardNavigationProvider>);
  return value;
}

/** The last toast's Undo, run. */
async function undoLastToast() {
  const calls = toast.show.mock.calls as Array<[string, { action?: ToastAction } | undefined]>;
  const call = calls[calls.length - 1];
  if (!call) throw new Error('no toast');
  expect(call[1]?.action?.label).toBe('Undo');
  await act(async () => {
    call[1]?.action?.run();
  });
}

const run = (over: Partial<AutomationRunRecord> & { id: string }): AutomationRunRecord => ({
  scheduledFor: '2026-10-13T09:00:00.000Z',
  startedAt: '2026-10-13T09:00:00.000Z',
  finishedAt: '2026-10-13T09:00:05.000Z',
  status: 'succeeded',
  error: null,
  manual: false,
  ...over,
});

const withStatus = (status: AutomationRecord['status'], over: Partial<AutomationRecord> = {}) => ({
  automation: { ...base, status, ...over },
});

beforeAll(stubEditorLayout);

describe('AutomationPane', () => {
  beforeEach(() => {
    __resetAutomationsStoreForTests();
    __resetCalendarStoreForTests({ calendars: testCalendars() });
    Object.values(api).forEach((fn) => fn.mockReset());
    toast.show.mockReset();
    Object.values(people).forEach((fn) => fn.mockReset());
    api.list.mockResolvedValue({ automations: [base] });
    api.runs.mockResolvedValue({ runs: [], nextCursor: null });
    upsertAutomation(base);
  });

  it('shows who wakes, the prompt, timing, next run, last result, failures, thread and calendar', () => {
    renderWithNav(<AutomationPane automationId={ID} />);

    expect(screen.getByRole('heading', { level: 1, name: 'Morning check' })).toBeInTheDocument();
    expect(screen.getByText('Wakes Test Agent A · Active')).toBeInTheDocument();
    expect(screen.getByText('Look at the build.')).toBeInTheDocument();
    expect(screen.getByText('every weekday at 9:00 AM')).toBeInTheDocument();
    const details = screen.getByRole('region', { name: 'Details' });
    expect(within(details).getByText('Next run').nextElementSibling?.textContent).toMatch(/Oct/);
    expect(within(details).getByText(/Failed: Provider exploded/)).toBeInTheDocument();
    expect(within(details).getByText('Failures in a row').nextElementSibling).toHaveTextContent(
      '1'
    );
    expect(within(details).getByText('Default calendar')).toBeInTheDocument();
    expect(screen.queryByText('Running')).toBeNull();
  });

  it('counts down to the next run beside its date while it is active', () => {
    act(() => upsertAutomation({ ...base, nextRunAt: '2099-01-01T09:00:00.000Z' }));
    renderWithNav(<AutomationPane automationId={ID} />);
    const nextRun = screen.getByText('Next run').nextElementSibling as HTMLElement;
    expect(within(nextRun).getByText(/Jan/)).toBeInTheDocument();
    expect(within(nextRun).getByRole('timer')).toHaveTextContent(/^in \d+d \d+h \d\dm \d\ds$/);
    expect(within(nextRun).getByRole('timer')).toHaveAccessibleName(/^Next run in \d+ days/);

    act(() => upsertAutomation({ ...base, status: 'paused', pausedReason: 'user' }));
    expect(screen.queryByRole('timer')).toBeNull();
  });

  it('says a first-open one runs when Snaglet first opens, from its earliest time, with no countdown', () => {
    act(() =>
      upsertAutomation({
        ...base,
        when: { kind: 'first_open', after: '05:00', tz: 'UTC' },
        whenText: 'when Snaglet first opens, after 5:00 AM',
        nextRunAt: '2099-01-15T12:00:00.000Z',
      })
    );
    renderWithNav(<AutomationPane automationId={ID} />);
    expect(screen.getByText('when Snaglet first opens, after 5:00 AM')).toBeInTheDocument();
    const nextRun = screen.getByText('Next run').nextElementSibling as HTMLElement;
    expect(nextRun).toHaveTextContent(/^When Snaglet first opens, from \w{3}, Jan 15, /);
    expect(within(nextRun).queryByRole('timer')).toBeNull();
  });

  it('shows a prompt written with chips as chips, not link markup', () => {
    const docId = 'doc-1111111111111-aaaaaaaaa';
    act(() => upsertAutomation({ ...base, prompt: `Read [Plan](${docId})\nthen reply.` }));
    renderWithNav(<AutomationPane automationId={ID} />);
    const prompt = screen.getByRole('region', { name: 'Prompt' });
    expect(
      prompt.querySelector(`[data-node-kind="doc"][data-node-url="${docId}"]`)
    ).toHaveTextContent('Plan');
    expect(prompt.textContent).not.toContain('](');
    expect(prompt.querySelector('br')).toBeInTheDocument();
  });

  it('opens the thread with its title, so the pane is named', () => {
    const value = renderWithNav(<AutomationPane automationId={ID} />);
    fireEvent.click(screen.getByRole('button', { name: 'In Test thread →' }));
    expect(value.openThread).toHaveBeenCalledWith(TEST_THREAD_ID, 'Test thread');
  });

  it('moves it to another calendar from the details, with Undo', async () => {
    api.update
      .mockResolvedValueOnce({
        automation: { ...base, calendarId: WORK_CALENDAR_ID, calendarTitle: 'Work' },
      })
      .mockResolvedValueOnce({ automation: base });
    renderWithNav(<AutomationPane automationId={ID} />);
    const details = screen.getByRole('region', { name: 'Details' });

    fireEvent.click(within(details).getByRole('button', { name: 'Calendar: Default calendar' }));
    const list = await screen.findByRole('listbox', { name: 'Calendar' });
    fireEvent.click(within(list).getByRole('option', { name: 'Work' }));

    await waitFor(() =>
      expect(api.update).toHaveBeenCalledWith(ID, { calendarId: WORK_CALENDAR_ID })
    );
    expect(
      await within(details).findByRole('button', { name: 'Calendar: Work' })
    ).toBeInTheDocument();
    expect(toast.show).toHaveBeenLastCalledWith('Moved Morning check to Work', expect.anything());

    await undoLastToast();
    expect(api.update).toHaveBeenLastCalledWith(ID, { calendarId: DEFAULT_CALENDAR_ID });
    await waitFor(() => expect(api.list).toHaveBeenCalled());
  });

  it('takes it off the calendar with No calendar, and Undo puts it back', async () => {
    const offCalendar = { ...base, calendarId: null, calendarTitle: null };
    api.update
      .mockResolvedValueOnce({ automation: offCalendar })
      .mockResolvedValueOnce({ automation: base });
    renderWithNav(<AutomationPane automationId={ID} />);
    const details = screen.getByRole('region', { name: 'Details' });

    fireEvent.click(within(details).getByRole('button', { name: 'Calendar: Default calendar' }));
    const list = await screen.findByRole('listbox', { name: 'Calendar' });
    const none = within(list).getAllByRole('option')[0]!;
    expect(none).toHaveTextContent('No calendar');
    expect(none.querySelector('[data-cal-color]')).toBeNull();
    fireEvent.click(none);

    await waitFor(() => expect(api.update).toHaveBeenCalledWith(ID, { calendarId: null }));
    expect(
      await within(details).findByRole('button', { name: 'Calendar: No calendar' })
    ).toBeInTheDocument();
    expect(toast.show).toHaveBeenLastCalledWith(
      'Removed Morning check from the calendar',
      expect.anything()
    );

    await undoLastToast();
    expect(api.update).toHaveBeenLastCalledWith(ID, { calendarId: DEFAULT_CALENDAR_ID });
  });

  it('does not offer a new default while calendars are loading, then allows selection', async () => {
    __resetCalendarStoreForTests();
    act(() => upsertAutomation({ ...base, calendarId: null, calendarTitle: null }));
    let resolve!: (value: { calendars: ReturnType<typeof testCalendars> }) => void;
    const listCalendars = vi.spyOn(calendarApi, 'listCalendars').mockImplementation(
      () =>
        new Promise((done) => {
          resolve = done;
        })
    );
    try {
      api.update.mockResolvedValue({
        automation: { ...base, calendarId: WORK_CALENDAR_ID, calendarTitle: 'Work' },
      });
      renderWithNav(<AutomationPane automationId={ID} />);
      const details = screen.getByRole('region', { name: 'Details' });
      fireEvent.click(within(details).getByRole('button', { name: 'Calendar: No calendar' }));
      expect(screen.queryByText('Default calendar (new)')).not.toBeInTheDocument();
      await waitFor(() => expect(listCalendars).toHaveBeenCalledOnce());
      await act(async () => resolve({ calendars: testCalendars() }));
      fireEvent.click(await screen.findByRole('option', { name: 'Work' }));
      await waitFor(() =>
        expect(api.update).toHaveBeenCalledWith(ID, { calendarId: WORK_CALENDAR_ID })
      );
    } finally {
      listCalendars.mockRestore();
    }
  });

  it('with no calendar left, Default calendar (new) makes it and moves the automation there', async () => {
    __resetCalendarStoreForTests({ calendars: [] });
    act(() => upsertAutomation({ ...base, calendarId: null, calendarTitle: null }));
    const made = calendarRecord({
      id: DEFAULT_CALENDAR_ID,
      title: 'Default calendar',
      color: null,
      isDefault: true,
      sortOrder: 0,
    });
    const create = vi.spyOn(calendarApi, 'createCalendar').mockResolvedValue({ calendar: made });
    try {
      api.update.mockResolvedValue({ automation: base });
      renderWithNav(<AutomationPane automationId={ID} />);
      const details = screen.getByRole('region', { name: 'Details' });
      fireEvent.click(within(details).getByRole('button', { name: 'Calendar: No calendar' }));
      const list = await screen.findByRole('listbox', { name: 'Calendar' });
      fireEvent.click(within(list).getByRole('option', { name: 'Default calendar (new)' }));
      await waitFor(() =>
        expect(api.update).toHaveBeenCalledWith(ID, { calendarId: DEFAULT_CALENDAR_ID })
      );
      expect(create).toHaveBeenCalledExactlyOnceWith({ title: 'Default calendar' });
      expect(toast.show).toHaveBeenLastCalledWith(
        'Moved Morning check to Default calendar',
        expect.anything()
      );
    } finally {
      create.mockRestore();
    }
  });

  it('shows No calendar when it has none, and Undo of a pick goes back to none', async () => {
    const offCalendar = { ...base, calendarId: null, calendarTitle: null };
    act(() => upsertAutomation(offCalendar));
    api.update
      .mockResolvedValueOnce({
        automation: { ...base, calendarId: WORK_CALENDAR_ID, calendarTitle: 'Work' },
      })
      .mockResolvedValueOnce({ automation: offCalendar });
    renderWithNav(<AutomationPane automationId={ID} />);
    const details = screen.getByRole('region', { name: 'Details' });

    fireEvent.click(within(details).getByRole('button', { name: 'Calendar: No calendar' }));
    const list = await screen.findByRole('listbox', { name: 'Calendar' });
    expect(within(list).getByRole('option', { name: 'No calendar' })).toHaveAttribute(
      'aria-selected',
      'true'
    );
    fireEvent.click(within(list).getByRole('option', { name: 'Work' }));

    await waitFor(() =>
      expect(api.update).toHaveBeenCalledWith(ID, { calendarId: WORK_CALENDAR_ID })
    );
    expect(toast.show).toHaveBeenLastCalledWith('Moved Morning check to Work', expect.anything());
    await undoLastToast();
    expect(api.update).toHaveBeenLastCalledWith(ID, { calendarId: null });
  });

  it('an Every has the calendar picker too; a deleted one keeps its calendar, fixed', async () => {
    const every: AutomationRecord = {
      ...base,
      when: { kind: 'interval', everyMs: 1_800_000, tz: 'UTC' },
      whenText: 'every 30 minutes',
      calendarId: null,
      calendarTitle: null,
    };
    act(() => upsertAutomation(every));
    api.update.mockResolvedValueOnce({
      automation: { ...every, calendarId: WORK_CALENDAR_ID, calendarTitle: 'Work' },
    });
    const { unmount } = render(<AutomationPane automationId={ID} />);
    const details = screen.getByRole('region', { name: 'Details' });
    expect(within(details).queryByText(/don't show on a calendar/)).toBeNull();
    fireEvent.click(within(details).getByRole('button', { name: 'Calendar: No calendar' }));
    const list = await screen.findByRole('listbox', { name: 'Calendar' });
    fireEvent.click(within(list).getByRole('option', { name: 'Work' }));
    await waitFor(() =>
      expect(api.update).toHaveBeenCalledWith(ID, { calendarId: WORK_CALENDAR_ID })
    );
    unmount();

    act(() => upsertAutomation({ ...base, status: 'cancelled', nextRunAt: null }));
    render(<AutomationPane automationId={ID} />);
    expect(screen.getByRole('button', { name: 'Calendar: Default calendar' })).toBeDisabled();
  });

  it('pauses with Undo, and Undo resumes', async () => {
    api.pause.mockResolvedValue(withStatus('paused', { pausedReason: 'user', nextRunAt: null }));
    api.resume.mockResolvedValue(withStatus('active'));
    renderWithNav(<AutomationPane automationId={ID} />);

    fireEvent.click(screen.getByRole('button', { name: 'Pause' }));
    expect(await screen.findByText('Wakes Test Agent A · Paused')).toBeInTheDocument();
    expect(api.pause).toHaveBeenCalledWith(ID);
    expect(toast.show).toHaveBeenLastCalledWith('Paused Morning check', expect.anything());
    expect(screen.getByRole('button', { name: 'Resume' })).toBeInTheDocument();

    await undoLastToast();
    expect(api.resume).toHaveBeenCalledWith(ID);
    await waitFor(() => expect(api.list).toHaveBeenCalled());
  });

  it("hands focus to the button that takes the pressed one's place", async () => {
    const user = userEvent.setup();
    api.pause.mockResolvedValue(withStatus('paused', { pausedReason: 'user', nextRunAt: null }));
    api.remove.mockResolvedValue(withStatus('cancelled', { nextRunAt: null }));
    api.resume.mockResolvedValue(withStatus('active'));
    api.restore.mockResolvedValue(withStatus('active'));
    renderWithNav(<AutomationPane automationId={ID} />);

    await user.click(screen.getByRole('button', { name: 'Pause' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Resume' })).toHaveFocus());

    await user.click(screen.getByRole('button', { name: 'Archive' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Restore' })).toHaveFocus());

    await user.click(screen.getByRole('button', { name: 'Restore' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Pause' })).toHaveFocus());
  });

  it('runs now and says who woke', async () => {
    api.runNow.mockResolvedValue({
      automation: { ...base, running: true, runningSince: '2026-10-14T09:00:00.000Z' },
      run: { status: 'succeeded', error: null },
    });
    renderWithNav(<AutomationPane automationId={ID} />);

    fireEvent.click(screen.getByRole('button', { name: 'Run now' }));
    await waitFor(() => expect(toast.show).toHaveBeenCalledWith('Woke Test Agent A'));
    expect(api.runNow).toHaveBeenCalledWith(ID);
    // While the wake runs: the badge shows and Run now waits.
    expect(await screen.findByRole('status')).toHaveTextContent('Running');
    expect(screen.getByRole('button', { name: 'Run now' })).toBeDisabled();
  });

  it('archives with no confirmation and Undo restores it', async () => {
    api.remove.mockResolvedValue(withStatus('cancelled', { nextRunAt: null }));
    api.restore.mockResolvedValue(withStatus('active'));
    renderWithNav(<AutomationPane automationId={ID} />);

    fireEvent.click(screen.getByRole('button', { name: 'Archive' }));
    expect(
      await screen.findByText(
        /Archived\. It won.t run again unless you restore it \(here or from the Archive drawer\)\./
      )
    ).toBeInTheDocument();
    expect(screen.getByText('Wakes Test Agent A · Archived')).toBeInTheDocument();
    expect(api.remove).toHaveBeenCalledWith(ID);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(toast.show).toHaveBeenLastCalledWith('Archived Morning check', expect.anything());
    // The deleted automation still says how its last run went.
    expect(screen.getByText(/Failed: Provider exploded/)).toBeInTheDocument();
    expect(screen.queryByText('Not run yet')).toBeNull();

    await undoLastToast();
    // The restore route, which changes only a deleted one (never `resume`).
    expect(api.restore).toHaveBeenCalledWith(ID);
    expect(api.resume).not.toHaveBeenCalled();
  });

  it('edits in place and saves through the automation API', async () => {
    api.update.mockResolvedValue({ automation: { ...base, name: 'Evening check' } });
    renderWithNav(<AutomationPane automationId={ID} />);

    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    const form = screen.getByRole('form', { name: 'Edit Morning check' });
    fireEvent.change(within(form).getByLabelText('Name'), { target: { value: 'Evening check' } });
    fireEvent.click(within(form).getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(api.update).toHaveBeenCalledWith(ID, { name: 'Evening check' }));
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Evening check' })
    ).toBeInTheDocument();
    expect(screen.queryByRole('form')).toBeNull();
    expect(toast.show).toHaveBeenCalledWith('Saved Evening check');
    // Focus comes back to Edit rather than falling to the page.
    expect(screen.getByRole('button', { name: 'Edit' })).toHaveFocus();
  });

  it('puts focus back on Edit when the inline form is canceled', async () => {
    const user = userEvent.setup();
    renderWithNav(<AutomationPane automationId={ID} />);

    await user.click(screen.getByRole('button', { name: 'Edit' }));
    const form = screen.getByRole('form', { name: 'Edit Morning check' });
    await user.click(within(form).getByRole('button', { name: 'Cancel' }));

    expect(screen.queryByRole('form')).toBeNull();
    expect(screen.getByRole('button', { name: 'Edit' })).toHaveFocus();
  });

  it('titles the pane with the live name', () => {
    const Title = () => (
      <span>
        {
          useSelectionDescriptor({ kind: 'automation-detail', automation_id: ID, name: 'Old' })
            ?.title
        }
      </span>
    );
    render(<Title />);
    expect(screen.getByText('Morning check')).toBeInTheDocument();
    act(() => upsertAutomation({ ...base, name: 'Renamed by an agent' }));
    expect(screen.getByText('Renamed by an agent')).toBeInTheDocument();
  });

  it('creates one: pick an agent (its only thread fills in), then what and when, then opens it', async () => {
    people.agents.mockResolvedValue([
      { id: 'test-agent-b', name: 'Test Agent B' },
      { id: 'test-agent-a', name: 'Test Agent A' },
    ]);
    people.threads.mockResolvedValue([{ id: TEST_THREAD_ID, title: 'Test thread' }]);
    people.thread.mockResolvedValue({ id: TEST_THREAD_ID, title: 'Test thread' });
    people.participants.mockResolvedValue([{ kind: 'agent', agentId: 'test-agent-a' }]);
    const created = automationRecord({ id: 'automation-2222222222222-bbbbbbbbb', name: 'Standup' });
    api.create.mockResolvedValue({ automation: created });
    const onReplaceSelection = vi.fn();
    renderWithNav(<AutomationPane create onReplaceSelection={onReplaceSelection} />);
    const user = userEvent.setup();

    const form = screen.getByRole('form', { name: 'New automation' });
    const create = within(form).getByRole('button', { name: 'Create automation' });
    expect(create).toBeDisabled();

    await user.click(within(form).getByRole('textbox', { name: 'Agent' }));
    await user.keyboard('Test Agent A');
    fireEvent.mouseDown(await screen.findByRole('option', { name: /Test Agent A/ }));
    await waitFor(() => expect(people.threads).toHaveBeenCalledWith('test-agent-a'));
    const thread = within(form).getByRole('textbox', { name: 'Thread' });
    await waitFor(() =>
      expect(thread.querySelector('[data-node-kind="thread"]')).toHaveTextContent('Test thread')
    );
    fireEvent.change(within(form).getByLabelText('Name'), { target: { value: 'Standup' } });
    await user.click(within(form).getByRole('textbox', { name: 'Prompt' }));
    await user.keyboard('Post the standup notes.');
    fireEvent.click(within(form).getByRole('radio', { name: 'Every' }));
    fireEvent.change(within(form).getByLabelText('How many'), { target: { value: '30' } });
    fireEvent.change(within(form).getByLabelText('Unit'), { target: { value: 'm' } });
    await waitFor(() => expect(create).not.toBeDisabled());
    fireEvent.click(create);

    await waitFor(() =>
      expect(api.create).toHaveBeenCalledWith({
        name: 'Standup',
        prompt: 'Post the standup notes.',
        when: { every: '30m', tz: expect.any(String) },
        agentId: 'test-agent-a',
        threadId: TEST_THREAD_ID,
        calendarId: DEFAULT_CALENDAR_ID,
      })
    );
    expect(onReplaceSelection).toHaveBeenCalledWith({
      kind: 'automation-detail',
      automation_id: created.id,
      name: 'Standup',
    });
    expect(toast.show).toHaveBeenCalledWith('Created Standup');
  });
  describe('Runs', () => {
    const runLog = () => screen.findByRole('region', { name: 'Run log' });

    it('lists every run newest first: when, how it went, Run now, and the failure text', async () => {
      api.runs.mockResolvedValue({
        runs: [
          run({
            id: 'schedule_run-4',
            status: 'running',
            scheduledFor: '2026-10-14T09:00:00.000Z',
            finishedAt: null,
          }),
          run({ id: 'schedule_run-3', scheduledFor: '2026-10-13T15:00:00.000Z', manual: true }),
          run({
            id: 'schedule_run-2',
            status: 'failed',
            scheduledFor: '2026-10-13T09:00:00.000Z',
            error: 'Provider exploded\nat step 2',
          }),
          run({
            id: 'schedule_run-1',
            status: 'skipped',
            scheduledFor: '2026-10-12T09:00:00.000Z',
            error: 'Missed while Snaglet was off',
          }),
        ],
        nextCursor: null,
      });
      renderWithNav(<AutomationPane automationId={ID} />);

      const log = await runLog();
      expect(api.runs).toHaveBeenCalledWith(ID, { limit: 50 });
      const rows = within(log).getAllByRole('listitem');
      expect(rows.map((row) => row.querySelector('time')?.getAttribute('datetime'))).toEqual([
        '2026-10-14T09:00:00.000Z',
        '2026-10-13T15:00:00.000Z',
        '2026-10-13T09:00:00.000Z',
        '2026-10-12T09:00:00.000Z',
      ]);
      expect(rows[0]).toHaveTextContent(/Oct.*Running/);
      expect(rows[1]).toHaveTextContent(/RanRun now/);
      expect(rows[2]).toHaveTextContent('Failed');
      expect(within(rows[2]!).getByText(/Provider exploded/).textContent).toBe(
        'Provider exploded\nat step 2'
      );
      expect(within(rows[2]!).getByRole('button', { name: 'Copy error' })).toBeInTheDocument();
      expect(rows[3]).toHaveTextContent('SkippedMissed while Snaglet was off');
      expect(within(log).queryByRole('button', { name: 'Load older runs' })).toBeNull();
    });

    it('says "No runs yet" when there are none', async () => {
      renderWithNav(<AutomationPane automationId={ID} />);
      const section = screen.getByRole('region', { name: 'Runs' });
      expect(await within(section).findByText('No runs yet')).toBeInTheDocument();
    });

    it('loads older runs when scrolled near the end of its box', async () => {
      api.runs
        .mockResolvedValueOnce({ runs: [run({ id: 'schedule_run-2' })], nextCursor: 'cursor-1' })
        .mockResolvedValueOnce({
          runs: [run({ id: 'schedule_run-1', status: 'failed', error: 'Older failure' })],
          nextCursor: null,
        });
      renderWithNav(<AutomationPane automationId={ID} />);
      const log = await runLog();
      Object.defineProperty(log, 'scrollHeight', { configurable: true, value: 1000 });
      Object.defineProperty(log, 'clientHeight', { configurable: true, value: 320 });

      log.scrollTop = 100;
      fireEvent.scroll(log);
      expect(api.runs).toHaveBeenCalledTimes(1);

      log.scrollTop = 650;
      fireEvent.scroll(log);
      expect(await within(log).findByText('Older failure')).toBeInTheDocument();
      expect(api.runs).toHaveBeenLastCalledWith(ID, { limit: 50, before: 'cursor-1' });
      expect(within(log).getAllByRole('listitem')).toHaveLength(2);
      expect(within(log).queryByRole('button', { name: 'Load older runs' })).toBeNull();
    });

    it('re-reads when the automation changes, so a new run shows and loaded ones stay', async () => {
      api.runs
        .mockResolvedValueOnce({ runs: [run({ id: 'schedule_run-2' })], nextCursor: 'cursor-1' })
        .mockResolvedValueOnce({ runs: [run({ id: 'schedule_run-1' })], nextCursor: null });
      renderWithNav(<AutomationPane automationId={ID} />);
      const log = await runLog();
      fireEvent.click(within(log).getByRole('button', { name: 'Load older runs' }));
      await waitFor(() => expect(within(log).getAllByRole('listitem')).toHaveLength(2));

      api.runs.mockResolvedValueOnce({
        runs: [
          run({ id: 'schedule_run-3', status: 'failed', error: 'Fresh failure' }),
          run({ id: 'schedule_run-2' }),
        ],
        nextCursor: 'cursor-2',
      });
      act(() =>
        upsertAutomation({
          ...base,
          lastRun: {
            status: 'failed',
            scheduledFor: '2026-10-14T09:00:00.000Z',
            finishedAt: '2026-10-14T09:00:05.000Z',
            error: 'Fresh failure',
          },
        })
      );
      expect(await within(log).findByText('Fresh failure')).toBeInTheDocument();
      expect(api.runs).toHaveBeenCalledTimes(3);
      expect(within(log).getAllByRole('listitem')).toHaveLength(3);
      // The older page loaded before stays, so there is nothing more to load.
      expect(within(log).queryByRole('button', { name: 'Load older runs' })).toBeNull();
    });

    it('keeps showing the runs of a deleted automation', async () => {
      act(() => upsertAutomation({ ...base, status: 'cancelled', nextRunAt: null }));
      api.runs.mockResolvedValue({ runs: [run({ id: 'schedule_run-1' })], nextCursor: null });
      renderWithNav(<AutomationPane automationId={ID} />);
      expect(screen.getByRole('button', { name: 'Restore' })).toBeInTheDocument();
      expect(within(await runLog()).getAllByRole('listitem')).toHaveLength(1);
    });
  });
});
