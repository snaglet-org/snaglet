import { useState, type FC } from 'react';
import { Button, Checkbox, Modal } from '@desktop/components';
import { threadsApi } from '@desktop/utils/api';
import { getErrorMessage } from '@snaglet/shared/utils';
import styles from './ClearThreadModal.module.scss';

interface ClearThreadModalProps {
  threadId: string;
  threadTitle: string;
  onClose: () => void;
}

/**
 * Confirm dialog for the "Clear" action. Always deletes the thread's messages
 * (and their embeddings) — irreversible — and offers opt-in extras to also
 * clear the thread's summaries and the memories agents formed from it. The open
 * message list empties via the server's `socket:thread:cleared` broadcast, so
 * on success we just close.
 */
export const ClearThreadModal: FC<ClearThreadModalProps> = ({ threadId, threadTitle, onClose }) => {
  const [clearSummaries, setClearSummaries] = useState(false);
  const [clearMemories, setClearMemories] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleClear = async () => {
    setSubmitting(true);
    setError(null);
    try {
      await threadsApi.clear(threadId, { clearSummaries, clearMemories });
      onClose();
    } catch (err) {
      setError(getErrorMessage(err, 'Could not clear thread'));
      setSubmitting(false);
    }
  };

  return (
    <Modal onClose={onClose}>
      <Modal.Header>Clear thread?</Modal.Header>
      <Modal.Body>
        <p className={styles.lead}>
          This permanently deletes every message and message embedding from
          <strong> {threadTitle}</strong>. It can&rsquo;t be undone. The thread itself and its token
          and usage history remain.
        </p>
        <div className={styles.options}>
          <Checkbox checked={clearSummaries} onChange={setClearSummaries} disabled={submitting}>
            Also clear this thread&rsquo;s summaries
          </Checkbox>
          <Checkbox checked={clearMemories} onChange={setClearMemories} disabled={submitting}>
            Also clear memories agents formed from this thread
          </Checkbox>
        </div>
        {error && (
          <div className={styles.error} role="alert">
            {error}
          </div>
        )}
      </Modal.Body>
      <Modal.Footer>
        <Button variant="ghost" onClick={onClose} disabled={submitting}>
          Cancel
        </Button>
        <Button variant="danger" onClick={handleClear} loading={submitting}>
          Clear thread
        </Button>
      </Modal.Footer>
    </Modal>
  );
};
