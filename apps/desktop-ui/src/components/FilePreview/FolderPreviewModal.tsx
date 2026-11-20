import { type FC } from 'react';
import { PreviewModalShell } from './PreviewModalShell';
import styles from './FilePreview.module.scss';

export const FolderPreviewModal: FC<{ path: string; onClose: () => void }> = ({
  path,
  onClose,
}) => {
  const folderName = path.split('/').filter(Boolean).pop() ?? path;
  return (
    <PreviewModalShell title={folderName} subtitle={path} onClose={onClose}>
      <div className={styles.notice}>No preview available for folders.</div>
    </PreviewModalShell>
  );
};
