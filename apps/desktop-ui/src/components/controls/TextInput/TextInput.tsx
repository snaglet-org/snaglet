import { forwardRef, useMemo } from 'react';
import type { InputHTMLAttributes, ReactNode } from 'react';
import { cn } from '@desktop/utils/classNames';
import styles from './TextInput.module.scss';

type TextInputSize = 'sm' | 'md' | 'lg';

export interface TextInputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'size'> {
  inputSize?: TextInputSize;
  size?: TextInputSize;
  unstyled?: boolean;
  label?: string;
  error?: string;
  hint?: string;
  leftIcon?: ReactNode;
  rightIcon?: ReactNode;
  fullWidth?: boolean;
  /**
   * Class for the bordered container box (not the inner <input>). Use this
   * for layout/sizing — e.g. a fixed width on a number field — instead of
   * passing chrome (border/background/padding) via `className`, which would
   * double up on the container's own border and look broken.
   */
  containerClassName?: string;
}

const sizeClassMap: Record<TextInputSize, string> = {
  sm: styles.sizeSm,
  md: styles.sizeMd,
  lg: styles.sizeLg,
};

let inputIdCounter = 0;

export const TextInput = forwardRef<HTMLInputElement, TextInputProps>(
  (
    {
      inputSize = 'md',
      size,
      unstyled = false,
      label,
      error,
      hint,
      leftIcon,
      rightIcon,
      fullWidth = false,
      className,
      containerClassName,
      id,
      required,
      disabled,
      'aria-describedby': ariaDescribedBy,
      ...rest
    },
    ref
  ) => {
    const generatedId = useMemo(() => id || `input-${++inputIdCounter}`, [id]);
    const hintId = `${generatedId}-hint`;
    const errorId = `${generatedId}-error`;
    const resolvedSize = size ?? inputSize;

    const describedByIds = [ariaDescribedBy, hint && hintId, error && errorId]
      .filter(Boolean)
      .join(' ');

    if (unstyled) {
      return (
        <input
          ref={ref}
          id={generatedId}
          className={className}
          disabled={disabled}
          required={required}
          aria-invalid={!!error}
          aria-describedby={describedByIds || undefined}
          {...rest}
        />
      );
    }

    const hasError = !!error;

    return (
      <div className={cn(styles.wrapper, fullWidth && styles.fullWidth)}>
        {label && (
          <label htmlFor={generatedId} className={styles.label}>
            {label}
            {required && (
              <span className={styles.required} aria-label="required">
                *
              </span>
            )}
          </label>
        )}
        <div
          className={cn(
            styles.inputContainer,
            sizeClassMap[resolvedSize],
            hasError && styles.error,
            disabled && styles.disabled,
            leftIcon && styles.hasLeftIcon,
            rightIcon && styles.hasRightIcon,
            containerClassName
          )}
        >
          {leftIcon && (
            <span className={styles.leftIcon} aria-hidden="true">
              {leftIcon}
            </span>
          )}
          <input
            ref={ref}
            id={generatedId}
            className={cn(styles.input, className)}
            disabled={disabled}
            required={required}
            aria-invalid={hasError}
            aria-describedby={describedByIds || undefined}
            {...rest}
          />
          {rightIcon && (
            <span className={styles.rightIcon} aria-hidden="true">
              {rightIcon}
            </span>
          )}
        </div>
        {hint && !error && (
          <p id={hintId} className={styles.hint}>
            {hint}
          </p>
        )}
        {error && (
          <p id={errorId} className={styles.errorText} role="alert">
            {error}
          </p>
        )}
      </div>
    );
  }
);

TextInput.displayName = 'TextInput';
