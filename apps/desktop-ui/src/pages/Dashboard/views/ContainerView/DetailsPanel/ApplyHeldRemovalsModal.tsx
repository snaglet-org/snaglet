import type { FC } from 'react';
import { Button, Modal } from '@desktop/components';
import modalStyles from '@desktop/components/Modal/Modal.module.scss';

export interface ApplyHeldRemovalsModalProps {
  /** The exact held count the person is confirming. */
  count: number;
  /** Indexed files the project had when the hold was recorded. */
  total: number;
  folderPath: string;
  busy: boolean;
  error: string | null;
  onConfirm: () => void;
  onCancel: () => void;
}

/**
 * Confirmation for releasing a mass-removal hold. Snaglet kept these rows because
 * most of the project vanished at once, and this is the only way to let that
 * deletion through, so the copy names the folder and the exact count, says
 * what is lost, and the button repeats the number.
 */
export const ApplyHeldRemovalsModal: FC<ApplyHeldRemovalsModalProps> = ({
  count,
  total,
  folderPath,
  busy,
  error,
  onConfirm,
  onCancel,
}) => {
  const files = `${count.toLocaleString()} missing file${count === 1 ? '' : 's'}`;
  return (
    <Modal onClose={onCancel} aria-label="Remove missing files from the index">
      <div className={modalStyles.modalContent}>
        <h2 className={modalStyles.modalTitle}>Remove {files} from the index?</h2>
        <p className={modalStyles.modalMessage}>
          <strong>
            {count.toLocaleString()} of {total.toLocaleString()} indexed files
          </strong>{' '}
          are missing from <code>{folderPath}</code>. Snaglet kept them in case this was a mistake —
          a folder on an unmounted drive, files evicted to iCloud, or a sync that hasn&rsquo;t
          finished.
        </p>
        <p className={modalStyles.modalMessage}>
          Removing them deletes their index records from Snaglet&rsquo;s local database, and
          anything in Snaglet that points at those files loses its link. Your files on disk are not
          touched. Only do this if you really deleted these files.
        </p>
        <p className={modalStyles.modalMessage}>
          Snaglet checks the folder again first: if the number has changed, nothing is removed and
          you will see the new count.
        </p>
        {error && (
          <p className={modalStyles.modalMessage} role="alert">
            {error}
          </p>
        )}
        <div className={modalStyles.modalActions}>
          <Button variant="neutral" size="lg" onClick={onCancel} disabled={busy}>
            Keep them
          </Button>
          <Button
            variant="danger"
            size="lg"
            onClick={onConfirm}
            disabled={busy}
            title="Delete these files' index records from Snaglet's local database"
          >
            {busy ? 'Removing…' : `Remove ${files}`}
          </Button>
        </div>
      </div>
    </Modal>
  );
};
