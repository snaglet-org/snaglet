import type { FC } from 'react';
import type { LiveConflict } from './agentLiveFields';
import styles from './LiveFieldNotice.module.scss';

interface LiveFieldNoticeProps {
  conflict: LiveConflict;
  /** Drop the draft and show the saved value. */
  onReload: () => void;
  /** Save what the field shows over the other change. */
  onKeepMine: () => void;
}

/**
 * The quiet line a field shows when someone else changed it while the user
 * was editing it. The user's text stays put until they pick.
 */
export const LiveFieldNotice: FC<LiveFieldNoticeProps> = ({ conflict, onReload, onKeepMine }) => (
  <span className={styles.notice} role="status" aria-live="polite">
    <span>Updated by {conflict.by} just now.</span>
    <button type="button" className={styles.action} onClick={onReload}>
      Reload to see it
    </button>
    <span aria-hidden>·</span>
    <button type="button" className={styles.action} onClick={onKeepMine}>
      Keep mine
    </button>
  </span>
);
