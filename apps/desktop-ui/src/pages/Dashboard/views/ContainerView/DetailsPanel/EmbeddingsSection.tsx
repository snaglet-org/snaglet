import { useCallback, useEffect, useRef, useState, type FC } from 'react';
import { projectsApi } from '@desktop/utils/api';
import type {
  ProjectEmbeddingsClearPreview,
  ProjectIndexingStatus,
} from '@desktop/utils/api/projects';
import { onLibraryEvent } from '@desktop/utils/workspaceEvents';
import { Button, Light } from '@desktop/components';
import { formatBytes, getErrorMessage } from '@snaglet/shared/utils';
import { ClearEmbeddingsModal } from './ClearEmbeddingsModal';
import { ApplyHeldRemovalsModal } from './ApplyHeldRemovalsModal';
import styles from './EmbeddingsSection.module.scss';

const REFRESH_DEBOUNCE_MS = 300;

/**
 * "Embeddings for this folder": worker status, vector coverage, and three
 * actions that keep pausing and deleting apart. Enable/Disable background
 * indexing writes `embeddings.enabled` and is reversible (paused data is
 * kept); Backfill runs an explicit indexing pass, even while paused; Clear
 * embeddings is the only deleting action, behind a confirmation that never
 * counts shared embeddings as reclaimed space.
 */
