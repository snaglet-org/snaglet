import { useCallback, useEffect, useState, type FC } from 'react';

import type { WorkspaceEditorAutosaveState } from './types';
import styles from './EditorSaveHint.module.scss';

interface EditorSaveStatus {
  state: WorkspaceEditorAutosaveState;
  error: string | null;
}

/**
 * Captures a WorkspaceEditor's autosave state for `<EditorSaveHint>`. The
 * returned `onSaveStateChange` is stable because WorkspaceEditor's status
 * effect depends on it; an inline arrow would re-fire it every render.
 */
export function useEditorSaveStatus(): {
  status: EditorSaveStatus;
  onSaveStateChange: (state: WorkspaceEditorAutosaveState, error: string | null) => void;
} {
  const [status, setStatus] = useState<EditorSaveStatus>({ state: 'pristine', error: null });
  const onSaveStateChange = useCallback(
    (state: WorkspaceEditorAutosaveState, error: string | null) => setStatus({ state, error }),
    []
  );
  return { status, onSaveStateChange };
}

interface EditorSaveHintProps {
  /** Autosave state piped up from a WorkspaceEditor via `onSaveStateChange`. */
  state: WorkspaceEditorAutosaveState;
  /** Last save error, shown as the hover title on failure. */
  error?: string | null;
  /** Optional extra class for layout tweaks at the call site. */
  className?: string;
}

/**
 * Quiet inline autosave status next to a section title (`SYSTEM PROMPT ·
 * saved`). `· saved` fades out when the state returns to `pristine`;
 * `· failed to save` stays until the next successful save.
 */
export const EditorSaveHint: FC<EditorSaveHintProps> = ({ state, error, className }) => {
  // `display` remembers the last meaningful label so the success fade-out
  // still has text to fade while `visible` animates to 0. `visible` drives
  // the CSS opacity transition.
  const [display, setDisplay] = useState<'saved' | 'error' | null>(null);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (state === 'saved') {
      setDisplay('saved');
      setVisible(true);
    } else if (state === 'error') {
      setDisplay('error');
      setVisible(true);
    } else if (state === 'pristine') {
      // Transient success settled → fade out. Errors never reach pristine;
      // they hold until the user edits and the next save resolves.
      setVisible(false);
    }
    // 'dirty' / 'saving' leave the hint alone, so an error stays visible
    // until the next 'saved' or 'error'.
  }, [state]);

  if (!display) return null;

  const label = display === 'error' ? 'failed to save' : 'saved';

  return (
    <span
      className={[styles.hint, className].filter(Boolean).join(' ')}
      data-visible={visible ? 'true' : 'false'}
      role="status"
      aria-live="polite"
      title={display === 'error' ? (error ?? undefined) : undefined}
    >
      <span aria-hidden className={styles.sep}>
        ·
      </span>
      {label}
    </span>
  );
};
