import type { FC } from 'react';
import { Button, EmptyState } from '@desktop/components';
import { useToolApprovalPending } from '@desktop/utils/notificationState';
import { useThreadRunning } from '@desktop/utils/threadRunState';
import type { HelperThreadInfo } from './useHelperThread';
import { removeHelper, resumeHelper } from './subagentActions';
import { helperLabel, helperProblem, liveSubagentLabel, liveSubagentStatus } from './subagentText';
import styles from './SubagentThreadHeader.module.scss';

interface SubagentThreadHeaderProps {
  threadId: string;
  helper: HelperThreadInfo;
  /**
   * Open the parent thread in this pane. Without it (previews) the header
   * only describes: no link and no actions.
   */
  onOpenParent?: () => void;
}

/**
 * Under the status strip of a helper's hidden thread: whose subagent this is,
 * on which model, its state, Resume while it is paused, Remove, and the way
 * back to the thread that started it. Pausing is the composer's Stop.
 */
export const SubagentThreadHeader: FC<SubagentThreadHeaderProps> = ({
  threadId,
  helper,
  onOpenParent,
}) => {
  const threadRunning = useThreadRunning(threadId);
  const approvalPending = useToolApprovalPending(threadId);
  const subagent = helper.subagent;
  if (!subagent) return null;
  const state = liveSubagentStatus(subagent.status, threadRunning, approvalPending);
  return (
    <div className={styles.header} data-tid="subagentThreadHeader">
      <span className={styles.label}>
        <span className={styles.who}>{helperLabel(subagent)}</span>
        <span className={styles.sep} aria-hidden>
          ·
        </span>
        <span className={styles.model}>{subagent.modelId}</span>
        <span className={styles.sep} aria-hidden>
          ·
        </span>
        <span
          className={styles.state}
          title={state === subagent.status ? (helperProblem(subagent) ?? undefined) : undefined}
        >
          {liveSubagentLabel(state, subagent.resumeAt)}
        </span>
      </span>
      {onOpenParent && state === 'stopped' && (
        <Button
          variant="link"
          size="xs"
          className={styles.action}
          onClick={() => void resumeHelper(subagent)}
        >
          Resume
        </Button>
      )}
      {onOpenParent && (
        <>
          <Button
            variant="link"
            size="xs"
            className={styles.action}
            title={
              state === 'finished' || state === 'failed'
                ? `Delete ${subagent.name} with its thread`
                : `Stop ${subagent.name} and delete it with its thread`
            }
            onClick={() => void removeHelper(subagent)}
          >
            Remove
          </Button>
          <Button variant="link" size="xs" className={styles.action} onClick={onOpenParent}>
            Open parent thread
          </Button>
        </>
      )}
    </div>
  );
};

/**
 * What a helper's thread shows once the helper is removed: its thread and
 * messages are deleted; its reports stay in the parent thread.
 */
export const SubagentRemovedState: FC<{ onOpenParent?: () => void }> = ({ onOpenParent }) => (
  <EmptyState
    title="This subagent was removed"
    body="Its thread was deleted. Its reports stay in the parent thread."
    action={
      onOpenParent ? (
        <Button variant="neutral" size="sm" onClick={onOpenParent}>
          Open parent thread
        </Button>
      ) : undefined
    }
  />
);
