import { useEffect, useState, type FC } from 'react';
import type { EmbeddingMaintenanceStatus } from '@desktop/utils/api/types';
import { embeddingOperationLabel } from '@desktop/utils/embeddingOperations';
import type { EmbedWorkItem } from '@desktop/utils/embeddingWorkState';
import styles from './EmbeddingPopover.module.scss';

function elapsedLabel(startedAt: string | null, now = Date.now()): string {
  if (!startedAt) return '0s';
  const elapsedSeconds = Math.max(0, Math.floor((now - Date.parse(startedAt)) / 1000));
  if (!Number.isFinite(elapsedSeconds)) return '0s';
  if (elapsedSeconds < 60) return `${elapsedSeconds}s`;
  const minutes = Math.floor(elapsedSeconds / 60);
  return `${minutes}m ${String(elapsedSeconds % 60).padStart(2, '0')}s`;
}

export const EmbeddingPopover: FC<{
  maintenance: EmbeddingMaintenanceStatus | null;
  items: EmbedWorkItem[];
}> = ({ maintenance, items }) => {
  const [now, setNow] = useState(() => Date.now());
  const active = maintenance?.running || items.length > 0;

  useEffect(() => {
    if (!active) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [active]);

  if (!active) return <div className={styles.empty}>No embeddings in progress.</div>;
  return (
    <div className={styles.surface}>
      <div className={styles.heading}>Embedding activity</div>
      {maintenance?.running && (
        <div className={styles.row}>
          <strong>{embeddingOperationLabel(maintenance.operation)}</strong>
          <span>
            {maintenance.processed}/{maintenance.total || '—'} processed
          </span>
          <span>{elapsedLabel(maintenance.startedAt, now)} elapsed</span>
          {maintenance.currentNodeId && (
            <span>
              Embedding {maintenance.currentNodeType ?? 'node'} {maintenance.currentNodeId}
            </span>
          )}
          {maintenance.failed > 0 && (
            <span className={styles.error}>
              {maintenance.failed} error{maintenance.failed === 1 ? '' : 's'}
            </span>
          )}
        </div>
      )}
      {items.map((item) => (
        <div className={styles.row} key={`${item.nodeType}:${item.nodeId}`}>
          <strong>Embedding {item.nodeTitle}</strong>
          <span>
            {item.nodeType} · {elapsedLabel(item.startedAt, now)} elapsed
          </span>
        </div>
      ))}
    </div>
  );
};
