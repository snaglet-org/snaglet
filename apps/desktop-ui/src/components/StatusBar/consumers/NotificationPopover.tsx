import { type FC, useCallback } from 'react';
import type { NotificationRecord } from '@snaglet/shared/types';
import { appUpdateOfferVersion } from '@snaglet/shared/constants/release';
import { useDashboardNavigation } from '@desktop/pages/Dashboard/selection/DashboardNavigationContext';
import { notificationsApi } from '@desktop/utils/api';
import {
  markNotificationRead,
  markAllNotificationsRead,
  dismissNotification,
  dismissAllNotifications,
} from '@desktop/utils/notificationState';
import { cn } from '@desktop/utils/classNames';
import { offerAppUpdate } from '@desktop/utils/appUpdate';
import styles from './NotificationPopover.module.scss';

/**
 * Format a relative time label: "just now", "2m", "1h", "3d".
 */
function formatRelativeTime(isoDate: string): string {
  const diff = Date.now() - Date.parse(isoDate);
  if (diff < 60_000) return 'just now';
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  return `${days}d`;
}

/**
 * Scrollable notification list rendered inside the status bar's toggle
 * popover. Each notification is clickable (navigates to the relevant
 * thread) and dismissible.
 */
export const NotificationPopover: FC<{
  notifications: NotificationRecord[];
  onClose: () => void;
}> = ({ notifications, onClose }) => {
  const nav = useDashboardNavigation();

  const handleClick = useCallback(
    (notif: NotificationRecord) => {
      // Mark as read (optimistic + server).
      markNotificationRead(notif.id);
      void notificationsApi.markRead(notif.id).catch((err: unknown) => {
        console.error('NotificationPopover: failed to mark notification read', err);
      });

      // The update offer asks before installing (the release page in a
      // browser). Other app_update notices, such as a moved project folder,
      // offer nothing.
      const offeredVersion = appUpdateOfferVersion(notif);
      if (offeredVersion) {
        void offerAppUpdate(offeredVersion);
        onClose();
        return;
      }

      // Navigate to the thread if one is referenced. A notification carries no
      // thread title, so the thread opens by id and the pane is named from the
      // workspace tree (a stub node with a null title would show the raw id).
      if (notif.threadId) nav?.openThread?.(notif.threadId);
      onClose();
    },
    [nav, onClose]
  );

  const handleDismiss = useCallback((id: string) => {
    dismissNotification(id);
    void notificationsApi.dismiss(id).catch((err: unknown) => {
      console.error('NotificationPopover: failed to dismiss notification', err);
    });
  }, []);

  const handleMarkAllRead = useCallback(() => {
    markAllNotificationsRead();
    void notificationsApi.markAllRead().catch((err: unknown) => {
      console.error('NotificationPopover: failed to mark all notifications read', err);
    });
  }, []);

  const handleDismissAll = useCallback(() => {
    dismissAllNotifications();
    void notificationsApi.dismissAll().catch((err: unknown) => {
      console.error('NotificationPopover: failed to dismiss all notifications', err);
    });
    onClose();
  }, [onClose]);

  const visible = notifications.filter((n) => !n.dismissed);

  return (
    <div>
      <div className={styles.header}>
        <span className={styles.headerTitle}>Notifications</span>
        {visible.length > 0 && (
          <div className={styles.headerActions}>
            <button type="button" className={styles.headerBtn} onClick={handleMarkAllRead}>
              Mark all read
            </button>
            <button type="button" className={styles.headerBtn} onClick={handleDismissAll}>
              Clear all
            </button>
          </div>
        )}
      </div>
      {visible.length === 0 ? (
        <div className={styles.empty}>No notifications.</div>
      ) : (
        <ul className={styles.list} aria-label="Notifications">
          {visible.map((notif) => (
            <li key={notif.id} className={styles.item}>
              {/* Two sibling buttons: a button can't hold another one. */}
              <div className={cn(styles.row, !notif.read && styles.rowUnread)}>
                <button
                  type="button"
                  className={styles.open}
                  onClick={() => handleClick(notif)}
                  title={notif.body ?? notif.title}
                >
                  {notif.read ? (
                    <span className={styles.unreadDotPlaceholder} />
                  ) : (
                    <span className={styles.unreadDot} />
                  )}
                  <span className={styles.rowContent}>
                    <span className={styles.title}>{notif.title}</span>
                    {notif.body && <span className={styles.body}>{notif.body}</span>}
                  </span>
                  <span className={styles.time}>{formatRelativeTime(notif.createdAt)}</span>
                </button>
                <button
                  type="button"
                  className={styles.dismissBtn}
                  onClick={() => handleDismiss(notif.id)}
                  title="Dismiss"
                  aria-label="Dismiss notification"
                >
                  &times;
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
};
