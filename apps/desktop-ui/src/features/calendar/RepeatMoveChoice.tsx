/**
 * Repeating row dropped somewhere new: "Only this one" /
 * "All upcoming" / Cancel, at the drop point. Enter = Only this one; Esc or
 * an outside press = Cancel. "All upcoming" is disabled with its reason when
 * the occurrence can't shift the series (`repeat.canShiftAll === false`).
 */
import { useEffect, useRef } from 'react';
import { Button } from '@desktop/components';
import { AnchoredSurface } from './AnchoredSurface';
import type { RepeatMoveMode } from './occurrenceWrites';
import styles from './CalendarPopovers.module.scss';

export interface RepeatMoveChoiceProps {
  anchor: HTMLElement;
  title: string;
  /** "Tue Oct 13, 10:15 AM". */
  target: string;
  canShiftAll: boolean;
  onChoose: (mode: RepeatMoveMode) => void;
  onCancel: () => void;
}

const SHIFT_ALL_DISABLED_REASON =
  'This occurrence is in the past: only the current or a later one can shift the series.';

export function RepeatMoveChoice({
  anchor,
  title,
  target,
  canShiftAll,
  onChoose,
  onCancel,
}: RepeatMoveChoiceProps) {
  const firstRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    firstRef.current?.focus({ preventScroll: true });
  }, []);
  return (
    <AnchoredSurface anchor={anchor} label={`Move ${title}`} width={260} onDismiss={onCancel}>
      <form
        className={styles.choice}
        onSubmit={(e) => {
          e.preventDefault();
          onChoose('one');
        }}
      >
        <p className={styles.choiceTitle}>
          Move <strong>{title}</strong> to {target}?
        </p>
        <Button ref={firstRef} type="submit" size="sm" variant="primary">
          Only this one
        </Button>
        <Button
          type="button"
          size="sm"
          disabled={!canShiftAll}
          title={canShiftAll ? 'Shift this and every later occurrence' : SHIFT_ALL_DISABLED_REASON}
          onClick={() => onChoose('all')}
        >
          All upcoming
        </Button>
        {!canShiftAll && <p className={styles.muted}>{SHIFT_ALL_DISABLED_REASON}</p>}
        <Button type="button" size="sm" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
      </form>
    </AnchoredSurface>
  );
}
