import type { FC } from 'react';

import { useWs } from '@desktop/ws/useWs';
import styles from './WsStatusIndicator.module.scss';

/**
 * WsStatusIndicator — small fixed badge in the bottom-right corner.
 *
 * Only visible when the connection is NOT open (reconnecting, error, closed,
 * or when the server is restarting). While connected it's invisible so it
 * doesn't distract users during normal operation.
 */
export const WsStatusIndicator: FC = () => {
  const { connectionState, serverRestarting } = useWs();

  if (connectionState === 'open' && !serverRestarting) return null;

  const label = serverRestarting
    ? 'Server restarting…'
    : connectionState === 'connecting'
      ? 'Reconnecting…'
      : connectionState === 'error'
        ? 'Connection error'
        : 'Disconnected';

  const variant = serverRestarting || connectionState === 'connecting' ? 'warning' : 'error';

  return (
    <div className={`${styles.badge} ${styles[variant]}`} role="status" aria-live="polite">
      <span className={styles.dot} />
      <span className={styles.label}>{label}</span>
    </div>
  );
};
