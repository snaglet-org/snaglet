import {
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type RefObject,
} from 'react';
import { cn } from '@desktop/utils/classNames';
import { formatTimeLabel, minutesOf, minutesToTime, parseTimeText } from './dateText';
import styles from './DatePicker.module.scss';

export interface TimeListProps {
  /** The selected wall time (`HH:mm[:ss]`), or `''`. */
  value: string;
  /** Minutes between rows. */
  step: number;
  locale: string;
  /** Minutes after midnight to scroll to when nothing is selected. */
  fallbackMinutes: number;
  isDisabled: (time: string) => boolean;
  onPick: (time: string, viaKeyboard: boolean) => void;
  listRef: RefObject<HTMLDivElement | null>;
  idPrefix: string;
  /** Bumped to move focus to the active row (after a day is picked from the keyboard). */
  focusRequest: number;
}

/**
 * The picker's time column: a typed entry on top (any form the field reads,
 * Enter picks it) and a scrollable list in `step` minutes that opens on the
 * selected or nearest row. ↑/↓ move, Home/End jump, PageUp/PageDown move an
 * hour, Enter or Space picks.
 */
export function TimeList({
  value,
  step,
  locale,
  fallbackMinutes,
  isDisabled,
  onPick,
  listRef,
  idPrefix,
  focusRequest,
}: TimeListProps) {
  const rows = useMemo(() => {
    const out: number[] = [];
    for (let m = 0; m < 1440; m += step) out.push(m);
    return out;
  }, [step]);
  const selected = minutesOf(value);
  const nearest = (minutes: number) =>
    rows.reduce(
      (best, m, i) => (Math.abs(m - minutes) < Math.abs(rows[best]! - minutes) ? i : best),
      0
    );
  const [active, setActive] = useState(() => nearest(selected ?? fallbackMinutes));
  const [entry, setEntry] = useState('');
  const [entryInvalid, setEntryInvalid] = useState(false);
  const focusPending = useRef(false);

  // Follow a new selection (a typed time, a day picked with a time).
  const [lastSelected, setLastSelected] = useState(selected);
  if (selected !== lastSelected) {
    setLastSelected(selected);
    if (selected !== null) setActive(nearest(selected));
  }

  // Center the active row: on open, and when the selection moves it.
  useLayoutEffect(() => {
    const list = listRef.current;
    const row = list?.querySelector<HTMLElement>(`[data-row="${active}"]`);
    if (!list || !row) return;
    if (focusPending.current) {
      focusPending.current = false;
      row.focus({ preventScroll: true });
    }
    const top = row.offsetTop;
    const bottom = top + row.offsetHeight;
    if (top < list.scrollTop || bottom > list.scrollTop + list.clientHeight)
      list.scrollTop = Math.max(0, top - (list.clientHeight - row.offsetHeight) / 2);
  }, [active, listRef]);

  const firstRequest = useRef(focusRequest);
  useLayoutEffect(() => {
    if (focusRequest === firstRequest.current) return;
    listRef.current
      ?.querySelector<HTMLElement>('[role="option"][tabindex="0"]')
      ?.focus({ preventScroll: true });
  }, [focusRequest, listRef]);

  const move = (index: number) => {
    focusPending.current = true;
    setActive(Math.max(0, Math.min(rows.length - 1, index)));
  };

  const onListKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const hour = Math.max(1, Math.round(60 / step));
    switch (event.key) {
      case 'ArrowDown':
        move(active + 1);
        break;
      case 'ArrowUp':
        move(active - 1);
        break;
      case 'PageDown':
        move(active + hour);
        break;
      case 'PageUp':
        move(active - hour);
        break;
      case 'Home':
        move(0);
        break;
      case 'End':
        move(rows.length - 1);
        break;
      case 'Enter':
      case ' ': {
        const time = minutesToTime(rows[active]!);
        if (!isDisabled(time)) onPick(time, true);
        break;
      }
      default:
        return;
    }
    event.preventDefault();
  };

  return (
    <div className={styles.timeColumn}>
      <input
        type="text"
        className={cn(styles.timeEntry, entryInvalid && styles.timeEntryInvalid)}
        aria-label="Type a time"
        aria-invalid={entryInvalid || undefined}
        placeholder="Type a time"
        autoComplete="off"
        spellCheck={false}
        value={entry}
        onChange={(event) => {
          setEntry(event.target.value);
          setEntryInvalid(false);
        }}
        onKeyDown={(event) => {
          if (event.key !== 'Enter') return;
          event.preventDefault();
          const time = parseTimeText(entry);
          if (!time || isDisabled(time)) {
            setEntryInvalid(true);
            return;
          }
          onPick(time, true);
        }}
      />
      <div
        ref={listRef}
        role="listbox"
        aria-label="Times"
        className={styles.timeList}
        onKeyDown={onListKeyDown}
      >
        {rows.map((minutes, index) => {
          const time = minutesToTime(minutes);
          const disabled = isDisabled(time);
          const isSelected = minutes === selected;
          return (
            <div
              key={minutes}
              id={`${idPrefix}-t${minutes}`}
              role="option"
              data-row={index}
              tabIndex={index === active ? 0 : -1}
              aria-selected={isSelected}
              aria-disabled={disabled || undefined}
              className={cn(
                styles.timeRow,
                isSelected && styles.timeSelected,
                disabled && styles.timeDisabled
              )}
              onFocus={() => setActive(index)}
              onClick={() => {
                if (!disabled) onPick(time, false);
              }}
            >
              {formatTimeLabel(minutes, locale)}
            </div>
          );
        })}
      </div>
    </div>
  );
}
