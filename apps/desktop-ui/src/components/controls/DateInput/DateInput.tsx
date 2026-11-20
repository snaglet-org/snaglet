import {
  forwardRef,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type FocusEvent,
  type InputHTMLAttributes,
  type KeyboardEvent,
  type Ref,
} from 'react';
import { userTimeZone } from '@snaglet/shared/utils';
import { todayIn } from '@desktop/features/calendar/calendarDates';
import { useCalendarWeekStart } from '@desktop/features/calendar/weekStart';
import { cn } from '@desktop/utils/classNames';
import { DatePicker, type DatePickerAddon, type PickerRange } from './DatePicker';
import {
  dayOf,
  defaultLocale,
  formatValue,
  isWireValue,
  parseTyped,
  rangeProblem,
  type PickerKind,
} from './dateText';
import { DATE_PENDING_ATTR } from './pickerLayer';
import styles from './DateInput.module.scss';

type DateInputSize = 'sm' | 'md' | 'lg';

export interface DateInputProps extends Omit<
  InputHTMLAttributes<HTMLInputElement>,
  'size' | 'type' | 'onChange'
> {
  /** The native wire value: `YYYY-MM-DD`, `YYYY-MM-DDTHH:mm[:ss]`, `HH:mm`, or `''`. */
  value: string;
  onChange: (next: string) => void;
  size?: DateInputSize;
  /** Stretch to fill the parent. Default: false (inline-flex shrink-to-content). */
  fullWidth?: boolean;
  /** Which picker: "date" (default), "datetime-local", "time"; "month" and "week" stay native. */
  type?: 'date' | 'datetime-local' | 'time' | 'month' | 'week';
  /**
   * This field is the Start or End of a range, and `other` the other end's
   * wire value (`''` when empty): the picker bands the days between them,
   * shows both ends as picked and, on the End, previews the range under the
   * pointer.
   */
  range?: { part: 'start' | 'end'; other: string };
  /**
   * The host's additions to the picker card (the table's Repeat row and
   * view). Leave out for a plain date field.
   */
  pickerAddon?: DatePickerAddon;
  /** Open the picker as the field mounts, focus inside it (the ↻ chip opens it so). */
  defaultOpen?: boolean;
  /** The picker opened or closed. */
  onOpenChange?: (open: boolean) => void;
}

const sizeClassMap: Record<DateInputSize, string> = {
  sm: styles.sizeSm,
  md: styles.sizeMd,
  lg: styles.sizeLg,
};

const PLACEHOLDER: Record<PickerKind, string> = {
  date: 'Pick a date',
  'datetime-local': 'Pick a date and time',
  time: 'Pick a time',
};

const DIALOG_LABEL: Record<PickerKind, string> = {
  date: 'Choose date',
  'datetime-local': 'Choose date and time',
  time: 'Choose time',
};

const CLEAR_NOUN: Record<PickerKind, string> = {
  date: 'date',
  'datetime-local': 'date and time',
  time: 'time',
};

/** Characters the field shows at its natural width ("Tue, Oct 13, 2026"). */
const FIELD_CHARS: Record<PickerKind, number> = { date: 16, 'datetime-local': 20, time: 8 };

type Problem = 'unreadable' | 'before-min' | 'after-max';

const EXAMPLES: Record<PickerKind, string> = {
  date: '10/13, Oct 13 or tomorrow',
  'datetime-local': 'tomorrow 9am or Oct 13 2:30pm',
  time: '9:30, 930p or noon',
};

/** The picker's one-line hint for text the field refused. */
function problemText(
  kind: PickerKind,
  problem: Problem,
  text: string,
  at: { minText?: string; maxText?: string; today: string; locale: string }
): string {
  if (problem === 'before-min' && at.minText)
    return `Pick ${formatValue(kind, at.minText, at)} or later.`;
  if (problem === 'after-max' && at.maxText)
    return `Pick ${formatValue(kind, at.maxText, at)} or earlier.`;
  return `Couldn’t read “${text.trim()}”. Try ${EXAMPLES[kind]}.`;
}

/** Native `step` is seconds; rows are 15 minutes unless the step is coarser than a minute. */
function stepMinutes(step: DateInputProps['step']): number {
  const seconds = Number(step);
  if (!Number.isFinite(seconds) || seconds <= 60) return 15;
  return Math.max(1, Math.min(720, Math.round(seconds / 60)));
}

