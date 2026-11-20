import React, { useEffect, useState } from 'react';
import { getErrorMessage } from '@snaglet/shared/utils';
import { Modal } from './Modal';
import styles from './Modal.module.scss';
import { hooksWorkspacesApi } from '@desktop/utils/api';
import type { HookDeleteResult, HookWorkspaceInfo } from '@desktop/utils/api';
import { Button } from '../controls/Button/Button';

interface MoveHookToTrashModalProps {
  /** Folder identity of the hook — hooks have no DB id; the name IS the key. */
  hookName: string;
  /**
   * Which gesture opened the modal — it changes only the framing copy, never
   * the action. 'archive-drop' (default) leads with "you can't archive this
   * hook" because the user just tried exactly that; 'delete' (the sidebar
   * trash button) asks the move-to-Trash question directly. One component
   * either way: the flow (DELETE /api/hooks/:hookName → files to the system
   * Trash) is identical.
   */
  variant?: 'archive-drop' | 'delete';
  /** Called after the move-to-Trash succeeds, with the server's outcome. */
  onTrashed: (result: HookDeleteResult) => void;
  onCancel: () => void;
}

/**
 * MoveHookToTrashModal — the one confirmation surface for removing a hook,
 * opened by dragging a hook onto the archive drop zone ('archive-drop') or
 * by the sidebar row's trash button ('delete'). Hooks are NOT archivable
 * (they're folders on the local machine, not workspace nodes), so the only
 * real action is: move the hook's physical files to the Trash and remove it
 * from Snaglet. One modal is both the explanation and the confirmation — no
 * second confirm. Structure/copy patterns follow ArchiveNodeModal (the
 * destructive-action modal): fetch context on mount, guard actions until it
 * resolves, surface failures inline rather than closing.
 */
export const MoveHookToTrashModal: React.FC<MoveHookToTrashModalProps> = ({
  hookName,
  variant = 'archive-drop',
  onTrashed,
  onCancel,
}) => {
  const [info, setInfo] = useState<HookWorkspaceInfo | null>(null);
  const [loadingInfo, setLoadingInfo] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let canceled = false;
    hooksWorkspacesApi
      .get(hookName)
      .then((workspace) => {
        if (canceled) return;
        setInfo(workspace);
      })
      .catch((err) => {
        if (canceled) return;
        setError(getErrorMessage(err, 'Failed to load the script'));
      })
      .finally(() => {
        if (canceled) return;
        setLoadingInfo(false);
      });
    return () => {
      canceled = true;
    };
  }, [hookName]);

  const handleMoveToTrash = async () => {
    setBusy(true);
    setError(null);
    try {
      const result = await hooksWorkspacesApi.delete(hookName);
      onTrashed(result);
    } catch (err) {
      setError(getErrorMessage(err, 'Failed to move the script to the Trash'));
      setBusy(false);
    }
  };

  return (
    <Modal onClose={onCancel} aria-label={`Move script ${hookName} to the Trash`}>
      <div className={styles.modalContent}>
        {variant === 'archive-drop' ? (
          <>
            <h2 className={styles.modalTitle}>You can&rsquo;t archive this script</h2>
            <p className={styles.modalMessage}>
              Scripts aren&rsquo;t workspace items, so &ldquo;{hookName}&rdquo; can&rsquo;t go to
              the archive. Its code lives on your local machine at{' '}
              <code>{info?.homeRelativeDir ?? '…'}</code>.
            </p>
            <p className={styles.modalMessage}>
              You can move it to the Trash from here instead: the script folder and its generated
              build files go to your system Trash (recoverable with Finder&rsquo;s &ldquo;Put
              Back&rdquo;), and the script — its registration, schedules, and run history — is
              removed from Snaglet.
            </p>
          </>
        ) : (
          <>
            <h2 className={styles.modalTitle}>Move &ldquo;{hookName}&rdquo; to the Trash?</h2>
            <p className={styles.modalMessage}>
              Its code lives on your local machine at <code>{info?.homeRelativeDir ?? '…'}</code>.
              The script folder and its generated build files go to your system Trash (recoverable
              with Finder&rsquo;s &ldquo;Put Back&rdquo;), and the script — its registration,
              schedules, and run history — is removed from Snaglet.
            </p>
          </>
        )}
        {error && <p className={styles.errorMessage}>{error}</p>}
        <div className={styles.modalActions}>
          <Button variant="neutral" size="lg" onClick={onCancel} disabled={busy}>
            Cancel
          </Button>
          <Button
            variant="danger"
            size="lg"
            onClick={() => void handleMoveToTrash()}
            disabled={busy || loadingInfo}
            loading={busy}
            loadingText="Moving to Trash…"
            title="Move the script's local files to the Trash and remove it from Snaglet"
          >
            Move to Trash
          </Button>
        </div>
      </div>
    </Modal>
  );
};
