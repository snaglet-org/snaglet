/**
 * Per-thread run-ended notification settings — /api/threads/:id/notification-settings
 * (contract: packages/shared/types/thread-notifications.ts).
 *
 * GET → ThreadNotificationSettingsResponse. A thread that was never
 *       configured answers the defaults (off), not 404, so the settings form
 *       has something to render.
 * PUT → ThreadNotificationSettingsResponse (body
 *       UpdateThreadNotificationSettingsRequest). Every field is required and
 *       strictly typed, in the style of parseReminderSettings: a readable 400
 *       on bad input, 404 when the thread does not exist.
 *
 * No realtime event on write: nothing else in the app mirrors these settings,
 * and the run:end path reads the row when a run actually ends.
 */
import type { Router } from 'express';
import { Threads } from '@snaglet/db/tables/threads';
import { ThreadNotificationSettingsTable } from '@snaglet/db/tables/thread_notification_settings';
import {
  ErrorCode,
  HTTP_STATUS,
  REMINDER_SOUNDS,
  defaultThreadNotificationSettings,
  type ReminderSoundId,
  type ThreadNotificationSettingsResponse,
  type UpdateThreadNotificationSettingsRequest,
} from '@snaglet/shared/types';
import { AppError } from '@snaglet/shared/utils';
import { asyncHandler } from '@server/middleware';
import { sendOk } from '@server/utils/http';

function badRequest(message: string): AppError {
  return new AppError(message, ErrorCode.VALIDATION_ERROR, HTTP_STATUS.BAD_REQUEST);
}

function parseBoolean(value: unknown, field: string): boolean {
  if (typeof value !== 'boolean') throw badRequest(`${field} must be true or false`);
  return value;
}

function parseSound(value: unknown): ReminderSoundId {
  if (typeof value !== 'string' || !(REMINDER_SOUNDS as readonly string[]).includes(value)) {
    throw badRequest(`sound must be one of: ${REMINDER_SOUNDS.join(', ')}`);
  }
  return value as ReminderSoundId;
}

/** The PUT body, or a 400 naming the first thing wrong with it. */
function parseThreadNotificationSettings(body: unknown): UpdateThreadNotificationSettingsRequest {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw badRequest('Body must be an object');
  }
  const raw = body as Record<string, unknown>;
  return {
    enabled: parseBoolean(raw.enabled, 'enabled'),
    sound: parseSound(raw.sound),
    onCompleted: parseBoolean(raw.onCompleted, 'onCompleted'),
    onFailed: parseBoolean(raw.onFailed, 'onFailed'),
  };
}

async function requireThreadId(id: string): Promise<string> {
  const thread = await Threads.findById(id);
  if (!thread) throw new AppError('Thread not found', ErrorCode.NOT_FOUND, HTTP_STATUS.NOT_FOUND);
  return thread.id;
}

export function registerThreadNotificationSettingsRoutes(router: Router): void {
  router.get(
    '/:id/notification-settings',
    asyncHandler(async (req, res) => {
      const threadId = await requireThreadId(req.params.id);
      const saved = await ThreadNotificationSettingsTable.get(threadId);
      const body: ThreadNotificationSettingsResponse = {
        settings: saved ?? defaultThreadNotificationSettings(threadId),
      };
      sendOk(res, body);
    })
  );

  router.put(
    '/:id/notification-settings',
    asyncHandler(async (req, res) => {
      const threadId = await requireThreadId(req.params.id);
      const input = parseThreadNotificationSettings(req.body);
      const settings = await ThreadNotificationSettingsTable.save(threadId, input);
      const body: ThreadNotificationSettingsResponse = { settings };
      sendOk(res, body);
    })
  );
}
