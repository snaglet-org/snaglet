import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import {
  REPEAT_INTERVAL_MAX_SECONDS,
  REPEAT_WEEKDAYS,
  fmtClock,
  fmtDay,
  fmtDayIn,
  fmtShort,
  normalizeRepeatDraft,
  ordinal,
  repeatDraftFor,
  repeatDraftFromRepeat,
  repeatDraftHasTime,
  repeatDraftIntervalProblem,
  repeatDraftSummary,
  repeatDraftUpcoming,
  repeatEveryOf,
  repeatEverySeconds,
  repeatInputFromDraft,
  tableRepeatSummary,
  upcomingTableRepeatItems,
  weekdayLong,
  weekdayShort,
  type RepeatDraft,
  type RepeatEnds,
  type RepeatEvery,
  type TableRepeat,
  type TableRepeatInput,
  type TableRepeatWeekday,
} from '@snaglet/shared/utils';
import { CALENDAR_INTERVAL_MIN_SECONDS } from '@snaglet/shared/types';
import { Button, DateInput, Select, TextInput } from '@desktop/components';
import { Segmented } from '@desktop/components/Segmented';
import { cn } from '@desktop/utils/classNames';
import {
  CUSTOM_COUNT_MAX,
  choiceOf,
  customStart,
  customUnitOf,
  customUnitWord,
  customUnits,
  repeatChoices,
  withCustomUnit,
  type CustomUnit,
  type QuickChoiceId,
} from './repeatChoices';
import styles from './RepeatPicker.module.scss';

export interface RepeatPickerProps {
  /**
   * The cell's date (its range's start), or the row's current occurrence:
   * the quick choices fill in from it and a new series starts there.
   */
  anchor: string;
  /** The saved repeat; null when the cell doesn't repeat. */
  repeat: TableRepeat | null;
  /** The field has an End date: it repeats on set days only. */
  hasEnd?: boolean;
  /** No Interval (a fixed length of time): calendar events repeat by day or longer. */
  noInterval?: boolean;
  busy?: boolean;
  error?: string | null;
  /** Done (or Back) after a change: save it; null = Doesn't repeat. */
  onSave: (input: TableRepeatInput | null) => void;
  /** Done (or Back) with nothing changed: no write. */
  onClose: () => void;
  /** Inside the date popover: a back arrow ("Back to the date") heads the panel. */
  nested?: boolean;
  /** What the back arrow names when nested. Default "Back to the date". */
  backLabel?: string;
  /** Focus the checked choice once mounted. Default true. */
  autoFocus?: boolean;
}

type Kind = 'none' | QuickChoiceId | 'custom';

const NTHS = [1, 2, 3, 4, -1];
/** The month's days for "on day [9]", and the last day. */
const MONTH_DAYS = [...Array.from({ length: 31 }, (_, i) => i + 1), -1];
/** The day-list entry that holds a saved repeat's several days of the month. */
const KEPT = 'kept';
/** Interval's four boxes: "Repeat every [0] days [1] hour [30] minutes [0] seconds". */
const INTERVAL_PARTS: { key: keyof RepeatEvery; name: string; word: string; max: number }[] = [
  { key: 'days', name: 'Days', word: 'day', max: 999 },
  { key: 'hours', name: 'Hours', word: 'hour', max: 23 },
  { key: 'minutes', name: 'Minutes', word: 'minute', max: 59 },
  { key: 'seconds', name: 'Seconds', word: 'second', max: 59 },
];
const DAY_MS = 86_400_000;

function addDays(date: string, n: number): string {
  const [y, m, d] = date.slice(0, 10).split('-').map(Number);
  return new Date(Date.UTC(y ?? 1970, (m ?? 1) - 1, d ?? 1) + n * DAY_MS)
    .toISOString()
    .slice(0, 10);
}

