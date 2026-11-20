import { forwardRef, useRef, useCallback, useEffect, useMemo } from 'react';
import type { TextareaHTMLAttributes, MutableRefObject } from 'react';
import { cn } from '@desktop/utils/classNames';
import styles from './Textarea.module.scss';

type TextareaSize = 'sm' | 'md' | 'lg';

export interface TextareaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  textareaSize?: TextareaSize;
  unstyled?: boolean;
  label?: string;
  error?: string;
  hint?: string;
  fullWidth?: boolean;
  resize?: 'none' | 'vertical' | 'horizontal' | 'both';
  maxLength?: number;
  showCharCount?: boolean;
  /** When true, textarea auto-grows to fit content up to maxHeight */
  autoGrow?: boolean;
  /** Maximum height in px when autoGrow is enabled */
  maxHeight?: number;
}

const sizeClassMap: Record<TextareaSize, string> = {
  sm: styles.sizeSm,
  md: styles.sizeMd,
  lg: styles.sizeLg,
};

let textareaIdCounter = 0;

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(
  (
    {
      textareaSize = 'md',
      unstyled = false,
      label,
      error,
      hint,
      fullWidth = false,
      resize = 'vertical',
      maxLength,
      showCharCount = false,
      className,
      id,
      required,
      disabled,
      value,
      autoGrow = false,
      maxHeight,
      'aria-describedby': ariaDescribedBy,
      ...rest
    },
    ref
  ) => {
    const internalRef = useRef<HTMLTextAreaElement | null>(null);
    const setRefs = useCallback(
      (el: HTMLTextAreaElement | null) => {
        internalRef.current = el;
        if (typeof ref === 'function') ref(el);
        else if (ref) (ref as MutableRefObject<HTMLTextAreaElement | null>).current = el;
      },
      [ref]
    );

    useEffect(() => {
      const el = internalRef.current;
      if (!autoGrow || !el) return;
      el.style.height = 'auto';
      const next = maxHeight ? Math.min(el.scrollHeight, maxHeight) : el.scrollHeight;
      el.style.height = `${next}px`;
    }, [autoGrow, maxHeight, value]);

    const generatedId = useMemo(() => id || `textarea-${++textareaIdCounter}`, [id]);
    const hintId = `${generatedId}-hint`;
    const errorId = `${generatedId}-error`;

    const describedByIds = [ariaDescribedBy, hint && hintId, error && errorId]
      .filter(Boolean)
      .join(' ');

    const charCount = typeof value === 'string' ? value.length : 0;
    const hasError = !!error;

    if (unstyled) {
      return (
        <textarea
          ref={setRefs}
          id={generatedId}
          className={className}
          disabled={disabled}
          required={required}
          maxLength={maxLength}
          value={value}
          aria-invalid={hasError}
          aria-describedby={describedByIds || undefined}
          style={{ resize }}
          {...rest}
        />
      );
    }

    return (
      <div className={cn(styles.wrapper, fullWidth && styles.fullWidth)}>
        {label && (
          <div className={styles.labelRow}>
            <label htmlFor={generatedId} className={styles.label}>
              {label}
              {required && (
                <span className={styles.required} aria-label="required">
                  *
                </span>
              )}
            </label>
            {showCharCount && maxLength && (
              <span className={styles.charCount} aria-live="polite">
                {charCount} / {maxLength}
              </span>
            )}
          </div>
        )}
        <div
          className={cn(
            styles.textareaContainer,
            sizeClassMap[textareaSize],
            hasError && styles.error,
            disabled && styles.disabled
          )}
        >
          <textarea
            ref={setRefs}
            id={generatedId}
            className={cn(styles.textarea, className)}
            disabled={disabled}
            required={required}
            maxLength={maxLength}
            value={value}
            aria-invalid={hasError}
            aria-describedby={describedByIds || undefined}
            style={{ resize }}
            {...rest}
          />
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

Textarea.displayName = 'Textarea';
