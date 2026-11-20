import { useCallback, useEffect, useState, type FC } from 'react';
import {
  snagletHomeApi,
  LOCAL_MODELS_CHANGED_EVENT,
  type SnagletHomeState,
  type SnagletStorageState,
  type SnagletVoiceStorageModel,
} from '@desktop/utils/api';
import { VoiceModelsSection } from './VoiceModelsSection';
import { StateHint } from '@desktop/pages/Dashboard/components/StateHint';
// Direct source imports (not the '@desktop/components' barrel) keep this view
// mockable under vitest — the barrel re-exports WsStatusIndicator, which needs
// runtime Vite config. Same reason as other settings views.
import { Button } from '@desktop/components/controls/Button/Button';
import { TextInput } from '@desktop/components/controls/TextInput/TextInput';
import { Tooltip } from '@desktop/components/Tooltip/Tooltip';
import { ConfirmModal } from '@desktop/components/Modal/ConfirmModal';
import { socketClient } from '@desktop/socket';
import styles from './StorageView.module.scss';
import { formatBytes, getErrorMessage } from '@snaglet/shared/utils';
import { LOCAL_MODEL_REMOVAL_UI_FLAG } from '@snaglet/shared/types';
import { useFeatureFlagGuard } from '@desktop/features/featureFlags/FeatureFlagsContext';

/**
 * The destructive/irreversible actions in this pane all gate on the in-app
 * ConfirmModal (window.confirm is suppressed by the Tauri webview). One
 * discriminated state drives which confirmation is showing.
 */
type PendingConfirm =
  | { kind: 'restart-into-new-home' }
  | { kind: 'move-home'; destination: string }
  | { kind: 'clear-storage'; key: string }
  | { kind: 'remove-model'; model: SnagletVoiceStorageModel };

/**
 * StorageView — local storage reporting and cleanup controls. Shows cache
 * sizes (database, cache, backups, models) with per-category clear buttons
 * for removable categories. Also manages voice model installation/download.
 * Dedicated pane opened from Settings → Storage.
 */
