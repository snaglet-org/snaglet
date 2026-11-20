import { useCallback, useEffect, useRef, useState, type FC } from 'react';
import { useGuardedInterval } from '@desktop/hooks/useGuardedInterval';
import { databaseApi } from '@desktop/utils/api';
import type { DbSnapshot, DbBackupJobStatus, DbPreUpdateCheckpoints } from '@desktop/utils/api';
import { PRE_UPDATE_SNAPSHOT_RETENTION } from '@snaglet/shared/constants/backups';
import type { DbStatsResponse } from '@snaglet/shared/types';
import { getErrorMessage, formatBytes } from '@snaglet/shared/utils';
import { Button, Checkbox, Modal } from '@desktop/components';
import { ConfirmModal } from '@desktop/components/Modal';
import { showToast } from '@desktop/utils/toast';
import { emitLibraryEvent } from '@desktop/utils/workspaceEvents';
import { isTauriEnv } from '@desktop/utils/tauriEnv';
import { socketClient } from '@desktop/socket';
import { useDashboardNavigation } from '../../selection/DashboardNavigationContext';
import styles from './DatabaseSettingsView.module.scss';

type ResetScope = 'content' | 'all';

const PRESERVED_SUMMARY = 'account, providers, API keys, models, and settings';

function kindLabel(kind: DbBackupJobStatus['kind']): string {
  if (kind === 'snapshot') return 'Snapshot';
  if (kind === 'restore') return 'Restore';
  if (kind === 'reset') return 'Reset';
  return 'Job';
}

function snapshotKindTag(kind: DbSnapshot['kind']): string {
  if (kind === 'pre-reset') return 'auto · pre-reset';
  if (kind === 'pre-restore') return 'auto · pre-restore';
  if (kind === 'pre-migration') return 'auto · pre-migration';
  if (kind === 'auto') return 'auto';
  return 'manual';
}

function snapshotFormatTag(snapshot: DbSnapshot): string {
  if (snapshot.legacy) return 'Legacy embedded · retained only';
  if (snapshot.format === 'plain-gzip') return 'Portable SQL';
  return 'PostgreSQL snapshot';
}

function formatWhen(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString();
}

