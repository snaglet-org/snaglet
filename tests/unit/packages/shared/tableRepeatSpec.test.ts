/**
 * The repeat editor's model and wording: the editor's
 * sentences, the round trip to a stored repeat, and the grid cell text.
 */
import {
  createTableRepeat,
  normalizeRepeatDraft,
  repeatDraftFor,
  repeatDraftFromRepeat,
  repeatDraftSummary,
  repeatDraftUpcoming,
  repeatInputFromDraft,
  tableRepeatCellText,
  tableRepeatSummary,
  type RepeatDraft,
  type TableRepeat,
} from '@snaglet/shared/utils';

function ok<T>(result: { ok: true; value: T } | { ok: false; error: string }): T {
  if (!result.ok) throw new Error(result.error);
  return result.value;
}

// Tue Oct 13, 2026.
const ANCHOR = '2026-10-13';
const draft = (patch: Partial<RepeatDraft> = {}, anchor = ANCHOR): RepeatDraft => ({
  ...repeatDraftFor(anchor),
  ...patch,
});
function saved(d: RepeatDraft, tz = 'America/New_York'): TableRepeat {
  const input = ok(repeatInputFromDraft(d));
  return ok(createTableRepeat({ ...input, tz }));
}

describe('summary sentences (the prototype rows)', () => {
  it.each<[string, Partial<RepeatDraft>, string]>([
    ['Standup', { weekdays: ['MO', 'TU', 'WE', 'TH', 'FR'] }, 'Every weekday'],
    ['Pay rent', { unit: 'month', monthDates: [1] }, 'Every month on the 1st'],
    ['Weekly review', { weekdays: ['FR'] }, 'Every week on Friday'],
    ['Dentist', {}, 'Every week on Tuesday'],
    ['Conference', { unit: 'year', hasEnd: true }, 'Every year on Oct 13'],
  ])('%s: %s', (_name, patch, sentence) => {
    expect(repeatDraftSummary(draft(patch))).toBe(sentence);
  });

  it.each<[Partial<RepeatDraft>, string]>([
    [{ unit: 'day' }, 'Every day'],
    [{ unit: 'day', interval: 3 }, 'Every 3 days'],
    [{ weekdays: ['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU'] }, 'Every day'],
    [{ interval: 2, weekdays: ['MO', 'TH'] }, 'Every 2 weeks on Mon and Thu'],
    [{ interval: 2, weekdays: ['MO', 'TU', 'WE', 'TH', 'FR'] }, 'Every 2 weeks on weekdays'],
    [{ unit: 'month', monthOn: 'weekday', nth: 2, nthDay: 'TU' }, 'Every month on the 2nd Tuesday'],
    [
      { unit: 'month', monthOn: 'weekday', nth: -1, nthDay: 'FR' },
      'Every month on the last Friday',
    ],
    [{ unit: 'month', monthDates: [15, -1, 1] }, 'Every month on the 1st, 15th and last day'],
    [{ unit: 'month', monthDates: [11, 12, 13] }, 'Every month on the 11th, 12th and 13th'],
    [{ ends: { kind: 'on', date: '2026-12-31' } }, 'Every week on Tuesday, until Dec 31'],
    [{ ends: { kind: 'on', date: '2027-01-05' } }, 'Every week on Tuesday, until Jan 5, 2027'],
    [{ ends: { kind: 'after', count: 1 } }, 'Every week on Tuesday, 1 time'],
    [{ ends: { kind: 'after', count: 6 } }, 'Every week on Tuesday, 6 times'],
  ])('%j reads "%s"', (patch, sentence) => {
    expect(repeatDraftSummary(draft(patch))).toBe(sentence);
  });

  it('lists days Monday first', () => {
    expect(repeatDraftSummary(draft({ weekdays: ['SU', 'WE'] }))).toBe('Every week on Wed and Sun');
    expect(repeatDraftSummary(draft({ weekdays: ['SU', 'MO'] }))).toBe('Every week on Mon and Sun');
  });
});

