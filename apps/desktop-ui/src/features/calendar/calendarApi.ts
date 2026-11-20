/**
 * Calendar API client — one function per route in
 * `packages/shared/types/calendar.ts` (all under `/api/calendar`, enveloped).
 */
import type {
  CalendarEventResponse,
  CalendarOccurrencesQuery,
  CalendarOccurrencesResponse,
  CalendarResponse,
  CalendarDeletionPreview,
  CalendarsResponse,
  CreateCalendarEventRequest,
  CreateCalendarRequest,
  ReorderCalendarsRequest,
  UpdateCalendarEventRequest,
  UpdateCalendarRequest,
} from '@snaglet/shared/types';
import { getPanelJsonHeaders } from '@desktop/utils/panelToken';
import { fetchData, getApiUrl } from '@desktop/utils/api/core';

const base = (path: string) => getApiUrl(`/calendar${path}`);
const id = (value: string) => encodeURIComponent(value);
const json = (method: string, body: unknown): RequestInit => ({
  method,
  body: JSON.stringify(body),
});

/** The occurrences query string, in a stable key order (used as a cache key too). */
export function occurrencesSearch(query: CalendarOccurrencesQuery): string {
  const params = new URLSearchParams();
  params.set('from', query.from);
  params.set('to', query.to);
  if (query.calendarIds) params.set('calendarIds', query.calendarIds.join(','));
  if (query.projectId) params.set('projectId', query.projectId);
  if (query.tz) params.set('tz', query.tz);
  return params.toString();
}

export const calendarApi = {
  listCalendars: () => fetchData<CalendarsResponse>(base('/calendars')),
  createCalendar: (input: CreateCalendarRequest) =>
    fetchData<CalendarResponse>(base('/calendars'), json('POST', input)),
  updateCalendar: (calendarId: string, input: UpdateCalendarRequest) =>
    fetchData<CalendarResponse>(base(`/calendars/${id(calendarId)}`), json('PATCH', input)),
  previewDeletion: (calendarId: string) =>
    fetchData<CalendarDeletionPreview>(base(`/calendars/${id(calendarId)}/deletion`), {
      headers: getPanelJsonHeaders(),
    }),
  deleteCalendar: (calendarId: string, token: string) =>
    fetchData<{ id: string }>(base(`/calendars/${id(calendarId)}`), {
      ...json('DELETE', { token }),
      headers: getPanelJsonHeaders(),
    }),
  reorderCalendars: (input: ReorderCalendarsRequest) =>
    fetchData<CalendarsResponse>(base('/calendars/order'), json('PUT', input)),

  createEvent: (input: CreateCalendarEventRequest) =>
    fetchData<CalendarEventResponse>(base('/events'), json('POST', input)),
  getEvent: (eventId: string) => fetchData<CalendarEventResponse>(base(`/events/${id(eventId)}`)),
  updateEvent: (eventId: string, input: UpdateCalendarEventRequest) =>
    fetchData<CalendarEventResponse>(base(`/events/${id(eventId)}`), json('PATCH', input)),
  deleteEvent: (eventId: string, expectedRevision: number) =>
    fetchData<{ id: string }>(
      base(
        `/events/${id(eventId)}?expectedRevision=${encodeURIComponent(String(expectedRevision))}`
      ),
      { method: 'DELETE' }
    ),

  occurrences: (query: CalendarOccurrencesQuery, init?: RequestInit) =>
    fetchData<CalendarOccurrencesResponse>(base(`/occurrences?${occurrencesSearch(query)}`), init),
};
