import { useEffect, useState, type FC } from 'react';
import type { FileContent, FileTreeNode } from '@desktop/utils/api';
import { filesApi } from '@desktop/utils/api';
import { FileContentBody, type RawFileSource } from '@desktop/components/FilePreview';
import { formatBytes, getErrorMessage } from '@snaglet/shared/utils';
import styles from './FileView.module.scss';

interface FileViewProps {
  node: FileTreeNode;
}

type LoadState =
  | { status: 'loading' }
  | { status: 'loaded'; data: FileContent }
  | { status: 'error'; message: string };

/**
 * Read-only viewer for an indexed project file in a pane. Fetches the body on
 * demand by node id; rendering (markdown / monospace / not-previewable notice)
 * is shared with the chip preview modal via FileContentBody.
 */
const FileView: FC<FileViewProps> = ({ node }) => {
  const [state, setState] = useState<LoadState>({ status: 'loading' });

  // A filesystem search hit carries an absolute path in `id` and no project
  // (projectId === ''), so it is read off disk by path; an indexed file node has
  // a real DB id and is read by id. The same split routes the PDF viewer's and
  // audio player's raw fetch to the by-path or by-id raw endpoint.
  const rawSource: RawFileSource =
    node.projectId === '' ? { kind: 'path', path: node.id } : { kind: 'id', fileId: node.id };

  useEffect(() => {
    let canceled = false;
    setState({ status: 'loading' });
    const isFilesystemHit = node.projectId === '';
    const load = isFilesystemHit
      ? filesApi.getContentByPath(node.id)
      : filesApi.getContent(node.id);
    load
      .then((data) => {
        if (!canceled) setState({ status: 'loaded', data });
      })
      .catch((err) => {
        if (!canceled) setState({ status: 'error', message: getErrorMessage(err) });
      });
    return () => {
      canceled = true;
    };
  }, [node.id, node.projectId]);

  return (
    <div className={styles.fileView}>
      <header className={styles.header}>
        <h1 className={styles.title} title={node.relativePath}>
          {node.relativePath}
        </h1>
        <span className={styles.badge}>{formatBytes(node.sizeBytes)}</span>
      </header>
      <div className={styles.body}>
        {state.status === 'loading' && <div className={styles.notice}>Loading…</div>}
        {state.status === 'error' && (
          <div className={styles.notice}>Could not load file: {state.message}</div>
        )}
        {state.status === 'loaded' && (
          <FileContentBody data={state.data} fileName={node.name} rawSource={rawSource} />
        )}
      </div>
    </div>
  );
};

export { FileView };
