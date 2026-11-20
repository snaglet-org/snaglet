/**
 * The "When" controls shared by the automation Edit and New forms:
 * - Once: a date and a time.
 * - Repeat: Every day / Every weekday / Every week on <day> / Every month on
 *   <date>, plus a time; or When Snaglet first opens that day, after an earliest
 *   time (once a day, the first time Snaglet is open and the computer awake from
 *   then on). A stored rule that is none of these (agents may set any RRULE)
 *   shows in words, read-only, until "Change to…" replaces it.
 * - Every: N minutes or hours (people may go down to 1 minute), optionally
 *   from a first run (the anchor that staggers automations on one interval),
 *   or only between two times of day (a daily window: runs from its start,
 *   up to and including its end; it replaces the first run).
 * Times are read in the automation's own zone.
 */
import { useId, useState } from 'react';
import {
  AUTOMATION_FIRST_OPEN_DEFAULT_AFTER,
  type AutomationWhen,
  type AutomationWhenInput,
} from '@snaglet/shared/types';
import {
  REPEAT_WEEKDAY_CODES,
  formatTimeOfDay,
  instantToWallTime,
  matchQuickRepeat,
  quickRepeatRule,
  type RepeatQuick,
  type RepeatQuickChoice,
  type RepeatWeekdayCode,
} from '@snaglet/shared/utils';
import { Button, DateInput, Segmented, Select, TextInput } from '@desktop/components';
import styles from './AutomationEditForm.module.scss';

type Mode = 'once' | 'repeat' | 'every';
/** A Repeat choice: a quick rule, or once a day when Snaglet first opens. */
type RepeatChoice = RepeatQuickChoice | 'first_open';

/** The segment each stored kind opens on (first open is a Repeat choice). */
const MODE_OF_KIND: Record<AutomationWhen['kind'], Mode> = {
  once: 'once',
  repeat: 'repeat',
  interval: 'every',
  first_open: 'repeat',
};

const WEEKDAY_NAMES: Record<RepeatWeekdayCode, string> = {
  MO: 'Monday',
  TU: 'Tuesday',
  WE: 'Wednesday',
  TH: 'Thursday',
  FR: 'Friday',
  SA: 'Saturday',
  SU: 'Sunday',
};

const CHOICES: Array<{ value: RepeatChoice; label: string }> = [
  { value: 'daily', label: 'Every day' },
  { value: 'weekdays', label: 'Every weekday' },
  { value: 'weekly', label: 'Every week on' },
  { value: 'monthly', label: 'Every month on' },
  { value: 'first_open', label: 'When Snaglet first opens that day' },
];

/** Starting values: the stored timing, or (new) once tomorrow at 09:00. */
function initialTiming(when: AutomationWhen | null, tz: string, now = new Date()) {
  const wallNow = instantToWallTime(now, tz);
  const tomorrow = instantToWallTime(new Date(now.getTime() + 86_400_000), tz).slice(0, 10);
  const weekdayIndex = (new Date(`${wallNow.slice(0, 10)}T00:00:00Z`).getUTCDay() + 6) % 7;
  const onceWall = when?.kind === 'once' ? instantToWallTime(new Date(when.at), tz) : null;
  const quick = when?.kind === 'repeat' ? matchQuickRepeat(when.rrule) : null;
  const everyMs = when?.kind === 'interval' ? when.everyMs : 3_600_000;
  const hours = everyMs % 3_600_000 === 0;
  const anchorWall =
    when?.kind === 'interval' && when.anchor ? instantToWallTime(new Date(when.anchor), tz) : null;
  const windowed = when?.kind === 'interval' && when.windowStart && when.windowEnd ? when : null;
  const firstOpen = when?.kind === 'first_open' ? when : null;
  return {
    mode: when ? MODE_OF_KIND[when.kind] : ('once' as Mode),
    date: onceWall ? onceWall.slice(0, 10) : tomorrow,
    onceTime: onceWall ? onceWall.slice(11, 16) : '09:00',
    repeatTime: when?.kind === 'repeat' ? when.timeOfDay : '09:00',
    quick: quick ?? {
      choice: 'daily' as const,
      weekday: REPEAT_WEEKDAY_CODES[weekdayIndex],
      monthDay: Number(wallNow.slice(8, 10)),
    },
    /** The stored rule is not a quick choice: shown read-only until replaced. */
    customRule: when?.kind === 'repeat' && !quick,
    firstOpen: firstOpen !== null,
    firstOpenAfter: firstOpen?.after ?? AUTOMATION_FIRST_OPEN_DEFAULT_AFTER,
    everyCount: String(hours ? everyMs / 3_600_000 : Math.round(everyMs / 60_000)),
    everyUnit: (hours ? 'h' : 'm') as 'h' | 'm',
    // The stored anchor (sent back only once these are edited; see `input`).
    /** The stored anchor as a wall time with seconds (null: none). */
    anchorWall,
    everyMs,
    firstDate: anchorWall ? anchorWall.slice(0, 10) : '',
    firstTime: anchorWall ? anchorWall.slice(11, 16) : '',
    windowStart: windowed?.windowStart ?? '',
    windowEnd: windowed?.windowEnd ?? '',
  };
}

