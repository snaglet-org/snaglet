import { useCallback, useEffect, useRef, useState, type FC } from 'react';
import {
  LOCAL_MODELS_CHANGED_EVENT,
  snagletHomeApi,
  type SnagletStorageState,
  type SnagletVoiceStorageModel,
  type VoiceModelState,
} from '@desktop/utils/api';
import { Button } from '@desktop/components/controls/Button/Button';
import { formatBytes, getErrorMessage } from '@snaglet/shared/utils';
import { VoiceChooser, type VoiceRowNote } from './VoiceChooser';
import styles from './StorageView.module.scss';

const VOICE_STATE_LABELS: Record<VoiceModelState['state'], string> = {
  'not-installed': 'Not installed',
  downloading: 'Downloading',
  ready: 'Installed',
  failed: 'Failed',
};

const COMPONENT_LABELS: Record<SnagletVoiceStorageModel['component'], string> = {
  reranker: 'Search ranking',
  stt: 'Speech recognition',
  vad: 'Voice detection',
  tts: 'Text to speech',
  shared: 'Shared voice assets',
};

export interface VoiceModelsSectionProps {
  /** Latest storage report (for installed sizes + the removal rows). */
  storage: SnagletStorageState | null;
  /** Re-read storage after an install so installed sizes refresh. */
  refreshStorage: () => Promise<void>;
  /** Removal/enable UI (per-model) is gated on this flag; the DOWNLOAD path is not. */
  removalUiEnabled: boolean;
  /** Open the remove-model confirmation (flag-gated path). */
  onRemoveModel: (model: SnagletVoiceStorageModel) => void;
  /** Re-enable + re-download a per-component-disabled model (flag-gated path). */
  onEnableModel: (model: SnagletVoiceStorageModel) => Promise<void>;
  /** Id of a per-model action in flight (disables the row's buttons). */
  modelBusy: string | null;
  /** Bumped by the parent after it clears/removes/enables voice models so this
   *  section re-reads its install state. */
  refreshKey?: number;
  /** Notifies the parent when a full install starts/stops, so it can disable
   *  the models-category Clear while a download runs. */
  onDownloadingChange?: (downloading: boolean) => void;
}

/**
 * The voice-models block in Settings → Storage.
 *
 * The voice chooser lists every voice the catalog offers: pick voices and
 * install them (the speech models and shared voice data come along once), or
 * uninstall one. A packaged-app user can't run the model-fetch CLI, so this is
 * their only way to get voice working, and it is deliberately NOT behind the
 * local-model-removal flag; only the per-component Remove/Enable rows for the
 * other models are (removal stays experimental). While a download runs the
 * server owns byte-accurate progress and we poll `/voice/models/status` for
 * percent + bytes. A failed voice offers Retry.
 */
