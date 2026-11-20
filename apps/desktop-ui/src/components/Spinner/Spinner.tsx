import type { ReactElement } from 'react';
import styles from './Spinner.module.scss';

type SpinnerVariant = 'border' | 'svg';
type SpinnerSize = 'xs' | 'sm' | 'md' | 'lg' | 'xl';
type SpinnerTone = 'default' | 'muted' | 'accent' | 'currentColor';

export interface SpinnerProps {
  variant?: SpinnerVariant;
  size?: SpinnerSize;
  tone?: SpinnerTone;
  className?: string;
  /** Accessible label. Omit (and optionally pass `aria-hidden`) when decorative. */
  label?: string;
  'aria-hidden'?: boolean;
}

/**
 * Shared spinner primitive. Replaces ad-hoc `.spinner` SCSS rules across the app.
 *
 * - `variant="border"` (default): lightweight CSS ring — inline status, banners,
 *   loading panes.
 * - `variant="svg"`: SVG stroke-dash arc — used inside Button. Inherits
 *   `currentColor` so it matches the button's text color.
 */
export function Spinner({
  variant = 'border',
  size = 'sm',
  tone = 'default',
  className,
  label,
  'aria-hidden': ariaHidden,
}: SpinnerProps): ReactElement {
  const classes = [
    styles.spinner,
    variant === 'border' ? styles.border : styles.svg,
    styles[`size-${size}`],
    styles[`tone-${tone}`],
    className,
  ]
    .filter(Boolean)
    .join(' ');

  const a11y = label
    ? { role: 'status' as const, 'aria-label': label }
    : { 'aria-hidden': ariaHidden ?? true };

  if (variant === 'svg') {
    return (
      <span className={classes} {...a11y}>
        <svg viewBox="0 0 24 24" width="100%" height="100%" aria-hidden="true">
          <circle
            cx="12"
            cy="12"
            r="7"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.5"
            strokeLinecap="round"
            strokeDasharray="44"
            strokeDashoffset="14"
            opacity="0.9"
          />
        </svg>
      </span>
    );
  }

  return <span className={classes} {...a11y} />;
}