const TIME = /^\d{2}:\d{2}$/;

/** What is wrong with a daily window as typed, or null (none at all is fine). */
function windowProblem(start: string, end: string): string | null {
  if (start === '' && end === '') return null;
  if (!TIME.test(start) || !TIME.test(end)) return 'Set both window times, or clear both.';
  if (start === end) return 'The window must end at another time than it starts.';
  return null;
}

/** Timing form state; render it with {@link AutomationTimingFields}. */
export function useAutomationTiming(when: AutomationWhen | null, tz: string) {
  const [start] = useState(() => initialTiming(when, tz));
  const [mode, setMode] = useState<Mode>(start.mode);
  const [date, setDate] = useState(start.date);
  const [onceTime, setOnceTime] = useState(start.onceTime);
  const [repeatTime, setRepeatTime] = useState(start.repeatTime);
  const [quick, setQuick] = useState<RepeatQuick>(start.quick);
  const [customRule, setCustomRule] = useState(start.customRule);
  const [firstOpen, setFirstOpen] = useState(start.firstOpen);
  const [firstOpenAfter, setFirstOpenAfter] = useState(start.firstOpenAfter);
  const [everyCount, setEveryCount] = useState(start.everyCount);
  const [everyUnit, setEveryUnit] = useState<'h' | 'm'>(start.everyUnit);
  const [firstDate, setFirstDate] = useState(start.firstDate);
  const [firstTime, setFirstTime] = useState(start.firstTime);
  const [firstTouched, setFirstTouched] = useState(false);
  const [windowStart, setWindowStart] = useState(start.windowStart);
  const [windowEnd, setWindowEnd] = useState(start.windowEnd);
  const [dirty, setDirty] = useState(false);

  const touch =
    <T,>(set: (v: T) => void) =>
    (value: T) => {
      set(value);
      setDirty(true);
    };

  const repeatChoice: RepeatChoice = firstOpen ? 'first_open' : quick.choice;
  const windowError = mode === 'every' ? windowProblem(windowStart, windowEnd) : null;
  const windowed = mode === 'every' && windowStart !== '' && windowEnd !== '' && !windowError;

  const valid =
    mode === 'once'
      ? /^\d{4}-\d{2}-\d{2}$/.test(date) && /^\d{2}:\d{2}$/.test(onceTime)
      : mode === 'repeat'
        ? customRule || TIME.test(firstOpen ? firstOpenAfter : repeatTime)
        : /^[1-9]\d{0,5}$/.test(everyCount.trim()) &&
          !windowError &&
          (windowed || (firstDate === '' && firstTime === '')
            ? true
            : /^\d{4}-\d{2}-\d{2}$/.test(firstDate) && /^\d{2}:\d{2}$/.test(firstTime));

  /** The timing to send, or null to keep the stored one (untouched, or a custom rule kept). */
  const input = (): AutomationWhenInput | null => {
    if (mode === 'repeat' && customRule) return null;
    if (mode === 'once') return { at: `${date}T${onceTime}`, tz };
    if (mode === 'repeat' && firstOpen) return { first_open: true, after: firstOpenAfter, tz };
    if (mode === 'repeat') return { repeat: quickRepeatRule(quick), at: repeatTime, tz };
    const every = `${Math.trunc(Number(everyCount))}${everyUnit}`;
    // A window sets the phase itself (runs from its start), so no first run goes with it.
    if (windowed) return { every, window_start: windowStart, window_end: windowEnd, tz };
    if (firstTouched) {
      if (firstDate) return { every, at: `${firstDate}T${firstTime}`, tz };
      // Cleared: start from now (the server would keep the stored phase).
      return start.anchorWall
        ? { every, at: instantToWallTime(new Date(), tz).slice(0, 16), tz }
        : { every, tz };
    }
    // Untouched: a changed length sends the stored anchor so the phase stays
    // (the server re-anchors to now when no `at` comes); the same length sends
    // none and the server keeps it.
    const ms = Number(every.slice(0, -1)) * (everyUnit === 'h' ? 3_600_000 : 60_000);
    return start.anchorWall && ms !== start.everyMs
      ? { every, at: start.anchorWall, tz }
      : { every, tz };
  };

  return {
    tz,
    mode,
    setMode: touch(setMode),
    date,
    setDate: touch(setDate),
    onceTime,
    setOnceTime: touch(setOnceTime),
    repeatTime,
    setRepeatTime: touch(setRepeatTime),
    quick,
    setQuick: touch(setQuick),
    firstOpen,
    /** The Repeat choice shown: a quick rule's, or `first_open`. */
    repeatChoice,
    setRepeatChoice: (choice: RepeatChoice) => {
      if (choice === 'first_open') setFirstOpen(true);
      else {
        setFirstOpen(false);
        setQuick({ ...quick, choice });
      }
      setDirty(true);
    },
    firstOpenAfter,
    setFirstOpenAfter: touch(setFirstOpenAfter),
    customRule,
    replaceCustomRule: () => {
      setCustomRule(false);
      setDirty(true);
    },
    everyCount,
    setEveryCount: touch(setEveryCount),
    everyUnit,
    setEveryUnit: touch(setEveryUnit),
    firstDate,
    setFirstDate: (v: string) => {
      setFirstDate(v);
      setFirstTouched(true);
      setDirty(true);
    },
    firstTime,
    setFirstTime: (v: string) => {
      setFirstTime(v);
      setFirstTouched(true);
      setDirty(true);
    },
    windowStart,
    setWindowStart: touch(setWindowStart),
    windowEnd,
    setWindowEnd: touch(setWindowEnd),
    windowed,
    windowError,
    dirty,
    valid,
    input,
  };
}

