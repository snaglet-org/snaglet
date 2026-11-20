import { useRef, useState, type FC, type FormEvent } from 'react';
import { formatTableName, getErrorMessage, tableNameProblem } from '@snaglet/shared/utils';
import { Button, Modal, TextInput } from '@desktop/components';
import { suggestRestoredTableName } from '@desktop/features/database/tableLifecycle';
import { formatFieldValue } from '@desktop/utils/formatAsYouType';
import styles from './RestoreTableNameModal.module.scss';

interface RestoreTableNameModalProps {
  /** What is being restored: a table (default) or one of a table's columns. */
  kind?: 'table' | 'field';
  /** The archived table's (or column's) name, which another has taken since. */
  tableName: string;
  /** The server's explanation of the conflict. */
  message: string;
  /**
   * Restore under the typed name. A rejection (another taken name, a failed
   * request) shows inline and keeps the prompt open; on success the parent
   * closes it.
   */
  onRestore: (name: string) => Promise<void>;
  onCancel: () => void;
}

const TITLE = 'Restore under a new name';

/**
 * Asks for a new name when an archived table's old one is taken. The field
 * starts from a suggestion and follows the shared table-name policy: typed
 * capitals and spaces become lowercase and `_`, and any other problem shows
 * as soon as the user types, or on submit when empty.
 */
export const RestoreTableNameModal: FC<RestoreTableNameModalProps> = ({
  kind = 'table',
  tableName,
  message,
  onRestore,
  onCancel,
}) => {
  const [value, setValue] = useState(() => suggestRestoredTableName(tableName));
  const [attempted, setAttempted] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);

  const problem = tableNameProblem(value, kind);
  const shownProblem = problem && (attempted || value.trim().length > 0) ? problem : null;
  const error = serverError ?? shownProblem;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (busyRef.current) return;
    setAttempted(true);
    if (problem) return;
    busyRef.current = true;
    setBusy(true);
    setServerError(null);
    try {
      await onRestore(value.trim());
    } catch (err) {
      setServerError(getErrorMessage(err, 'Restore failed'));
      busyRef.current = false;
      setBusy(false);
    }
  };

  return (
    <Modal onClose={busy ? () => undefined : onCancel} aria-label={TITLE}>
      <form className={styles.content} onSubmit={(event) => void submit(event)} noValidate>
        <h2 className={styles.title}>{TITLE}</h2>
        <p className={styles.message}>{message}</p>
        <TextInput
          label={kind === 'field' ? 'New column name' : 'New table name'}
          value={value}
          onChange={(event) => {
            setServerError(null);
            setValue(formatFieldValue(event.target, formatTableName));
          }}
          onFocus={(event) => event.currentTarget.select()}
          error={error ?? undefined}
          disabled={busy}
          autoComplete="off"
          spellCheck={false}
          fullWidth
        />
        <div className={styles.actions}>
          <Button variant="neutral" size="lg" onClick={onCancel} disabled={busy}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" size="lg" loading={busy} loadingText="Restoring…">
            Restore
          </Button>
        </div>
      </form>
    </Modal>
  );
};
