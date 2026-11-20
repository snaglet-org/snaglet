/**
 * automationRunsBetween (the planned runs reminders count): an Every
 * automation with a daily window runs only inside it, from the
 * window's start each day; one without a window keeps its anchor lattice.
 */
import { describe, expect, it, jest } from '@jest/globals';

jest.mock('@snaglet/db/db', () => ({
  getDb: () => ({ query: jest.fn() }),
  transaction: jest.fn(),
}));

import type { AutomationListRow } from '@snaglet/db/tables/automations';
import { automationRunsBetween } from '@server/domains/calendar/automationOccurrences';

function row(over: Partial<AutomationListRow> = {}): AutomationListRow {
  return {
    id: 'automation-1111111111111-aaaaaaaaa',
    name: 'Stall watch',
    prompt: 'Check for stalls.',
    status: 'active',
    whenKind: 'interval',
    at: null,
    rrule: null,
    timeOfDay: null,
    startsOn: null,
    everyMs: 300_000,
    windowStart: '05:05',
    windowEnd: '06:00',
    tz: 'UTC',
    calendarId: null,
    threadId: 'thread-1111111111111-aaaaaaaaa',
    agentId: 'test-agent-a',
    scheduleId: null,
    createdByAgentId: null,
    createdByMemberId: null,
    consecutiveFailures: 0,
    pausedReason: null,
    createdRunId: null,
    createdAt: '2026-10-01T00:00:00.000Z',
    updatedAt: '2026-10-01T00:00:00.000Z',
    agentName: 'Test Agent A',
    threadTitle: 'Test thread',
    calendarTitle: null,
    nextRunAt: null,
    anchor: null,
    lastRun: null,
    ...over,
  };
}

const iso = (ms: number[]) => ms.map((at) => new Date(at).toISOString());

describe('automationRunsBetween', () => {
  it('lists a windowed interval’s runs inside its window only, day after day', () => {
    const runs = automationRunsBetween(
      row(),
      Date.parse('2026-10-01T00:02:00.000Z'),
      new Date('2026-10-14T05:50:00.000Z'),
      new Date('2026-10-15T05:12:00.000Z'),
      50
    );
    expect(iso(runs)).toEqual([
      '2026-10-14T05:50:00.000Z',
      '2026-10-14T05:55:00.000Z',
      '2026-10-14T06:00:00.000Z',
      '2026-10-15T05:05:00.000Z',
      '2026-10-15T05:10:00.000Z',
    ]);
  });

  it('keeps an interval without a window on its anchor, all day', () => {
    const runs = automationRunsBetween(
      row({ windowStart: null, windowEnd: null }),
      Date.parse('2026-10-01T00:02:00.000Z'),
      new Date('2026-10-14T05:50:00.000Z'),
      new Date('2026-10-14T06:10:00.000Z'),
      50
    );
    expect(iso(runs)).toEqual([
      '2026-10-14T05:52:00.000Z',
      '2026-10-14T05:57:00.000Z',
      '2026-10-14T06:02:00.000Z',
      '2026-10-14T06:07:00.000Z',
    ]);
  });
});
