/**
 * Calendar routes — /api/calendar (contract: packages/shared/types/calendar.ts).
 *
 * GET    /calendars                          → CalendarsResponse (empty stays empty)
 * POST   /calendars                          → CalendarResponse (201)
 * PUT    /calendars/order                    → CalendarsResponse
 * PATCH  /calendars/:id                      → CalendarResponse
 * GET    /calendars/:id/deletion             → CalendarDeletionPreview (app only)
 * DELETE /calendars/:id                      → { id } (app only)
 * POST   /events                             → CalendarEventResponse (201; 200 on a replay)
 * GET    /events/:id                         → CalendarEventResponse
 * PATCH  /events/:id                         → CalendarEventResponse
 * DELETE /events/:id?expectedRevision=N      → { id } (archives the event node)
 * POST   /events/:id/restore                 → CalendarEventResponse (undo of delete)
 * GET    /occurrences?from&to&calendarIds&projectId&tz → CalendarOccurrencesResponse
 */
import { Router } from 'express';
import type {
  CalendarEventResponse,
  CalendarOccurrencesResponse,
  CalendarResponse,
  CalendarsResponse,
} from '@snaglet/shared/types';
import { asyncHandler } from '@server/middleware';
import { sendCreated, sendOk } from '@server/utils/http';
import {
  createCalendar,
  createEvent,
  deleteEvent,
  getEvent,
  listCalendars,
  reorderCalendars,
  restoreEvent,
  updateCalendar,
  updateEvent,
} from './calendarService';
import { listOccurrences } from './occurrences';

import { calendarDeletionAuth, previewCalendarDeletion, deleteCalendar } from './calendarDeletion';

const router = Router();

router.get(
  '/calendars/:id/deletion',
  calendarDeletionAuth,
  asyncHandler(async (req, res) => {
    sendOk(res, await previewCalendarDeletion(req.params.id));
  })
);
router.delete(
  '/calendars/:id',
  calendarDeletionAuth,
  asyncHandler(async (req, res) => {
    sendOk(res, await deleteCalendar(req.params.id, req.body?.token));
  })
);

router.get(
  '/calendars',
  asyncHandler(async (req, res) => {
    const body: CalendarsResponse = {
      calendars: await listCalendars(),
    };
    sendOk(res, body);
  })
);

router.post(
  '/calendars',
  asyncHandler(async (req, res) => {
    const body: CalendarResponse = { calendar: await createCalendar(req.body) };
    sendCreated(res, body);
  })
);

// Before '/calendars/:id' routes so "order" is never read as an id.
router.put(
  '/calendars/order',
  asyncHandler(async (req, res) => {
    const body: CalendarsResponse = { calendars: await reorderCalendars(req.body) };
    sendOk(res, body);
  })
);

router.patch(
  '/calendars/:id',
  asyncHandler(async (req, res) => {
    const body: CalendarResponse = { calendar: await updateCalendar(req.params.id, req.body) };
    sendOk(res, body);
  })
);

router.post(
  '/events',
  asyncHandler(async (req, res) => {
    const { event, created } = await createEvent(req.body);
    const body: CalendarEventResponse = { event };
    if (created) sendCreated(res, body);
    else sendOk(res, body);
  })
);

router.get(
  '/events/:id',
  asyncHandler(async (req, res) => {
    const body: CalendarEventResponse = { event: await getEvent(req.params.id) };
    sendOk(res, body);
  })
);

router.patch(
  '/events/:id',
  asyncHandler(async (req, res) => {
    const body: CalendarEventResponse = { event: await updateEvent(req.params.id, req.body) };
    sendOk(res, body);
  })
);

router.delete(
  '/events/:id',
  asyncHandler(async (req, res) => {
    sendOk(res, await deleteEvent(req.params.id, req.query.expectedRevision));
  })
);

router.post(
  '/events/:id/restore',
  asyncHandler(async (req, res) => {
    const body: CalendarEventResponse = { event: await restoreEvent(req.params.id) };
    sendOk(res, body);
  })
);

router.get(
  '/occurrences',
  asyncHandler(async (req, res) => {
    const body: CalendarOccurrencesResponse = await listOccurrences(
      req.query as Record<string, unknown>
    );
    sendOk(res, body);
  })
);

export default router;
