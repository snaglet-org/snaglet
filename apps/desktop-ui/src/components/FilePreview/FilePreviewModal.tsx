import { useEffect, useState, type FC } from 'react';
import type { FileContent } from '@desktop/utils/api';
import { filesApi } from '@desktop/utils/api';
import { formatBytes, getErrorMessage } from '@snaglet/shared/utils';
import { FileContentBody } from './FileContentBody';
import { PreviewModalShell } from './PreviewModalShell';
import styles from './FilePreview.module.scss';

type LoadState =
  | { status: 'loading' }
  | { status: 'loaded'; data: FileContent }
  | { status: 'error'; message: string };

/**
 * Read-only file preview in a modal, opened by clicking a `file:` chip. The chip
 * carries the absolute path, so content is fetched by path (the server refuses
 * paths outside an indexed project folder).
 */
export const FilePreviewModal: FC<{ path: string; onClose: () => void }> = ({ path, onClose }) => {
  const [state, setState] = useState<LoadState>({ status: 'loading' });

  useEffect(() => {
    let canceled = false;
    setState({ status: 'loading' });
    filesApi
      .getContentByPath(path)
      .then((data) => {
        if (!canceled) setState({ status: 'loaded', data });
      })
      .catch((err) => {
        if (!canceled) setState({ status: 'error', message: getErrorMessage(err) });
      });
    return () => {
      canceled = true;
    };
  }, [path]);

  const fileName = path.split('/').pop() ?? path;

  return (
    <PreviewModalShell
      title={fileName}
      subtitle={path}
      headerAside={
        state.status === 'loaded' ? (
          <span className={styles.badge}>{formatBytes(state.data.sizeBytes)}</span>
        ) : undefined
      }
      onClose={onClose}
    >
      {state.status === 'loading' && <div className={styles.notice}>Loading…</div>}
      {state.status === 'error' && (
        <div className={styles.notice}>Could not load file: {state.message}</div>
      )}
      {state.status === 'loaded' && (
        <FileContentBody data={state.data} fileName={fileName} rawSource={{ kind: 'path', path }} />
      )}
    </PreviewModalShell>
  );
};
