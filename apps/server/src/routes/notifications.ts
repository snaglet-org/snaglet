/**
 * Notification REST API.
 *
 * GET    /api/notifications            — list recent (non-dismissed)
 * GET    /api/notifications/unread     — unread count
 * POST   /api/notifications/:id/read   — mark one as read
 * POST   /api/notifications/read-all   — mark all as read
 * POST   /api/notifications/:id/dismiss — dismiss one
 * POST   /api/notifications/dismiss-all — dismiss all
 */

import { Router } from 'express';
import { asyncHandler } from '@server/middleware';
import { sendOk } from '@server/utils/http';
import { notificationService } from '@server/services/NotificationService';

const router = Router();

function parseLimit(value: unknown, fallback: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(Math.floor(parsed), 1), 200);
}

router.get(
  '/',
  asyncHandler(async (req, res) => {
    const limit = parseLimit(req.query.limit, 50);
    const notifications = await notificationService.listRecent(limit);
    sendOk(res, notifications);
  })
);

router.get(
  '/unread',
  asyncHandler(async (_req, res) => {
    const count = await notificationService.countUnread();
    sendOk(res, { count });
  })
);

router.post(
  '/read-all',
  asyncHandler(async (_req, res) => {
    const count = await notificationService.markAllRead();
    sendOk(res, { count });
  })
);

router.post(
  '/dismiss-all',
  asyncHandler(async (_req, res) => {
    const count = await notificationService.dismissAll();
    sendOk(res, { count });
  })
);

router.post(
  '/:id/read',
  asyncHandler(async (req, res) => {
    const notification = await notificationService.markRead(req.params.id);
    sendOk(res, notification);
  })
);

router.post(
  '/:id/dismiss',
  asyncHandler(async (req, res) => {
    const notification = await notificationService.dismiss(req.params.id);
    sendOk(res, notification);
  })
);

export default router;
