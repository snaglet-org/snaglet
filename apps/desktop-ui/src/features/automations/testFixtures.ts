import type { AutomationRecord, Calendar } from '@snaglet/shared/types';

export const TEST_THREAD_ID = 'thread-1111111111111-aaaaaaaaa';

/** A neutral automation for tests: active, every weekday at 9:00 AM, in "Test thread". */
export function automationRecord(over: Partial<AutomationRecord> = {}): AutomationRecord {
  return {
    id: 'automation-1111111111111-aaaaaaaaa',
    name: 'Morning check',
    prompt: 'Look at the build.',
    status: 'active',
    when: {
      kind: 'repeat',
      rrule: 'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR',
      timeOfDay: '09:00',
      startsOn: '2026-10-13',
      tz: 'UTC',
    },
    whenText: 'every weekday at 9:00 AM',
    calendarId: null,
    threadId: TEST_THREAD_ID,
    agentId: 'test-agent-a',
    scheduleId: 'schedule-1111111111111-aaaaaaaaa',
    createdByAgentId: 'test-agent-a',
    createdByMemberId: null,
    consecutiveFailures: 0,
    pausedReason: null,
    createdAt: '2026-10-13T16:00:00.000Z',
    updatedAt: '2026-10-13T16:00:00.000Z',
    nextRunAt: '2026-10-14T09:00:00.000Z',
    lastRun: null,
    agentName: 'Test Agent A',
    threadTitle: 'Test thread',
    calendarTitle: null,
    running: false,
    runningSince: null,
    unattendedPolicy: 'skip',
    ...over,
  };
}

export const DEFAULT_CALENDAR_ID = 'calendar-1111111111111-aaaaaaaaa';
export const WORK_CALENDAR_ID = 'calendar-2222222222222-bbbbbbbbb';

/** A neutral calendar for tests: active, not the Default one, blue. */
export function calendarRecord(over: Partial<Calendar> = {}): Calendar {
  return {
    id: WORK_CALENDAR_ID,
    title: 'Work',
    description: '',
    timeZone: 'UTC',
    color: 'blue',
    isDefault: false,
    sortOrder: 1,
    revision: 1,
    createdAt: '2026-10-13T16:00:00.000Z',
    updatedAt: '2026-10-13T16:00:00.000Z',
    boundFields: [],
    ...over,
  };
}

/** The Default calendar and Work, as the calendar store lists them. */
export const testCalendars = (): Calendar[] => [
  calendarRecord({
    id: DEFAULT_CALENDAR_ID,
    title: 'Default calendar',
    color: null,
    isDefault: true,
    sortOrder: 0,
  }),
  calendarRecord(),
];

/**
 * jsdom has no layout: the stubs a ProseMirror editor (the prompt field and
 * the chip pickers) needs to mount and take input. Call from `beforeAll`.
 */
export function stubEditorLayout(): void {
  if (!document.elementFromPoint) document.elementFromPoint = () => null;
  if (!Range.prototype.getClientRects)
    Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
  if (!Range.prototype.getBoundingClientRect)
    Range.prototype.getBoundingClientRect = () => new DOMRect();
}