function assignRef<T>(ref: Ref<T> | undefined, value: T | null) {
  if (typeof ref === 'function') ref(value);
  else if (ref) (ref as { current: T | null }).current = value;
}

/**
 * DateInput — Snaglet's own date, time and date-time field.
 *
 * Shows the value for the viewer's locale ("Tue, Oct 13, 2026", "Oct 13,
 * 9:00 AM", "9:00 AM") and reads what is typed: ISO, `10/13`, `oct 13`,
 * `tomorrow`, `930p`, `noon`… A complete ISO value takes effect at once; any
 * other text on Enter or blur, and text that doesn't read marks the field
 * invalid and keeps the last good value. Click, ↓/Alt+↓, Space (when nothing
 * is typed) or Enter (outside a form, when no host takes it) opens the
 * picker card; × clears an optional field.
 *
 * Same props as the native input it replaces, in the same wire formats, so
 * callers keep working. `month` and `week` still render the native control.
 */
export const DateInput = forwardRef<HTMLInputElement, DateInputProps>(
  ({ type = 'date', ...props }, ref) =>
    type === 'month' || type === 'week' ? (
      <NativeDateInput ref={ref} type={type} {...props} />
    ) : (
      <PickerField ref={ref} kind={type} {...props} />
    )
);

DateInput.displayName = 'DateInput';

type FieldProps = Omit<DateInputProps, 'type'> & { kind: PickerKind };

interface Draft {
  text: string;
  /** The wire value the text already stands for (a typed ISO), or null while it waits for Enter/blur. */
  committed: string | null;
}

