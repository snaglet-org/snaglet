import { useMemo, type FC } from 'react';
import { useNotifications, useUnreadCount } from '@desktop/utils/notificationState';
import { useStatusBarSlot } from '../StatusBarContext';
import type { StatusBarSlot } from '../types';
import { NotificationPopover } from './NotificationPopover';
import { BellIcon } from '@desktop/components/Icons';
import styles from './NotificationsSlot.module.scss';

/**
 * NotificationsSlot -- headless status-bar consumer (renders null) that pushes
 * the notification bell into the right zone of the status bar.
 *
 * Shows unread count as a red badge over the bell icon. Clicking opens
 * the NotificationPopover with the list of recent notifications.
 * Data is push-only: seeded from REST on connect, updated by
 * `notification.created` workspace events.
 */
export const NotificationsSlot: FC = () => {
  const notifications = useNotifications();
  const unreadCount = useUnreadCount();

  const slot = useMemo<StatusBarSlot>(
    () => ({
      id: 'notifications',
      zone: 'right',
      order: 0,
      item: {
        type: 'toggle',
        label:
          unreadCount > 0
            ? `${unreadCount} notification${unreadCount === 1 ? '' : 's'}`
            : 'Notifications',
        tone: unreadCount > 0 ? 'warning' : 'muted',
        title:
          unreadCount === 0
            ? 'No unread notifications'
            : `${unreadCount} unread notification${unreadCount === 1 ? '' : 's'}`,
        icon: (
          <span className={styles.glyph}>
            <BellIcon />
            {unreadCount > 0 && (
              <span className={styles.badge}>{unreadCount > 99 ? '99+' : unreadCount}</span>
            )}
          </span>
        ),
        render: ({ close }) => (
          <NotificationPopover notifications={notifications} onClose={close} />
        ),
      },
    }),
    [notifications, unreadCount]
  );

  useStatusBarSlot(slot);
  return null;
};
