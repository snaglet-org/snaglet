import { describe, expect, it } from 'vitest';
import {
  repeatDraftFor,
  repeatDraftSummary,
  repeatEveryOf,
  repeatInputFromDraft,
  type RepeatDraft,
} from '@snaglet/shared/utils';
import {
  choiceOf,
  customStart,
  customUnitOf,
  customUnitWord,
  customUnits,
  repeatChoices,
  withCustomUnit,
} from './repeatChoices';

// Fri Oct 9, 2026.
const ANCHOR = '2026-10-09';
const TIMED = '2026-10-09T09:00:00';
const draft = (patch: Partial<RepeatDraft> = {}, anchor = ANCHOR): RepeatDraft => ({
  ...repeatDraftFor(anchor),
  ...patch,
});
const rule = (s: RepeatDraft) => {
  const input = repeatInputFromDraft(s);
  if (!input.ok) throw new Error(input.error);
  return input.value.rrule;
};

describe('quick choices', () => {
  it('fill in from the cell’s date, and each reads as itself', () => {
    const choices = repeatChoices(ANCHOR);
    expect(choices.map((choice) => choice.label)).toEqual([
      'Every day',
      'Every week on Friday',
      'Every month on the 9th',
      'Every year on Oct 9',
    ]);
    for (const choice of choices) {
      const made = choice.make(draft({ interval: 3 }));
      expect(repeatDraftSummary(made)).toBe(choice.label);
      expect(choiceOf(made)).toBe(choice.id);
    }
    expect(choices.map((choice) => rule(choice.make(draft())))).toEqual([
      'FREQ=DAILY',
      'FREQ=WEEKLY;BYDAY=FR',
      'FREQ=MONTHLY',
      'FREQ=YEARLY',
    ]);
  });

  it('anything else is Custom', () => {
    expect(choiceOf(draft({ weekdays: ['MO', 'FR'] }))).toBe('custom');
    expect(choiceOf(draft({ interval: 2 }))).toBe('custom');
    expect(choiceOf(draft({ unit: 'month', monthOn: 'weekday', nth: 2, nthDay: 'FR' }))).toBe(
      'custom'
    );
  });
});

describe('Custom: "Repeat every [N] [unit]", or an Interval', () => {
  it('offers Interval only with a time (or a saved interval), and Year only for a saved yearly repeat', () => {
    const plain = draft();
    const yearly = draft({ unit: 'year', interval: 2 });
    const interval = draft({ mode: 'interval' }, TIMED);
    expect(customUnits({ timed: false, saved: plain })).toEqual(['day', 'week', 'month']);
    expect(customUnits({ timed: true, saved: plain })).toEqual([
      'day',
      'week',
      'month',
      'interval',
    ]);
    expect(customUnits({ timed: false, saved: interval })).toContain('interval');
    expect(customUnits({ timed: false, saved: yearly })).toEqual(['day', 'week', 'month', 'year']);
  });

  it('opens on every week instead of the yearly quick choice, unless the repeat is saved yearly', () => {
    const yearly = draft({ unit: 'year', ends: { kind: 'after', count: 3 } });
    expect(customStart(yearly, draft())).toMatchObject({
      unit: 'week',
      interval: 1,
      weekdays: ['FR'],
      ends: { kind: 'after', count: 3 },
    });
    expect(customStart(yearly, yearly)).toBe(yearly);
    const monthly = draft({ unit: 'month' });
    expect(customStart(monthly, draft())).toBe(monthly);
  });

  it('a period keeps its count and days; a week starts on the cell’s weekday', () => {
    const weekly = withCustomUnit(draft({ unit: 'day', interval: 2, weekdays: [] }), 'week');
    expect(weekly).toMatchObject({ mode: 'schedule', unit: 'week', interval: 2, weekdays: ['FR'] });
    expect(rule(weekly)).toBe('FREQ=WEEKLY;INTERVAL=2;BYDAY=FR');
    expect(rule(withCustomUnit(draft({ weekdays: ['MO', 'WE'] }), 'week'))).toBe(
      'FREQ=WEEKLY;BYDAY=MO,WE'
    );
    expect(rule(withCustomUnit(draft({ interval: 4 }), 'month'))).toBe('FREQ=MONTHLY;INTERVAL=4');
    expect(customUnitOf(weekly)).toBe('week');
  });

  it('Interval keeps its length, and a period its count, across the switch', () => {
    const daily = draft({ unit: 'day', interval: 3, every: repeatEveryOf(5400) }, TIMED);
    const interval = withCustomUnit(daily, 'interval');
    expect(customUnitOf(interval)).toBe('interval');
    expect(rule(interval)).toBe('FREQ=MINUTELY;INTERVAL=90');
    const back = withCustomUnit(interval, 'day');
    expect(rule(back)).toBe('FREQ=DAILY;INTERVAL=3');
  });

  it('names the unit after its count; Interval is one word', () => {
    expect(customUnitWord('week', 1)).toBe('week');
    expect(customUnitWord('week', 2)).toBe('weeks');
    expect(customUnitWord('day', 3)).toBe('days');
    expect(customUnitWord('interval', 2)).toBe('Interval');
  });
});
