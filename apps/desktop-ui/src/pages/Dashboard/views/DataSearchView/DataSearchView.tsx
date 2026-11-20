import type { FC } from 'react';
import type { DataSearchTab } from '../../selection/types';
import { EmbeddingsMaintenanceView } from './EmbeddingsMaintenanceView';
import { DatabaseSettingsView } from '../DatabaseSettingsView';
import styles from './DataSearchView.module.scss';

type Mode = 'embeddings' | 'backups';

export interface DataSearchViewProps {
  tab?: DataSearchTab;
}

const VIEW_META: Record<Mode, { title: string; subtitle: string }> = {
  embeddings: {
    title: 'Embeddings',
    subtitle: 'Inspect local index coverage and recover anything waiting to be embedded.',
  },
  backups: {
    title: 'Backups of the local database',
    subtitle: 'Snapshots and restore.',
  },
};

/** Old persisted Embeddings subtabs collapse into the maintenance overview. */
function normalizeMode(tab?: DataSearchTab): Mode {
  if (tab === 'backups') return tab;
  return 'embeddings';
}

const ModeBody: FC<{ mode: Mode }> = ({ mode }) => {
  if (mode === 'backups') return <DatabaseSettingsView />;
  return <EmbeddingsMaintenanceView />;
};

/** Data exposes index maintenance and database backups. */
export const DataSearchView: FC<DataSearchViewProps> = ({ tab }) => {
  const mode = normalizeMode(tab);
  const meta = VIEW_META[mode];

  return (
    <div className={styles.root}>
      <header className={styles.header}>
        <div className={styles.headerCopy}>
          <h2 className={styles.title}>{meta.title}</h2>
          <p className={styles.subtitle}>{meta.subtitle}</p>
        </div>
      </header>
      <ModeBody mode={mode} />
    </div>
  );
};
