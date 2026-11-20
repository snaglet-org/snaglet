import { type FC } from 'react';
import type { VoiceInstallInfo } from '@desktop/utils/api';
import { Button } from '@desktop/components/controls/Button/Button';
import { OptionToggle } from '@desktop/components/controls/OptionToggle/OptionToggle';
import { formatBytes } from '@snaglet/shared/utils';
import styles from './StorageView.module.scss';

/** "en-US" → "American English"; the tag itself when the runtime cannot name it. */
function languageName(lang: string): string {
  try {
    return new Intl.DisplayNames(['en'], { type: 'language' }).of(lang) ?? lang;
  } catch {
    return lang;
  }
}

const capitalize = (text: string): string => text.charAt(0).toUpperCase() + text.slice(1);

/** What a voice row says inline after an uninstall: the space freed, or why it failed. */
export interface VoiceRowNote {
  voiceId: string;
  text: string;
  error?: boolean;
}

export interface VoiceChooserProps {
  voices: readonly VoiceInstallInfo[];
  defaultVoiceId?: string;
  /** Voices picked to install (only ones not installed yet). */
  selected: ReadonlySet<string>;
  onToggle: (voiceId: string, selected: boolean) => void;
  /** Bytes an install adds besides the voices (the base pieces not on disk). */
  baseMissingBytes: number;
  /** Install these voices (with the base pieces). */
  onInstall: (voiceIds: string[]) => void;
  onUninstall: (voiceId: string) => void;
  /** An install is running: nothing else starts. */
  downloading: boolean;
  /** Overall install percent while downloading. */
  percent?: number;
  /** Voice being uninstalled. */
  uninstalling: string | null;
  note: VoiceRowNote | null;
}

/**
 * The voices in Settings → Local storage: every voice the catalog offers, with
 * its language, quality and download size. Pick voices with their pills and
 * install them together; an installed voice has Uninstall (no confirmation: a
 * voice is cheap to download again). The shared voice data and the speech
 * models install once with the first voice and stay when voices are removed.
 */
export const VoiceChooser: FC<VoiceChooserProps> = ({
  voices,
  defaultVoiceId,
  selected,
  onToggle,
  baseMissingBytes,
  onInstall,
  onUninstall,
  downloading,
  percent,
  uninstalling,
  note,
}) => {
  const installed = voices.filter((voice) => voice.state === 'installed');
  const picked = voices.filter((voice) => selected.has(voice.id) && voice.state !== 'installed');
  const totalBytes =
    picked.length > 0
      ? baseMissingBytes + picked.reduce((sum, voice) => sum + voice.downloadBytes, 0)
      : 0;
  const busy = downloading || uninstalling !== null;

  const status = (voice: VoiceInstallInfo) => {
    switch (voice.state) {
      case 'installed':
        return (
          <>
            <span>Installed</span>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => onUninstall(voice.id)}
              disabled={busy}
              loading={uninstalling === voice.id}
              loadingText="Uninstalling…"
              aria-label={`Uninstall ${voice.name}`}
            >
              Uninstall
            </Button>
          </>
        );
      case 'installing':
        return <span>{`Installing · ${percent ?? 0}%`}</span>;
      case 'failed':
        return (
          <>
            <span className={styles.voiceFailed}>Failed</span>
            <Button
              variant="neutral"
              size="sm"
              onClick={() => onInstall([voice.id])}
              disabled={busy}
              aria-label={`Retry ${voice.name}`}
            >
              Retry
            </Button>
          </>
        );
      default:
        return <span>Not installed</span>;
    }
  };

  return (
    <div className={styles.voiceChooser} data-testid="voice-chooser">
      <div className={styles.storageHeader}>
        <span className={styles.fieldLabel}>Voices</span>
        <strong>
          {installed.length === 0
            ? 'No voice installed'
            : `${installed.length} of ${voices.length} installed`}
        </strong>
      </div>
      {installed.length === 0 && (
        <p className={styles.fieldHint}>
          No voice installed: agents can&apos;t read replies aloud until you install one.
        </p>
      )}
      <ul className={styles.voiceList} aria-label="Voices">
        {voices.map((voice) => {
          const label = `${voice.name}${voice.id === defaultVoiceId ? ' (default)' : ''}`;
          const rowNote = note?.voiceId === voice.id ? note : null;
          return (
            <li key={voice.id} className={styles.voiceRow} data-voice-id={voice.id}>
              <div className={styles.voiceName}>
                {voice.state === 'installed' || voice.state === 'installing' ? (
                  <strong>{label}</strong>
                ) : (
                  <OptionToggle
                    pressed={selected.has(voice.id)}
                    onChange={(next) => onToggle(voice.id, next)}
                    disabled={busy}
                  >
                    {label}
                  </OptionToggle>
                )}
                <div className={styles.fieldHint}>
                  {languageName(voice.lang)} · {capitalize(voice.quality)} quality ·{' '}
                  {formatBytes(voice.downloadBytes)}
                </div>
                {voice.state === 'failed' && voice.error && (
                  <div className={styles.voiceFailed} role="alert">
                    {voice.error}
                  </div>
                )}
                {rowNote && (
                  <div
                    className={rowNote.error ? styles.voiceFailed : styles.fieldHint}
                    role="status"
                  >
                    {rowNote.text}
                  </div>
                )}
              </div>
              <div className={styles.voiceActions}>{status(voice)}</div>
            </li>
          );
        })}
      </ul>
      <div className={styles.voiceInstallBar}>
        <Button
          variant="neutral"
          size="sm"
          onClick={() => onInstall(picked.map((voice) => voice.id))}
          disabled={busy || picked.length === 0}
          loading={downloading}
          loadingText="Installing…"
        >
          {picked.length > 0
            ? `Install selected (${picked.length}) · ${formatBytes(totalBytes)}`
            : 'Install selected'}
        </Button>
        {picked.length > 0 && baseMissingBytes > 0 && (
          <span className={styles.fieldHint}>
            Includes {formatBytes(baseMissingBytes)} of speech models and shared voice data,
            downloaded once.
          </span>
        )}
      </div>
    </div>
  );
};
