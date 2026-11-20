import { describe, expect, it } from 'vitest';
import type { ReminderDue } from '@snaglet/shared/types';
import {
  formatOffset,
  isReminderDueFrame,
  isRemindersChangedFrame,
  parseReminderDue,
  reminderLead,
} from './reminderText';

const NOW = Date.parse('2026-10-15T09:00:00.000Z');
const at = (minutes: number) => new Date(NOW + minutes * 60_000).toISOString();

function due(over: Partial<ReminderDue> = {}): ReminderDue {
  return {
    key: 'k',
    item: { kind: 'event', eventId: 'event-1111111111111-aaaaaaaaa' },
    title: 'Standup',
    calendarName: 'Work',
    startsAt: at(15),
    fireAt: at(0),
    offset: { amount: 15, unit: 'minutes' },
    sound: 'chime',
    ...over,
  };
}

describe('reminder text', () => {
  it('formats offsets, singular for one', () => {
    expect(formatOffset({ amount: 15, unit: 'minutes' })).toBe('15 minutes');
    expect(formatOffset({ amount: 1, unit: 'hours' })).toBe('1 hour');
    expect(formatOffset({ amount: 1, unit: 'days' })).toBe('1 day');
  });

  it('leads with the offset when on time, else the real time left', () => {
    expect(reminderLead(due(), NOW)).toBe('Starts in 15 minutes');
    expect(
      reminderLead(due({ offset: { amount: 1, unit: 'days' }, startsAt: at(1440) }), NOW)
    ).toBe('Starts in 1 day');
    // Delivered late (after sleep): 5 minutes left, not 15.
    expect(reminderLead(due({ startsAt: at(5), fireAt: at(-10) }), NOW)).toBe(
      'Starts in 5 minutes'
    );
    expect(reminderLead(due({ startsAt: at(120), fireAt: at(-60) }), NOW)).toBe(
      'Starts in 2 hours'
    );
  });

  it('says Starting now at the start, and how long ago when late', () => {
    expect(reminderLead(due({ offset: null, startsAt: at(0), fireAt: at(0) }), NOW)).toBe(
      'Starting now'
    );
    expect(reminderLead(due({ offset: null, startsAt: at(-20), fireAt: at(-20) }), NOW)).toBe(
      'Started 20 minutes ago'
    );
  });

  it('parses a due frame, bare or wrapped, and rejects junk', () => {
    const d = due();
    expect(parseReminderDue(d)).toEqual(d);
    expect(parseReminderDue({ reminder: d })).toEqual(d);
    expect(parseReminderDue({ ...d, item: { kind: 'event' } })).toBeNull();
    expect(parseReminderDue({ ...d, offset: { amount: 0, unit: 'minutes' } })).toBeNull();
    expect(parseReminderDue({ ...d, key: 3 })).toBeNull();
    expect(parseReminderDue(null)).toBeNull();
    // Unknown sound: the default; blank title: Untitled.
    expect(parseReminderDue({ ...d, sound: 'gong', title: ' ' })).toMatchObject({
      sound: 'chime',
      title: 'Untitled',
    });
  });

  it('knows both frame spellings', () => {
    expect(isReminderDueFrame('reminder:due')).toBe(true);
    expect(isReminderDueFrame('reminder.due')).toBe(true);
    expect(isReminderDueFrame('reminders:changed')).toBe(false);
    expect(isRemindersChangedFrame('reminders:changed')).toBe(true);
    expect(isRemindersChangedFrame('reminders.changed')).toBe(true);
  });
});