const PickerField = forwardRef<HTMLInputElement, FieldProps>(function PickerField(
  {
    kind,
    value,
    onChange,
    size = 'md',
    fullWidth,
    className,
    disabled,
    readOnly,
    required,
    min,
    max,
    step,
    placeholder,
    name,
    form,
    onKeyDown,
    onBlur,
    onFocus,
    onClick,
    onMouseDown,
    onMouseUp,
    range,
    pickerAddon,
    defaultOpen = false,
    onOpenChange,
    'aria-invalid': ariaInvalid,
    ...rest
  },
  ref
) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const setInput = useCallback(
    (el: HTMLInputElement | null) => {
      inputRef.current = el;
      assignRef(ref, el);
    },
    [ref]
  );
  const [wrapper, setWrapper] = useState<HTMLSpanElement | null>(null);
  const pickerId = useId();
  const locale = useMemo(defaultLocale, []);
  // The Calendar's own week start, so the picker's weeks match its grid.
  const weekStart = useCalendarWeekStart();
  const today = todayIn(userTimeZone());
  const minText = min === undefined || min === '' ? undefined : String(min);
  const maxText = max === undefined || max === '' ? undefined : String(max);
  const interactive = !disabled && !readOnly;

  const [draft, setDraft] = useState<Draft | null>(null);
  const draftRef = useRef<Draft | null>(null);
  const writeDraft = (next: Draft | null) => {
    draftRef.current = next;
    setDraft(next);
  };
  const [problem, setProblem] = useState<Problem | null>(null);
  const invalid = problem !== null;
  const [open, setOpenState] = useState<{ keyboard: boolean } | null>(() =>
    defaultOpen && interactive ? { keyboard: true } : null
  );
  const openChange = useRef(onOpenChange);
  openChange.current = onOpenChange;
  const setOpen = (next: { keyboard: boolean } | null) => {
    setOpenState(next);
    if ((next !== null) !== (open !== null)) openChange.current?.(next !== null);
  };
  const [focusRequest, setFocusRequest] = useState(0);
  const selectOnMouseUp = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  // A typed ISO keeps its text while the value still matches it.
  const shown = draft !== null && (draft.committed === null || draft.committed === value);
  const text = shown ? draft.text : formatValue(kind, value, { today, locale });
  const pending = shown && draft.committed === null;
  const context = { today, locale, current: value, min: minText, max: maxText };
  const previewOutcome = pending ? parseTyped(kind, draft.text, context) : null;
  const preview = previewOutcome?.ok && previewOutcome.value ? previewOutcome.value : null;
  const storedBad = value !== '' && !isWireValue(kind, value);
  const pickerRange: PickerRange | undefined =
    range && kind !== 'time' ? { part: range.part, otherDay: dayOf(kind, range.other) } : undefined;

  const commit = (next: string) => {
    if (next !== value) onChange(next);
  };

  /** Take the typed text; false when it doesn't read (the field shows why). */
  const commitDraft = (): boolean => {
    const current = draftRef.current;
    if (!current) return true;
    if (current.committed !== null) {
      writeDraft(null);
      return true;
    }
    const outcome = parseTyped(kind, current.text, context);
    if (!outcome.ok) {
      setProblem(outcome.reason);
      return false;
    }
    writeDraft(null);
    setProblem(null);
    commit(outcome.value);
    return true;
  };

  const isPending = () => draftRef.current !== null && draftRef.current.committed === null;

  const openPicker = (keyboard: boolean) => {
    if (interactive) setOpen({ keyboard });
  };
  const closePicker = (returnFocus: boolean) => {
    if (returnFocus) inputRef.current?.focus({ preventScroll: true });
    setOpen(null);
  };

  const onPick = (next: string, close: boolean) => {
    writeDraft(null);
    setProblem(null);
    commit(next);
    if (close) closePicker(true);
  };

  const handleKey = (event: KeyboardEvent<HTMLInputElement>) => {
    if (!interactive) return;
    const { key } = event;
    if (key === 'ArrowDown' && !event.metaKey && !event.ctrlKey && !event.shiftKey) {
      event.preventDefault();
      if (open) setFocusRequest((n) => n + 1);
      else openPicker(true);
      return;
    }
    if (key === 'ArrowUp' && event.altKey && open) {
      event.preventDefault();
      closePicker(false);
      return;
    }
    if (key === 'Enter') {
      if (isPending()) {
        // Unreadable text stays put: no cell commit, no form submit with a stale value.
        if (!commitDraft()) {
          event.preventDefault();
          event.stopPropagation();
          return;
        }
        if (open) closePicker(false);
        return;
      }
      if (draftRef.current) writeDraft(null);
      if (open) {
        closePicker(false);
        return;
      }
      // Nothing typed: Enter opens the picker, unless a host takes it (a grid
      // cell commits) or a form submits.
      if (inputRef.current?.form) return;
      const native = event.nativeEvent;
      queueMicrotask(() => {
        if (
          !native.defaultPrevented &&
          mounted.current &&
          document.activeElement === inputRef.current
        )
          openPicker(true);
      });
      return;
    }
    if (key === ' ' && draftRef.current === null && !open) {
      event.preventDefault();
      openPicker(true);
      return;
    }
    if (key === 'Escape' && isPending()) {
      // Revert the typing first; a second Escape reaches the host.
      event.preventDefault();
      writeDraft(null);
      setProblem(null);
      return;
    }
    if (key === 'Tab' && open) closePicker(false);
  };

  const onInputBlur = (event: FocusEvent<HTMLInputElement>) => {
    const next = event.relatedTarget;
    commitDraft();
    if (
      open &&
      next instanceof Node &&
      !document.getElementById(pickerId)?.contains(next) &&
      !wrapper?.contains(next)
    )
      closePicker(false);
    onBlur?.(event);
  };

  const showClear = interactive && !required && (value !== '' || (draft?.text ?? '') !== '');

  return (
    <span
      ref={setWrapper}
      className={cn(
        styles.wrapper,
        sizeClassMap[size],
        fullWidth && styles.fullWidth,
        disabled && styles.disabled,
        (invalid || storedBad) && styles.invalid,
        open && styles.open,
        className
      )}
      data-date-input=""
    >
      <input
        ref={setInput}
        type="text"
        role="combobox"
        aria-haspopup="dialog"
        aria-expanded={open !== null}
        aria-controls={open ? pickerId : undefined}
        aria-invalid={invalid || storedBad || ariaInvalid === true || ariaInvalid === 'true'}
        autoComplete="off"
        spellCheck={false}
        size={FIELD_CHARS[kind]}
        placeholder={placeholder ?? PLACEHOLDER[kind]}
        disabled={disabled}
        readOnly={readOnly}
        required={required}
        value={text}
        data-value={value}
        data-type={kind}
        {...(pending ? { [DATE_PENDING_ATTR]: '' } : {})}
        className={styles.input}
        {...rest}
        onChange={(event) => {
          if (!interactive) return;
          const raw = event.target.value;
          const trimmed = raw.trim();
          setProblem(null);
          if (
            trimmed === '' ||
            (isWireValue(kind, trimmed) && !rangeProblem(kind, trimmed, minText, maxText))
          ) {
            writeDraft({ text: raw, committed: trimmed });
            commit(trimmed);
          } else {
            writeDraft({ text: raw, committed: null });
          }
        }}
        onKeyDown={(event) => {
          handleKey(event);
          onKeyDown?.(event);
        }}
        onFocus={(event) => {
          if (interactive) event.currentTarget.select();
          onFocus?.(event);
        }}
        onBlur={onInputBlur}
        onMouseDown={(event) => {
          if (document.activeElement !== event.currentTarget) selectOnMouseUp.current = true;
          onMouseDown?.(event);
        }}
        onMouseUp={(event) => {
          // A click that focuses the field selects it all, so typing replaces.
          const input = event.currentTarget;
          if (selectOnMouseUp.current && input.selectionStart === input.selectionEnd)
            input.select();
          selectOnMouseUp.current = false;
          onMouseUp?.(event);
        }}
        onClick={(event) => {
          if (!open) openPicker(false);
          onClick?.(event);
        }}
      />
      {showClear && (
        <button
          type="button"
          className={styles.clear}
          tabIndex={-1}
          aria-label={`Clear ${rest['aria-label'] ?? CLEAR_NOUN[kind]}`}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => {
            writeDraft(null);
            setProblem(null);
            commit('');
            if (open) closePicker(false);
            inputRef.current?.focus({ preventScroll: true });
          }}
        >
          <svg viewBox="0 0 10 10" width="8" height="8" aria-hidden="true">
            <path
              d="M2 2l6 6M8 2 2 8"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
            />
          </svg>
        </button>
      )}
      <span
        className={styles.glyph}
        aria-hidden="true"
        onMouseDown={(event) => {
          event.preventDefault();
          if (!interactive) return;
          if (document.activeElement !== inputRef.current)
            inputRef.current?.focus({ preventScroll: true });
          if (open) closePicker(false);
          else openPicker(false);
        }}
      >
        {kind === 'time' ? <ClockGlyph /> : <CalendarGlyph />}
      </span>
      {name && <input type="hidden" name={name} form={form} value={value} />}
      {open && wrapper && (
        <DatePicker
          id={pickerId}
          anchor={wrapper}
          kind={kind}
          value={isWireValue(kind, value) ? value : ''}
          preview={preview}
          min={minText}
          max={maxText}
          step={stepMinutes(step)}
          clearable={!required}
          locale={locale}
          today={today}
          weekStart={weekStart}
          focusOnOpen={open.keyboard}
          focusRequest={focusRequest}
          label={DIALOG_LABEL[kind]}
          range={pickerRange}
          addon={pickerAddon}
          onCommit={onPick}
          onClose={closePicker}
          problem={
            problem && draft
              ? problemText(kind, problem, draft.text, { minText, maxText, today, locale })
              : null
          }
        />
      )}
    </span>
  );
});

