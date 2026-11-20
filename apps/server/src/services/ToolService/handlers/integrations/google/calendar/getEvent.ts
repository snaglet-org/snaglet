import { google } from 'googleapis';
import type { calendar_v3 } from 'googleapis';
import type { ToolHandlerContext } from '@server/services/ToolService/types';
import { getGoogleClient } from '@server/integrations/google/getGoogleClient';

interface GetEventInput {
  eventId?: string;
  calendarId?: string;
}

function formatEvent(event: calendar_v3.Schema$Event) {
  const start = event.start?.dateTime ?? event.start?.date ?? null;
  const end = event.end?.dateTime ?? event.end?.date ?? null;
  return {
    id: event.id ?? null,
    summary: event.summary ?? '(no title)',
    description: event.description ?? null,
    location: event.location ?? null,
    start,
    end,
    allDay: Boolean(event.start?.date && !event.start?.dateTime),
    status: event.status ?? null,
    organizer: event.organizer?.email ?? null,
    attendees: (event.attendees ?? []).map((a: calendar_v3.Schema$EventAttendee) => ({
      email: a.email ?? null,
      responseStatus: a.responseStatus ?? null,
    })),
    htmlLink: event.htmlLink ?? null,
    created: event.created ?? null,
    updated: event.updated ?? null,
  };
}

const tool = async (input: GetEventInput, _context: ToolHandlerContext): Promise<string> => {
  const eventId = input.eventId?.trim();
  if (!eventId) {
    throw new Error('eventId is required');
  }
  const calendarId = input.calendarId?.trim() || 'primary';

  const auth = await getGoogleClient();
  const calendar = google.calendar({ version: 'v3', auth });

  const res = await calendar.events.get({
    calendarId,
    eventId,
  });

  return JSON.stringify({
    calendarId,
    event: formatEvent(res.data),
  });
};

export default tool;
