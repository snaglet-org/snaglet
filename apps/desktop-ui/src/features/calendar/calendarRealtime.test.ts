import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  __resetCalendarRealtimeForTests,
  createCoalescer,
  isOwnEcho,
  isOwnEchoOfAll,
  markOwnWrite,
  parseCalendarChanged,
  relevantTableChange,
} from './calendarRealtime';
import type { Calendar } from '@snaglet/shared/types';

const calendar = (tableIds: string[]): Calendar =>
  ({
    id: 'cal-1',
    boundFields: tableIds.map((tableId) => ({ tableId, fieldId: `f-${tableId}` })),
  }) as unknown as Calendar;

describe('calendar realtime', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    __resetCalendarRealtimeForTests();
  });
  afterEach(() => vi.useRealTimers());

  it('coalesces a burst into one trailing call ~250 ms after the last event', () => {
    const run = vi.fn();
    const c = createCoalescer(run, 250);
    c.trigger();
    vi.advanceTimersByTime(200);
    c.trigger();
    vi.advanceTimersByTime(200);
    c.trigger();
    expect(run).not.toHaveBeenCalled();
    vi.advanceTimersByTime(250);
    expect(run).toHaveBeenCalledTimes(1);
    c.cancel();
  });

  it('cancel drops a pending call', () => {
    const run = vi.fn();
    const c = createCoalescer(run, 250);
    c.trigger();
    c.cancel();
    vi.advanceTimersByTime(500);
    expect(run).not.toHaveBeenCalled();
  });

  it('only table changes on bound tables matter', () => {
    const cals = [calendar(['t1', 't2'])];
    expect(
      relevantTableChange({ type: 'table.entries.changed', tableId: 't1', entryId: 'e' }, cals)
    ).toBe(true);
    expect(
      relevantTableChange({ type: 'table.entries.changed', tableId: 'zz', entryId: 'e' }, cals)
    ).toBe(false);
    expect(relevantTableChange({ type: 'table.fields.changed', tableId: 'zz' }, cals)).toBe(true);
    expect(
      relevantTableChange({ type: 'table.removed', tableId: 't2', state: 'archived' }, cals)
    ).toBe(true);
    expect(relevantTableChange({ type: 'tables.invalidated' }, cals)).toBe(true);
    expect(relevantTableChange({ type: 'draft.discarded', draftId: 'd' }, cals)).toBe(false);
  });

  it('recognizes calendar:changed in either naming', () => {
    expect(
      parseCalendarChanged({ type: 'calendar:changed', payload: { kind: 'event', eventId: 'e1' } })
    ).toEqual({
      kind: 'event',
      eventId: 'e1',
    });
    expect(
      parseCalendarChanged({
        type: 'calendar.changed',
        payload: { type: 'calendar.changed', kind: 'calendar' },
      })
    ).toMatchObject({ kind: 'calendar' });
    expect(parseCalendarChanged({ type: 'table.entries.changed', payload: {} })).toBeNull();
    // Automation wakes.
    expect(
      parseCalendarChanged({
        type: 'calendar:changed',
        payload: { kind: 'automation', automationId: 'automation-1', calendarId: 'c1' },
      })
    ).toEqual({ kind: 'automation', automationId: 'automation-1', calendarId: 'c1' });
  });

  it('swallows the echo of our own write once, inside its window', () => {
    markOwnWrite('event:e1');
    expect(isOwnEcho('event:e1')).toBe(true);
    expect(isOwnEcho('event:e1')).toBe(false);
    markOwnWrite('entry:t1:e9');
    vi.advanceTimersByTime(5000);
    expect(isOwnEcho('entry:t1:e9')).toBe(false);
  });

  it('takes a batch as our echo only when every key is ours, keeping our marks otherwise', () => {
    markOwnWrite('entry:t1:a');
    expect(isOwnEchoOfAll(['entry:t1:a', 'entry:t1:b'])).toBe(false);
    // A's mark is still there for its own echo.
    markOwnWrite('entry:t1:b');
    expect(isOwnEchoOfAll(['entry:t1:a', 'entry:t1:b'])).toBe(true);
    expect(isOwnEchoOfAll(['entry:t1:a'])).toBe(false);
    expect(isOwnEchoOfAll([])).toBe(false);
  });
});
