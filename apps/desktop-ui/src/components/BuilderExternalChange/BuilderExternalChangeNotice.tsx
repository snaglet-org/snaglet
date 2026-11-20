import type { FC } from 'react';
import { Button } from '@desktop/components';
import styles from './BuilderExternalChangeNotice.module.scss';

interface BuilderExternalChangeNoticeProps {
  /** The file that moved, e.g. `hook.ts`. */
  fileName: string;
  /** The copy currently on disk — shown so the choice is an informed one. */
  disk: string;
  onReloadFromDisk: () => void;
  onKeepMine: () => void;
  disabled?: boolean;
}

/**
 * Announces that the file under the editor changed while the user had unsaved
 * edits, and makes them pick. There is no default and no timer: both outcomes
 * lose someone's work, so neither happens on its own.
 */
export const BuilderExternalChangeNotice: FC<BuilderExternalChangeNoticeProps> = ({
  fileName,
  disk,
  onReloadFromDisk,
  onKeepMine,
  disabled,
}) => (
  <div className={styles.root} role="alert">
    <p className={styles.headline}>
      <code>{fileName}</code> changed on disk while you were editing it.
    </p>
    <p className={styles.detail}>
      An agent or another editor rewrote it. Your unsaved edits are still here — nothing has been
      overwritten, and nothing will be until you choose.
    </p>
    <details className={styles.disclosure}>
      <summary className={styles.summary}>Show the version on disk</summary>
      <pre className={styles.disk}>{disk}</pre>
    </details>
    <div className={styles.actions}>
      <Button variant="neutral" onClick={onReloadFromDisk} disabled={disabled}>
        Use the version on disk
      </Button>
      <Button variant="neutral" onClick={onKeepMine} disabled={disabled}>
        Keep my edits
      </Button>
    </div>
    <p className={styles.footnote}>
      Using the disk version discards your edits. Keeping yours means the next save overwrites the
      file.
    </p>
  </div>
);
