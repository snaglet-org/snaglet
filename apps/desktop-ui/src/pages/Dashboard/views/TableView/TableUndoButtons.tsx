import { RedoArrowIcon, UndoArrowIcon } from '@desktop/components/Icons';
import { stepActionLabel, useTableUndo } from './tableUndo';
import styles from './TableEntries.module.scss';

/**
 * Undo and Redo for the table toolbar: the user's next table steps (any
 * table), named in their tooltips, disabled when there is none. They keep
 * an open cell open until the step runs, which saves it first.
 */
export function TableUndoButtons() {
  const control = useTableUndo();
  if (!control) return null;
  const { undo, redo, busy, run } = control;
  return (
    <>
      <button
        type="button"
        className={styles.quietButton}
        data-keeps-cell=""
        disabled={!undo || busy}
        aria-label={undo ? stepActionLabel('Undo', undo) : 'Undo'}
        title={undo ? `${stepActionLabel('Undo', undo)} (Cmd/Ctrl+Z)` : 'Nothing to undo'}
        onClick={() => void run('undo', undo)}
      >
        <UndoArrowIcon />
      </button>
      <button
        type="button"
        className={styles.quietButton}
        data-keeps-cell=""
        disabled={!redo || busy}
        aria-label={redo ? stepActionLabel('Redo', redo) : 'Redo'}
        title={redo ? `${stepActionLabel('Redo', redo)} (Cmd/Ctrl+Shift+Z)` : 'Nothing to redo'}
        onClick={() => void run('redo', redo)}
      >
        <RedoArrowIcon />
      </button>
    </>
  );
}