const dayName = (n: number) => (n === -1 ? 'last day' : ordinal(n));
const dayList = (days: number[]) =>
  days.length < 2
    ? days.map(dayName).join('')
    : `${days.slice(0, -1).map(dayName).join(', ')} and ${dayName(days[days.length - 1]!)}`;

/** What the panel opens on: the saved repeat as a draft (or a fresh one), and whether it reads exactly. */
function savedDraft(
  anchor: string,
  repeat: TableRepeat | null,
  hasEnd: boolean
): { draft: RepeatDraft; exact: boolean } {
  if (!repeat) return { draft: repeatDraftFor(anchor, { hasEnd }), exact: true };
  return repeatDraftFromRepeat(repeat, { anchor, hasEnd });
}

/** An interval's parts carried over, 90 minutes as 1 hour 30 minutes (whole numbers 0 or more only). */
function carried(every: RepeatEvery): RepeatEvery {
  if (!Object.values(every).every((n) => Number.isInteger(n) && n >= 0)) return every;
  return repeatEveryOf(Math.min(REPEAT_INTERVAL_MAX_SECONDS, repeatEverySeconds(every)));
}

/**
 * The most N can be: 99, or a saved repeat's own larger count (an agent may
 * save every 180 days), so opening, leaving the box or changing anything
 * else never rewrites it.
 */
const countMaxOf = (saved: RepeatDraft) => Math.max(CUSTOM_COUNT_MAX, saved.interval);

/** Every number inside its bounds (what leaving a field does), for Done and Enter. */
function settled(s: RepeatDraft, countMax: number): RepeatDraft {
  let next: RepeatDraft = {
    ...s,
    interval: Math.min(countMax, Math.max(1, s.interval || 1)),
  };
  if (next.ends.kind === 'after')
    next = {
      ...next,
      ends: { kind: 'after', count: Math.min(999, Math.max(1, next.ends.count || 1)) },
    };
  if (next.mode === 'interval') next = { ...next, every: carried(next.every) };
  return normalizeRepeatDraft(next);
}

/** What saving `s` would write, so a draft changed and changed back is unchanged. */
function ruleOf(s: RepeatDraft, countMax: number): string {
  const input = repeatInputFromDraft(settled(s, countMax));
  return input.ok ? JSON.stringify(input.value) : `! ${JSON.stringify(settled(s, countMax))}`;
}

/**
 * The Repeat view of the date popover, also used on its own (the row's Repeat
 * section, the calendar's Repeat…, an event's Repeat row): quick choices,
 * Custom…, Ends, and a sentence with the next date.
 *
 * Custom is one form, "Repeat every [N] [unit]", plus Interval (a fixed
 * duration) for dates with a time. A saved repeat the form can't make reads
 * as itself until something changes.
 *
 * Choices edit a draft. Done (or Back, when nested) saves it only when it
 * changed, so a saved repeat opened and closed is never rewritten. Escape and
 * an outside press drop the draft.
 */
