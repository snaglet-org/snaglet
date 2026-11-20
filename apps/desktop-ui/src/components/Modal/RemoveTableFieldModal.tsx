import React, { useCallback, useEffect, useRef, useState } from 'react';
import { getErrorMessage } from '@snaglet/shared/utils';
import { Modal } from './Modal';
import styles from './Modal.module.scss';
import { Button } from '../controls/Button/Button';

export interface RemoveTableFieldModalProps {
  /** The column's display name. */
  fieldName: string;
  /** Entries the table holds, for the delete-forever wording; omit when unknown. */
  entryCount?: number;
  /**
   * Archive the column (hidden, kept, restorable from Archived). May be
   * async: while it runs every button locks and the dialog cannot be
   * dismissed; a rejection renders inline and the dialog stays open. On
   * success the parent closes the dialog.
   */
  onArchive: () => void | Promise<void>;
  /** Drop the column and every value in it for good; same contract as `onArchive`. */
  onDelete: () => void | Promise<void>;
  /** Dismiss without acting — Esc and backdrop click route here too. */
  onCancel: () => void;
}

type Choice = 'archive' | 'delete';

function valuesPhrase(entryCount: number | undefined): string {
  if (entryCount === undefined || entryCount === 0) return 'all of its values';
  return entryCount === 1 ? 'its value in 1 entry' : `its values in ${entryCount} entries`;
}

/**
 * Asks whether a custom table column should be archived (hidden, kept, and
 * restorable from Archived — an undoable step) or deleted forever with every
 * value in it. Same lock-and-inline-error contract as `ConfirmModal`.
 */
export const RemoveTableFieldModal: React.FC<RemoveTableFieldModalProps> = ({
  fieldName,
  entryCount,
  onArchive,
  onDelete,
  onCancel,
}) => {
  const [busy, setBusy] = useState<Choice | null>(null);
  const [error, setError] = useState<string | null>(null);
  const busyRef = useRef(false);
  const archiveRef = useRef<HTMLButtonElement>(null);
  const title = `Remove column “${fieldName}”?`;

  // Archive is the default: focus it once Modal's own first-focusable pass
  // (a microtask after mount) has run, so Enter archives and Esc cancels.
  useEffect(() => {
    const id = window.setTimeout(() => archiveRef.current?.focus(), 0);
    return () => window.clearTimeout(id);
  }, []);

  const run = useCallback(
    async (choice: Choice) => {
      if (busyRef.current) return;
      busyRef.current = true;
      setBusy(choice);
      setError(null);
      try {
        await (choice === 'archive' ? onArchive() : onDelete());
        // Success: the parent unmounts the dialog; keep the lock until then.
      } catch (err) {
        setError(getErrorMessage(err, 'Action failed'));
        busyRef.current = false;
        setBusy(null);
      }
    },
    [onArchive, onDelete]
  );

  return (
    <Modal onClose={busy ? () => undefined : onCancel} aria-label={title}>
      <div className={styles.modalContent} data-testid="remove-table-field-modal">
        <h2 className={styles.modalTitle}>{title}</h2>
        <p className={styles.modalMessage}>
          <strong>Archive</strong> hides the column but keeps its values. You can restore it from
          Archived, and undo the step.
        </p>
        <p className={styles.modalMessage}>
          <strong>Delete forever</strong> drops the column and {valuesPhrase(entryCount)}. This
          cannot be undone.
        </p>
        {error && (
          <p className={styles.errorMessage} role="alert">
            {error}
          </p>
        )}
        <div className={styles.modalActions}>
          <Button variant="neutral" size="lg" onClick={onCancel} disabled={busy !== null}>
            Cancel
          </Button>
          <Button
            variant="danger"
            size="lg"
            onClick={() => void run('delete')}
            disabled={busy === 'archive'}
            loading={busy === 'delete'}
            loadingText="Deleting…"
          >
            Delete forever
          </Button>
          <Button
            ref={archiveRef}
            variant="primary"
            size="lg"
            onClick={() => void run('archive')}
            disabled={busy === 'delete'}
            loading={busy === 'archive'}
            loadingText="Archiving…"
          >
            Archive
          </Button>
        </div>
      </div>
    </Modal>
  );
};