describe('saving a draft', () => {
  it('starts on the first set day at or after the cell date', () => {
    expect(ok(repeatInputFromDraft(draft({ weekdays: ['TU', 'TH'] }, '2026-10-14')))).toEqual({
      rrule: 'FREQ=WEEKLY;BYDAY=TU,TH',
      date: '2026-10-15',
    });
  });

  it('keeps "every month on the 12th" as plain FREQ=MONTHLY, and the last day as -1', () => {
    expect(ok(repeatInputFromDraft(draft({ unit: 'month', monthDates: [13] })))).toMatchObject({
      rrule: 'FREQ=MONTHLY',
      date: '2026-10-13',
    });
    expect(ok(repeatInputFromDraft(draft({ unit: 'month', monthDates: [12] })))).toMatchObject({
      rrule: 'FREQ=MONTHLY',
      date: '2026-11-12',
    });
    expect(ok(repeatInputFromDraft(draft({ unit: 'month', monthDates: [-1] })))).toMatchObject({
      rrule: 'FREQ=MONTHLY;BYMONTHDAY=-1',
      date: '2026-10-31',
    });
  });

  it('writes the Ends rule, and no week start (weeks start on Monday)', () => {
    expect(
      ok(
        repeatInputFromDraft(
          draft({
            unit: 'month',
            monthDates: [1, 15],
            ends: { kind: 'after', count: 6 },
          })
        )
      )
    ).toEqual({
      rrule: 'FREQ=MONTHLY;BYMONTHDAY=1,15;COUNT=6',
      date: '2026-10-15',
    });
    expect(
      ok(
        repeatInputFromDraft(draft({ interval: 2, weekdays: ['SU', 'WE'] }, '2026-10-13T09:30:00'))
      )
    ).toEqual({
      rrule: 'FREQ=WEEKLY;INTERVAL=2;BYDAY=WE,SU',
      date: '2026-10-14T09:30:00',
    });
    expect(
      ok(
        repeatInputFromDraft(
          draft({ ends: { kind: 'on', date: '2026-12-31' } }, '2026-10-13T09:30:00')
        )
      ).rrule
    ).toBe('FREQ=WEEKLY;BYDAY=TU;UNTIL=20261231T235959');
  });

  it('a field with an End date saves set days', () => {
    expect(ok(repeatInputFromDraft(draft({ hasEnd: true })))).toEqual({
      rrule: 'FREQ=WEEKLY;BYDAY=TU',
      date: ANCHOR,
    });
  });

  it('says "No dates" when Ends leaves none', () => {
    const ended = repeatInputFromDraft(
      draft({ weekdays: ['FR'], ends: { kind: 'on', date: '2026-10-14' } })
    );
    expect(ended.ok ? '' : ended.error).toBe('No dates: check Ends.');
  });

  it.each<[string, Partial<RepeatDraft>]>([
    ['weekly', { weekdays: ['MO', 'TH'], interval: 2 }],
    ['monthly dates', { unit: 'month', monthDates: [1, 15, -1] }],
    ['monthly weekday', { unit: 'month', monthOn: 'weekday', nth: -1, nthDay: 'FR' }],
    ['yearly', { unit: 'year', ends: { kind: 'after', count: 3 } }],
    ['daily', { unit: 'day', interval: 3 }],
  ])('%s round-trips through the stored value', (_name, patch) => {
    const d = draft(patch);
    const repeat = saved(d);
    const back = repeatDraftFromRepeat(repeat);
    expect(back.exact).toBe(true);
    expect(repeatDraftSummary(back.draft)).toBe(repeatDraftSummary(normalizeRepeatDraft(d)));
    expect(tableRepeatSummary(repeat)).toBe(repeatDraftSummary(normalizeRepeatDraft(d)));
  });
});

