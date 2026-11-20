/**
 * The announcements after a thread delete commits: the scheduler is
 * refreshed first, and a failing announcement is logged without stopping the
 * ones after it.
 */
import { beforeEach, describe, expect, it, jest } from '@jest/globals';

const calls: string[] = [];
const notifySchedulesChanged = jest.fn((ids: Iterable<string>) => {
  calls.push(`schedules:${[...ids].join(',')}`);
});
const clearThread = jest.fn((threadId: string) => calls.push(`queue:${threadId}`));
const emitNotificationDismissed = jest.fn((id: string) => calls.push(`dismissed:${id}`));
const emitAutomationsChanged = jest.fn((event: { automationId?: string }) =>
  calls.push(`automation:${event.automationId}`)
);
const emitCalendarChanged = jest.fn((event: { automationId?: string }) =>
  calls.push(`calendar:${event.automationId}`)
);
const emitHookRunsChanged = jest.fn((names: Iterable<string>, reason: string) =>
  calls.push(`hooks:${[...names].join(',')}:${reason}`)
);

jest.mock('@server/services/ScheduleService', () => ({
  scheduleService: {
    notifySchedulesChanged: (ids: Iterable<string>) => notifySchedulesChanged(ids),
  },
}));
jest.mock('@server/services/PendingAgentMessageService', () => ({
  pendingAgentMessages: { clearThread: (threadId: string) => clearThread(threadId) },
}));
jest.mock('@server/realtime/surfaces/notifications', () => ({
  emitNotificationDismissed: (id: string) => emitNotificationDismissed(id),
}));
jest.mock('@server/realtime/surfaces/automations', () => ({
  emitAutomationsChanged: (event: { automationId?: string }) => emitAutomationsChanged(event),
}));
jest.mock('@server/realtime/surfaces/calendar', () => ({
  emitCalendarChanged: (event: { automationId?: string }) => emitCalendarChanged(event),
}));
jest.mock('@server/realtime/surfaces/hookRuns', () => ({
  emitHookRunsChanged: (names: Iterable<string>, reason: string) =>
    emitHookRunsChanged(names, reason),
}));

import { announceThreadResidueRemoved } from '@server/services/threadDeleteResidue';

const removed = {
  threadIds: ['thread-1111111111111-aaaaaaaaa'],
  dismissedNotificationIds: ['notif-1111111111111-aaaaaaaaa', 'notif-2222222222222-bbbbbbbbb'],
  scheduleIds: ['schedule-1111111111111-aaaaaaaaa'],
  automations: [{ id: 'automation-1111111111111-aaaaaaaaa', calendarId: null }],
  hookNames: ['test-hook'],
};

beforeEach(() => {
  calls.length = 0;
  jest.clearAllMocks();
});

describe('announceThreadResidueRemoved', () => {
  it('refreshes the scheduler first, then drops queued messages and tells open views', async () => {
    await announceThreadResidueRemoved(removed);

    expect(calls).toEqual([
      'schedules:schedule-1111111111111-aaaaaaaaa',
      'queue:thread-1111111111111-aaaaaaaaa',
      'dismissed:notif-1111111111111-aaaaaaaaa',
      'dismissed:notif-2222222222222-bbbbbbbbb',
      'automation:automation-1111111111111-aaaaaaaaa',
      'calendar:automation-1111111111111-aaaaaaaaa',
      'hooks:test-hook:thread-delete',
    ]);
  });

  it('keeps going when one announcement throws', async () => {
    emitNotificationDismissed.mockImplementationOnce(() => {
      throw new Error('broadcast failed');
    });
    notifySchedulesChanged.mockImplementationOnce(() => {
      throw new Error('scheduler failed');
    });

    await expect(announceThreadResidueRemoved(removed)).resolves.toBeUndefined();

    expect(calls).toEqual([
      'queue:thread-1111111111111-aaaaaaaaa',
      'dismissed:notif-2222222222222-bbbbbbbbb',
      'automation:automation-1111111111111-aaaaaaaaa',
      'calendar:automation-1111111111111-aaaaaaaaa',
      'hooks:test-hook:thread-delete',
    ]);
  });
});
