import { google } from 'googleapis';
import type { calendar_v3 } from 'googleapis';
import type { ToolHandlerContext } from '@server/services/ToolService/types';
import { getGoogleClient } from '@server/integrations/google/getGoogleClient';
import { isoNow } from '@snaglet/shared/utils';

interface ListEventsInput {
  calendarId?: string;
  timeMin?: string;
  timeMax?: string;
  query?: string;
  maxResults?: number;
}

/**
 * Formats Calendar API events into the tool's stable JSON response shape.
 * Credential lookup stays outside this helper; callers pass an authenticated
 * OAuth2Client from getGoogleClient().
 */
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
    attendees: (event.attendees ?? []).map((a: calendar_v3.Schema$EventAttendee) => ({
      email: a.email ?? null,
      responseStatus: a.responseStatus ?? null,
    })),
    htmlLink: event.htmlLink ?? null,
  };
}

function isIsoString(value: string): boolean {
  return !Number.isNaN(Date.parse(value));
}

const tool = async (input: ListEventsInput, _context: ToolHandlerContext): Promise<string> => {
  const calendarId = input.calendarId?.trim() || 'primary';
  const maxResults = input.maxResults ?? 25;

  if (!Number.isInteger(maxResults) || maxResults < 1 || maxResults > 100) {
    throw new Error('maxResults must be an integer between 1 and 100');
  }
  if (input.timeMin && !isIsoString(input.timeMin)) {
    throw new Error('timeMin must be a valid ISO 8601 date-time string');
  }
  if (input.timeMax && !isIsoString(input.timeMax)) {
    throw new Error('timeMax must be a valid ISO 8601 date-time string');
  }

  const auth = await getGoogleClient();
  const calendar = google.calendar({ version: 'v3', auth });

  const res = await calendar.events.list({
    calendarId,
    timeMin: input.timeMin ?? isoNow(),
    timeMax: input.timeMax,
    q: input.query?.trim() || undefined,
    singleEvents: true,
    orderBy: 'startTime',
    maxResults,
  });

  const events = (res.data.items ?? []).map(formatEvent);

  return JSON.stringify({
    calendarId,
    count: events.length,
    events,
  });
};

export default tool;