describe('stored repeats', () => {
  it('reads v1 rules', () => {
    const v1 = (rrule: string, date = '2026-10-12') =>
      tableRepeatSummary(ok(createTableRepeat({ date, rrule, tz: 'UTC' })));
    expect(v1('FREQ=DAILY')).toBe('Every day');
    expect(v1('FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR')).toBe('Every weekday');
    expect(v1('FREQ=WEEKLY;BYDAY=MO')).toBe('Every week on Monday');
    expect(v1('FREQ=MONTHLY')).toBe('Every month on the 12th');
    expect(v1('FREQ=MONTHLY;BYDAY=2MO')).toBe('Every month on the 2nd Monday');
    expect(v1('FREQ=YEARLY')).toBe('Every year on Oct 12');
    expect(v1('FREQ=WEEKLY;INTERVAL=2;BYDAY=MO;COUNT=6')).toBe('Every 2 weeks on Monday, 6 times');
    expect(tableRepeatSummary(null)).toBe('Doesn’t repeat');
  });

  it('reads stored repeats the editor does not make as themselves', () => {
    const read = (rrule: string, date = '2026-10-12') => {
      const repeat = ok(createTableRepeat({ date, rrule, tz: 'UTC' }));
      return { exact: repeatDraftFromRepeat(repeat).exact, sentence: tableRepeatSummary(repeat) };
    };
    // Several days of a month, every few years, an interval with seconds.
    expect(read('FREQ=MONTHLY;BYMONTHDAY=1,15,-1', '2026-10-15')).toEqual({
      exact: true,
      sentence: 'Every month on the 1st, 15th and last day',
    });
    expect(read('FREQ=YEARLY;INTERVAL=2')).toEqual({
      exact: true,
      sentence: 'Every 2 years on Oct 12',
    });
    expect(read('FREQ=SECONDLY;INTERVAL=194415', '2026-10-12T09:00:00')).toEqual({
      exact: true,
      sentence: 'Every 2 days 6 h 15 s',
    });
  });

  it('falls back to the rule library for parts the editor can’t show', () => {
    const odd = ok(
      createTableRepeat({
        date: '2026-10-30',
        rrule: 'FREQ=MONTHLY;BYDAY=FR;BYSETPOS=-1',
        tz: 'UTC',
      })
    );
    expect(repeatDraftFromRepeat(odd).exact).toBe(false);
    expect(tableRepeatSummary(odd)).toMatch(/^Every month/);
  });

  it('reads every few weeks from another week start (an older WKST) as inexact', () => {
    const rule = (rrule: string) =>
      repeatDraftFromRepeat(ok(createTableRepeat({ date: '2026-10-04', rrule, tz: 'UTC' })));
    expect(rule('FREQ=WEEKLY;INTERVAL=2;BYDAY=SU,TU;WKST=SU').exact).toBe(false);
    // Monday, or a week start that changes nothing, reads exactly.
    expect(rule('FREQ=WEEKLY;INTERVAL=2;BYDAY=SU,TU;WKST=MO').exact).toBe(true);
    expect(rule('FREQ=WEEKLY;BYDAY=SU,TU;WKST=SU').exact).toBe(true);
  });
});

describe('the next dates and the grid cell', () => {
  it('lists scheduled days, and periods with their days', () => {
    expect(repeatDraftUpcoming(draft({ unit: 'month', monthDates: [1] }), 2)).toEqual([
      { kind: 'date', occurrence: '2026-11-01' },
      { kind: 'date', occurrence: '2026-12-01' },
    ]);
  });

  it('reads like the prototype: "Sun Nov 1"', () => {
    const rent = saved(draft({ unit: 'month', monthDates: [1] }, '2026-11-01'));
    expect(tableRepeatCellText(rent)).toBe('Sun Nov 1');
    const standup = saved(draft({ weekdays: ['MO', 'TU', 'WE', 'TH', 'FR'] }));
    expect(tableRepeatCellText(standup)).toBe('Tue Oct 13');
  });

  it('shows the time of a datetime occurrence, and "No more dates" after the end', () => {
    const call = saved(draft({ weekdays: ['WE'] }, '2026-10-13T09:00:00'));
    expect(tableRepeatCellText(call)).toBe('Wed Oct 14, 9:00 AM');
    const ended = { ...saved(draft({ ends: { kind: 'after', count: 1 } })) };
    expect(tableRepeatCellText({ ...ended, current: '2026-10-13' })).toBe('Tue Oct 13');
  });
});