function CalendarGlyph() {
  return (
    <svg
      viewBox="0 0 14 14"
      width="13"
      height="13"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.2"
    >
      <rect x="1.75" y="2.75" width="10.5" height="9.5" rx="2.25" />
      <path d="M1.75 5.75h10.5M4.75 1.5v2.25M9.25 1.5v2.25" strokeLinecap="round" />
      <circle cx="9.25" cy="9" r="0.9" fill="currentColor" stroke="none" />
    </svg>
  );
}

function ClockGlyph() {
  return (
    <svg
      viewBox="0 0 14 14"
      width="13"
      height="13"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.2"
    >
      <circle cx="7" cy="7" r="5.25" />
      <path d="M7 4.25V7l1.9 1.25" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/** `month` and `week`: the native control, in the same rounded shell. */
const NativeDateInput = forwardRef<
  HTMLInputElement,
  Omit<DateInputProps, 'type'> & { type: 'month' | 'week' }
>(function NativeDateInput(
  {
    value,
    onChange,
    size = 'md',
    fullWidth,
    type,
    className,
    disabled,
    range: _range,
    pickerAddon: _addon,
    defaultOpen: _defaultOpen,
    onOpenChange: _onOpenChange,
    ...rest
  },
  ref
) {
  return (
    <span
      className={cn(
        styles.wrapper,
        styles.native,
        sizeClassMap[size],
        fullWidth && styles.fullWidth,
        disabled && styles.disabled,
        className
      )}
    >
      <input
        ref={ref}
        type={type}
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
        className={styles.input}
        {...rest}
      />
      <span className={styles.glyph} aria-hidden="true">
        <CalendarGlyph />
      </span>
    </span>
  );
});
