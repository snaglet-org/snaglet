import type { FC } from 'react';
import { Button, Modal } from '@desktop/components';
import modalStyles from '@desktop/components/Modal/Modal.module.scss';
import { formatBytes } from '@snaglet/shared/utils';
import type { ProjectEmbeddingsClearPreview } from '@desktop/utils/api/projects';

export interface ClearEmbeddingsModalProps {
  preview: ProjectEmbeddingsClearPreview;
  folderPath: string;
  /** Whether background indexing is currently on — if so, say out loud that
   * the folder will be re-indexed automatically after the clear. */
  workerEnabled: boolean;
  busy: boolean;
  error: string | null;
  onConfirm: () => void;
  onCancel: () => void;
}

/**
 * Destructive confirmation for clearing a project's stored embeddings, the
 * only ordinary UI action that deletes them. The headline number is
 * `reclaimableBytes`; embeddings shared with other projects are called out as
 * kept, never counted as freed. Sizes are approximate stored-data sizes, not
 * a promise of on-disk shrinkage. Source files and the worker preference are
 * untouched.
 */
export const ClearEmbeddingsModal: FC<ClearEmbeddingsModalProps> = ({
  preview,
  folderPath,
  workerEnabled,
  busy,
  error,
  onConfirm,
  onCancel,
}) => {
  const files = preview.fileCount;
  return (
    <Modal onClose={onCancel} aria-label="Clear embeddings for this project">
      <div className={modalStyles.modalContent}>
        <h2 className={modalStyles.modalTitle}>Clear embeddings for this project?</h2>
        {/*
          `fileCount` (indexed file rows) and `vectorChunks` (embeddings) are
          different numbers and must be stated separately — collapsing them
          into "N file embeddings" contradicts the coverage line behind the
          modal whenever coverage is partial.
        */}
        <p className={modalStyles.modalMessage}>
          This will delete{' '}
          <strong>
            {files.toLocaleString()} indexed file{files === 1 ? '' : 's'}
            {preview.vectorChunks > 0 ? (
              <>
                {' '}
                and {preview.vectorChunks.toLocaleString()} embedding
                {preview.vectorChunks === 1 ? '' : 's'} (~
                {formatBytes(preview.reclaimableBytes)})
              </>
            ) : null}
          </strong>{' '}
          for <code>{folderPath}</code> from Snaglet&rsquo;s local database.{' '}
          {preview.vectorChunks > 0 ? (
            <>
              Semantic file search and agent retrieval for these files will stop working until
              embeddings are created again.
            </>
          ) : (
            <>
              These files have no embeddings yet, so nothing searchable is lost and no storage is
              reclaimed — this only clears the index records.
            </>
          )}{' '}
          Your source files will not be changed.
        </p>
        {preview.sharedContents > 0 && (
          <p className={modalStyles.modalMessage}>
            {preview.sharedContents.toLocaleString()} embedded content
            {preview.sharedContents === 1 ? ' is' : 's are'} also referenced by other projects and
            will be kept — only storage no other project uses (~
            {formatBytes(preview.reclaimableBytes)} of {formatBytes(preview.linkedBytes)} linked) is
            reclaimed.
          </p>
        )}
        {workerEnabled && (
          <p className={modalStyles.modalMessage}>
            Background indexing is still enabled, so Snaglet will start re-indexing this folder
            automatically. Disable background indexing first if you want the folder to stay
            unindexed.
          </p>
        )}
        {error && (
          <p className={modalStyles.modalMessage} role="alert">
            {error}
          </p>
        )}
        <div className={modalStyles.modalActions}>
          <Button variant="neutral" size="lg" onClick={onCancel} disabled={busy}>
            Cancel
          </Button>
          <Button
            variant="danger"
            size="lg"
            onClick={onConfirm}
            disabled={busy}
            title="Delete this project’s stored embeddings from Snaglet’s local database"
          >
            {busy ? 'Clearing…' : 'Clear embeddings'}
          </Button>
        </div>
      </div>
    </Modal>
  );
};
