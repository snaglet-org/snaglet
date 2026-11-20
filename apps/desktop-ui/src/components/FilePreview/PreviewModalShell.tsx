import { type FC, type ReactNode } from 'react';
import { Modal } from '@desktop/components/Modal';
import styles from './FilePreview.module.scss';

interface PreviewModalShellProps {
  /** Primary header label (file/folder name). */
  title: string;
  /** Secondary header line — the full path. */
  subtitle?: string;
  /** Optional node placed in the header before the close button (e.g. a size badge). */
  headerAside?: ReactNode;
  onClose: () => void;
  children: ReactNode;
}

/**
 * Shared centered-modal chrome for path-based previews (file / folder), built
 * the same way as WikiLinkPreviewModal: `Modal` provides the portal + Esc +
 * backdrop-dismiss; we supply our own centered overlay + sized panel so it reads
 * as part of the same design system instead of the narrow default Modal card.
 */
export const PreviewModalShell: FC<PreviewModalShellProps> = ({
  title,
  subtitle,
  headerAside,
  onClose,
  children,
}) => (
  <Modal onClose={onClose} unstyled className={styles.overlay} aria-label={`${title} preview`}>
    <div className={styles.panel}>
      <header className={styles.header}>
        <h2 className={styles.title} title={subtitle ?? title}>
          {title}
        </h2>
        {subtitle && (
          <span className={styles.path} title={subtitle}>
            {subtitle}
          </span>
        )}
        {headerAside}
        <button
          type="button"
          className={styles.closeBtn}
          onClick={onClose}
          aria-label="Close preview"
          title="Close (Esc)"
        >
          ×
        </button>
      </header>
      <div className={styles.body}>{children}</div>
    </div>
  </Modal>
);
