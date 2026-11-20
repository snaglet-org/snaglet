import { forwardRef, useEffect, useRef, type ReactNode } from 'react';
import styles from './Checkbox.module.scss';
import { cn } from '@desktop/utils/classNames';

type CheckboxSize = 'sm' | 'md';

/** The modifier keys held for the click or key press that toggled the box. */
export interface CheckboxModifiers {
  shiftKey: boolean;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
}

const NO_MODIFIERS: CheckboxModifiers = {
  shiftKey: false,
  metaKey: false,
  ctrlKey: false,
  altKey: false,
};

/**
 * A checkbox's change is driven by a click (React listens to `click` for
 * checkboxes, and keyboard Space dispatches one), so its modifiers are read
 * off that event; any other event reports none held.
 */
function modifiersOf(event: Event): CheckboxModifiers {
  if (!(event instanceof MouseEvent)) return NO_MODIFIERS;
  const { shiftKey, metaKey, ctrlKey, altKey } = event;
  return { shiftKey, metaKey, ctrlKey, altKey };
}

export interface CheckboxProps {
  /** Whether the box is currently checked. */
  checked: boolean;
  /**
   * Called with the next boolean state on change, and the modifier keys
   * held (a list's Shift-click range, Cmd/Ctrl-click single toggle).
   */
  onChange: (next: boolean, modifiers: CheckboxModifiers) => void;
  /**
   * Tri-state — when true, paints the indeterminate (—) glyph regardless
   * of `checked`. The `aria-checked="mixed"` semantics flow through the
   * underlying input so screen readers announce it correctly.
   */
  indeterminate?: boolean;
  disabled?: boolean;
  size?: CheckboxSize;
  /** Applied to the outer <label> wrapper. */
  className?: string;
  /** Accessible name when no visible label is provided via children. */
  'aria-label'?: string;
  /** Id of text that describes the box, beyond its label. */
  'aria-describedby'?: string;
  title?: string;
  /** Inline label content. Pass nothing for a bare checkbox (e.g. inside a row). */
  children?: ReactNode;
}

/**
 * Checkbox — sharp-corner Y2K/terminal-flavored boolean control with
 * primary-tinted check glyph. Wraps a native `<input type="checkbox">`
 * so form submission and screen-reader semantics come for free; the
 * native control is visually hidden in favor of a custom-painted box.
 */
export const Checkbox = forwardRef<HTMLInputElement, CheckboxProps>(
  (
    {
      checked,
      onChange,
      indeterminate = false,
      disabled = false,
      size = 'md',
      className,
      children,
      title,
      'aria-label': ariaLabel,
      'aria-describedby': ariaDescribedBy,
    },
    ref
  ) => {
    const innerRef = useRef<HTMLInputElement>(null);
    // Indeterminate is a DOM property — must be set imperatively.
    useEffect(() => {
      if (innerRef.current) innerRef.current.indeterminate = indeterminate;
    }, [indeterminate]);

    const setRefs = (el: HTMLInputElement | null) => {
      innerRef.current = el;
      if (typeof ref === 'function') ref(el);
      else if (ref) (ref as React.MutableRefObject<HTMLInputElement | null>).current = el;
    };

    return (
      <label
        className={cn(
          styles.wrap,
          size === 'sm' ? styles.sizeSm : styles.sizeMd,
          disabled && styles.disabled,
          className
        )}
        title={title}
        onMouseDown={(e) => {
          // Prevent the browser from scrolling the nearest scroll ancestor
          // to keep the newly-focused input in view. Keyboard focus (Tab)
          // still works normally; only pointer-click focus is suppressed.
          e.preventDefault();
        }}
        onClick={(e) => {
          if (disabled) return;
          // When the click lands directly on the native input — a synthetic
          // click from keyboard Space, or a test's fireEvent/userEvent that
          // targets the input by role — the input's own change event already
          // drove onChange. Re-driving here would fire it a second time and
          // cancel out flip-style handlers (e.g. `() => toggle(id)`), so bail.
          if (e.target === innerRef.current) return;
          // Otherwise the click hit the label/box: mousedown's preventDefault
          // suppressed the label→input forwarding, so no change event fired.
          // Re-drive the toggle here; preventDefault stops a double-fire.
          e.preventDefault();
          onChange(!checked, modifiersOf(e.nativeEvent));
        }}
      >
        <input
          ref={setRefs}
          type="checkbox"
          checked={checked}
          disabled={disabled}
          aria-label={ariaLabel}
          aria-describedby={ariaDescribedBy}
          aria-checked={indeterminate ? 'mixed' : checked}
          onChange={(e) => onChange(e.target.checked, modifiersOf(e.nativeEvent))}
          className={styles.input}
        />
        <span className={styles.box} aria-hidden="true">
          {indeterminate ? (
            <span className={styles.glyphIndeterminate} />
          ) : checked ? (
            <svg viewBox="0 0 12 12" className={styles.glyphCheck} fill="none">
              <path
                d="M2.5 6.5l2.5 2.5 4.5-5"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="square"
                strokeLinejoin="miter"
              />
            </svg>
          ) : null}
        </span>
        {children !== undefined && <span className={styles.label}>{children}</span>}
      </label>
    );
  }
);

Checkbox.displayName = 'Checkbox';
