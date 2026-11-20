import type { MouseEvent, ReactNode } from 'react';
import { Tooltip, type TooltipSide } from './Tooltip';
import styles from './Tooltip.module.scss';

export interface HelpTooltipProps {
  label: ReactNode;
  ariaLabel: string;
  side?: TooltipSide;
  className?: string;
}

/** A click on the hint shows help only; it must not activate a surrounding `<label>`. */
const keepClickOnHint = (event: MouseEvent<HTMLSpanElement>) => event.preventDefault();

/**
 * Shared question-mark help trigger using the activity-bar tooltip behavior.
 *
 * The trigger is a focusable span, not a `<button>`: hints sit inside field
 * labels, and a label forwards clicks and focus to its first button or input.
 * A `?` button there took every click meant for an editor in the same label
 * (focus jumped to the `?` and pinned its bubble over the field).
 */
export function HelpTooltip({ label, ariaLabel, side = 'left', className }: HelpTooltipProps) {
  return (
    <Tooltip
      label={label}
      side={side}
      className={[styles.helpBubble, className].filter(Boolean).join(' ')}
    >
      <span
        role="button"
        tabIndex={0}
        className={styles.helpTrigger}
        aria-label={ariaLabel}
        onClick={keepClickOnHint}
      >
        ?
      </span>
    </Tooltip>
  );
}
