import { type FC, type ReactNode } from 'react';
import type { LoadStatus } from './hubTypes';
import styles from './HubView.module.scss';

interface SectionLabelProps {
  id: string;
  /** Shown beside the label once the section has loaded. */
  count?: number;
  /** Small controls at the right end of the label row. */
  actions?: ReactNode;
  children: ReactNode;
}

/**
 * A section's quiet label row: the app's small mono uppercase label, an
 * optional count, and actions on the right. The label is the section's
 * heading (an h2), so each section is a named region.
 */
export const SectionLabel: FC<SectionLabelProps> = ({ id, count, actions, children }) => (
  <div className={styles.labelRow}>
    <h2 id={id} className={styles.label}>
      {children}
    </h2>
    {count !== undefined && count > 0 && (
      <span className={styles.labelCount} aria-hidden>
        {count}
      </span>
    )}
    {actions && <div className={styles.labelActions}>{actions}</div>}
  </div>
);

interface SectionStateProps {
  status: LoadStatus;
  error: string | null;
  loadingText: string;
  onRetry?: () => void;
}

/**
 * The one-line loading note or error a section shows instead of its items.
 * Renders nothing once the section is ready.
 */
export const SectionState: FC<SectionStateProps> = ({ status, error, loadingText, onRetry }) => {
  if (status === 'loading') {
    return (
      <p className={styles.stateLine} role="status">
        {loadingText}
      </p>
    );
  }
  if (status === 'error') {
    return (
      <p className={styles.errorLine} role="alert">
        <span>{error ?? 'Something went wrong.'}</span>
        {onRetry && (
          <button type="button" className={styles.textButton} onClick={onRetry}>
            Try again
          </button>
        )}
      </p>
    );
  }
  return null;
};
