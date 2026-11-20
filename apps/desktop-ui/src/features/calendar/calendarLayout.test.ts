import { describe, expect, it } from 'vitest';
import type { CalendarIntervalSpan, CalendarOccurrence } from '@snaglet/shared/types';
import {
  allDayLanes,
  intervalLane,
  intervalRunsOnDay,
  intervalStart,
  intervalsByDay,
  openingScrollMinutes,
  packTimed,
  placeOccurrences,
  type TimedSegment,
} from './calendarLayout';

const TZ = 'America/Los_Angeles';

function ev(key: string, time: CalendarOccurrence['time']): CalendarOccurrence {
  return {
    source: 'event',
    key,
    eventId: key,
    revision: 1,
    calendarId: 'c',
    title: key,
    time,
    status: 'upcoming',
    canMove: true,
    canResize: true,
  };
}

const seg = (key: string, start: number, end: number): TimedSegment => ({
  key,
  day: '2026-10-12',
  start,
  end,
  occurrence: ev(key, { kind: 'timed', start: '', end: '' }),
  continuesBefore: false,
  continuesAfter: false,
});

describe('placeOccurrences', () => {
  it('a day whose midnight is skipped (DST at 00:00) starts at its first hour', () => {
    // Santiago jumps from midnight to 1:00 AM on 2026-09-06.
    const late = ev('late', {
      kind: 'timed',
      start: '2026-09-06T03:30:00.000Z', // Sat Sep 5, 11:30 PM (-04)
      end: '2026-09-06T03:45:00.000Z',
    });
    const placed = placeOccurrences([late], ['2026-09-05', '2026-09-06'], 'America/Santiago');
    expect(placed.timed.map((s) => [s.day, s.start, s.end])).toEqual([['2026-09-05', 1410, 1425]]);
  });

  it('puts timed items on their wall-clock day in the viewer zone', () => {
    const placed = placeOccurrences(
      [
        ev('a', {
          kind: 'timed',
          start: '2026-10-12T16:00:00.000Z',
          end: '2026-10-12T16:30:00.000Z',
        }),
      ],
      ['2026-10-12', '2026-10-13'],
      TZ
    );
    expect(placed.timed).toHaveLength(1);
    expect(placed.timed[0]).toMatchObject({ day: '2026-10-12', start: 540, end: 570 });
  });

  it('splits a timed item that crosses midnight into per-day segments', () => {
    const placed = placeOccurrences(
      [
        ev('late', {
          kind: 'timed',
          start: '2026-10-13T06:00:00.000Z',
          end: '2026-10-13T08:00:00.000Z',
        }),
      ],
      ['2026-10-12', '2026-10-13'],
      TZ
    );
    expect(placed.timed.map((s) => [s.day, s.start, s.end])).toEqual([
      ['2026-10-12', 1380, 1440],
      ['2026-10-13', 0, 60],
    ]);
    expect(placed.timed[0]!.continuesAfter).toBe(true);
    expect(placed.timed[1]!.continuesBefore).toBe(true);
  });

  it('keeps all-day items as dates, clipped to the range', () => {
    const placed = placeOccurrences(
      [ev('trip', { kind: 'all_day', startDate: '2026-10-10', endDate: '2026-10-14' })],
      ['2026-10-12', '2026-10-13', '2026-10-14'],
      TZ
    );
    // endDate is exclusive: the trip's last day is Oct 13 (index 1).
    expect(placed.allDay[0]).toMatchObject({
      startIndex: 0,
      endIndex: 1,
      continuesBefore: true,
      continuesAfter: false,
    });
  });

  it('drops items outside the range', () => {
    const placed = placeOccurrences(
      [ev('x', { kind: 'all_day', startDate: '2026-10-01', endDate: '2026-10-02' })],
      ['2026-10-12'],
      TZ
    );
    expect(placed.allDay).toHaveLength(0);
  });
});

describe('packTimed (Google-style columns)', () => {
  it('a lone item takes the full width', () => {
    expect(packTimed([seg('a', 540, 600)])[0]).toMatchObject({ left: 0, width: 1 });
  });

  it('items starting together split the width', () => {
    const out = packTimed([seg('a', 540, 600), seg('b', 545, 630)]);
    const widths = out.filter((o) => !o.hidden).map((o) => o.width);
    expect(widths).toEqual([0.5, 0.5]);
  });

  it('an item starting >= 30 min later is offset 12 %, not split', () => {
    const out = packTimed([seg('long', 540, 720), seg('later', 600, 660)]);
    const later = out.find((o) => o.key === 'later')!;
    expect(later.left).toBeCloseTo(0.12);
    expect(later.width).toBeCloseTo(0.88);
    expect(out.find((o) => o.key === 'long')!.width).toBe(1);
  });

  it('never narrower than 40 %: extra items hide behind a +N marker', () => {
    const out = packTimed([seg('a', 540, 600), seg('b', 540, 600), seg('c', 540, 600)]);
    const shown = out.filter((o) => !o.hidden);
    expect(shown).toHaveLength(2);
    expect(shown.every((o) => o.width >= 0.4)).toBe(true);
    expect(out.find((o) => o.hidden)).toBeDefined();
    expect(shown[shown.length - 1]!.moreCount).toBe(1);
    // The marker knows which items it hides, so "+N" can list them.
    expect(shown[shown.length - 1]!.more.map((s) => s.key)).toEqual([
      out.find((o) => o.hidden)!.key,
    ]);
  });
});

