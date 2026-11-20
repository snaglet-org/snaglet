/**
 * The Repeat panel's model on top of the shared draft (`@snaglet/shared/utils`
 * tableRepeatSpec, which words and saves it):
 *
 * - the quick choices (Every day, Every week on Tuesday, Every month on the
 *   13th, Every year on Oct 13), filled in from the cell's date. Each is a
 *   change to the panel's draft that keeps its Ends.
 * - Custom's unit list: a schedule's day, week or month, "Repeat every [N]
 *   [unit]", or, for a date with a time, Interval: a fixed length of time
 *   in days, hours, minutes and seconds.
 *
 * Saved repeats Custom can't make keep reading as themselves: a yearly one
 * keeps Year in the list, and several days of the month stay one entry of
 * the day list.
 */
import {
  fmtShort,
  ordinal,
  repeatDraftSummary,
  weekdayLong,
  weekdayOf,
  type RepeatDraft,
  type TableRepeatUnit,
} from '@snaglet/shared/utils';

export type QuickChoiceId = 'daily' | 'weekly' | 'monthly' | 'yearly';

export interface RepeatChoice {
  id: QuickChoiceId;
  label: string;
  make: (s: RepeatDraft) => RepeatDraft;
}

/** The plain parts every quick choice resets: no custom period. Ends stay. */
const plain = (s: RepeatDraft): RepeatDraft => ({
  ...s,
  mode: 'schedule',
  interval: 1,
});

/** The quick choices for a cell's date, in the panel's order. */
export function repeatChoices(anchor: string): RepeatChoice[] {
  const weekday = weekdayOf(anchor);
  const date = Number(anchor.slice(8, 10));
  return [
    { id: 'daily', label: 'Every day', make: (s) => ({ ...plain(s), unit: 'day' }) },
    {
      id: 'weekly',
      label: `Every week on ${weekdayLong(weekday)}`,
      make: (s) => ({ ...plain(s), unit: 'week', weekdays: [weekday] }),
    },
    {
      id: 'monthly',
      label: `Every month on the ${ordinal(date)}`,
      make: (s) => ({ ...plain(s), unit: 'month', monthOn: 'dates', monthDates: [date] }),
    },
    {
      id: 'yearly',
      label: `Every year on ${fmtShort(anchor)}`,
      make: (s) => ({ ...plain(s), unit: 'year' }),
    },
  ];
}

/**
 * The quick choice `s` is, or 'custom'. Compared on what each choice sets
 * (an interval is never a quick choice, whatever its sentence).
 */
export function choiceOf(s: RepeatDraft): QuickChoiceId | 'custom' {
  const same = (a: RepeatDraft) =>
    a.mode === s.mode && repeatDraftSummary(a) === repeatDraftSummary(s);
  return repeatChoices(s.anchor).find((choice) => same(choice.make(s)))?.id ?? 'custom';
}

// Custom: "Repeat every [N] [unit]", or an Interval

/**
 * Custom's units: a schedule's period, or Interval, a fixed length of time
 * from the date and time (the draft's `every`).
 */
export type CustomUnit = TableRepeatUnit | 'interval';

/** The most periods: every 99 days, weeks or months. */
export const CUSTOM_COUNT_MAX = 99;

const isYearly = (s: RepeatDraft) => s.mode === 'schedule' && s.unit === 'year';

/** The unit Custom shows for the draft. */
export const customUnitOf = (s: RepeatDraft): CustomUnit =>
  s.mode === 'interval' ? 'interval' : s.unit;

/**
 * Custom's units: day, week and month; Year only for a saved repeat that is
 * already yearly (every few years included), so it reads as itself, as a
 * new yearly repeat is the quick choice Every year on the date; and Interval
 * for a date with a time (`timed`), or a saved interval.
 */
export function customUnits(options: { timed: boolean; saved: RepeatDraft }): CustomUnit[] {
  return [
    'day',
    'week',
    'month',
    ...(isYearly(options.saved) ? (['year'] as const) : []),
    ...(options.timed || options.saved.mode === 'interval' ? (['interval'] as const) : []),
  ];
}

/**
 * The draft repeating by `unit`. A period keeps its count (between days,
 * weeks and months) and an interval its length, so a unit picked and picked
 * back is unchanged; weeks keep their days, or start on the cell's weekday.
 */
export function withCustomUnit(s: RepeatDraft, unit: CustomUnit): RepeatDraft {
  if (unit === 'interval') return { ...s, mode: 'interval' };
  return {
    ...s,
    mode: 'schedule',
    unit,
    weekdays: unit === 'week' && s.weekdays.length === 0 ? [weekdayOf(s.anchor)] : s.weekdays,
  };
}

/**
 * The draft Custom opens on: the current one, except that a yearly draft
 * that isn't the saved yearly repeat (the quick choice, picked just before)
 * starts as every week on the cell's weekday, since Custom has no Year for
 * a new repeat. Ends stay.
 */
export function customStart(s: RepeatDraft, saved: RepeatDraft): RepeatDraft {
  if (!isYearly(s) || isYearly(saved)) return s;
  return { ...s, unit: 'week', interval: 1, weekdays: [weekdayOf(s.anchor)] };
}

/** "Interval", or the period as the line names it after `count`: "week", "weeks". */
export const customUnitWord = (unit: CustomUnit, count: number) =>
  unit === 'interval' ? 'Interval' : count === 1 ? unit : `${unit}s`;
