import { forwardRef, type MouseEventHandler } from 'react';
import styles from './Switch.module.scss';
import { cn } from '@desktop/utils/classNames';

type SwitchSize = 'sm' | 'md' | 'lg';

export interface SwitchProps {
  /** Whether the switch is currently on. */
  checked: boolean;
  /** Called with the next state (the inverse of `checked`) on click. */
  onChange: (next: boolean) => void;
  /**
   * Optional raw click passthrough. Useful when the Switch sits inside a
   * clickable row container and the consumer needs to stop the bubble
   * (e.g. `e.stopPropagation()`). Fires before `onChange`.
   */
  onClickCapture?: MouseEventHandler<HTMLButtonElement>;
  /**
   * sm — inline pill (16px tall) used in dense list rows.
   * md — slightly larger inline pill (22px tall) for header/detail surfaces.
   * lg — large header tile (132×stretch) with state + hint stacked.
   */
  size?: SwitchSize;
  disabled?: boolean;
  /** Label shown when on. Defaults to "Enabled" (both sizes). */
  onLabel?: string;
  /** Label shown when off. Defaults to "Disabled" (both sizes). */
  offLabel?: string;
  /** Secondary hint line shown under the main label. Only honored when `size="lg"`. */
  hint?: string;
  /** Accessible name when no visible text fully describes the action. */
  'aria-label'?: string;
  /** Id of the text that explains the switch, such as a warning shown after a change. */
  'aria-describedby'?: string;
  title?: string;
  className?: string;
}

/**
 * Switch — binary toggle with `role="switch"` semantics.
 *
 * Two sizes share the same primary-on / muted-off color logic but
 * differ in shape:
 *   - `sm` renders as a tight inline pill (used in list rows).
 *   - `lg` renders as a stretched header tile with stacked state + hint.
 */
export const Switch = forwardRef<HTMLButtonElement, SwitchProps>(
  (
    {
      checked,
      onChange,
      onClickCapture,
      size = 'sm',
      disabled = false,
      onLabel,
      offLabel,
      hint,
      title,
      className,
      'aria-label': ariaLabel,
      'aria-describedby': ariaDescribedBy,
    },
    ref
  ) => {
    // One vocabulary for the single `enabled` flag, regardless of size — the
    // sm pill and lg tile are the same control, so they read the same word.
    const resolvedOnLabel = onLabel ?? 'Enabled';
    const resolvedOffLabel = offLabel ?? 'Disabled';
    const stateLabel = checked ? resolvedOnLabel : resolvedOffLabel;

    return (
      <button
        ref={ref}
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={ariaLabel}
        aria-describedby={ariaDescribedBy}
        title={title}
        disabled={disabled}
        onClick={(e) => {
          onClickCapture?.(e);
          if (e.defaultPrevented) return;
          onChange(!checked);
        }}
        className={cn(
          styles.switch,
          size === 'lg' ? styles.sizeLg : size === 'md' ? styles.sizeMd : styles.sizeSm,
          checked ? styles.on : styles.off,
          className
        )}
      >
        <span className={styles.state}>{stateLabel}</span>
        {size === 'lg' && hint && <span className={styles.hint}>{hint}</span>}
      </button>
    );
  }
);

Switch.displayName = 'Switch';
