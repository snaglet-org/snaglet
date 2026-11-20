import { type FC } from 'react';
import type { RenderMode } from '../ChatView';
import { MarkdownTextToggle } from '@desktop/components/MarkdownTextToggle/MarkdownTextToggle';
import { LeafToggle } from '@desktop/components/Icons';
import styles from './StatusStrip.module.scss';

interface StatusStripProps {
  renderMode: RenderMode;
  onRenderModeChange: (mode: RenderMode) => void;
  /** Whether the settings panel is currently open. */
  settingsOpen: boolean;
  /** Toggles the settings panel open/closed. */
  onToggleSettings: () => void;
  /**
   * Live multi-wave indicator ("wave 3 · 2 active") — null outside
   * multi-wave dispatches so the strip stays quiet in normal chat.
   */
  waveLabel?: string | null;
}

/**
 * Status strip: signal bars + caller name + render-mode toggle.
 * Agent activity (thinking / typing / running tool) is surfaced in the
 * AgentStatusBubbles row above the composer, not here — keeps the
 * strip stable so the title doesn't reflow every time an agent moves
 * between states.
 */
export const StatusStrip: FC<StatusStripProps> = ({
  renderMode,
  onRenderModeChange,
  settingsOpen,
  onToggleSettings,
  waveLabel = null,
}) => {
  return (
    <div className={styles.strip}>
      {waveLabel && (
        <span className={styles.waveIndicator} data-tid="waveIndicator" aria-live="polite">
          {waveLabel}
        </span>
      )}
      <span className={styles.spacer} />
      <MarkdownTextToggle
        activeSide={renderMode === 'md' ? 'left' : 'right'}
        leftLabel="md"
        rightLabel="txt"
        onToggle={() => onRenderModeChange(renderMode === 'md' ? 'raw' : 'md')}
        title={renderMode === 'md' ? 'Show raw markdown' : 'Render markdown'}
        size="xs"
        chrome="pill"
        font="mono"
        ariaPressed={renderMode === 'raw'}
      />
      <button
        type="button"
        onClick={onToggleSettings}
        title={settingsOpen ? 'Close settings' : 'Open chat and agent settings'}
        className={styles.settingsButton}
        aria-label={settingsOpen ? 'Close settings' : 'Open chat and agent settings'}
        aria-expanded={settingsOpen}
      >
        <LeafToggle open={settingsOpen} className={styles.settingsLeaf} />
        <span className={styles.settingsLabel}>Settings</span>
      </button>
    </div>
  );
};
