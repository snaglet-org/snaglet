import { type ReactNode } from 'react';
import styles from './OptionToggle.module.scss';
import { cn } from '@desktop/utils/classNames';

interface OptionToggleProps {
  /** Whether the option is on. */
  pressed: boolean;
  /** Called with the next state. */
  onChange: (next: boolean) => void;
  disabled?: boolean;
  /** The option's name, e.g. "Required". It is the button's accessible name. */
  children: ReactNode;
  /** Id of text that explains the option, such as a warning shown after a change. */
  'aria-describedby'?: string;
  className?: string;
}

/**
 * OptionToggle — one yes/no option in a settings panel, drawn as a small
 * pill: an outline when off, filled with the accent color when on. It is a
 * real toggle button (`aria-pressed`), so a click, Space or Enter flips it.
 * Every boolean option in a panel uses this, so they share one size, spacing
 * and type; set several side by side in an `OptionToggleRow`.
 */
export function OptionToggle({
  pressed,
  onChange,
  disabled,
  children,
  'aria-describedby': describedBy,
  className,
}: OptionToggleProps) {
  return (
    <button
      type="button"
      className={cn(styles.pill, className)}
      aria-pressed={pressed}
      aria-describedby={describedBy}
      disabled={disabled}
      onClick={() => onChange(!pressed)}
    >
      {children}
    </button>
  );
}

interface OptionToggleRowProps {
  children: ReactNode;
  /** Names the row as a group of options for assistive tech. */
  'aria-label'?: string;
  className?: string;
}

/** A compact, wrapping row of `OptionToggle` pills. */
export function OptionToggleRow({
  children,
  'aria-label': label,
  className,
}: OptionToggleRowProps) {
  return (
    <div
      role={label ? 'group' : undefined}
      aria-label={label}
      className={cn(styles.row, className)}
    >
      {children}
    </div>
  );
}
