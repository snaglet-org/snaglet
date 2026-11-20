// First-use voice-model prompt. Shown just above the composer the first time a
// user turns voice on without the ~469 MB local models installed (the gate
// lives in VoiceSessionContext). Download starts the same in-app install the
// Settings → Storage button uses and shows byte progress; on success the gate
// flips the pressed toggle on so voice starts with no restart. Theme tokens only.

import { type FC, type CSSProperties } from 'react';
import { Button } from '@desktop/components';
import { formatBytes } from '@snaglet/shared/utils';
import { useVoiceSessionContext } from '../VoiceSessionContext';

const wrap: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: '0.5rem',
  padding: '0.625rem 0.75rem',
  border: '1px solid var(--color-border)',
  borderRadius: 'var(--radius-md, 8px)',
  background: 'var(--color-surface-raised, var(--color-surface))',
};

const row: CSSProperties = { display: 'flex', alignItems: 'center', gap: '0.5rem' };

export const VoiceFirstUsePrompt: FC = () => {
  const ctx = useVoiceSessionContext();
  if (!ctx || !ctx.firstUsePrompt) return null;

  const { firstUsePrompt: state, confirmFirstUseDownload, dismissFirstUsePrompt } = ctx;
  const downloading = state.state === 'downloading';
  const failed = state.state === 'failed';

  const progressText = (): string => {
    if (state.totalBytes && state.totalBytes > 0) {
      return `${state.percent ?? 0}% · ${formatBytes(state.receivedBytes ?? 0)} of ${formatBytes(state.totalBytes)}`;
    }
    return 'Starting…';
  };

  // Size from the manifest's pinned total rather than a hardcoded figure.
  const sizeText = state.expectedTotalBytes
    ? `~${formatBytes(state.expectedTotalBytes)}`
    : 'a few hundred MB';

  return (
    <div
      style={wrap}
      role="dialog"
      aria-label="Download voice models"
      data-testid="voice-first-use"
    >
      <div style={{ fontSize: '0.85rem', fontWeight: 600 }}>
        Voice needs a one-time {sizeText} download.
      </div>

      {failed && state.error && (
        <div role="alert" style={{ fontSize: '0.78rem', color: 'var(--color-error)' }}>
          {state.error}
        </div>
      )}

      {downloading && (
        <div
          style={{ fontSize: '0.78rem', color: 'var(--color-text-secondary, inherit)' }}
          role="progressbar"
          aria-label="Voice model download progress"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={state.percent ?? 0}
        >
          Downloading — {progressText()}
        </div>
      )}

      <div style={row}>
        <Button
          variant="primary"
          size="sm"
          onClick={() => confirmFirstUseDownload()}
          disabled={downloading}
          loading={downloading}
          loadingText="Downloading…"
        >
          {failed ? 'Retry download' : 'Download'}
        </Button>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => dismissFirstUsePrompt()}
          // Enabled even mid-download: closing the prompt just dismisses it —
          // the install keeps running server-side and a later toggle picks up
          // the finished models.
        >
          {downloading ? 'Close' : 'Not now'}
        </Button>
      </div>
    </div>
  );
};
