/**
 * A searchable dropdown for the calendar popovers (the Calendar and Table
 * field pickers in quick add and the event popover): a field-shaped trigger
 * showing the choice, and a floating list with a search box.
 *
 * Keyboard: on the trigger, ↓ / ↑ / Enter / Space open it, and typing a
 * letter opens it filtered by that letter. In the list, typing filters,
 * ↑ / ↓ / Home / End move, Enter picks, Escape and Tab close it. Escape is
 * claimed here, so it never also closes the popover the picker sits in. A
 * press outside closes it. Focus goes back to the trigger when it closes.
 */
import { useId, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { TextInput } from '@desktop/components';
import { usePointerMoveGate } from '@desktop/hooks/usePointerMoveGate';
import { LeafToggle } from '@desktop/components/Icons';
import { cn } from '@desktop/utils/classNames';
import { AnchoredSurface } from './AnchoredSurface';
import { calendarColorProps } from './calendarColors';
import styles from './CalendarPopovers.module.scss';

export interface SearchSelectOption {
  value: string;
  label: string;
  /** Muted text after the label (e.g. "Date & time"). */
  detail?: string;
  /** A calendar color (palette id, theme token or hex): the option wears a dot of it. */
  color?: string;
  /** A leading glyph instead of a dot. */
  icon?: ReactNode;
  /** A choice of nothing (e.g. "No calendar"): its label reads muted. */
  muted?: boolean;
}

interface SearchSelectProps {
  /** Accessible name of the control and of its list ("Calendar"). */
  label: string;
  value: string;
  options: readonly SearchSelectOption[];
  onChange: (value: string) => void;
  searchPlaceholder?: string;
  /** Shown when nothing matches the search. */
  emptyText?: string;
  disabled?: boolean;
  id?: string;
  className?: string;
}

/** @public Options whose label or detail holds `query` (any case); unit-tested. */
export function filterOptions(
  options: readonly SearchSelectOption[],
  query: string
): SearchSelectOption[] {
  const q = query.trim().toLowerCase();
  if (!q) return [...options];
  return options.filter((o) => `${o.label} ${o.detail ?? ''}`.toLowerCase().includes(q));
}

function Lead({ option }: { option: SearchSelectOption }) {
  if (option.icon) {
    return (
      <span className={styles.selectIcon} aria-hidden>
        {option.icon}
      </span>
    );
  }
  if (option.color) {
    return <span className={styles.swatch} {...calendarColorProps(option.color)} aria-hidden />;
  }
  return null;
}

export function SearchSelect({
  label,
  value,
  options,
  onChange,
  searchPlaceholder = 'Search',
  emptyText = 'No matches',
  disabled,
  id,
  className,
}: SearchSelectProps) {
  const uid = useId();
  const listId = `${uid}-list`;
  const triggerRef = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  // Hover moves the highlight only once the pointer really moves: options
  // that appear under a resting pointer must not take Enter.
  const pointer = usePointerMoveGate();
  const selected = options.find((o) => o.value === value);
  const shown = useMemo(() => filterOptions(options, query), [options, query]);

  const openWith = (initial: string) => {
    if (disabled) return;
    const list = filterOptions(options, initial);
    const at = list.findIndex((o) => o.value === value);
    setQuery(initial);
    setActive(initial ? 0 : Math.max(0, at));
    pointer.reset();
    setOpen(true);
  };
  const close = () => setOpen(false);
  const pick = (option: SearchSelectOption | undefined) => {
    if (!option) return;
    close();
    if (option.value !== value) onChange(option.value);
  };

  const onTriggerKeyDown = (e: KeyboardEvent<HTMLButtonElement>) => {
    if (open || e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      openWith('');
    } else if (e.key.length === 1 && e.key !== ' ') {
      e.preventDefault();
      openWith(e.key);
    }
  };

  const onSearchKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    const last = shown.length - 1;
    const move = (to: number) => {
      e.preventDefault();
      setActive(Math.max(0, Math.min(last, to)));
    };
    switch (e.key) {
      case 'ArrowDown':
        return move(active + 1);
      case 'ArrowUp':
        return move(active - 1);
      case 'Home':
        return move(0);
      case 'End':
        return move(last);
      case 'Enter':
        // Never the form's implicit submit: Enter here picks.
        e.preventDefault();
        e.stopPropagation();
        pick(shown[active]);
        return;
      case 'Escape':
        // The picker's, not the popover's around it.
        e.preventDefault();
        e.stopPropagation();
        close();
        return;
      case 'Tab':
        close();
        return;
      default:
    }
  };

  const activeId = shown[active] ? `${uid}-opt-${active}` : undefined;

  return (
    <>
      <button
        ref={triggerRef}
        id={id}
        type="button"
        className={cn(styles.selectTrigger, className)}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-label={`${label}: ${selected?.label ?? 'None'}`}
        disabled={disabled}
        data-search-select={uid}
        onClick={() => (open ? close() : openWith(''))}
        onKeyDown={onTriggerKeyDown}
      >
        {selected && <Lead option={selected} />}
        <span className={cn(styles.selectValue, selected?.muted && styles.selectMuted)}>
          {selected?.label ?? 'None'}
        </span>
        {selected?.detail && <span className={styles.selectDetail}>{selected.detail}</span>}
        <LeafToggle open={open} className={styles.selectChevron} />
      </button>
      {open && triggerRef.current && (
        <AnchoredSurface
          anchor={triggerRef.current}
          label={label}
          width={Math.max(240, triggerRef.current.offsetWidth)}
          onDismiss={close}
          // The trigger toggles on its own click; a press on it isn't "outside".
          keepOpenSelector={`[data-search-select="${uid}"]`}
          className={styles.selectSurface}
        >
          <TextInput
            size="sm"
            data-autofocus=""
            role="combobox"
            aria-label={`Search ${label.toLowerCase()}`}
            aria-expanded
            aria-controls={listId}
            aria-autocomplete="list"
            aria-activedescendant={activeId}
            placeholder={searchPlaceholder}
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setActive(0);
              pointer.reset();
            }}
            onKeyDown={onSearchKeyDown}
          />
          <div id={listId} role="listbox" aria-label={label} className={styles.selectList}>
            {shown.length === 0 && <p className={styles.muted}>{emptyText}</p>}
            {shown.map((option, index) => (
              <div
                key={option.value}
                id={`${uid}-opt-${index}`}
                role="option"
                aria-selected={option.value === value}
                className={cn(styles.selectOption, index === active && styles.selectOptionActive)}
                // Keep focus in the search box; the click picks.
                onMouseDown={(e) => e.preventDefault()}
                onMouseMove={(e) => {
                  if (pointer.moved(e)) setActive(index);
                }}
                onClick={() => pick(option)}
              >
                <Lead option={option} />
                <span className={cn(styles.selectValue, option.muted && styles.selectMuted)}>
                  {option.label}
                </span>
                {option.detail && <span className={styles.selectDetail}>{option.detail}</span>}
              </div>
            ))}
          </div>
        </AnchoredSurface>
      )}
    </>
  );
}
