import {
  createContext,
  forwardRef,
  useCallback,
  useContext,
  useRef,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from 'react';
import styles from './Segmented.module.scss';
import { cn } from '@desktop/utils/classNames';

type SegmentedSize = 'sm' | 'md';

interface SegmentedContextValue {
  value: string;
  onChange: (next: string) => void;
}

const SegmentedContext = createContext<SegmentedContextValue | null>(null);

function useSegmentedContext(): SegmentedContextValue {
  const ctx = useContext(SegmentedContext);
  if (!ctx) {
    throw new Error('<Segmented.Option> must be rendered inside a <Segmented> parent.');
  }
  return ctx;
}

interface SegmentedProps {
  /** Currently-selected option value. */
  value: string;
  /** Called with the next value when the user picks a different option. */
  onChange: (next: string) => void;
  size?: SegmentedSize;
  /** Fill the row, with the options sharing its width evenly (no empty strip after the last). */
  fullWidth?: boolean;
  /** Accessible name for the segmented control's radio group. */
  'aria-label'?: string;
  className?: string;
  children: ReactNode;
}

/**
 * Segmented — in-place single-choice control with `role="radiogroup"`
 * semantics. Use for switching a setting within the current view
 * (e.g. Icons vs List rendering of the same folder); use <Tabs> for
 * navigating between distinct view contents.
 *
 * Keyboard: Arrow keys move + select within the group. Home/End jump
 * to the ends. Standard ARIA radiogroup pattern.
 */
const SegmentedInner = forwardRef<HTMLDivElement, SegmentedProps>(
  (
    { value, onChange, size = 'md', fullWidth, className, children, 'aria-label': ariaLabel },
    ref
  ) => {
    const listRef = useRef<HTMLDivElement>(null);

    const handleKeyDown = useCallback(
      (e: ReactKeyboardEvent<HTMLDivElement>) => {
        if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(e.key)) {
          return;
        }
        e.preventDefault();
        const root = listRef.current;
        if (!root) return;
        const opts = Array.from(
          root.querySelectorAll<HTMLButtonElement>('[role="radio"]:not(:disabled)')
        );
        if (opts.length === 0) return;
        const currentIdx = opts.findIndex((b) => b.getAttribute('data-value') === value);
        const next = e.key === 'ArrowRight' || e.key === 'ArrowDown';
        let targetIdx: number;
        if (e.key === 'Home') targetIdx = 0;
        else if (e.key === 'End') targetIdx = opts.length - 1;
        else if (next) targetIdx = currentIdx >= 0 ? (currentIdx + 1) % opts.length : 0;
        else targetIdx = currentIdx >= 0 ? (currentIdx - 1 + opts.length) % opts.length : 0;
        const target = opts[targetIdx];
        const targetValue = target?.getAttribute('data-value');
        if (targetValue) {
          onChange(targetValue);
          target?.focus();
        }
      },
      [value, onChange]
    );

    const ctx: SegmentedContextValue = { value, onChange };

    return (
      <SegmentedContext.Provider value={ctx}>
        <div
          ref={ref ?? listRef}
          role="radiogroup"
          aria-label={ariaLabel}
          onKeyDown={handleKeyDown}
          className={cn(
            styles.group,
            size === 'sm' ? styles.sizeSm : styles.sizeMd,
            fullWidth && styles.fullWidth,
            className
          )}
        >
          {children}
        </div>
      </SegmentedContext.Provider>
    );
  }
);

SegmentedInner.displayName = 'Segmented';

interface SegmentedOptionProps {
  value: string;
  disabled?: boolean;
  'aria-label'?: string;
  title?: string;
  className?: string;
  children: ReactNode;
}

const Option = forwardRef<HTMLButtonElement, SegmentedOptionProps>(
  ({ value, disabled, title, className, children, 'aria-label': ariaLabel }, ref) => {
    const { value: activeValue, onChange } = useSegmentedContext();
    const isActive = activeValue === value;
    return (
      <button
        ref={ref}
        type="button"
        role="radio"
        aria-checked={isActive}
        aria-label={ariaLabel}
        // Standard radiogroup pattern: only the checked option is in the
        // tab order; arrow keys move focus among the others.
        tabIndex={isActive ? 0 : -1}
        data-value={value}
        title={title}
        disabled={disabled}
        onClick={() => onChange(value)}
        className={cn(styles.option, isActive && styles.optionActive, className)}
      >
        {children}
      </button>
    );
  }
);

Option.displayName = 'Segmented.Option';

type SegmentedCompound = typeof SegmentedInner & {
  Option: typeof Option;
};
export const Segmented = SegmentedInner as SegmentedCompound;
Segmented.Option = Option;