export const EmbeddingsSection: FC<{ projectId: string }> = ({ projectId }) => {
  const [status, setStatus] = useState<ProjectIndexingStatus | null>(null);
  const [statusFailed, setStatusFailed] = useState(false);
  const [preview, setPreview] = useState<ProjectEmbeddingsClearPreview | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [cancelBusy, setCancelBusy] = useState(false);
  const [toggleBusy, setToggleBusy] = useState(false);
  const [clearModalOpen, setClearModalOpen] = useState(false);
  const [clearBusy, setClearBusy] = useState(false);
  const [clearError, setClearError] = useState<string | null>(null);
  const [heldModalOpen, setHeldModalOpen] = useState(false);
  const [heldBusy, setHeldBusy] = useState(false);
  const [heldError, setHeldError] = useState<string | null>(null);

  const requestVersionRef = useRef(0);
  const refreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const refresh = useCallback(async () => {
    const version = ++requestVersionRef.current;
    try {
      const [nextStatus, nextPreview] = await Promise.all([
        projectsApi.getIndexingStatus(projectId),
        projectsApi.getEmbeddingsClearPreview(projectId),
      ]);
      if (requestVersionRef.current !== version) return;
      setStatus(nextStatus);
      setPreview(nextPreview);
      setStatusFailed(false);
    } catch {
      if (requestVersionRef.current === version) setStatusFailed(true);
    }
  }, [projectId]);

  useEffect(() => {
    setStatus(null);
    setPreview(null);
    setStatusFailed(false);
    setActionError(null);
    void refresh();
    return () => {
      requestVersionRef.current += 1;
    };
  }, [refresh]);

  // Realtime: coverage deltas (any ingest/GC anywhere) refetch debounced;
  // runtime transitions for this project merge in-place, and a transition back
  // to idle (backfill/clear finished) triggers a full refetch so coverage and
  // the clear preview reflect the outcome.
  useEffect(() => {
    const unsubscribe = onLibraryEvent((event) => {
      if (event.type === 'file-embedding-coverage-changed') {
        if (refreshTimerRef.current) clearTimeout(refreshTimerRef.current);
        refreshTimerRef.current = setTimeout(() => void refresh(), REFRESH_DEBOUNCE_MS);
        return;
      }
      if (event.type !== 'file-indexing-status-changed' || event.projectId !== projectId) return;
      const { runtime } = event;
      setStatus((prev) => (prev ? { ...prev, ...runtime } : prev));
      if (runtime.op === 'idle' || runtime.op === 'cancelled') {
        setCancelBusy(false);
        void refresh();
      }
    });
    return () => {
      unsubscribe();
      if (refreshTimerRef.current) clearTimeout(refreshTimerRef.current);
    };
  }, [projectId, refresh]);

  useEffect(() => {
    if (!status?.activeExclusiveOp) return;
    const timer = setInterval(() => void refresh(), 2000);
    return () => clearInterval(timer);
  }, [status?.activeExclusiveOp, refresh]);

  useEffect(() => {
    if (status?.activeExclusiveOp !== 'backfill') setCancelBusy(false);
  }, [status?.activeExclusiveOp]);

  const toggleWorker = useCallback(async () => {
    if (!status) return;
    const next = !status.workerEnabled;
    setToggleBusy(true);
    setActionError(null);
    try {
      // Writes `embeddings.enabled` to snaglet.config.json (the source of truth).
      // Pausing stops future watching/indexing only — the server-side
      // lifecycle preserves all indexed rows and embeddings.
      await projectsApi.updateIndexConfig(projectId, { enabled: next });
      await refresh();
    } catch (err) {
      setActionError(getErrorMessage(err, 'Could not update background indexing'));
    } finally {
      setToggleBusy(false);
    }
  }, [projectId, refresh, status]);

  const startBackfill = useCallback(async () => {
    setActionError(null);
    try {
      await projectsApi.startEmbeddingsBackfill(projectId);
      // Progress streams in via file-indexing-status-changed events; refresh
      // once so the scanning phase shows immediately even if events lag.
      await refresh();
    } catch (err) {
      setActionError(getErrorMessage(err, 'Could not start backfill'));
    }
  }, [projectId, refresh]);

  const cancelBackfill = useCallback(async () => {
    setCancelBusy(true);
    setActionError(null);
    try {
      await projectsApi.cancelEmbeddingsBackfill(projectId);
      await refresh();
    } catch (err) {
      setCancelBusy(false);
      setActionError(getErrorMessage(err, 'Could not cancel backfill'));
    }
  }, [projectId, refresh]);

  const openClearModal = useCallback(() => {
    setClearError(null);
    setClearModalOpen(true);
    // Refetch the numbers the user is about to confirm — they must be current.
    void refresh();
  }, [refresh]);

  const confirmClear = useCallback(async () => {
    setClearBusy(true);
    setClearError(null);
    try {
      await projectsApi.clearEmbeddings(projectId);
      setClearModalOpen(false);
      await refresh();
    } catch (err) {
      setClearError(getErrorMessage(err, 'Could not clear embeddings'));
    } finally {
      setClearBusy(false);
    }
  }, [projectId, refresh]);

  const openHeldModal = useCallback(() => {
    setHeldError(null);
    setHeldModalOpen(true);
    void refresh();
  }, [refresh]);

  const confirmHeld = useCallback(
    async (expected: number) => {
      setHeldBusy(true);
      setHeldError(null);
      try {
        await projectsApi.applyHeldRemovals(projectId, expected);
        setHeldModalOpen(false);
      } catch (err) {
        setHeldError(getErrorMessage(err, 'Could not remove the missing files'));
      } finally {
        setHeldBusy(false);
        await refresh();
      }
    },
    [projectId, refresh]
  );

  if (statusFailed) {
    return (
      <div className={styles.embeddingsSection}>
        <span className={styles.sectionLabel}>Embeddings for this folder</span>
        <div className={styles.errorBanner}>Embedding status unavailable.</div>
      </div>
    );
  }

  if (!status) {
    return (
      <div className={styles.embeddingsSection}>
        <span className={styles.sectionLabel}>Embeddings for this folder</span>
        <div className={styles.statusHint}>Checking embedding status…</div>
      </div>
    );
  }

  const { workerEnabled, configStatus, coverage, op, lastError, lastCheckedAt, backfill } = status;
  const exclusiveBusy = status.activeExclusiveOp !== null;
  const failed = op === 'idle' && lastError !== null;

  const lightState =
    op !== 'idle' && op !== 'cancelled'
      ? 'busy'
      : failed || configStatus === 'invalid' || configStatus === 'unreadable'
        ? 'failed'
        : workerEnabled
          ? 'enabled'
          : 'paused';

  const stateName =
    op === 'scanning'
      ? 'Scanning'
      : op === 'embedding'
        ? 'Embedding'
        : op === 'clearing'
          ? 'Clearing'
          : op === 'cancelled'
            ? 'Canceled'
            : failed
              ? 'Failed'
              : configStatus === 'invalid'
                ? 'Config error'
                : configStatus === 'unreadable'
                  ? 'Folder unreachable'
                  : workerEnabled
                    ? 'Enabled'
                    : 'Paused';

  const narrative =
    op === 'scanning'
      ? 'Checking this folder for changed or added files…'
      : op === 'embedding'
        ? 'Creating embeddings for missing or stale files…'
        : op === 'clearing'
          ? 'Clearing this project’s stored embeddings…'
          : op === 'cancelled'
            ? 'Backfill canceled. Finished embeddings are preserved. Re-run backfill to resume.'
            : failed
              ? (lastError ?? 'The last operation failed.')
              : configStatus === 'invalid'
                ? 'snaglet.config.json in this folder is not valid JSON, so background indexing is stopped. Existing embeddings are preserved. Fix the file by hand to resume.'
                : configStatus === 'unreadable'
                  ? 'Snaglet can’t read this folder right now, so background indexing is stopped. Existing embeddings are preserved.'
                  : workerEnabled
                    ? 'Background embeddings are enabled for this project’s local folder. Snaglet periodically checks the folder for changed or added files.'
                    : 'Background embeddings are paused for this project’s local folder. Existing embeddings are preserved and remain searchable.';

  const embedded = coverage.embeddedFiles;
  const total = coverage.totalFiles;
  const missing = Math.max(0, total - embedded);
  const percent = total > 0 ? Math.min(100, Math.round((embedded / total) * 100)) : 0;
  const coverageLabel =
    total > 0
      ? `${embedded.toLocaleString()} of ${total.toLocaleString()} indexed files vectorized`
      : 'No files indexed yet';

  const clearLabel =
    preview && preview.fileCount > 0
      ? `Clear embeddings · ${formatBytes(preview.reclaimableBytes)}`
      : 'Clear embeddings';

  return (
    <div className={styles.embeddingsSection} aria-label="Embeddings for this folder">
      <span className={styles.sectionLabel}>Embeddings for this folder</span>

      <div className={styles.statusRow}>
        <Light
          className={styles.statusLight}
          color={
            lightState === 'enabled'
              ? 'green'
              : lightState === 'paused'
                ? 'amber'
                : lightState === 'busy'
                  ? 'blue'
                  : 'red'
          }
          on
          pulse={lightState === 'busy'}
        />
        <div className={styles.statusText}>
          <span className={styles.statusName} data-state={lightState}>
            {stateName}
          </span>
          <p className={styles.statusHint}>{narrative}</p>
        </div>
      </div>

      {status.folderPath && <p className={styles.statusHint}>Folder: {status.folderPath}</p>}
      <div className={styles.actionsRow}>
        <Button
          variant="neutral"
          size="sm"
          onClick={() => void toggleWorker()}
          disabled={toggleBusy || op === 'clearing'}
          title={
            workerEnabled
              ? 'Stop watching and background indexing. Existing embeddings are kept.'
              : 'Resume watching and background indexing for this folder.'
          }
        >
          {workerEnabled ? 'Disable background indexing' : 'Enable background indexing'}
        </Button>
        <Button
          variant="neutral"
          size="sm"
          onClick={() => void startBackfill()}
          disabled={exclusiveBusy}
          title="Index this folder now and embed missing or stale files. Works while background indexing is paused."
        >
          Backfill missing or stale
        </Button>
        {status.activeExclusiveOp === 'backfill' && (
          <Button
            variant="neutral"
            size="sm"
            onClick={() => void cancelBackfill()}
            disabled={cancelBusy}
          >
            {cancelBusy ? 'Canceling…' : 'Cancel backfill'}
          </Button>
        )}
        <Button
          variant="danger"
          size="sm"
          onClick={openClearModal}
          disabled={exclusiveBusy || !preview || preview.fileCount === 0}
          title="Delete this project’s stored embeddings from Snaglet’s local database. Source files are not changed."
        >
          {clearLabel}
        </Button>
      </div>

      {actionError && <div className={styles.errorBanner}>{actionError}</div>}

      {status.heldRemovals ? (
        <div className={styles.warningBanner} role="status" data-testid="held-removals-banner">
          {status.heldRemovals.count.toLocaleString()} file
          {status.heldRemovals.count === 1 ? ' is' : 's are'} missing from the folder; Snaglet kept
          them in case this was a mistake. If you really deleted them, you can remove them from the
          index.{' '}
          <Button
            variant="danger"
            size="sm"
            onClick={openHeldModal}
            disabled={exclusiveBusy}
            title="Review before removing these files' index records"
          >
            Remove {status.heldRemovals.count.toLocaleString()} missing file
            {status.heldRemovals.count === 1 ? '' : 's'}…
          </Button>
        </div>
      ) : status.lastWarning ? (
        <div className={styles.warningBanner} role="status" data-testid="indexing-warning">
          {status.lastWarning}
        </div>
      ) : null}

      <div className={styles.coverageBlock}>
        <div className={styles.coverageHead}>
          <span className={styles.coverageLabel}>File vector coverage</span>
          <span className={styles.coverageCount} aria-live="polite">
            {coverageLabel}
            {total > 0 ? ` · ${percent}%` : ''}
          </span>
        </div>
        <div
          className={styles.coverageTrack}
          role="progressbar"
          aria-label="Vectorized project files"
          aria-valuemin={0}
          aria-valuemax={Math.max(total, 1)}
          aria-valuenow={embedded}
          aria-valuetext={coverageLabel}
          data-paused={!workerEnabled && op === 'idle' ? true : undefined}
        >
          <span className={styles.coverageFill} style={{ width: `${percent}%` }} />
        </div>
        <div className={styles.coverageMeta}>
          {(op === 'embedding' || op === 'cancelled') && backfill ? (
            <span className={styles.coverageOp} aria-live="polite">
              {op === 'cancelled' ? 'Canceled — processed' : 'Embedding'}{' '}
              {backfill.processed.toLocaleString()} of {backfill.total.toLocaleString()}
              {op === 'cancelled'
                ? ` · ${backfill.embedded.toLocaleString()} embedded · re-run to resume`
                : ''}
              {backfill.failed > 0 ? ` · ${backfill.failed.toLocaleString()} failed` : ''}
            </span>
          ) : (
            <span>
              {missing > 0 ? `${missing.toLocaleString()} missing or stale` : 'Up to date'}
              {lastCheckedAt ? ` · Last checked ${relativeTime(lastCheckedAt)}` : ''}
            </span>
          )}
        </div>
        {op === 'idle' && backfill && backfill.failed > 0 && (
          <div className={styles.warningBanner} role="status">
            Last backfill finished with {backfill.failed.toLocaleString()} failed file
            {backfill.failed === 1 ? '' : 's'} of {backfill.total.toLocaleString()}.
          </div>
        )}
      </div>

      {heldModalOpen && status.heldRemovals && (
        <ApplyHeldRemovalsModal
          count={status.heldRemovals.count}
          total={status.heldRemovals.total}
          folderPath={status.folderPath ?? ''}
          busy={heldBusy}
          error={heldError}
          onConfirm={() => void confirmHeld(status.heldRemovals?.count ?? 0)}
          onCancel={() => {
            if (!heldBusy) setHeldModalOpen(false);
          }}
        />
      )}

      {clearModalOpen && preview && (
        <ClearEmbeddingsModal
          preview={preview}
          folderPath={status.folderPath ?? ''}
          workerEnabled={workerEnabled}
          busy={clearBusy}
          error={clearError}
          onConfirm={() => void confirmClear()}
          onCancel={() => {
            if (!clearBusy) setClearModalOpen(false);
          }}
        />
      )}
    </div>
  );
};

/** Compact "8 minutes ago"-style stamp for the last completed check. */
function relativeTime(iso: string): string {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return iso;
  const seconds = Math.max(0, Math.floor((Date.now() - then) / 1000));
  if (seconds < 60) return 'just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'} ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  const days = Math.floor(hours / 24);
  return `${days} day${days === 1 ? '' : 's'} ago`;
}
