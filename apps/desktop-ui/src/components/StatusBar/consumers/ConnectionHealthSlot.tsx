import { useMemo, type FC } from 'react';
import { useWs } from '@desktop/ws/useWs';
import { useStatusBarSlot } from '../StatusBarContext';
import type { StatusBarSlot, StatusBarTone } from '../types';
import styles from './ConnectionHealthSlot.module.scss';

/**
 * ConnectionHealthSlot — a real consumer of the status-bar slot API.
 *
 * Renders nothing itself; it registers a persistent text slot in the LEFT zone
 * that live-updates as the WebSocket connection state changes, and unregisters
 * on unmount. Complements <WsStatusIndicator> (the transient corner badge) with
 * an always-present health readout, and proves the push/pop slot registry.
 */
export const ConnectionHealthSlot: FC = () => {
  const { connectionState, serverRestarting } = useWs();

  const slot = useMemo<StatusBarSlot>(() => {
    let label: string;
    let tone: StatusBarTone;
    if (serverRestarting) {
      label = 'Server restarting';
      tone = 'warning';
    } else {
      switch (connectionState) {
        case 'open':
          label = 'Connected';
          tone = 'success';
          break;
        case 'connecting':
          label = 'Reconnecting';
          tone = 'warning';
          break;
        case 'error':
          label = 'Connection error';
          tone = 'error';
          break;
        default:
          label = 'Disconnected';
          tone = 'error';
          break;
      }
    }

    return {
      id: 'connection-health',
      zone: 'left',
      order: 0,
      item: {
        type: 'text',
        label,
        tone,
        title: 'Live connection to the Snaglet server',
        icon: <span className={`${styles.dot} ${styles[tone]}`} />,
      },
    };
  }, [connectionState, serverRestarting]);

  useStatusBarSlot(slot);
  return null;
};
