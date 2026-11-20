import { forwardRef } from 'react';
import { cn } from '@desktop/utils/classNames';
import styles from './RepeatRow.module.scss';

export interface RepeatRowProps {
  /** The rule as a sentence ("Every week on Thursday"), or "Never". */
  value: string;
  /** The row has a rule: its sentence is drawn in the accent color. */
  on: boolean;
  disabled?: boolean;
  onClick: () => void;
}

/** Two arrows round a loop (Bootstrap Icons `repeat`). */
function RepeatGlyph() {
  return (
    <svg viewBox="0 0 16 16" width="15" height="15" fill="currentColor" aria-hidden="true">
      <path d="M11 5.466V4H5a4 4 0 0 0-3.584 5.777.5.5 0 1 1-.896.446A5 5 0 0 1 5 3h6V1.534a.25.25 0 0 1 .41-.192l2.36 1.966c.12.1.12.284 0 .384l-2.36 1.966a.25.25 0 0 1-.41-.192m3.81.086a.5.5 0 0 1 .67.225A5 5 0 0 1 11 13H5v1.466a.25.25 0 0 1-.41.192l-2.36-1.966a.25.25 0 0 1 0-.384l2.36-1.966a.25.25 0 0 1 .41.192V12h6a4 4 0 0 0 3.585-5.777.5.5 0 0 1 .225-.67Z" />
    </svg>
  );
}

/** "↻ Repeat   Never ›": opens the repeat picker. */
export const RepeatRow = forwardRef<HTMLButtonElement, RepeatRowProps>(function RepeatRow(
  { value, on, disabled, onClick },
  ref
) {
  return (
    <button
      ref={ref}
      type="button"
      className={styles.row}
      aria-label={`Repeat, ${value}`}
      data-repeat-row=""
      disabled={disabled}
      onClick={onClick}
    >
      <span className={styles.icon}>
        <RepeatGlyph />
      </span>
      <span className={styles.label}>Repeat</span>
      <span className={cn(styles.value, on && styles.valueOn)}>{value}</span>
      <svg className={styles.chevron} viewBox="0 0 12 12" width="12" height="12" aria-hidden="true">
        <path
          d="M4.5 2.5 8 6 4.5 9.5"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    </button>
  );
});