type AutomationTiming = ReturnType<typeof useAutomationTiming>;

export interface AutomationTimingFieldsProps {
  timing: AutomationTiming;
  /** The stored timing in words, shown for a rule the quick choices can't edit. */
  whenText?: string;
}

export function AutomationTimingFields({ timing: t, whenText }: AutomationTimingFieldsProps) {
  const id = useId();
  return (
    <div className={styles.timing} role="group" aria-labelledby={`${id}-timing`}>
      <span id={`${id}-timing`} className={styles.label}>
        When
      </span>
      <Segmented value={t.mode} onChange={(v) => t.setMode(v as Mode)} aria-label="Timing">
        <Segmented.Option value="once">Once</Segmented.Option>
        <Segmented.Option value="repeat">Repeat</Segmented.Option>
        <Segmented.Option value="every">Every</Segmented.Option>
      </Segmented>

      {t.mode === 'once' && (
        <div className={styles.row}>
          <DateInput aria-label="Date" value={t.date} onChange={t.setDate} size="sm" />
          <DateInput
            aria-label="Time"
            type="time"
            value={t.onceTime}
            onChange={t.setOnceTime}
            size="sm"
          />
        </div>
      )}

      {t.mode === 'repeat' && t.customRule && (
        <div className={styles.row}>
          <span className={styles.rule} data-custom-rule="">
            {whenText}
          </span>
          <Button type="button" size="sm" variant="ghost" onClick={t.replaceCustomRule}>
            Change to…
          </Button>
        </div>
      )}

      {t.mode === 'repeat' && !t.customRule && (
        <div className={styles.row}>
          <Select
            aria-label="Repeats"
            size="sm"
            value={t.repeatChoice}
            onChange={(e) => t.setRepeatChoice(e.target.value as RepeatChoice)}
          >
            {CHOICES.map((c) => (
              <option key={c.value} value={c.value}>
                {c.label}
              </option>
            ))}
          </Select>
          {!t.firstOpen && t.quick.choice === 'weekly' && (
            <Select
              aria-label="Day"
              size="sm"
              value={t.quick.weekday ?? 'MO'}
              onChange={(e) =>
                t.setQuick({ ...t.quick, weekday: e.target.value as RepeatWeekdayCode })
              }
            >
              {REPEAT_WEEKDAY_CODES.map((code) => (
                <option key={code} value={code}>
                  {WEEKDAY_NAMES[code]}
                </option>
              ))}
            </Select>
          )}
          {!t.firstOpen && t.quick.choice === 'monthly' && (
            <Select
              aria-label="Date of the month"
              size="sm"
              value={String(t.quick.monthDay ?? 1)}
              onChange={(e) => t.setQuick({ ...t.quick, monthDay: Number(e.target.value) })}
            >
              {Array.from({ length: 31 }, (_, i) => i + 1).map((d) => (
                <option key={d} value={String(d)}>
                  {d}
                </option>
              ))}
            </Select>
          )}
          {t.firstOpen ? (
            <>
              <span className={styles.at}>after</span>
              <DateInput
                aria-label="Earliest time"
                type="time"
                value={t.firstOpenAfter}
                onChange={t.setFirstOpenAfter}
                size="sm"
              />
            </>
          ) : (
            <>
              <span className={styles.at}>at</span>
              <DateInput
                aria-label="Time"
                type="time"
                value={t.repeatTime}
                onChange={t.setRepeatTime}
                size="sm"
              />
            </>
          )}
        </div>
      )}

      {t.mode === 'every' && (
        <div className={styles.row}>
          <TextInput
            aria-label="How many"
            inputMode="numeric"
            size="sm"
            value={t.everyCount}
            onChange={(e) => t.setEveryCount(e.target.value)}
            className={styles.count}
          />
          <Select
            aria-label="Unit"
            size="sm"
            value={t.everyUnit}
            onChange={(e) => t.setEveryUnit(e.target.value as 'h' | 'm')}
          >
            <option value="m">minutes</option>
            <option value="h">hours</option>
          </Select>
          {!t.windowed && (
            <>
              <span className={styles.at}>from</span>
              <DateInput
                aria-label="First run date"
                value={t.firstDate}
                onChange={t.setFirstDate}
                size="sm"
              />
              <DateInput
                aria-label="First run time"
                type="time"
                value={t.firstTime}
                onChange={t.setFirstTime}
                size="sm"
              />
            </>
          )}
        </div>
      )}
      {t.mode === 'every' && (
        <div className={styles.row}>
          <span className={styles.at}>only between</span>
          <DateInput
            aria-label="Window start"
            type="time"
            value={t.windowStart}
            onChange={t.setWindowStart}
            size="sm"
          />
          <span className={styles.at}>and</span>
          <DateInput
            aria-label="Window end"
            type="time"
            value={t.windowEnd}
            onChange={t.setWindowEnd}
            size="sm"
          />
        </div>
      )}
      {t.windowError && (
        <span className={styles.error} role="alert">
          {t.windowError}
        </span>
      )}
      <span className={styles.hint}>
        {t.mode === 'repeat' && t.firstOpen && !t.customRule
          ? `Once a day, the first time Snaglet is open and the computer awake at or after ${formatTimeOfDay(t.firstOpenAfter)}, in ${t.tz}. A day Snaglet isn't open is skipped.`
          : t.mode !== 'every'
            ? `Times in ${t.tz}.`
            : t.windowed
              ? `Runs at ${formatTimeOfDay(t.windowStart)}, then each interval up to ${formatTimeOfDay(t.windowEnd)}, every day, in ${t.tz}.`
              : `First run, in ${t.tz}. Leave as is to keep the current phase; clear to start from now. Optionally only between two times each day.`}
      </span>
    </div>
  );
}
