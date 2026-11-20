import { useEffect, useRef } from 'react';
import { Checkbox } from '@desktop/components';
import styles from './EntryCellEditor.module.scss';

interface Props {
  checked: boolean;
  label: string;
  onToggle?: () => void;
  disabled?: boolean;
  autoFocus?: boolean;
}

/** The same two-state control is used in persisted cells and new-row drafts. */
export function CheckboxCellValue({ checked, label, onToggle, disabled, autoFocus }: Props) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (autoFocus) ref.current?.focus();
  }, [autoFocus]);
  return (
    <div
      className={styles.checkboxControl}
      onKeyDown={(event) => {
        // Native checkboxes already handle Space; Enter should toggle too.
        if (event.key !== 'Enter' || disabled || !onToggle) return;
        event.preventDefault();
        event.stopPropagation();
        onToggle();
      }}
    >
      <Checkbox
        ref={ref}
        checked={checked}
        disabled={disabled || !onToggle}
        aria-label={label}
        onChange={() => {
          // The shared checkbox suppresses pointer focus to avoid scrolling.
          // A grid cell still needs a stable keyboard target after a click.
          ref.current?.focus({ preventScroll: true });
          onToggle?.();
        }}
      />
    </div>
  );
}
