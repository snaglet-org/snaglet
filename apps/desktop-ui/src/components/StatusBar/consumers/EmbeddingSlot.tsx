import { useEffect, useMemo, type FC } from 'react';
import { Spinner } from '@desktop/components';
import { useEmbeddingWork, embeddingWorkState } from '@desktop/utils/embeddingWorkState';
import { useStatusBarSlot } from '../StatusBarContext';
import type { StatusBarSlot } from '../types';
import { EmbeddingPopover } from './EmbeddingPopover';
import styles from './EmbeddingSlot.module.scss';

export const EmbeddingSlot: FC = () => {
  const work = useEmbeddingWork();
  useEffect(() => {
    void embeddingWorkState.refreshMaintenance();
    const timer = window.setInterval(() => void embeddingWorkState.refreshMaintenance(), 2000);
    return () => window.clearInterval(timer);
  }, []);
  const active = Boolean(work.maintenance?.running) || work.items.length > 0;
  const slot = useMemo<StatusBarSlot>(
    () => ({
      id: 'embeddings',
      zone: 'left',
      order: 3,
      item: {
        type: 'toggle',
        label: active ? 'Embedding' : '0 embeddings',
        tone: active ? 'primary' : 'muted',
        title: active ? 'Embedding activity — click for details' : 'No embeddings in progress',
        icon: active ? (
          <Spinner variant="svg" size="xs" tone="accent" />
        ) : (
          <span className={styles.idle} />
        ),
        render: () => <EmbeddingPopover maintenance={work.maintenance} items={work.items} />,
      },
    }),
    [active, work]
  );
  useStatusBarSlot(slot);
  return null;
};