export function RepeatPicker({
  anchor,
  repeat,
  hasEnd = false,
  noInterval = false,
  busy = false,
  error,
  onSave,
  onClose,
  nested = false,
  backLabel = 'Back to the date',
  autoFocus = true,
}: RepeatPickerProps) {
  const saved = useMemo(() => savedDraft(anchor, repeat, hasEnd), [anchor, repeat, hasEnd]);
  const initialKind: Kind = !repeat ? 'none' : saved.exact ? choiceOf(saved.draft) : 'custom';
  const [kind, setKind] = useState<Kind>(initialKind);
  const [draft, setDraft] = useState(saved.draft);
  const [localError, setLocalError] = useState<string | null>(null);
  const groupRef = useRef<HTMLDivElement>(null);
  const ids = useId();

  // Once, as the panel opens: the checked choice.
  const focusOnOpen = useRef(autoFocus);
  useEffect(() => {
    if (!focusOnOpen.current) return;
    groupRef.current
      ?.querySelector<HTMLElement>('[role="radio"][aria-checked="true"]')
      ?.focus({ preventScroll: true });
  }, []);

  const s = draft;
  const repeating = kind !== 'none';
  const custom = kind === 'custom';
  const choices = repeatChoices(anchor);
  const hasTime = repeatDraftHasTime(s);
  const intervalMode = s.mode === 'interval';
  const intervalProblem = repeating && intervalMode ? repeatDraftIntervalProblem(s) : null;
  const year = Number(anchor.slice(0, 4));
  const countMax = countMaxOf(saved.draft);
  const changed =
    (kind === 'none') !== (initialKind === 'none') ||
    (repeating && ruleOf(s, countMax) !== ruleOf(saved.draft, countMax));
  // A saved repeat the form can't show exactly (another WKST, an agent's
  // BYSETPOS) reads as itself, its own sentence and dates, until something
  // changes; from then on the draft is what Done would save.
  const asSaved = repeat !== null && !saved.exact && !changed;
  const savedUpcoming = asSaved ? upcomingTableRepeatItems(repeat, 3) : null;
  const upcoming = !repeating
    ? []
    : savedUpcoming
      ? savedUpcoming.ok
        ? savedUpcoming.value
        : []
      : repeatDraftUpcoming(s, 3);
  const blocked = repeating && changed && (intervalProblem !== null || upcoming.length === 0);
  const shownError = localError ?? error ?? null;

  // Custom's line: the unit shown, and the units on offer.
  const unit = customUnitOf(s);
  const units = customUnits({ timed: hasTime && !noInterval, saved: saved.draft });

  const update = (patch: Partial<RepeatDraft>) => {
    setDraft((current) => normalizeRepeatDraft({ ...current, ...patch }));
    setLocalError(null);
  };
  const updateWith = (change: (current: RepeatDraft) => RepeatDraft) => {
    setDraft((current) => normalizeRepeatDraft(change(current)));
    setLocalError(null);
  };

  const pick = (next: Kind) => {
    // The checked choice again keeps the draft as it is.
    if (next === kind) return;
    setLocalError(null);
    setKind(next);
    const choice = choices.find((c) => c.id === next);
    if (choice) setDraft((current) => normalizeRepeatDraft(choice.make(current)));
    else if (next === 'custom')
      setDraft((current) => normalizeRepeatDraft(customStart(current, saved.draft)));
  };

  const done = () => {
    if (busy) return;
    if (!changed) {
      onClose();
      return;
    }
    if (!repeating) {
      onSave(null);
      return;
    }
    // The reason is on screen already (the interval's floor, no dates).
    if (blocked) return;
    const final = settled(s, countMax);
    setDraft(final);
    const input = repeatInputFromDraft(final);
    if (!input.ok) {
      setLocalError(input.error);
      return;
    }
    onSave(input.value);
  };

  const setCount = (n: number) => update({ interval: n });
  // A period keeps its count and an interval its length, so a unit picked
  // and picked back is unchanged.
  const setUnit = (next: CustomUnit) => updateWith((current) => withCustomUnit(current, next));
  const setEveryPart = (key: keyof RepeatEvery, value: string) => {
    const n = value.trim() === '' ? 0 : Number(value);
    update({ every: { ...s.every, [key]: Number.isFinite(n) ? n : 0 } });
  };
  // Leaving a box carries over: 90 minutes reads 1 hour 30 minutes.
  const carryEvery = () => update({ every: carried(s.every) });
  const toggleWeekday = (day: TableRepeatWeekday) => {
    const on = s.weekdays.includes(day);
    if (on && s.weekdays.length === 1) return;
    update({ weekdays: on ? s.weekdays.filter((d) => d !== day) : [...s.weekdays, day] });
  };
  const setEnds = (ends: RepeatEnds['kind']) =>
    update({
      ends:
        ends === 'on'
          ? { kind: 'on', date: s.ends.kind === 'on' ? s.ends.date : addDays(s.anchor, 90) }
          : ends === 'after'
            ? { kind: 'after', count: s.ends.kind === 'after' ? s.ends.count : 10 }
            : { kind: 'never' },
    });

  // Enter in a number saves, as Done does.
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (
      event.key === 'Enter' &&
      event.target instanceof HTMLInputElement &&
      event.target.type === 'number'
    ) {
      event.preventDefault();
      done();
    }
  };

  // Arrow keys move the choice, as in any radio group.
  const onChoiceKey = (event: KeyboardEvent<HTMLDivElement>) => {
    const step = { ArrowDown: 1, ArrowRight: 1, ArrowUp: -1, ArrowLeft: -1 }[event.key];
    if (step === undefined) return;
    event.preventDefault();
    const order: Kind[] = ['none', ...choices.map((c) => c.id), 'custom'];
    const next = order[(order.indexOf(kind) + step + order.length) % order.length]!;
    pick(next);
    queueMicrotask(() =>
      groupRef.current
        ?.querySelector<HTMLElement>(`[data-choice="${next}"]`)
        ?.focus({ preventScroll: true })
    );
  };

  const choiceRow = (id: Kind, label: string) => (
    <button
      key={id}
      type="button"
      role="radio"
      aria-checked={kind === id}
      tabIndex={kind === id ? 0 : -1}
      data-choice={id}
      className={styles.choice}
      disabled={busy}
      onClick={() => pick(id)}
    >
      <span className={styles.ring} aria-hidden>
        <span className={styles.dot} />
      </span>
      <span className={styles.choiceText}>{label}</span>
    </button>
  );

  const numberField = (props: {
    label: string;
    value: number;
    min: number;
    max: number;
    onValue: (n: number) => void;
    onSettle?: () => void;
    invalid?: boolean;
  }) => (
    <TextInput
      type="number"
      size="sm"
      min={props.min}
      max={props.max}
      aria-label={props.label}
      aria-invalid={props.invalid || undefined}
      disabled={busy}
      containerClassName={styles.count}
      value={String(props.value || '')}
      onChange={(event) => props.onValue(Number(event.target.value) || 0)}
      onBlur={props.onSettle}
    />
  );

  // Custom: "Repeat every [N] [unit]" (weeks add "on"), or "Repeat every [Interval]"
  const everyLine = (
    <div className={styles.line}>
      <span>Repeat every</span>
      {!intervalMode &&
        numberField({
          label: 'Every how many',
          value: s.interval,
          min: 1,
          max: countMax,
          onValue: setCount,
          onSettle: () => setCount(Math.min(countMax, Math.max(1, s.interval || 1))),
        })}
      <span className={styles.unit}>
        <Select
          size="sm"
          aria-label="Period"
          value={unit}
          disabled={busy}
          onChange={(event) => setUnit(event.target.value as CustomUnit)}
        >
          {units.map((u) => (
            <option key={u} value={u}>
              {customUnitWord(u, s.interval)}
            </option>
          ))}
        </Select>
      </span>
      {!intervalMode && s.unit === 'week' && <span>on</span>}
      {!intervalMode && s.unit === 'year' && <span>on {fmtShort(s.anchor)}</span>}
    </div>
  );

  const weekdayChips = (
    <div role="group" aria-label="On these days" className={styles.weekdays}>
      {REPEAT_WEEKDAYS.map((day) => (
        <button
          key={day}
          type="button"
          className={styles.dayChip}
          aria-pressed={s.weekdays.includes(day)}
          aria-label={weekdayLong(day)}
          title={weekdayLong(day)}
          disabled={busy}
          onClick={() => toggleWeekday(day)}
        >
          {weekdayShort(day).slice(0, 1)}
        </button>
      ))}
    </div>
  );

  // "on day [9]" or "on the [2nd] [Friday]"; a saved repeat's several days stay one entry.
  const oneDay = s.monthDates.length === 1 && MONTH_DAYS.includes(s.monthDates[0]!);
  const monthOn = (
    <div role="radiogroup" aria-label="Monthly on" className={styles.monthOn}>
      <div className={styles.monthRow}>
        <label className={styles.monthOption}>
          <input
            type="radio"
            name={`${ids}-month`}
            checked={s.monthOn === 'dates'}
            disabled={busy}
            onChange={() => update({ monthOn: 'dates' })}
          />
          on day
        </label>
        <span className={styles.unit}>
          <Select
            size="sm"
            aria-label="Day of the month"
            value={oneDay ? String(s.monthDates[0]) : KEPT}
            disabled={busy}
            onChange={(event) =>
              event.target.value !== KEPT &&
              update({ monthOn: 'dates', monthDates: [Number(event.target.value)] })
            }
          >
            {!oneDay && <option value={KEPT}>{dayList(s.monthDates)}</option>}
            {MONTH_DAYS.map((n) => (
              <option key={n} value={n}>
                {n === -1 ? 'last day' : n}
              </option>
            ))}
          </Select>
        </span>
      </div>
      <div className={styles.monthRow}>
        <label className={styles.monthOption}>
          <input
            type="radio"
            name={`${ids}-month`}
            checked={s.monthOn === 'weekday'}
            disabled={busy}
            onChange={() => update({ monthOn: 'weekday' })}
          />
          on the
        </label>
        <span className={styles.unit}>
          <Select
            size="sm"
            aria-label="Which week"
            value={String(s.nth)}
            disabled={busy}
            onChange={(event) => update({ monthOn: 'weekday', nth: Number(event.target.value) })}
          >
            {NTHS.map((n) => (
              <option key={n} value={n}>
                {ordinal(n)}
              </option>
            ))}
          </Select>
        </span>
        <span className={styles.unitWide}>
          <Select
            size="sm"
            aria-label="Weekday"
            value={s.nthDay}
            disabled={busy}
            onChange={(event) =>
              update({ monthOn: 'weekday', nthDay: event.target.value as TableRepeatWeekday })
            }
          >
            {REPEAT_WEEKDAYS.map((day) => (
              <option key={day} value={day}>
                {weekdayLong(day)}
              </option>
            ))}
          </Select>
        </span>
      </div>
    </div>
  );

  // Interval: "[0] days [1] hour [30] minutes [0] seconds"
  const intervalParts = (
    <div role="group" aria-label="Interval" className={styles.every}>
      {INTERVAL_PARTS.map(({ key, name, word, max }) => (
        <span key={key} className={styles.everyPart}>
          <TextInput
            type="number"
            size="sm"
            min={0}
            max={max}
            step={1}
            aria-label={name}
            aria-invalid={intervalProblem ? true : undefined}
            disabled={busy}
            containerClassName={styles.count}
            value={String(s.every[key])}
            onChange={(event) => setEveryPart(key, event.target.value)}
            onBlur={carryEvery}
          />
          <span aria-hidden>{s.every[key] === 1 ? word : `${word}s`}</span>
        </span>
      ))}
    </div>
  );

  const intervalNote = intervalProblem ? (
    <p className={styles.error} role="alert">
      {intervalProblem}
    </p>
  ) : (
    <p className={styles.hint}>
      Starts {fmtDay(s.anchor)}, {fmtClock(s.anchor)}. A fixed length of time, so it doesn’t shift
      with daylight saving.
      {repeatEverySeconds(s.every) < CALENDAR_INTERVAL_MIN_SECONDS &&
        ' Too frequent to show on the calendar.'}
    </p>
  );

  // The foot: the sentence and the next one
  const nextItem = upcoming.find((item) => item.occurrence > anchor) ?? upcoming[0];
  const nextText = !nextItem
    ? null
    : hasTime
      ? `${fmtDayIn(nextItem.occurrence, year)}, ${fmtClock(nextItem.occurrence)}`
      : fmtDayIn(nextItem.occurrence, year);
  const footNote = !repeating
    ? 'Pick how often'
    : intervalProblem
      ? null
      : nextText
        ? `Next: ${nextText}`
        : 'No dates: check Ends.';

  return (
    <div className={styles.panel} aria-busy={busy || undefined} onKeyDown={onKeyDown}>
      <div className={styles.header}>
        {nested && (
          <button
            type="button"
            className={styles.back}
            aria-label={backLabel}
            title="Back"
            disabled={busy}
            onClick={done}
          >
            <svg viewBox="0 0 12 12" width="12" height="12" aria-hidden="true">
              <path
                d="M7.5 2.5 4 6l3.5 3.5"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </button>
        )}
        <span className={styles.title}>Repeat</span>
        <span className={styles.starts}>from {fmtShort(anchor)}</span>
      </div>

      <div
        ref={groupRef}
        role="radiogroup"
        aria-label="How it repeats"
        className={styles.choices}
        onKeyDown={onChoiceKey}
      >
        {choiceRow('none', 'Doesn’t repeat')}
        {choices.map((choice) => choiceRow(choice.id, choice.label))}
        {choiceRow('custom', custom ? 'Custom' : 'Custom…')}
      </div>

      {custom && (
        <div className={styles.custom} role="group" aria-label="Custom repeat">
          {!saved.exact && (
            <p className={styles.hint}>
              This repeat has parts this editor can’t show. Changing it here replaces them.
            </p>
          )}
          {everyLine}
          {!hasTime && !noInterval && (
            <p className={styles.hint}>Add a time to repeat every few seconds, minutes or hours.</p>
          )}
          {intervalMode ? (
            <>
              {intervalParts}
              {intervalNote}
            </>
          ) : s.unit === 'week' ? (
            weekdayChips
          ) : s.unit === 'month' ? (
            monthOn
          ) : null}
        </div>
      )}

      {repeating && (
        <div className={styles.ends}>
          <span className={styles.endsLabel}>Ends</span>
          <Segmented
            size="sm"
            aria-label="Ends"
            className={styles.endsChoice}
            value={s.ends.kind}
            onChange={(value) => setEnds(value as RepeatEnds['kind'])}
          >
            <Segmented.Option value="never" className={styles.mode}>
              Never
            </Segmented.Option>
            <Segmented.Option value="on" className={styles.mode}>
              On date
            </Segmented.Option>
            <Segmented.Option value="after" className={styles.mode}>
              After
            </Segmented.Option>
          </Segmented>
          {s.ends.kind === 'on' && (
            <div className={styles.endsValue}>
              <DateInput
                size="sm"
                required
                aria-label="End date"
                value={s.ends.date}
                min={s.anchor.slice(0, 10)}
                onChange={(date) => update({ ends: { kind: 'on', date } })}
              />
            </div>
          )}
          {s.ends.kind === 'after' && (
            <div className={styles.endsValue}>
              {numberField({
                label: 'How many',
                value: s.ends.count,
                min: 1,
                max: 999,
                onValue: (n) => update({ ends: { kind: 'after', count: n } }),
                onSettle: () =>
                  s.ends.kind === 'after' &&
                  update({
                    ends: { kind: 'after', count: Math.min(999, Math.max(1, s.ends.count || 1)) },
                  }),
              })}
              <span className={styles.muted}>times</span>
            </div>
          )}
        </div>
      )}

      {shownError && (
        <p className={cn(styles.error, styles.padded)} role="alert">
          {shownError}
        </p>
      )}

      <div className={styles.foot}>
        <div className={styles.footText}>
          <p className={styles.summary} aria-live="polite" data-testid="repeat-panel-summary">
            {!repeating
              ? 'Doesn’t repeat'
              : asSaved
                ? tableRepeatSummary(repeat, { hasEnd })
                : repeatDraftSummary(s)}
          </p>
          {footNote && <p className={styles.next}>{footNote}</p>}
        </div>
        <Button size="sm" variant="primary" onClick={done} disabled={busy || blocked}>
          {busy ? 'Saving…' : 'Done'}
        </Button>
      </div>
    </div>
  );
}