export const StorageView: FC = () => {
  const [snagletHome, setSnagletHome] = useState<SnagletHomeState | null>(null);
  // Separate from `snagletHome` so a failed home fetch settles the pane instead of
  // parking it on the loading hint forever — the storage and voice sections
  // below are independent of the home pointer and still render.
  const [homeLoaded, setHomeLoaded] = useState(false);
  const [newHomePath, setNewHomePath] = useState('');
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [storage, setStorage] = useState<SnagletStorageState | null>(null);
  const [modelBusy, setModelBusy] = useState<string | null>(null);
  // Bumped whenever an action elsewhere in this pane changes installed voice
  // models (clear storage, remove/enable a component) so the voice section
  // re-reads its own install state.
  const [voiceRefresh, setVoiceRefresh] = useState(0);
  // Mirrors whether a full voice install is in flight (reported by
  // VoiceModelsSection) so the models-category Clear is disabled while it runs,
  // and a concurrent clear can't yank files mid-download.
  const [voiceDownloading, setVoiceDownloading] = useState(false);
  const [pendingConfirm, setPendingConfirm] = useState<PendingConfirm | null>(null);
  const { enabled: localModelsUiEnabled, isEnabled: isLocalModelsUiEnabled } = useFeatureFlagGuard(
    LOCAL_MODEL_REMOVAL_UI_FLAG
  );

  useEffect(() => {
    let canceled = false;
    snagletHomeApi
      .get()
      .then((state) => {
        if (!canceled) setSnagletHome(state);
      })
      .catch((err: unknown) => {
        // Non-fatal: the Snaglet home section stays hidden, storage/voice still show.
        console.error('[StorageView] failed to read Snaglet home:', getErrorMessage(err));
      })
      .finally(() => {
        if (!canceled) setHomeLoaded(true);
      });
    return () => {
      canceled = true;
    };
  }, []);

  const refreshStorage = useCallback(async () => {
    setStorage(await snagletHomeApi.storage.get());
  }, []);

  // Without the report the storage section has nothing to show, so say why
  // instead of leaving the pane silently short a section.
  useEffect(() => {
    void refreshStorage().catch((err: unknown) => {
      setError(getErrorMessage(err, 'Failed to read storage usage'));
    });
  }, [refreshStorage]);

  /**
   * SNAGLET_HOME is resolved once at startup, so switching homes only takes effect
   * after a restart. Offer it immediately rather than leaving the pane showing
   * a "restart pending" banner the user has to act on separately. The restart
   * itself runs from the ConfirmModal's confirm button; declining leaves the
   * "Restart pending" banner, same as before.
   */
  const restartIntoNewHome = useCallback(() => {
    setPendingConfirm({ kind: 'restart-into-new-home' });
  }, []);

  const onClearOverride = useCallback(async () => {
    setWorking(true);
    setError(null);
    try {
      setSnagletHome(await snagletHomeApi.clearOverride());
      restartIntoNewHome();
    } catch (err) {
      setError(getErrorMessage(err, 'Failed to clear override'));
    } finally {
      setWorking(false);
    }
  }, [restartIntoNewHome]);

  const onSetOverride = useCallback(
    async (path: string) => {
      setWorking(true);
      setError(null);
      try {
        setSnagletHome(await snagletHomeApi.setOverride(path));
        setNewHomePath('');
        restartIntoNewHome();
      } catch (err) {
        setError(getErrorMessage(err, 'Failed to set Snaglet home override'));
      } finally {
        setWorking(false);
      }
    },
    [restartIntoNewHome]
  );

  const onRemoveSaved = useCallback(async (path: string) => {
    setWorking(true);
    setError(null);
    try {
      setSnagletHome(await snagletHomeApi.removeSaved(path));
    } catch (err) {
      setError(getErrorMessage(err, 'Failed to remove saved path'));
    } finally {
      setWorking(false);
    }
  }, []);

  const onAddSaved = useCallback(async () => {
    const trimmed = newHomePath.trim();
    if (!trimmed) return;
    setWorking(true);
    setError(null);
    try {
      setSnagletHome(await snagletHomeApi.addSaved(trimmed));
      setNewHomePath('');
    } catch (err) {
      setError(getErrorMessage(err, 'Failed to register path'));
    } finally {
      setWorking(false);
    }
  }, [newHomePath]);

  /**
   * Moving the home is a Tauri-shell operation, not an HTTP one: the server
   * lives inside the home it would be copying, so the shell stops it, copies,
   * keeps the original folder as a rollback, and relaunches. `working` is left set
   * on success because the app is going away.
   */
  const onMoveHome = useCallback(async () => {
    setError(null);
    let destination: string | null;
    try {
      destination = await socketClient.pickFolder('Choose the new Snaglet home folder');
    } catch (err) {
      setError(getErrorMessage(err, 'Failed to open the folder picker'));
      return;
    }
    if (!destination) return;
    setPendingConfirm({ kind: 'move-home', destination });
  }, []);

  /** Runs only from the move-home confirmation's confirm button. */
  const performMoveHome = useCallback(async (destination: string) => {
    setWorking(true);
    try {
      await socketClient.moveSnagletHome(destination);
    } catch (err) {
      setError(getErrorMessage(err, 'Failed to move Snaglet home'));
      setWorking(false);
    }
  }, []);

  const onClearStorage = useCallback(
    (key: string) => {
      if (key === 'models' && !isLocalModelsUiEnabled()) return;
      setPendingConfirm({ kind: 'clear-storage', key });
    },
    [isLocalModelsUiEnabled]
  );

  /** Runs only from the clear-storage confirmation's confirm button. */
  const performClearStorage = useCallback(
    async (key: string) => {
      if (key === 'models' && !isLocalModelsUiEnabled()) return;
      setWorking(true);
      setError(null);
      try {
        setStorage(await snagletHomeApi.storage.clear(key));
        if (key === 'models') setVoiceRefresh((n) => n + 1);
      } catch (err) {
        setError(getErrorMessage(err, `Failed to clear ${key}`));
      } finally {
        setWorking(false);
      }
    },
    [isLocalModelsUiEnabled]
  );

  const onRemoveModel = useCallback(
    (model: SnagletVoiceStorageModel) => {
      if (!isLocalModelsUiEnabled()) return;
      setPendingConfirm({ kind: 'remove-model', model });
    },
    [isLocalModelsUiEnabled]
  );

  /** Runs only from the remove-model confirmation's confirm button. */
  const performRemoveModel = useCallback(
    async (model: SnagletVoiceStorageModel) => {
      if (!isLocalModelsUiEnabled()) return;
      setModelBusy(model.id);
      setError(null);
      try {
        setStorage(await snagletHomeApi.storage.clearLocalModel(model.id));
        window.dispatchEvent(new Event(LOCAL_MODELS_CHANGED_EVENT));
        if (model.component !== 'reranker') setVoiceRefresh((n) => n + 1);
      } catch (err) {
        setError(getErrorMessage(err, 'Failed to remove local model'));
      } finally {
        setModelBusy(null);
      }
    },
    [isLocalModelsUiEnabled]
  );

  const onEnableModel = useCallback(
    async (model: SnagletVoiceStorageModel) => {
      if (!isLocalModelsUiEnabled()) return;
      setModelBusy(model.id);
      setError(null);
      try {
        setStorage(await snagletHomeApi.storage.enableLocalModel(model.id));
        window.dispatchEvent(new Event(LOCAL_MODELS_CHANGED_EVENT));
        setVoiceRefresh((n) => n + 1);
      } catch (err) {
        setError(getErrorMessage(err, 'Failed to restore local model'));
      } finally {
        setModelBusy(null);
      }
    },
    [isLocalModelsUiEnabled]
  );

  if (!homeLoaded) {
    return (
      <div className={styles.shell}>
        <StateHint>Loading storage…</StateHint>
      </div>
    );
  }

  return (
    <div className={styles.shell}>
      <div className={styles.body}>
        <header className={styles.header}>
          <div className={styles.titleRow}>
            <span className={styles.glyph} aria-hidden>
              ↺
            </span>
            <h1 className={styles.title}>Local storage</h1>
          </div>
        </header>

        {/* Errors render here, under the title, so a refused action (for
            example a Move Snaglet home into a non-empty folder) explains itself
            where the user is looking instead of below the storage table. */}
        {error && (
          <div className={styles.errorBanner} role="alert">
            {error}
          </div>
        )}

        {snagletHome && (
          <div className={styles.field}>
            <span className={styles.fieldLabel}>Snaglet home directory</span>
            <p className={styles.fieldHint}>
              The config folder the server reads on startup (<code>~/.snaglet</code> by default).
              Set an override and restart the server to switch to a different directory — useful for
              testing fresh-launch bootstrap with a clean config.
            </p>

            <div className={styles.readonly} style={{ marginBottom: 6 }}>
              {snagletHome.active}
            </div>

            {snagletHome.override && snagletHome.override !== snagletHome.active && (
              <div className={styles.restartNotice}>
                Restart pending to apply: <code>{snagletHome.override}</code>
              </div>
            )}

            {snagletHome.override && (
              <Button
                variant="neutral"
                size="sm"
                onClick={() => void onClearOverride()}
                disabled={working}
                style={{ alignSelf: 'flex-start', marginBottom: 8 }}
              >
                Clear override
              </Button>
            )}

            {snagletHome.saved.length > 0 && (
              <ul className={styles.savedPaths}>
                {snagletHome.saved.map((p) => (
                  <li key={p} className={styles.savedPathRow}>
                    <span className={styles.savedPathText}>{p}</span>
                    <div className={styles.savedPathActions}>
                      <Button
                        variant="neutral"
                        size="sm"
                        onClick={() => void onSetOverride(p)}
                        disabled={working || snagletHome.override === p}
                        title="Set as override (requires restart)"
                      >
                        {snagletHome.override === p ? 'Active override' : 'Use'}
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => void onRemoveSaved(p)}
                        disabled={working}
                        title="Remove from registry"
                      >
                        Remove
                      </Button>
                    </div>
                  </li>
                ))}
              </ul>
            )}

            <div className={styles.addPathRow}>
              <TextInput
                type="text"
                fullWidth
                aria-label="Snaglet home folder to register"
                value={newHomePath}
                onChange={(e) => setNewHomePath(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void onAddSaved();
                }}
                disabled={working}
                placeholder="/Users/you/.snaglet-test"
              />
              <Button
                variant="neutral"
                size="md"
                onClick={() => void onAddSaved()}
                disabled={working || !newHomePath.trim()}
              >
                Register
              </Button>
            </div>

            <div className={styles.homeActions}>
              <Button
                variant="neutral"
                size="sm"
                onClick={() => void onMoveHome()}
                disabled={working}
              >
                Move this Snaglet home…
              </Button>
              <span className={styles.fieldHint}>
                Copies verified data and retains the current folder for rollback.
              </span>
            </div>
          </div>
        )}

        {storage && (
          <section className={styles.storageSection}>
            <div className={styles.storageHeader}>
              <span className={styles.fieldLabel}>Storage</span>
              <strong>{formatBytes(storage.totalBytes)}</strong>
            </div>
            <ul className={styles.storageList}>
              {storage.categories.map((category) => {
                const clear = (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => onClearStorage(category.key)}
                    disabled={
                      working ||
                      category.bytes === 0 ||
                      (category.key === 'models' && voiceDownloading)
                    }
                  >
                    Clear
                  </Button>
                );
                return (
                  <li key={category.key} className={styles.storageRow}>
                    <span className={styles.storageName}>{category.key}</span>
                    <span>{formatBytes(category.bytes)}</span>
                    {category.removable &&
                      (category.key !== 'models' || localModelsUiEnabled) &&
                      (category.clearDescription ? (
                        <Tooltip
                          label={category.clearDescription}
                          side="left"
                          className={styles.clearTip}
                        >
                          {clear}
                        </Tooltip>
                      ) : (
                        clear
                      ))}
                  </li>
                );
              })}
            </ul>
            <p className={styles.fieldHint}>
              Backups and canonical database, image, tool, and script data are never bulk-cleared
              here.
            </p>
          </section>
        )}

        <VoiceModelsSection
          storage={storage}
          refreshStorage={refreshStorage}
          removalUiEnabled={localModelsUiEnabled}
          onRemoveModel={onRemoveModel}
          onEnableModel={onEnableModel}
          modelBusy={modelBusy}
          refreshKey={voiceRefresh}
          onDownloadingChange={setVoiceDownloading}
        />
      </div>
      {pendingConfirm?.kind === 'restart-into-new-home' && (
        <ConfirmModal
          title="Restart Snaglet?"
          confirmLabel="Restart now"
          confirmingLabel="Restarting…"
          onConfirm={async () => {
            // Async on purpose: a restart failure shows inline in the dialog.
            await socketClient.restartApp();
          }}
          onCancel={() => setPendingConfirm(null)}
        >
          Snaglet needs to restart to switch to this home folder. Restart now?
        </ConfirmModal>
      )}
      {pendingConfirm?.kind === 'move-home' && (
        <ConfirmModal
          title={`Move this Snaglet home to ${pendingConfirm.destination}?`}
          confirmLabel="Move and restart"
          onConfirm={() => {
            const { destination } = pendingConfirm;
            setPendingConfirm(null);
            void performMoveHome(destination);
          }}
          onCancel={() => setPendingConfirm(null)}
        >
          Snaglet will stop safely, copy the home, keep the current folder as a rollback copy, and
          restart.
        </ConfirmModal>
      )}
      {pendingConfirm?.kind === 'clear-storage' && (
        <ConfirmModal
          title={`Clear Snaglet ${pendingConfirm.key}?`}
          confirmLabel="Clear"
          destructive
          onConfirm={() => {
            const { key } = pendingConfirm;
            setPendingConfirm(null);
            void performClearStorage(key);
          }}
          onCancel={() => setPendingConfirm(null)}
        >
          {storage?.categories.find((category) => category.key === pendingConfirm.key)
            ?.clearDescription ?? 'Replaceable models will be downloaded again when needed.'}
        </ConfirmModal>
      )}
      {pendingConfirm?.kind === 'remove-model' && (
        <ConfirmModal
          title={`Remove ${pendingConfirm.model.name}?`}
          confirmLabel="Remove"
          destructive
          onConfirm={() => {
            const { model } = pendingConfirm;
            setPendingConfirm(null);
            void performRemoveModel(model);
          }}
          onCancel={() => setPendingConfirm(null)}
        >
          It can be downloaded again later.
        </ConfirmModal>
      )}
    </div>
  );
};