describe('allDayLanes', () => {
  it('stacks overlapping spans in lanes, reusing free lanes', () => {
    const lanes = allDayLanes([
      { key: 'a', startIndex: 0, endIndex: 2 },
      { key: 'b', startIndex: 1, endIndex: 1 },
      { key: 'c', startIndex: 3, endIndex: 4 },
    ]);
    expect(lanes.get('a')).toBe(0);
    expect(lanes.get('b')).toBe(1);
    expect(lanes.get('c')).toBe(0);
  });
});

describe('openingScrollMinutes', () => {
  it('is 8 AM with no timed item and today not shown', () => {
    expect(openingScrollMinutes([], null)).toBe(8 * 60);
  });
  it('is 1 h before the first timed item', () => {
    expect(
      openingScrollMinutes([seg('a', 10 * 60, 11 * 60), seg('b', 6 * 60 + 30, 7 * 60)], null)
    ).toBe(5 * 60 + 30);
  });
  it('is 1 h before now when now is earlier than every item', () => {
    expect(openingScrollMinutes([seg('a', 15 * 60, 16 * 60)], 9 * 60)).toBe(8 * 60);
  });
  it('takes the earlier of the first item and now', () => {
    expect(openingScrollMinutes([seg('a', 7 * 60, 8 * 60)], 14 * 60)).toBe(6 * 60);
  });
  it('clamps at midnight', () => {
    expect(openingScrollMinutes([seg('a', 20, 80)], null)).toBe(0);
    expect(openingScrollMinutes([], 30)).toBe(0);
  });
});

describe('Every automations’ lane', () => {
  const span = (id: string, day: string, startsAt: string): CalendarIntervalSpan => ({
    key: `automation:${id}:span:${day}`,
    source: 'automation',
    kind: 'interval',
    automationId: id,
    calendarId: 'c',
    name: id,
    day,
    everyMs: 900_000,
    startsAt,
    nextRunAt: null,
    agentId: 'test-agent-a',
    agentName: 'Test Agent A',
    threadId: 'thread-1',
  });

  it('groups spans by day, oldest start first, then by id', () => {
    const byDay = intervalsByDay([
      span('b', '2026-10-14', '2026-10-14T16:00:00.000Z'),
      span('c', '2026-10-14', '2026-10-01T00:00:00.000Z'),
      span('a', '2026-10-14', '2026-10-14T16:00:00.000Z'),
      span('c', '2026-10-15', '2026-10-01T00:00:00.000Z'),
    ]);
    expect(byDay.get('2026-10-14')!.map((s) => s.automationId)).toEqual(['c', 'a', 'b']);
    expect(byDay.get('2026-10-15')!.map((s) => s.automationId)).toEqual(['c']);
  });

  it('is 8 px a line, narrowing past four so the lane stays small, and nothing with none', () => {
    expect(intervalLane(0)).toEqual({ step: 0, width: 0 });
    expect(intervalLane(1)).toEqual({ step: 8, width: 10 });
    expect(intervalLane(4)).toEqual({ step: 8, width: 34 });
    expect(intervalLane(8)).toEqual({ step: 4, width: 34 });
    expect(intervalLane(20).step).toBe(4);
  });

  it('starts at its start time on the day it started, else at midnight', () => {
    const s = span('a', '2026-10-14', '2026-10-14T16:30:00.000Z');
    expect(intervalStart(s, TZ)).toEqual({ minutes: 9 * 60 + 30, startsHere: true });
    expect(intervalStart({ ...s, day: '2026-10-15' }, TZ)).toEqual({
      minutes: 0,
      startsHere: false,
    });
  });

  it('lists a day’s runs between two times only, from the start on its first day', () => {
    // Every 15 minutes from 9:30 AM (Los Angeles) on the 14th.
    const s = { ...span('a', '2026-10-14', '2026-10-14T16:30:00.000Z'), everyMs: 15 * 60_000 };
    const first = intervalRunsOnDay(s, TZ, 9 * 60, 10 * 60 + 15);
    expect(first.map((r) => r.minutes)).toEqual([570, 585, 600]);
    expect(first[0]!.iso).toBe('2026-10-14T16:30:00.000Z');
    // The next day, a window of the afternoon: never the whole day.
    const later = intervalRunsOnDay({ ...s, day: '2026-10-15' }, TZ, 13 * 60, 14 * 60);
    expect(later.map((r) => r.minutes)).toEqual([780, 795, 810, 825]);
    expect(intervalRunsOnDay(s, TZ, 600, 600)).toEqual([]);
  });

  it('keeps wall times across a DST change', () => {
    // Every hour from midnight on Nov 1, 2026 (clocks go back at 2 AM).
    const s = {
      ...span('a', '2026-11-01', '2026-11-01T07:00:00.000Z'),
      everyMs: 60 * 60_000,
    };
    const runs = intervalRunsOnDay(s, TZ, 0, 4 * 60);
    // 12, 1, 1 (again), 2, 3 AM: wall minutes, not elapsed ones.
    expect(runs.map((r) => r.minutes)).toEqual([0, 60, 60, 120, 180]);
  });

  it('puts a windowed one’s runs inside its daily window only', () => {
    // Every 5 minutes from 05:05 to 06:00 Los Angeles time, started long before.
    const s = {
      ...span('a', '2026-10-14', '2026-10-01T07:03:00.000Z'),
      everyMs: 5 * 60_000,
      window: { start: '05:05', end: '06:00', tz: TZ },
    };
    const runs = intervalRunsOnDay(s, TZ, 4 * 60, 7 * 60);
    expect(runs.map((r) => r.minutes)).toEqual([
      305, 310, 315, 320, 325, 330, 335, 340, 345, 350, 355, 360,
    ]);
    expect(runs[0]!.iso).toBe('2026-10-14T12:05:00.000Z');
    expect(intervalRunsOnDay(s, TZ, 7 * 60, 23 * 60)).toEqual([]);
  });
});
