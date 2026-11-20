import { forwardRef } from 'react';
import type { ButtonHTMLAttributes, ReactNode } from 'react';
import { Spinner } from '../../Spinner';
import { cn } from '@desktop/utils/classNames';
import styles from './Button.module.scss';

type ButtonVariant = 'neutral' | 'primary' | 'danger' | 'ghost' | 'link';
type ButtonSize = 'xs' | 'sm' | 'md' | 'lg';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  fullWidth?: boolean;
  unstyled?: boolean;
  loading?: boolean;
  /**
   * Square icon-only button. Drops min-width, makes the dimensions square
   * to the size token, and centers the content. Pair with `leftIcon` (or
   * just put the glyph in `children`) and supply `aria-label`.
   */
  iconOnly?: boolean;
  leftIcon?: ReactNode;
  rightIcon?: ReactNode;
  /** Accessible label for loading state */
  loadingText?: string;
}

const variantClassMap: Record<ButtonVariant, string> = {
  neutral: styles.variantNeutral,
  primary: styles.variantPrimary,
  danger: styles.variantDanger,
  ghost: styles.variantGhost,
  link: styles.variantLink,
};

const sizeClassMap: Record<ButtonSize, string> = {
  xs: styles.sizeXs,
  sm: styles.sizeSm,
  md: styles.sizeMd,
  lg: styles.sizeLg,
};

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  (
    {
      variant = 'neutral',
      size = 'md',
      fullWidth = false,
      unstyled = false,
      loading = false,
      iconOnly = false,
      leftIcon,
      rightIcon,
      loadingText = 'Loading...',
      className,
      type = 'button',
      disabled,
      children,
      'aria-label': ariaLabel,
      ...rest
    },
    ref
  ) => {
    const isDisabled = disabled || loading;

    return (
      <button
        ref={ref}
        type={type}
        className={cn(
          !unstyled && styles.button,
          !unstyled && variantClassMap[variant],
          !unstyled && sizeClassMap[size],
          fullWidth && styles.fullWidth,
          iconOnly && styles.iconOnly,
          loading && styles.loading,
          className
        )}
        disabled={isDisabled}
        aria-label={ariaLabel}
        aria-busy={loading}
        aria-disabled={isDisabled}
        {...rest}
      >
        {loading && (
          <Spinner variant="svg" size="sm" tone="currentColor" className={styles.spinner} />
        )}
        {!loading && leftIcon && (
          <span className={styles.leftIcon} aria-hidden="true">
            {leftIcon}
          </span>
        )}
        <span className={styles.content}>{loading ? loadingText : children}</span>
        {!loading && rightIcon && (
          <span className={styles.rightIcon} aria-hidden="true">
            {rightIcon}
          </span>
        )}
      </button>
    );
  }
);

Button.displayName = 'Button';
