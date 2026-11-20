import { useCallback, useState, type FC } from 'react';
import { Button, Modal, Select, TextInput } from '@desktop/components';
import { projectOptionLabel, useProjectList } from '@desktop/features/database';
import { threadsApi, type ThreadSummary } from '@desktop/utils/api';
import { getErrorMessage } from '@snaglet/shared/utils';
import { THREAD_TITLE_MAX_LENGTH } from '@snaglet/shared/types';
import styles from './ForkThreadModal.module.scss';

interface ForkThreadModalProps {
  threadId: string;
  /** Prefilled title, e.g. "Sprout · Home thread · Nov 6". */
  defaultTitle: string;
  onClose: () => void;
  /** The forked workspace thread, once the server has created it. */
  onForked: (thread: ThreadSummary) => void;
}

/**
 * The "Fork thread to workspace" dialog: a title (prefilled) and an optional
 * project (none = a flat workspace thread). One action forks the home thread's
 * whole history into a new real thread, leaving the source untouched.
 */
export const ForkThreadModal: FC<ForkThreadModalProps> = ({
  threadId,
  defaultTitle,
  onClose,
  onForked,
}) => {
  const [title, setTitle] = useState(defaultTitle);
  const [projectId, setProjectId] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { projects, error: projectsError } = useProjectList();

  const trimmedTitle = title.trim();

  // While the request is in flight, Escape / backdrop clicks must not dismiss
  // the dialog: that would hide a failure (and leave the user unsure whether
  // the fork happened). Closing is only allowed once we are idle.
  const requestClose = useCallback(() => {
    if (submitting) return;
    onClose();
  }, [submitting, onClose]);

  const handleFork = async (): Promise<void> => {
    if (!trimmedTitle || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      const thread = await threadsApi.fork(threadId, {
        title: trimmedTitle,
        projectId: projectId || null,
      });
      onForked(thread);
      onClose();
    } catch (err) {
      setError(getErrorMessage(err, 'Failed to fork this thread'));
      setSubmitting(false);
    }
  };

  return (
    <Modal onClose={requestClose}>
      <Modal.Header>Fork thread to workspace</Modal.Header>
      <Modal.Body>
        <p className={styles.intro}>
          Copies this conversation&rsquo;s whole history into a new workspace thread. The home
          thread is left as it is.
        </p>
        <label className={styles.field}>
          <span className={styles.label}>Title</span>
          <TextInput
            fullWidth
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            onKeyDown={(e) => {
              // Enter submits the fork (unless composing, or the title is
              // empty / a request is in flight, which handleFork guards).
              if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
                e.preventDefault();
                void handleFork();
              }
            }}
            maxLength={THREAD_TITLE_MAX_LENGTH}
            disabled={submitting}
            autoFocus
          />
        </label>
        <label className={styles.field}>
          <span className={styles.label}>Project (optional)</span>
          <Select
            value={projectId}
            onChange={(e) => setProjectId(e.target.value)}
            disabled={submitting}
            aria-label="Project for the forked thread"
          >
            <option value="">No project (flat)</option>
            {(projects ?? []).map((project) => (
              <option key={project.id} value={project.id}>
                {projectOptionLabel(project)}
              </option>
            ))}
          </Select>
        </label>
        {projectsError && (
          <div className={styles.error} role="alert">
            {projectsError}
          </div>
        )}
        {error && (
          <div className={styles.error} role="alert">
            {error}
          </div>
        )}
      </Modal.Body>
      <Modal.Footer>
        <Button variant="ghost" onClick={requestClose} disabled={submitting}>
          Cancel
        </Button>
        <Button
          variant="primary"
          onClick={() => void handleFork()}
          loading={submitting}
          disabled={!trimmedTitle}
        >
          Fork
        </Button>
      </Modal.Footer>
    </Modal>
  );
};