export const VoiceModelsSection: FC<VoiceModelsSectionProps> = ({
  storage,
  refreshStorage,
  removalUiEnabled,
  onRemoveModel,
  onEnableModel,
  modelBusy,
  refreshKey = 0,
  onDownloadingChange,
}) => {
  const [voice, setVoice] = useState<VoiceModelState>({ state: 'not-installed' });
  // Voices picked to install. Seeded once from the first report that lists
  // voices: the default voice when none is installed, else nothing.
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const seededRef = useRef(false);
  const [uninstalling, setUninstalling] = useState<string | null>(null);
  const [note, setNote] = useState<VoiceRowNote | null>(null);

  useEffect(() => {
    if (seededRef.current || !voice.voices) return;
    seededRef.current = true;
    const noneInstalled = voice.voices.every((v) => v.state !== 'installed');
    if (noneInstalled && voice.defaultVoiceId) setSelected(new Set([voice.defaultVoiceId]));
  }, [voice]);

  // Re-read on mount and whenever the parent signals an installed-models change
  // (clear storage, remove/enable a component). A download in flight is left
  // alone — the polling effect below owns it until it settles.
  useEffect(() => {
    let canceled = false;
    void Promise.resolve(snagletHomeApi.voiceModels.get())
      .then((state) => {
        if (!canceled && state) setVoice((prev) => (prev.state === 'downloading' ? prev : state));
      })
      .catch((err: unknown) => {
        console.error(
          '[VoiceModelsSection] failed to read voice model state:',
          getErrorMessage(err)
        );
      });
    return () => {
      canceled = true;
    };
  }, [refreshKey]);

  // While a download runs the server owns progress; poll until it settles, then
  // refresh storage so the installed sizes render, and tell open voice pickers.
  useEffect(() => {
    if (voice.state !== 'downloading') return;
    const timer = window.setInterval(() => {
      void Promise.resolve(snagletHomeApi.voiceModels.get())
        .then((state) => {
          if (!state) return;
          setVoice(state);
          if (state.state !== 'downloading') {
            void refreshStorage();
            window.dispatchEvent(new Event(LOCAL_MODELS_CHANGED_EVENT));
          }
        })
        .catch((err: unknown) => {
          console.error('[VoiceModelsSection] voice model poll failed:', getErrorMessage(err));
        });
    }, 1_000);
    return () => window.clearInterval(timer);
  }, [voice.state, refreshStorage]);

  /** Install the base pieces plus `voiceIds` (no ids: the server's default choice). */
  const onInstallVoice = useCallback(
    async (voiceIds?: string[]) => {
      setNote(null);
      setVoice((prev) => ({
        ...prev,
        state: 'downloading',
        receivedBytes: 0,
        totalBytes: 0,
        percent: 0,
        voices: prev.voices?.map((v) =>
          voiceIds?.includes(v.id) ? { ...v, state: 'installing', error: undefined } : v
        ),
      }));
      try {
        const result = await snagletHomeApi.voiceModels.install(voiceIds);
        setVoice(result);
        if (voiceIds) {
          setSelected((prev) => new Set([...prev].filter((id) => !voiceIds.includes(id))));
        }
        if (result.state !== 'downloading') await refreshStorage();
      } catch (err) {
        const error = getErrorMessage(err, 'Voice model download failed');
        setVoice((prev) => ({
          ...prev,
          state: 'failed',
          error,
          voices: prev.voices?.map((v) =>
            voiceIds?.includes(v.id) ? { ...v, state: 'failed', error } : v
          ),
        }));
      }
    },
    [refreshStorage]
  );

  /** Uninstall one voice at once (no confirmation) and say inline what it freed. */
  const onUninstallVoice = useCallback(
    async (voiceId: string) => {
      setUninstalling(voiceId);
      setNote(null);
      try {
        const result = await snagletHomeApi.voiceModels.uninstall([voiceId]);
        setVoice(result);
        setNote({
          voiceId,
          text: `Uninstalled · ${formatBytes(result.freedBytes ?? 0)} freed`,
        });
        window.dispatchEvent(new Event(LOCAL_MODELS_CHANGED_EVENT));
        await refreshStorage();
      } catch (err) {
        setNote({
          voiceId,
          text: getErrorMessage(err, "Couldn't uninstall the voice"),
          error: true,
        });
      } finally {
        setUninstalling(null);
      }
    },
    [refreshStorage]
  );

  const installed = voice.state === 'ready';
  const downloading = voice.state === 'downloading';
  const failed = voice.state === 'failed';

  // Size text comes from the manifest's pinned total (server:
  // expectedTotalBytes), not a hardcoded figure. Falls back to an approximate
  // label until the status read lands.
  // Keep the parent's "a voice install is running" flag in sync so it can
  // disable the models-category Clear for the duration.
  useEffect(() => {
    onDownloadingChange?.(downloading);
  }, [downloading, onDownloadingChange]);

  const downloadSizeText = voice.expectedTotalBytes
    ? `~${formatBytes(voice.expectedTotalBytes)}`
    : 'a few hundred MB';

  // Per-component rows are driven by the storage report, not by the global
  // voice install state: removing one component flips voice.state away from
  // 'ready', but the other installed components must keep their Remove rows.
  // Every component is included (the search reranker too) so its Remove /
  // "Enable and download" row renders alongside the voice ones.
  // Voices have their own rows in the chooser when the server lists them.
  const voices = voice.voices;
  const localModels = (storage?.localModels ?? []).filter(
    (model) => !voices || model.component !== 'tts'
  );
  const presentModels = localModels.filter((model) => model.installed && !model.disabled);
  const removedModels = localModels.filter((model) => model.disabled);
  // The header size badge sums only the voice components actually present,
  // voices included (the reranker has its own line in the general storage list).
  const installedBytes = (storage?.localModels ?? [])
    .filter((model) => model.installed && !model.disabled && model.component !== 'reranker')
    .reduce((n, m) => n + m.bytes, 0);

  const progressLabel = (): string => {
    if (voice.totalBytes && voice.totalBytes > 0) {
      const pct = voice.percent ?? 0;
      return `${pct}% · ${formatBytes(voice.receivedBytes ?? 0)} of ${formatBytes(voice.totalBytes)}`;
    }
    return 'Starting download…';
  };

  return (
    <section className={styles.storageSection} data-testid="voice-models-section">
      <div className={styles.storageHeader}>
        <span className={styles.fieldLabel}>Voice models</span>
        <strong>
          {VOICE_STATE_LABELS[voice.state]}
          {installed && installedBytes > 0 ? ` · ${formatBytes(installedBytes)}` : ''}
        </strong>
      </div>
      <p className={styles.fieldHint}>
        Voice mode needs speech recognition, voice detection and at least one voice: a one-time{' '}
        {downloadSizeText} download with the default voice. Choose which voices to install below.
        Files are checksum-verified.
      </p>

      {failed && voice.error && !voices && (
        <div className={styles.errorBanner} role="alert">
          {voice.error}
        </div>
      )}

      {downloading && (
        <div
          className={styles.fieldHint}
          role="progressbar"
          aria-label="Voice model download progress"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={voice.percent ?? 0}
        >
          Downloading voice models — {progressLabel()}
        </div>
      )}

      {/* Installed per-component rows (sizes) — every present component, voice
          and reranker alike, rendered from the storage report regardless of the
          global voice install state. The Remove buttons stay behind the removal
          flag; the rows themselves are informational. */}
      {presentModels.length > 0 && (
        <div className={styles.storageList}>
          {presentModels.map((model) => (
            <div key={model.id} className={styles.storageRow}>
              <div>
                <strong>{model.name}</strong>
                <div className={styles.fieldHint}>
                  {COMPONENT_LABELS[model.component]} · {formatBytes(model.bytes)}
                </div>
              </div>
              {removalUiEnabled && model.removable && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => onRemoveModel(model)}
                  // Also disabled while a full install runs — removing a
                  // component mid-download would race the writes.
                  disabled={modelBusy !== null || downloading}
                >
                  {modelBusy === model.id ? 'Removing…' : 'Remove'}
                </Button>
              )}
            </div>
          ))}
        </div>
      )}

      {/* Flag-gated: per-component disabled ("removed from this device") rows with
          a re-download button — again every component, the reranker included, so
          its "Enable and download" row is reachable. */}
      {removalUiEnabled && removedModels.length > 0 && (
        <>
          <div className={styles.fieldHint}>Removed from this device</div>
          {removedModels.map((model) => (
            <div key={model.id} className={styles.storageRow}>
              <div>
                <strong>{model.name}</strong>
                <div className={styles.fieldHint}>
                  {COMPONENT_LABELS[model.component]} · {formatBytes(model.expectedBytes)} download
                </div>
              </div>
              <Button
                variant="neutral"
                size="sm"
                onClick={() => void onEnableModel(model)}
                // Disabled while the full install runs so the two downloads
                // can't fight over the same files.
                disabled={modelBusy !== null || downloading}
                loading={modelBusy === model.id}
                loadingText="Downloading…"
              >
                Enable and download
              </Button>
            </div>
          ))}
        </>
      )}

      {voices ? (
        <VoiceChooser
          voices={voices}
          defaultVoiceId={voice.defaultVoiceId}
          selected={selected}
          onToggle={(voiceId, on) =>
            setSelected((prev) => {
              const next = new Set(prev);
              if (on) next.add(voiceId);
              else next.delete(voiceId);
              return next;
            })
          }
          baseMissingBytes={voice.baseMissingBytes ?? 0}
          onInstall={(voiceIds) => void onInstallVoice(voiceIds)}
          onUninstall={(voiceId) => void onUninstallVoice(voiceId)}
          downloading={downloading}
          percent={voice.percent}
          uninstalling={uninstalling}
          note={note}
        />
      ) : (
        !installed && (
          <Button
            variant="neutral"
            size="sm"
            onClick={() => void onInstallVoice()}
            disabled={downloading}
            loading={downloading}
            loadingText="Downloading voice models…"
          >
            {failed ? 'Retry download' : 'Download voice models'}
          </Button>
        )
      )}
    </section>
  );
};
