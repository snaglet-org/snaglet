import { google } from 'googleapis';
import type { calendar_v3 } from 'googleapis';
import type { ToolHandlerContext } from '@server/services/ToolService/types';
import { getGoogleClient } from '@server/integrations/google/getGoogleClient';

interface SearchEventsInput {
  query: string;
  calendarId?: string;
  timeMin?: string;
  timeMax?: string;
  maxResults?: number;
}

/**
 * Free-text search across calendar events. Distinct from list_events: list_events is a
 * time-windowed agenda browser defaulting to upcoming events; search_events is a find
 * tool — query is required and the default window is unbounded (searches past + future)
 * so a user can locate an event by name regardless of when it occurs. Uses the workspace
 * seam getGoogleClient(); the handler never touches credentials.
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

const tool = async (input: SearchEventsInput, _context: ToolHandlerContext): Promise<string> => {
  const query = input.query?.trim();
  if (!query) {
    throw new Error('query is required and must be a non-empty free-text search string');
  }

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

  // Unbounded by default: unlike list_events, do not default timeMin to now;
  // a search should find past events too. Only constrain when caller passes bounds.
  const res = await calendar.events.list({
    calendarId,
    q: query,
    timeMin: input.timeMin,
    timeMax: input.timeMax,
    singleEvents: true,
    orderBy: 'startTime',
    maxResults,
  });

  const events = (res.data.items ?? []).map(formatEvent);

  return JSON.stringify({
    calendarId,
    query,
    count: events.length,
    events,
  });
};

export default tool;
