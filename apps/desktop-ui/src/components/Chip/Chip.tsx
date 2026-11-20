import React, { forwardRef } from 'react';
import styles from './Chip.module.scss';
import { cn } from '@desktop/utils/classNames';

export type ChipTone = 'neutral' | 'muted' | 'primary' | 'success' | 'warning' | 'error' | 'info';

type ChipSize = 'xs' | 'sm';
type ChipVariant = 'solid' | 'outline' | 'dashed';

export interface ChipProps {
  tone?: ChipTone;
  size?: ChipSize;
  variant?: ChipVariant;
  /** Optional leading glyph (icon or short ASCII). */
  icon?: React.ReactNode;
  /** When set, the whole chip becomes a clickable button. */
  onClick?: React.MouseEventHandler<HTMLElement>;
  /** Passthrough for cases that need to suppress focus loss before click. */
  onMouseDown?: React.MouseEventHandler<HTMLElement>;
  /** Toggle state — reflects the chip's pressed visual. Only meaningful with onClick. */
  'aria-pressed'?: boolean;
  /** Override tab order (e.g. `-1` to keep focus on a sibling input). */
  tabIndex?: number;
  /** When set, adds a trailing × that calls onRemove (independent of onClick). */
  onRemove?: (e: React.MouseEvent) => void;
  /** Accessible label for the × button (defaults to "Remove"). */
  removeLabel?: string;
  className?: string;
  title?: string;
  /** Disabled state (only meaningful for interactive chips). */
  disabled?: boolean;
  children: React.ReactNode;
}

const toneClassMap: Record<ChipTone, string> = {
  neutral: styles.toneNeutral,
  muted: styles.toneMuted,
  primary: styles.tonePrimary,
  success: styles.toneSuccess,
  warning: styles.toneWarning,
  error: styles.toneError,
  info: styles.toneInfo,
};

const sizeClassMap: Record<ChipSize, string> = {
  xs: styles.sizeXs,
  sm: styles.sizeSm,
};

const variantClassMap: Record<ChipVariant, string> = {
  solid: styles.variantSolid,
  outline: styles.variantOutline,
  dashed: styles.variantDashed,
};

export const Chip = forwardRef<HTMLElement, ChipProps>(
  (
    {
      tone = 'muted',
      size = 'sm',
      variant = 'solid',
      icon,
      onClick,
      onMouseDown,
      onRemove,
      removeLabel = 'Remove',
      className,
      title,
      disabled,
      tabIndex,
      children,
      'aria-pressed': ariaPressed,
    },
    ref
  ) => {
    const interactive = Boolean(onClick);
    const classes = cn(
      styles.chip,
      sizeClassMap[size],
      variantClassMap[variant],
      toneClassMap[tone],
      interactive && styles.interactive,
      className
    );

    const body = (
      <>
        {icon !== undefined && (
          <span className={styles.icon} aria-hidden="true">
            {icon}
          </span>
        )}
        <span className={styles.label}>{children}</span>
        {onRemove && (
          <button
            type="button"
            className={styles.remove}
            onClick={(e) => {
              e.stopPropagation();
              onRemove(e);
            }}
            aria-label={removeLabel}
            tabIndex={-1}
          >
            ×
          </button>
        )}
      </>
    );

    if (interactive) {
      return (
        <button
          ref={ref as React.Ref<HTMLButtonElement>}
          type="button"
          className={classes}
          onClick={onClick}
          onMouseDown={onMouseDown}
          aria-pressed={ariaPressed}
          disabled={disabled}
          tabIndex={tabIndex}
          title={title}
        >
          {body}
        </button>
      );
    }

    return (
      <span ref={ref as React.Ref<HTMLSpanElement>} className={classes} title={title}>
        {body}
      </span>
    );
  }
);

Chip.displayName = 'Chip';
