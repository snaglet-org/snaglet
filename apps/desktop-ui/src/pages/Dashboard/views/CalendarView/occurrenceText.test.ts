import { describe, expect, it } from 'vitest';
import type {
  CalendarIntervalSpan,
  CalendarOccurrence,
  CalendarRowOccurrence,
} from '@snaglet/shared/types';
import {
  ariaLabelFor,
  intervalAriaLabel,
  intervalHover,
  intervalText,
  isOverdue,
  itemLabel,
} from './occurrenceText';

const ZONE = 'UTC';
const NOW = new Date('2026-10-14T12:00:00.000Z'); // Wed Oct 14

function row(
  repeat: Partial<NonNullable<CalendarRowOccurrence['repeat']>> | null,
  extra: Partial<CalendarRowOccurrence> = {}
): CalendarOccurrence {
  return {
    source: 'row',
    key: 'row:f1:e1:2026-10-12',
    calendarId: 'c',
    title: 'Gym',
    time: { kind: 'all_day', startDate: '2026-10-12', endDate: '2026-10-19' },
    status: 'upcoming',
    canMove: false,
    canResize: false,
    tableId: 't1',
    tableName: 'Habits',
    projectId: null,
    entryId: 'e1',
    fieldId: 'f1',
    range: false,
    hasEnd: false,
    entryRevision: 'r1',
    schemaVersion: 's1',
    ...(repeat
      ? {
          repeat: {
            occurrence: '2026-10-12',
            isCurrent: true,
            summary: '3 times a week',
            ...repeat,
          },
        }
      : {}),
    ...extra,
  };
}

describe('repeat occurrence words', () => {
  it('a plain set-day row shows just its title', () => {
    expect(itemLabel(row({ summary: 'Every week on Tuesday' }))).toBe('Gym');
    expect(itemLabel(row(null, { title: 'Pay rent' }))).toBe('Pay rent');
  });
});

describe('isOverdue', () => {
  it('takes the server’s word on a repeat occurrence', () => {
    // Its day is past, but the server says it is not overdue: trust that word.
    const notOverdue = row(
      { overdue: false, occurrence: '2026-10-12' },
      { time: { kind: 'all_day', startDate: '2026-10-12', endDate: '2026-10-13' } }
    );
    expect(isOverdue(notOverdue, NOW, ZONE)).toBe(false);
    const overdue = row(
      { overdue: true, occurrence: '2026-10-12' },
      { time: { kind: 'all_day', startDate: '2026-10-12', endDate: '2026-10-13' } }
    );
    expect(isOverdue(overdue, NOW, ZONE)).toBe(true);
    expect(ariaLabelFor(overdue, ZONE, NOW)).toMatch(/, overdue$/);
    expect(isOverdue(row({ overdue: true, isCurrent: false }), NOW, ZONE)).toBe(false);
  });

  it('falls back to the day having passed without the server’s word (older server)', () => {
    const old = row(
      { occurrence: '2026-10-12' },
      { time: { kind: 'all_day', startDate: '2026-10-12', endDate: '2026-10-13' } }
    );
    expect(isOverdue(old, NOW, ZONE)).toBe(true);
  });
});

describe('Every automation text', () => {
  const span: CalendarIntervalSpan = {
    key: 'automation:a:span:2026-10-14',
    source: 'automation',
    kind: 'interval',
    automationId: 'a',
    calendarId: 'c',
    name: 'Check inbox',
    day: '2026-10-14',
    everyMs: 900_000,
    startsAt: '2026-10-14T09:00:00.000Z',
    nextRunAt: null,
    agentId: 'test-agent-a',
    agentName: 'Test Agent A',
    threadId: 'thread-1',
  };

  it('says the interval in words, capitalized', () => {
    expect(intervalText(span)).toBe('Every 15 minutes');
    expect(intervalText({ everyMs: 3_600_000 })).toBe('Every hour');
    expect(intervalText({ everyMs: 2 * 86_400_000 })).toBe('Every 2 days');
  });

  it('names a daily window', () => {
    const windowed = {
      ...span,
      everyMs: 300_000,
      window: { start: '05:05', end: '06:00', tz: 'America/Los_Angeles' },
    };
    expect(intervalText(windowed)).toBe('Every 5 minutes from 05:05 to 06:00');
    expect(intervalHover(windowed)).toBe('Every 5 minutes from 05:05 to 06:00 · Check inbox');
  });

  it('names the line for hover and assistive tech', () => {
    expect(intervalHover(span)).toBe('Every 15 minutes · Check inbox');
    expect(intervalAriaLabel(span)).toBe('Every 15 minutes automation: Check inbox');
    expect(intervalAriaLabel({ ...span, name: '  ' })).toBe(
      'Every 15 minutes automation: Untitled'
    );
  });
});
