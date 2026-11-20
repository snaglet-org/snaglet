/**
 * Reminder routes — /api/reminders (contract: packages/shared/types/reminders.ts).
 *
 * The item comes from the query: `kind=event&eventId=…`,
 * `kind=table_entry&tableId=…&entryId=…&fieldId=…` or `kind=automation&automationId=…`.
 *
 * GET    /settings?<item>            → ReminderSettingsResponse (settings null when none)
 * PUT    /settings?<item>            → ReminderSettingsResponse (body UpdateReminderSettingsRequest;
 *                                      400 bad input, 404 item missing)
 * DELETE /settings?<item>            → ReminderSettingsResponse ({ settings: null })
 * GET    /upcoming?hours=72          → UpcomingRemindersResponse (0 < hours ≤ 168, default 72):
 *                                      reminders firing after now and up to now + hours
 *
 * PUT and DELETE emit `reminders:changed`.
 */
import { Router } from 'express';
import { Reminders } from '@snaglet/db/tables/reminders';
import type { ReminderSettingsResponse, UpcomingRemindersResponse } from '@snaglet/shared/types';
import { asyncHandler } from '@server/middleware';
import { emitRemindersChanged } from '@server/realtime/surfaces/reminders';
import { sendOk } from '@server/utils/http';
import {
  assertReminderItemExists,
  parseReminderItem,
  parseReminderSettings,
  reminderBadRequest,
} from './reminderInput';
import { refreshReminderTables, remindersBetween } from './upcomingReminders';

const UPCOMING_DEFAULT_HOURS = 72;
const UPCOMING_MAX_HOURS = 168;

const router = Router();

router.get(
  '/settings',
  asyncHandler(async (req, res) => {
    const item = parseReminderItem(req.query as Record<string, unknown>);
    const body: ReminderSettingsResponse = { settings: await Reminders.get(item) };
    sendOk(res, body);
  })
);

router.put(
  '/settings',
  asyncHandler(async (req, res) => {
    const item = parseReminderItem(req.query as Record<string, unknown>);
    const input = parseReminderSettings(req.body);
    await assertReminderItemExists(item);
    const body: ReminderSettingsResponse = { settings: await Reminders.save(item, input) };
    await refreshReminderTables();
    emitRemindersChanged();
    sendOk(res, body);
  })
);

router.delete(
  '/settings',
  asyncHandler(async (req, res) => {
    const item = parseReminderItem(req.query as Record<string, unknown>);
    if (await Reminders.remove(item)) {
      await refreshReminderTables();
      emitRemindersChanged();
    }
    const body: ReminderSettingsResponse = { settings: null };
    sendOk(res, body);
  })
);

function parseHours(value: unknown): number {
  if (value === undefined || value === '') return UPCOMING_DEFAULT_HOURS;
  const hours = typeof value === 'string' ? Number(value) : Number.NaN;
  if (!Number.isFinite(hours) || hours <= 0 || hours > UPCOMING_MAX_HOURS)
    throw reminderBadRequest(`hours must be more than 0 and at most ${UPCOMING_MAX_HOURS}.`);
  return hours;
}

router.get(
  '/upcoming',
  asyncHandler(async (req, res) => {
    const hours = parseHours(req.query.hours);
    const now = Date.now();
    const until = new Date(now + hours * 3_600_000);
    const reminders = (await remindersBetween({ from: new Date(now), to: until })).filter(
      (reminder) => Date.parse(reminder.fireAt) > now
    );
    const body: UpcomingRemindersResponse = { reminders, until: until.toISOString() };
    sendOk(res, body);
  })
);

export default router;
