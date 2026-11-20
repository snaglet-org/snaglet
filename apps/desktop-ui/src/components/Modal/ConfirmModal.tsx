import React, { useCallback, useRef, useState } from 'react';
import { getErrorMessage } from '@snaglet/shared/utils';
import { Modal } from './Modal';
import styles from './Modal.module.scss';
import { Button } from '../controls/Button/Button';

export interface ConfirmModalProps {
  /** Dialog title — doubles as the accessible dialog name. */
  title: string;
  /**
   * Body content. A plain string (or an array of strings) renders as the
   * standard message paragraph(s); pass nodes for anything richer.
   */
  children?: React.ReactNode;
  /** Confirm button label. */
  confirmLabel?: string;
  /** Cancel button label. */
  cancelLabel?: string;
  /** Style the confirm button as destructive (danger) instead of primary. */
  destructive?: boolean;
  confirmDisabled?: boolean;
  /** Confirm button label while an async `onConfirm` is in flight. */
  confirmingLabel?: string;
  /**
   * The confirmed action. May be async: while it runs both buttons lock and
   * the dialog cannot be dismissed; a rejection is rendered inline and the
   * dialog stays open (retry or cancel). On success the parent closes the
   * dialog — typically by clearing the state that renders it — so the busy
   * state is intentionally left on until unmount (no idle flash).
   */
  onConfirm: () => void | Promise<void>;
  /** Dismiss without acting — Esc and backdrop click route here too. */
  onCancel: () => void;
}

function renderBody(children: React.ReactNode): React.ReactNode {
  if (typeof children === 'string') {
    return <p className={styles.modalMessage}>{children}</p>;
  }
  if (Array.isArray(children) && children.every((child) => typeof child === 'string')) {
    return children.map((child, index) => (
      <p key={index} className={styles.modalMessage}>
        {child}
      </p>
    ));
  }
  return children;
}

/**
 * ConfirmModal — the in-app replacement for `window.confirm`. The Tauri
 * webview suppresses browser-native dialogs (`confirm`/`alert`/`prompt`
 * return immediately without ever showing), so any flow gated on them dies
 * silently in the desktop app. Route every "are you sure?" through this
 * component instead: the guarded action runs only from the confirm button,
 * and cancel/Esc/backdrop are a strict no-op.
 */
export const ConfirmModal: React.FC<ConfirmModalProps> = ({
  title,
  children,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  destructive = false,
  confirmDisabled = false,
  confirmingLabel = 'Working…',
  onConfirm,
  onCancel,
}) => {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const busyRef = useRef(false);

  const handleConfirm = useCallback(async () => {
    // Ref-based re-entrancy guard: a double-activation in the same tick
    // (Enter + click) would race the state update alone.
    if (busyRef.current || confirmDisabled) return;
    busyRef.current = true;
    setBusy(true);
    setError(null);
    try {
      await onConfirm();
      // Success: the parent unmounts the dialog; keep `busy` on until then.
    } catch (err) {
      setError(getErrorMessage(err, 'Action failed'));
      busyRef.current = false;
      setBusy(false);
    }
  }, [onConfirm, confirmDisabled]);

  return (
    <Modal
      onClose={busy ? () => undefined : onCancel}
      aria-label={title}
      className={styles.confirmOverlay}
    >
      <div className={styles.modalContent}>
        <h2 className={styles.modalTitle}>{title}</h2>
        {renderBody(children)}
        {error && (
          <p className={styles.errorMessage} role="alert">
            {error}
          </p>
        )}
        <div className={styles.modalActions}>
          <Button variant="neutral" size="lg" onClick={onCancel} disabled={busy}>
            {cancelLabel}
          </Button>
          <Button
            variant={destructive ? 'danger' : 'primary'}
            size="lg"
            onClick={() => void handleConfirm()}
            disabled={confirmDisabled}
            loading={busy}
            loadingText={confirmingLabel}
          >
            {confirmLabel}
          </Button>
        </div>
      </div>
    </Modal>
  );
};
