/**
 * "Move to…" from the item context menu: a date picker;
 * the item keeps its time of day (timed) or its span (all-day). Enter or
 * Move commits through the same path as a drag (repeating rows then ask
 * Only this one / All upcoming).
 */
import { useEffect, useRef, useState } from 'react';
import { Button, DateInput } from '@desktop/components';
import { AnchoredSurface } from './AnchoredSurface';
import styles from './CalendarPopovers.module.scss';

export interface MoveToPopoverProps {
  anchor: HTMLElement;
  title: string;
  /** Current day, YYYY-MM-DD. */
  day: string;
  onMove: (day: string) => void;
  onCancel: () => void;
}

export function MoveToPopover({ anchor, title, day, onMove, onCancel }: MoveToPopoverProps) {
  const [value, setValue] = useState(day);
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    inputRef.current?.focus({ preventScroll: true });
  }, []);
  const valid = /^\d{4}-\d{2}-\d{2}$/.test(value);
  return (
    <AnchoredSurface anchor={anchor} label={`Move ${title} to`} width={260} onDismiss={onCancel}>
      <form
        className={styles.choice}
        onSubmit={(e) => {
          e.preventDefault();
          if (valid) onMove(value);
        }}
      >
        <p className={styles.choiceTitle}>
          Move <strong>{title}</strong> to
        </p>
        <DateInput
          ref={inputRef}
          required
          aria-label="Date"
          value={value}
          onChange={setValue}
          size="sm"
          fullWidth
        />
        <div className={styles.footer}>
          <Button type="button" size="sm" variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
          <Button type="submit" size="sm" variant="primary" disabled={!valid || value === day}>
            Move
          </Button>
        </div>
      </form>
    </AnchoredSurface>
  );
}
