import { isTableRepeatOverdue, tableRepeatCellText } from '@snaglet/shared/utils';
import { cn } from '@desktop/utils/classNames';
import type { CellRepeat } from './useTableRepeats';
import styles from './RepeatCellText.module.scss';

/**
 * The repeating cell's text: the next occurrence, e.g. "Sun
 * Nov 1", marked when overdue. Shown instead of the date on a repeating row.
 */
export function RepeatCellText({ cellRepeat }: { cellRepeat: CellRepeat }) {
  const { repeat, log } = cellRepeat;
  // An interval (sub-daily) is overdue once its time has passed, the same day.
  // The cell-text payload carries no range end, so a range is marked overdue
  // by its start here; the row's own views (RepeatSection / DateRepeatPopover)
  // and the server use the range end. This is the lighter grid/board hint.
  const overdue = isTableRepeatOverdue(repeat, new Date(), { log });
  return (
    <span
      className={cn(styles.text, overdue && styles.overdueText)}
      data-repeat-text=""
      data-overdue={overdue || undefined}
      title={overdue ? 'Overdue' : undefined}
    >
      {tableRepeatCellText(repeat)}
    </span>
  );
}
