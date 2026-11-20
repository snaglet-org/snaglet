import type { FC } from 'react';
import styles from './DispatchHint.module.scss';

interface DispatchHintProps {
  /** The server's hint, e.g. that a group-thread send reached no agent. */
  message: string;
  onDismiss: () => void;
}

/** Transient hint above the composer after a send the server dispatched to nobody. */
export const DispatchHint: FC<DispatchHintProps> = ({ message, onDismiss }) => (
  <div className={styles.hint} role="status">
    <span>{message}</span>
    <button
      type="button"
      className={styles.dismiss}
      onClick={onDismiss}
      aria-label="Dismiss hint"
      title="Dismiss"
    >
      ✕
    </button>
  </div>
);
