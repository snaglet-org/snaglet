import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AutomationRecord, CalendarAutomationOccurrence } from '@snaglet/shared/types';

const toast = vi.hoisted(() => ({ showToast: vi.fn(), dismissToast: vi.fn() }));
vi.mock('@desktop/utils/toast', () => toast);

const api = vi.hoisted(() => ({
  get: vi.fn(),
  pause: vi.fn(),
  resume: vi.fn(),
  runNow: vi.fn(),
}));
vi.mock('@desktop/utils/api/automations', () => ({ automationsApi: api }));

import { AutomationOccurrencePopover } from './AutomationOccurrencePopover';
import { OccurrenceItem } from '@desktop/pages/Dashboard/views/CalendarView/OccurrenceItem';

const ID = 'automation-1111111111111-aaaaaaaaa';

const occurrence: CalendarAutomationOccurrence = {
  key: `automation:${ID}:2026-10-14T09:00:00.000Z`,
  source: 'automation',
  calendarId: 'calendar-1111',
  title: 'Morning check',
  time: { kind: 'timed', start: '2026-10-14T09:00:00.000Z', end: '2026-10-14T09:15:00.000Z' },
  status: 'upcoming',
  canMove: false,
  canResize: false,
  automationId: ID,
  agentId: 'test-agent-a',
  agentName: 'Test Agent A',
  threadId: 'thread-1111111111111-aaaaaaaaa',
  automationStatus: 'active',
};

function record(over: Partial<AutomationRecord> = {}): AutomationRecord {
  return {
    id: ID,
    name: 'Morning check',
    prompt: 'Look at the build.',
    status: 'active',
    when: {
      kind: 'repeat',
      rrule: 'FREQ=DAILY',
      timeOfDay: '09:00',
      startsOn: '2026-10-13',
      tz: 'UTC',
    },
    whenText: 'every day at 09:00',
    calendarId: 'calendar-1111',
    threadId: occurrence.threadId,
    agentId: 'test-agent-a',
    scheduleId: 'schedule-1',
    createdByAgentId: 'test-agent-a',
    createdByMemberId: null,
    consecutiveFailures: 0,
    pausedReason: null,
    createdAt: '',
    updatedAt: '',
    nextRunAt: '2026-10-14T09:00:00.000Z',
    lastRun: null,
    agentName: 'Test Agent A',
    threadTitle: 'Test thread',
    calendarTitle: 'Default calendar',
    running: false,
    runningSince: null,
    unattendedPolicy: 'skip',
    ...over,
  };
}

function renderPopover() {
  const anchor = document.createElement('button');
  document.body.appendChild(anchor);
  const props = {
    offerUndo: vi.fn(),
    onEdit: vi.fn(),
    onOpenThread: vi.fn(),
    onChanged: vi.fn(),
    onClose: vi.fn(),
  };
  render(<AutomationOccurrencePopover anchor={anchor} occurrence={occurrence} {...props} />);
  return props;
}

describe('AutomationOccurrencePopover', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    api.get.mockResolvedValue({ automation: record() });
  });

  it('shows the agent, timing in words and thread, and pauses with Undo, then closes', async () => {
    api.pause.mockResolvedValue({ automation: record({ status: 'paused', pausedReason: 'user' }) });
    api.resume.mockResolvedValue({ automation: record() });
    const props = renderPopover();
    expect(await screen.findByText('every day at 09:00')).toBeTruthy();
    expect(screen.getByText(/Wakes Test Agent A/)).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Pause' }));
    await waitFor(() => expect(api.pause).toHaveBeenCalledWith(ID));
    expect(props.offerUndo).toHaveBeenCalledWith('Paused Morning check', expect.any(Function));
    expect(props.onChanged).toHaveBeenCalled();
    // A paused automation is not on the calendar, so the popover closes.
    await waitFor(() => expect(props.onClose).toHaveBeenCalled());
    // The Undo resumes.
    await (props.offerUndo.mock.calls[0]![1] as () => Promise<void>)();
    expect(api.resume).toHaveBeenCalledWith(ID);
  });

  it('says a first-open one runs when Snaglet first opens, with no countdown and no reminders', async () => {
    api.get.mockResolvedValue({
      automation: record({
        when: { kind: 'first_open', after: '05:00', tz: 'UTC' },
        whenText: 'when Snaglet first opens, after 05:00',
        nextRunAt: '2099-01-15T12:00:00.000Z',
      }),
    });
    renderPopover();
    expect(await screen.findByText('when Snaglet first opens, after 05:00')).toBeTruthy();
    expect(screen.getByText(/^When Snaglet first opens, from \w{3}, Jan 15, /)).toBeTruthy();
    expect(screen.queryByRole('timer')).toBeNull();
    expect(document.querySelector('[data-reminder-settings]')).toBeNull();
  });

  it('runs now, opens the thread and opens the Edit form', async () => {
    api.runNow.mockResolvedValue({
      automation: record(),
      run: { status: 'skipped', error: 'Previous run is still going' },
    });
    const props = renderPopover();
    fireEvent.click(await screen.findByRole('button', { name: 'Run now' }));
    await waitFor(() =>
      expect(toast.showToast).toHaveBeenCalledWith('Not run: Previous run is still going')
    );

    fireEvent.click(screen.getByRole('button', { name: /In Test thread/ }));
    expect(props.onOpenThread).toHaveBeenCalledWith(occurrence.threadId, 'Test thread');
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    expect(props.onEdit).toHaveBeenCalledWith(expect.objectContaining({ id: ID }));
  });
});

describe('OccurrenceItem for an automation wake', () => {
  it('draws the clock glyph, never offers drag or resize handles, and opens on click', () => {
    const onOpen = vi.fn();
    const onDragStart = vi.fn();
    render(
      <OccurrenceItem
        occurrence={occurrence}
        color="blue"
        variant="block"
        ariaLabel="Morning check"
        hover="Morning check"
        resize="both"
        onOpen={onOpen}
        onDragStart={onDragStart}
      />
    );
    const item = screen.getByRole('button', { name: 'Morning check' });
    expect(item.hasAttribute('data-automation')).toBe(true);
    expect(item.querySelector('[data-automation-glyph]')?.textContent).toContain('◷');
    expect(item.querySelector('[data-cal-resize]')).toBeNull();
    fireEvent.pointerDown(item, { button: 0 });
    expect(onDragStart).not.toHaveBeenCalled();
    fireEvent.click(item);
    expect(onOpen).toHaveBeenCalledWith(occurrence, item, false);
  });
});
