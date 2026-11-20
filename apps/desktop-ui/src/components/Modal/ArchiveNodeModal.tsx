import React, { useEffect, useState } from 'react';
import { getErrorMessage } from '@snaglet/shared/utils';
import { Modal } from './Modal';
import { ConfirmModal } from './ConfirmModal';
import styles from './Modal.module.scss';
import { archiveApi } from '@desktop/utils/api';
import type { ArchiveCascadeCounts, ArchivedNode } from '@desktop/utils/api';
import { Button } from '../controls/Button/Button';

interface ArchiveNodeModalProps {
  /** The node being archived. */
  node: { id: string; type: string; label?: string };
  /** Called after the archive succeeds. The cascade affected-row count is passed. */
  onArchived: (result: { node: ArchivedNode | null; affected: number }) => void;
  onCancel: () => void;
}

const TYPE_LABEL: Record<string, string> = {
  container: 'container',
  doc: 'doc',
  project: 'project',
  thread: 'thread',
  agent: 'agent',
  memory: 'memory',
  image: 'image',
  message: 'message',
};

function pluralize(n: number, unit: string): string {
  return `${n} ${unit}${n === 1 ? '' : 's'}`;
}

function renderCascadeLines(counts: ArchiveCascadeCounts, nodeType: string): React.ReactNode {
  const lines: string[] = [];
  if (counts.sub_containers > 0)
    lines.push(`• ${pluralize(counts.sub_containers, 'sub-container')}`);
  if (counts.docs > 0) lines.push(`• ${pluralize(counts.docs, 'doc')}`);
  if (counts.projects > 0) {
    lines.push(`• ${pluralize(counts.projects, 'project')}`);
  }
  if (counts.threads > 0) {
    lines.push(
      counts.messages > 0
        ? `• ${pluralize(counts.threads, 'thread')} (${pluralize(counts.messages, 'message')})`
        : `• ${pluralize(counts.threads, 'thread')}`
    );
  }
  if (counts.memories > 0) lines.push(`• ${pluralize(counts.memories, 'memory')}`);
  if (lines.length === 0) {
    if (nodeType === 'container' || nodeType === 'project' || nodeType === 'thread') {
      return <p className={styles.modalMessage}>No active children — only this item.</p>;
    }
    return null;
  }
  return (
    <pre className={styles.modalMessage} style={{ whiteSpace: 'pre-line' }}>
      {lines.join('\n')}
    </pre>
  );
}

export const ArchiveNodeModal: React.FC<ArchiveNodeModalProps> = ({
  node,
  onArchived,
  onCancel,
}) => {
  const [counts, setCounts] = useState<ArchiveCascadeCounts | null>(null);
  const [loadingCounts, setLoadingCounts] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busyAction, setBusyAction] = useState<'archive' | 'hard-delete' | null>(null);
  /** Second-step confirmation for the irreversible hard delete. */
  const [confirmingHardDelete, setConfirmingHardDelete] = useState(false);

  useEffect(() => {
    let canceled = false;
    archiveApi
      .counts(node.id)
      .then((r) => {
        if (canceled) return;
        setCounts(r.counts);
      })
      .catch((err) => {
        if (canceled) return;
        setError(getErrorMessage(err, 'Failed to load cascade counts'));
      })
      .finally(() => {
        if (canceled) return;
        setLoadingCounts(false);
      });
    return () => {
      canceled = true;
    };
  }, [node.id]);

  const typeLabel = TYPE_LABEL[node.type] ?? node.type;
  const labelText = node.label ?? node.id;

  const handleArchive = async () => {
    setBusyAction('archive');
    setError(null);
    try {
      const result = await archiveApi.archive(node.id);
      onArchived({ node: result.node, affected: result.affected });
    } catch (err) {
      setError(getErrorMessage(err, 'Failed to archive'));
      setBusyAction(null);
    }
  };

  // Runs only from the stacked ConfirmModal's confirm button — the Tauri
  // webview suppresses window.confirm (returns falsy without showing), so a
  // native-dialog gate here silently killed the Delete Permanently button.
  const handleHardDelete = async () => {
    setBusyAction('hard-delete');
    setError(null);
    try {
      await archiveApi.hardDelete(node.id);
      onArchived({ node: null, affected: 0 });
    } catch (err) {
      setError(getErrorMessage(err, 'Failed to hard-delete'));
      setBusyAction(null);
    }
  };

  const busy = busyAction !== null;

  return (
    // While the confirmation is stacked on top, the base modal must not
    // dismiss — both dialogs listen for Esc, and closing this one would
    // orphan the confirmation mid-decision.
    <Modal
      onClose={confirmingHardDelete ? () => undefined : onCancel}
      aria-label={`Archive ${labelText}`}
    >
      <div className={styles.modalContent}>
        <h2 className={styles.modalTitle}>
          Archive {typeLabel} &ldquo;{labelText}&rdquo;?
        </h2>
        {loadingCounts ? (
          <p className={styles.modalMessage}>Computing cascade…</p>
        ) : counts ? (
          <>
            <p className={styles.modalMessage}>This will archive:</p>
            {renderCascadeLines(counts, node.type)}
            <p className={styles.modalMessage}>
              Archived items keep a 30-day TTL — they auto hard-delete after 30 days unless
              restored.
            </p>
          </>
        ) : null}
        {error && <p className={styles.errorMessage}>{error}</p>}
        <div className={styles.modalActions}>
          <Button variant="neutral" size="lg" onClick={onCancel} disabled={busy}>
            Cancel
          </Button>
          <Button
            variant="danger"
            size="lg"
            onClick={() => setConfirmingHardDelete(true)}
            disabled={busy || loadingCounts}
            loading={busyAction === 'hard-delete'}
            loadingText="Deleting…"
            title="Skip the archive intermediate — delete immediately and irreversibly"
          >
            Delete Permanently
          </Button>
          <Button
            variant="primary"
            size="lg"
            onClick={handleArchive}
            disabled={busy || loadingCounts}
            loading={busyAction === 'archive'}
            loadingText="Archiving…"
          >
            Archive
          </Button>
        </div>
      </div>
      {confirmingHardDelete && (
        <ConfirmModal
          title="Delete permanently?"
          confirmLabel="Delete Permanently"
          confirmingLabel="Deleting…"
          destructive
          onConfirm={() => {
            // Close the confirmation first, then run the delete — the base
            // modal's own button carries the in-flight spinner and any
            // failure message, exactly as the window.confirm flow did.
            setConfirmingHardDelete(false);
            void handleHardDelete();
          }}
          onCancel={() => setConfirmingHardDelete(false)}
        >
          {`Permanently delete "${labelText}" and all its contents? This cannot be undone.`}
        </ConfirmModal>
      )}
    </Modal>
  );
};