export const DatabaseSettingsView: FC = () => {
  const nav = useDashboardNavigation();
  const [snapshots, setSnapshots] = useState<DbSnapshot[] | null>(null);
  const [stats, setStats] = useState<DbStatsResponse | null>(null);
  const [checkpoints, setCheckpoints] = useState<DbPreUpdateCheckpoints | null>(null);
  // A list or stats read that failed has nothing left to wait for, so its
  // placeholder must stop saying it is loading.
  const [snapshotsFailed, setSnapshotsFailed] = useState(false);
  const [statsFailed, setStatsFailed] = useState(false);
  const [job, setJob] = useState<DbBackupJobStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [label, setLabel] = useState('');

  // Confirm-modal state for the destructive actions.
  const [confirm, setConfirm] = useState<
    | { type: 'reset'; backupFirst: boolean; scope: ResetScope }
    | { type: 'restore'; snapshot: DbSnapshot }
    | { type: 'delete'; snapshot: DbSnapshot }
    | null
  >(null);

  const wasRunning = useRef(false);

  const refreshLists = useCallback(async () => {
    const [snaps, st, cps] = await Promise.allSettled([
      databaseApi.snapshots.list(),
      databaseApi.getStats(),
      databaseApi.preUpdateCheckpoints(),
    ]);
    setSnapshotsFailed(snaps.status === 'rejected');
    if (snaps.status === 'fulfilled') setSnapshots(snaps.value);
    else setError(getErrorMessage(snaps.reason, 'Failed to load snapshots'));
    setStatsFailed(st.status === 'rejected');
    if (st.status === 'fulfilled') setStats(st.value);
    // Informational only: a failed read just leaves the line out.
    setCheckpoints(cps.status === 'fulfilled' ? cps.value : null);
  }, []);

  // Initial load + pick up any already-running job.
  useEffect(() => {
    void refreshLists();
    databaseApi
      .backupStatus()
      .then(setJob)
      .catch((err: unknown) => {
        console.error('DatabaseSettingsView: failed to load backup status', err);
      });
  }, [refreshLists]);

  // Poll while a job is running.
  useGuardedInterval(
    async (signal) => {
      const next = await databaseApi.backupStatus();
      if (!signal.canceled) setJob(next);
    },
    { intervalMs: 1500, enabled: Boolean(job?.running) }
  );

  // On running → stopped transition: toast + refresh. A reset or restore
  // replaced the content, so the open panes may point at items that are gone:
  // the window opens Home (and Get started while the first run is unfinished)
  // in their place, and the workspace tree reads again.
  useEffect(() => {
    const finishedNow = wasRunning.current && job && !job.running;
    wasRunning.current = !!job?.running;
    if (!finishedNow || !job) return;
    if (job.error) {
      showToast(`${kindLabel(job.kind)} failed: ${job.error}`, { durationMs: 6000 });
    } else if (job.requiresRestart) {
      showToast(`${kindLabel(job.kind)} complete. Restart the app to load the new state cleanly.`, {
        durationMs: 8000,
      });
      emitLibraryEvent({ type: 'tree-invalidated', ids: [] });
      nav?.reopenForNewContent?.();
    } else {
      showToast(`${kindLabel(job.kind)} complete`, { durationMs: 3000 });
    }
    void refreshLists();
  }, [job, nav, refreshLists]);

  // A start request is in flight: the job is not reported running yet, so
  // `job.running` alone would leave the buttons live for a second click.
  const [starting, setStarting] = useState(false);
  const startingRef = useRef(false);
  const busy = !!job?.running || starting;

  /** Resolves true when the server accepted the job. */
  const startJob = useCallback(async (fn: () => Promise<DbBackupJobStatus>) => {
    if (startingRef.current) return false;
    startingRef.current = true;
    setStarting(true);
    setError(null);
    try {
      const next = await fn();
      setJob(next);
      return true;
    } catch (err) {
      const msg = getErrorMessage(err, 'Request failed');
      setError(msg);
      showToast(msg, { durationMs: 5000 });
      return false;
    } finally {
      startingRef.current = false;
      setStarting(false);
    }
  }, []);

  // The label is cleared only once the snapshot starts, so a refused request
  // keeps what the user typed for the retry.
  const handleCreate = async () => {
    const text = label.trim();
    if (await startJob(() => databaseApi.snapshots.create(text || undefined))) setLabel('');
  };

  const handlePortableExport = async () => {
    const text = label.trim();
    if (await startJob(() => databaseApi.snapshots.create(text || undefined, 'plain-gzip'))) {
      setLabel('');
    }
  };

  const handleDownload = async (snapshot: DbSnapshot) => {
    try {
      const { blob, fileName } = await databaseApi.snapshots.download(snapshot.id);
      if (isTauriEnv()) {
        // The desktop webview has no save dialog of its own; the shell's
        // native one lets the user choose where the snapshot goes.
        const savedPath = await socketClient.saveDownload(blob, fileName, 'Save snapshot');
        if (savedPath) showToast(`Snapshot saved to ${savedPath}`, { durationMs: 4000 });
        return;
      }
      const href = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = href;
      anchor.download = fileName;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      // Revoking in the same tick can cancel the download in some browsers.
      setTimeout(() => URL.revokeObjectURL(href), 0);
    } catch (err) {
      showToast(getErrorMessage(err, 'Download failed'), { durationMs: 4000 });
    }
  };

  // Runs inside ConfirmModal: a rejection stays in the dialog as an inline
  // error so the user can retry or cancel; success closes it.
  const confirmDelete = async () => {
    if (confirm?.type !== 'delete') return;
    await databaseApi.snapshots.remove(confirm.snapshot.id);
    setConfirm(null);
    showToast('Snapshot deleted');
    await refreshLists();
  };

  const confirmReset = () => {
    if (confirm?.type !== 'reset') return;
    const { backupFirst, scope } = confirm;
    setConfirm(null);
    void startJob(() => databaseApi.reset({ createBackup: backupFirst, scope }));
  };

  const confirmRestore = () => {
    if (confirm?.type !== 'restore') return;
    const id = confirm.snapshot.id;
    setConfirm(null);
    void startJob(() => databaseApi.snapshots.restore(id));
  };

  return (
    <div className={styles.root}>
      {/* Section heading is owned by the parent DataSearchView ("Backups of the
          local database" / "Snapshots and restore.") — no local header here to
          avoid a redundant second heading directly above this one. */}
      <div className={styles.body}>
        {error && (
          <div className={styles.error} role="alert">
            ! {error}
          </div>
        )}

        {job?.running && (
          <div className={styles.jobBanner}>
            <span className={styles.spinner} aria-hidden />
            {kindLabel(job.kind)} in progress — {job.phase ?? 'working…'}
          </div>
        )}

        {!job?.running && job?.requiresRestart && (
          <div className={styles.restartNote}>
            Restore/reset finished. Restart the app to load the new state cleanly.
          </div>
        )}

        {/* Current database */}
        <section className={styles.card}>
          <div className={styles.cardTitle}>Current database</div>
          <div className={styles.metaRow}>
            <span className={styles.metaLabel}>Size</span>
            <span className={styles.metaValue}>
              {stats ? stats.database_size : statsFailed ? '—' : '…'}
            </span>
          </div>
        </section>

        {/* Snapshots */}
        <section className={styles.card}>
          <div className={styles.cardHeaderRow}>
            <div className={styles.cardTitle}>Snapshots</div>
            <div className={styles.createRow}>
              <input
                className={styles.labelInput}
                type="text"
                aria-label="Snapshot label"
                placeholder="Optional label…"
                value={label}
                disabled={busy}
                onChange={(e) => setLabel(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void handleCreate();
                }}
              />
              <Button
                variant="primary"
                size="sm"
                onClick={() => void handleCreate()}
                disabled={busy}
              >
                Create snapshot
              </Button>
              <Button
                variant="neutral"
                size="sm"
                onClick={() => void handlePortableExport()}
                disabled={busy}
              >
                Portable export
              </Button>
            </div>
          </div>

          {snapshots === null ? (
            <div className={styles.placeholder}>
              {snapshotsFailed ? 'Snapshots unavailable.' : 'Loading snapshots…'}
            </div>
          ) : snapshots.length === 0 ? (
            <div className={styles.placeholder}>No snapshots yet.</div>
          ) : (
            <ul className={styles.snapList} role="list">
              {snapshots.map((s) => (
                <li key={s.id} className={styles.snapRow}>
                  <div className={styles.snapInfo}>
                    <div className={styles.snapLabel}>
                      {s.label}
                      <span className={styles.snapTag}>{snapshotKindTag(s.kind)}</span>
                      <span className={styles.snapTag}>{snapshotFormatTag(s)}</span>
                    </div>
                    <div className={styles.snapMeta}>
                      {formatWhen(s.createdAt)} · {formatBytes(s.sizeBytes)}
                    </div>
                  </div>
                  <div className={styles.snapActions}>
                    <Button
                      variant="neutral"
                      size="sm"
                      disabled={busy || !s.restorable}
                      onClick={() => setConfirm({ type: 'restore', snapshot: s })}
                      title={
                        s.legacy
                          ? 'Legacy snapshots are retained and downloadable but cannot be restored by this release'
                          : undefined
                      }
                    >
                      Restore
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={busy}
                      onClick={() => void handleDownload(s)}
                    >
                      Download
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={busy}
                      onClick={() => setConfirm({ type: 'delete', snapshot: s })}
                    >
                      Delete
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
          )}

          <p className={styles.retentionNote}>
            Snaglet keeps the last {PRE_UPDATE_SNAPSHOT_RETENTION} pre-update snapshots.
            {checkpoints && checkpoints.count > 0 && (
              <>
                {' '}
                Update checkpoints in backups/pre-migration: {checkpoints.count} ·{' '}
                {formatBytes(checkpoints.totalBytes)}.
              </>
            )}
          </p>
        </section>

        {/* Clean slate */}
        <section className={`${styles.card} ${styles.dangerCard}`}>
          <div className={styles.cardTitle}>Clean slate</div>
          <p className={styles.dangerText}>
            Wipe workspace content (docs, threads, messages, tasks, agents, embeddings, …) and keep
            the schema. Your {PRESERVED_SUMMARY} are preserved. A backup is taken first by default,
            so you can always restore.
          </p>
          <Button
            variant="danger"
            size="sm"
            disabled={busy}
            onClick={() => setConfirm({ type: 'reset', backupFirst: true, scope: 'content' })}
          >
            Reset to clean slate…
          </Button>
        </section>
      </div>

      {confirm?.type === 'reset' && (
        <Modal onClose={() => setConfirm(null)}>
          <Modal.Header>Reset database to clean slate</Modal.Header>
          <Modal.Body>
            <p className={styles.modalText}>
              This permanently deletes all workspace content. Recoverable only from a snapshot.
            </p>
            <label className={styles.modalOption}>
              <input
                type="radio"
                name="scope"
                checked={confirm.scope === 'content'}
                onChange={() => setConfirm({ ...confirm, scope: 'content' })}
              />
              <span>
                <strong>Keep config</strong> — preserve your {PRESERVED_SUMMARY}; wipe workspace
                content only.
              </span>
            </label>
            <label className={styles.modalOption}>
              <input
                type="radio"
                name="scope"
                checked={confirm.scope === 'all'}
                onChange={() => setConfirm({ ...confirm, scope: 'all' })}
              />
              <span>
                <strong>Wipe everything</strong> — empty every table (you'll reconfigure providers /
                login).
              </span>
            </label>
            <Checkbox
              className={styles.modalCheck}
              checked={confirm.backupFirst}
              onChange={(next) => setConfirm({ ...confirm, backupFirst: next })}
            >
              <span>Back up first (recommended)</span>
            </Checkbox>
          </Modal.Body>
          <Modal.Footer>
            <Button variant="ghost" size="sm" onClick={() => setConfirm(null)}>
              Cancel
            </Button>
            <Button variant="danger" size="sm" onClick={confirmReset}>
              {confirm.scope === 'all' ? 'Wipe everything' : 'Wipe content'}
            </Button>
          </Modal.Footer>
        </Modal>
      )}

      {confirm?.type === 'delete' && (
        <ConfirmModal
          title="Delete snapshot?"
          confirmLabel="Delete"
          confirmingLabel="Deleting…"
          destructive
          onConfirm={confirmDelete}
          onCancel={() => setConfirm(null)}
        >
          <p className={styles.modalText}>
            Permanently delete <strong>{confirm.snapshot.label}</strong> (
            {formatWhen(confirm.snapshot.createdAt)}). This cannot be undone.
          </p>
        </ConfirmModal>
      )}

      {confirm?.type === 'restore' && (
        <Modal onClose={() => setConfirm(null)}>
          <Modal.Header>Restore snapshot</Modal.Header>
          <Modal.Body>
            <p className={styles.modalText}>
              Replace the current database with <strong>{confirm.snapshot.label}</strong> (
              {formatWhen(confirm.snapshot.createdAt)}). The current state is backed up first, then
              everything is replaced by the snapshot.
            </p>
          </Modal.Body>
          <Modal.Footer>
            <Button variant="ghost" size="sm" onClick={() => setConfirm(null)}>
              Cancel
            </Button>
            <Button variant="primary" size="sm" onClick={confirmRestore}>
              Restore
            </Button>
          </Modal.Footer>
        </Modal>
      )}
    </div>
  );
};
