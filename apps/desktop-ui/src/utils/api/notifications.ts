/**
 * notificationsApi — client for the notification REST surface.
 */

import { fetchData, getApiUrl } from './core';
import type { NotificationRecord } from '@snaglet/shared/types';

export const notificationsApi = {
  list: (limit = 50) => fetchData<NotificationRecord[]>(getApiUrl(`/notifications?limit=${limit}`)),

  unreadCount: () =>
    fetchData<{ count: number }>(getApiUrl('/notifications/unread')).then((d) => d.count),

  markRead: (id: string) =>
    fetchData<NotificationRecord | null>(getApiUrl(`/notifications/${id}/read`), {
      method: 'POST',
    }),

  markAllRead: () =>
    fetchData<{ count: number }>(getApiUrl('/notifications/read-all'), {
      method: 'POST',
    }),

  dismiss: (id: string) =>
    fetchData<NotificationRecord | null>(getApiUrl(`/notifications/${id}/dismiss`), {
      method: 'POST',
    }),

  dismissAll: () =>
    fetchData<{ count: number }>(getApiUrl('/notifications/dismiss-all'), {
      method: 'POST',
    }),
};
